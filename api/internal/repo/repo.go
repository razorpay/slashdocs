package repo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/internal/textedit"
)

type Role string

const (
	RoleNone      Role = ""
	RoleViewer    Role = "viewer"
	RoleCommenter Role = "commenter"
	RoleEditor    Role = "editor"
	RoleOwner     Role = "owner"
)

var roleRank = map[Role]int{RoleViewer: 1, RoleCommenter: 2, RoleEditor: 3, RoleOwner: 4}

// MaxRole returns whichever role grants more access. RoleNone ("") ranks below
// every real role, so MaxRole(RoleNone, x) == x.
func MaxRole(a, b Role) Role {
	if roleRank[b] > roleRank[a] {
		return b
	}
	return a
}

// ErrNotFound wraps auth.ErrNotFound so that packages which cannot import repo
// (to avoid an import cycle) can still detect not-found via errors.Is.
var ErrNotFound = fmt.Errorf("not found: %w", auth.ErrNotFound)
var ErrConflict = errors.New("conflict")
var ErrForbidden = errors.New("forbidden")
var ErrInvalidCommentBody = errors.New("invalid comment body")
var ErrInvalidCommentMention = errors.New("invalid comment mention")

// Ownership-transfer state errors, shared by all repository implementations so
// handlers can map them to responses without matching on message text.
var (
	ErrNotTransferTarget  = errors.New("not transfer target")
	ErrTransferNotPending = errors.New("transfer not pending")
)

// ErrVersionConflict reports a write that names a state which is not what
// the document needs: a base that is not a version of the document, a change
// of text that other people changed after its base, or an approval action on
// content that the document no longer has. The concrete error is
// a *VersionConflictError with the current version id. Callers can match it
// with errors.Is(err, ErrVersionConflict) or extract details with
// errors.As(&VersionConflictError{}).
var ErrVersionConflict = errors.New("version_conflict")

// VersionConflictError carries the current/latest version id and the seq of
// the live document alongside the sentinel ErrVersionConflict. Text, when
// set, is the sentence that holds the text of other people that a refused
// push changes, in plain words.
type VersionConflictError struct {
	LatestVersionID string
	Seq             int64
	Text            string
}

func (e *VersionConflictError) Error() string        { return "version_conflict" }
func (e *VersionConflictError) Is(target error) bool { return target == ErrVersionConflict }

// EmailIdentityConflictError reports a sign-in whose identity key matches no
// user while its verified email belongs to a user with another identity key,
// for example after SLASHDOCS_OIDC_ISSUER_URL changed.
type EmailIdentityConflictError struct {
	Email            string
	ExistingIdentity string
	IncomingIdentity string
}

func (e *EmailIdentityConflictError) Error() string { return "email_identity_conflict" }

// MaxHTMLBytes caps the HTML of a document.
const MaxHTMLBytes = 50 << 20

// ErrTooLarge reports a write that makes the HTML of a document larger than
// MaxHTMLBytes.
var ErrTooLarge = errors.New("document HTML exceeds 50 MiB")

// ErrNoSuchSeq reports a seq that is after the live document.
var ErrNoSuchSeq = errors.New("the document has no such seq")

// ErrStale reports a seq that the server can no longer serve: the log does
// not hold every operation after it. The caller loads the document again.
var ErrStale = errors.New("the seq is too old")

// ErrApplied reports a repeat of an operation that the document has, when
// the log no longer gives the answer of the first attempt.
var ErrApplied = errors.New("the document has the operation")

// ErrEditing reports a write on a document whose current version is open:
// people are editing the document. The write needs the seq that its caller
// saw, and the caller did not say which state of the document it has. Or
// the write is a decision of an approver, and another person typed a moment
// ago.
var ErrEditing = errors.New("people are editing the document")

// ErrBaseVersion reports a base version that is not a version of the
// document.
var ErrBaseVersion = errors.New("the base version is not a version of the document")

// ErrNotUTF8 reports HTML that is not valid UTF-8. The live document is
// always valid UTF-8.
var ErrNotUTF8 = errors.New("the HTML is not valid UTF-8")

// LiveSeq asks for the content of a version as it is now, and not at a seq.
const LiveSeq int64 = -1

var ErrAmbiguousPath = errors.New("ambiguous_path")

type AmbiguousPathError struct {
	Segment    string
	Candidates []Folder
}

func (e *AmbiguousPathError) Error() string        { return "ambiguous_path" }
func (e *AmbiguousPathError) Is(target error) bool { return target == ErrAmbiguousPath }

// Comment / transfer status values.
const (
	StatusOpen     = "open"
	StatusPending  = "pending"
	StatusAccepted = "accepted"
	StatusDeclined = "declined"
)

// Approval decision values. A document's derived approval status reuses these
// plus StatusPending.
const (
	DecisionApproved = "approved"
	DecisionRejected = "rejected"
)

// Approval event types, one per kind of change to a document's approvals. A
// new version is an event because it changes which decisions count without
// changing any decision.
const (
	ApprovalEventRequested      = "approval.requested"
	ApprovalEventRemoved        = "approval.removed"
	ApprovalEventApproved       = "approval.approved"
	ApprovalEventRejected       = "approval.rejected"
	ApprovalEventRevoked        = "approval.revoked"
	ApprovalEventVersionCreated = "approval.version_created"
)

// ApprovalEvent is a queued webhook event: Payload is the JSON body, and ID is
// its idempotency key.
type ApprovalEvent struct {
	ID       string
	Payload  []byte
	Attempts int
}

type Document struct {
	ID               string         `json:"id"`
	Title            string         `json:"title"`
	Owner            auth.Principal `json:"owner"`
	CurrentVersionID string         `json:"current_version_id"`
	// Seq is the sequence number of the live document. Lists do not set it.
	Seq            int64             `json:"seq,omitempty"`
	ParentFolderID string            `json:"parent_folder_id,omitempty"`
	ParentFolder   *FolderBreadcrumb `json:"parent_folder,omitempty"`
	// CanMove is set by GET /v1/documents/{id}: the caller may move it.
	CanMove   bool     `json:"can_move,omitempty"`
	UpdatedAt string   `json:"updated_at,omitempty"`
	Labels    []string `json:"labels,omitempty"`
	// Snippet is set in search results when the text matches. U+0002 and
	// U+0003 surround each match.
	Snippet string `json:"snippet,omitempty"`
	// ApprovalStatus and ApprovalSummary are handler-populated (like
	// ParentFolder) and only present when the document has assigned approvers.
	ApprovalStatus  string           `json:"approval_status,omitempty"`
	ApprovalSummary *ApprovalSummary `json:"approval_summary,omitempty"`
}

// ApprovalRequest names a principal the document owner wants a decision from.
// It is version-independent: the set of approvers survives new versions.
type ApprovalRequest struct {
	ID          string         `json:"id"`
	DocumentID  string         `json:"document_id"`
	Approver    auth.Principal `json:"approver"`
	RequestedBy auth.Principal `json:"requested_by"`
}

// Approval is one approver's decision on one content. It vouches for the
// content (SHA256), so every version with that content shows it. VersionID and
// VersionNumber name the version the approver decided on.
type Approval struct {
	ID            string         `json:"id"`
	DocumentID    string         `json:"document_id"`
	VersionID     string         `json:"version_id"`
	VersionNumber int            `json:"version_number"`
	SHA256        string         `json:"sha256"`
	Approver      auth.Principal `json:"approver"`
	Decision      string         `json:"decision"`
	// Note is the reviewer's explanation. Optional; a rejection without one
	// needs open comments by the reviewer instead.
	Note      string `json:"note,omitempty"`
	DecidedAt string `json:"decided_at,omitempty"`
}

// ApprovalSummary aggregates decisions from currently assigned approvers on
// one content. Status is derived, not stored: approved when everyone
// approved, rejected when anyone rejected, pending otherwise.
type ApprovalSummary struct {
	Total    int    `json:"total"`
	Approved int    `json:"approved"`
	Rejected int    `json:"rejected"`
	Pending  int    `json:"pending"`
	Status   string `json:"-"`
}

// DeriveApprovalStatus computes the aggregate status for a version given its
// decision counts. Returns "" when no approvers are assigned.
func DeriveApprovalStatus(total, approved, rejected int) string {
	switch {
	case total == 0:
		return ""
	case approved == total:
		return DecisionApproved
	case rejected > 0:
		return DecisionRejected
	default:
		return StatusPending
	}
}

type FolderBreadcrumb struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type Folder struct {
	ID             string             `json:"id"`
	Title          string             `json:"title"`
	Owner          auth.Principal     `json:"owner"`
	ParentFolderID string             `json:"parent_folder_id,omitempty"`
	Ancestors      []FolderBreadcrumb `json:"ancestors,omitempty"`
}

// FolderAccess is one element of a folder's ancestor chain annotated with a
// principal's effective role at that folder (RoleNone when they have no
// access at that level).
type FolderAccess struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Role  Role   `json:"role"`
}

// VisibleAncestors returns the breadcrumbs of the folder at the end of chain
// (root first). It keeps the ancestors nearest the folder up to the first one
// that the principal cannot view, so a breadcrumb shows no hidden title.
func VisibleAncestors(chain []FolderAccess) []FolderBreadcrumb {
	from := len(chain) - 1
	for from > 0 && chain[from-1].Role != RoleNone {
		from--
	}
	out := make([]FolderBreadcrumb, 0, len(chain)-1-from)
	for _, a := range chain[from : len(chain)-1] {
		out = append(out, FolderBreadcrumb{ID: a.ID, Title: a.Title})
	}
	return out
}

type FolderEntry struct {
	Type       string    `json:"type"`
	Folder     *Folder   `json:"folder,omitempty"`
	Document   *Document `json:"document,omitempty"`
	LastActive string    `json:"last_active,omitempty"`
}

// Page selects at most Limit items after the first Offset items of a list.
type Page struct {
	Limit  int32
	Offset int32
}

// DocumentSearch filters documents. All values are lowercase, and empty
// fields do not filter.
type DocumentSearch struct {
	Terms         []string // Every term is in the title or the text.
	ExcludedTerms []string // No term is in the title or the text.
	Owners        []string // The owner's ID, email, or email name is one of these.
	Folders       []string // A folder that holds the document has one of these titles or IDs.
	Labels        []string // The document has every label.
	UpdatedSince  time.Time
	UpdatedBefore time.Time
	// IncludeLabels controls response hydration only; Labels still filter
	// regardless of this value.
	IncludeLabels bool
}

type Pin struct {
	ResourceType string `json:"resource_type"`
	ResourceID   string `json:"resource_id"`
}

type AccessSource struct {
	ResourceType  string `json:"resource_type"`
	ResourceID    string `json:"resource_id"`
	ResourceTitle string `json:"resource_title"`
	Role          Role   `json:"role"`
	GrantID       string `json:"grant_id,omitempty"`
}
type EffectiveAccessItem struct {
	Principal     auth.Principal `json:"principal"`
	EffectiveRole Role           `json:"effective_role"`
	Sources       []AccessSource `json:"sources"`
}

// AccessRequest is a request for access to a document. A grant on the
// document to the requester removes it.
type AccessRequest struct {
	Requester   auth.Principal `json:"requester"`
	RequestedAt string         `json:"requested_at"`
}

// DocumentAccessRequest is an access request with the document that it asks
// for, for a list across documents.
type DocumentAccessRequest struct {
	AccessRequest
	DocumentID    string `json:"document_id"`
	DocumentTitle string `json:"document_title"`
}

type ServiceAccount struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Owner    auth.Principal `json:"owner"`
	Disabled bool           `json:"disabled"`
}

type ServiceAccountKey struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type OwnershipTransfer struct {
	ID               string `json:"id"`
	ServiceAccountID string `json:"service_account_id"`
	FromUserID       string `json:"from_user_id"`
	ToUserID         string `json:"to_user_id"`
	Status           string `json:"status"`
}

type Grant struct {
	ID           string         `json:"id"`
	DocumentID   string         `json:"document_id,omitempty"`
	ResourceType string         `json:"resource_type,omitempty"`
	ResourceID   string         `json:"resource_id,omitempty"`
	Principal    auth.Principal `json:"principal"`
	Role         Role           `json:"role"`
	GrantedBy    auth.Principal `json:"granted_by"`
}

type GoogleGroup struct {
	ID             string    `json:"id"`
	CustomerID     string    `json:"-"`
	Email          string    `json:"email"`
	Name           string    `json:"name"`
	LastVerifiedAt time.Time `json:"-"`
}

type GoogleGroupMembershipSnapshot struct {
	GroupIDs      []string
	LastAttemptAt time.Time
	LastSuccessAt time.Time
	LastErrorCode string
}

type Version struct {
	ID            string         `json:"id"`
	Number        int            `json:"number"`
	DocumentID    string         `json:"document_id"`
	CreatedBy     auth.Principal `json:"created_by"`
	ChangeSummary string         `json:"change_summary"`
	SHA256        string         `json:"sha256"`
	CreatedAt     string         `json:"created_at"`
	// EditedAt is the time of the last operation of the version, or
	// CreatedAt when the log holds none.
	EditedAt string `json:"edited_at"`
	// Open is set while people type in the version. Its content is then the
	// live document, and it has no SHA256 until it is sealed.
	Open bool `json:"open"`
	// Authors are the creator of the version and the people whose
	// operations it holds.
	Authors []auth.Principal `json:"authors"`
	// Seq is the seq of the content of the version. For the current version
	// it is the seq of the live document.
	Seq int64 `json:"-"`
}

// Operation is one write of the browser editor to the live document.
type Operation struct {
	// BaseSeq is the seq of the source that the replacements were made on.
	BaseSeq int64
	// ClientOpID names the operation, so that a retry applies nothing.
	ClientOpID   string
	Replacements []textedit.Replacement
	// Summary, when set, is a line for the change summary of the version.
	Summary string
}

// OperationResult tells the sender of an operation where the document is
// after it.
type OperationResult struct {
	Seq       int64  `json:"seq"`
	VersionID string `json:"version_id"`
	// Others are the operations that the document had after the base seq,
	// as they apply to the source that the sender made: the state at the base seq with its replacements. The
	// sender applies them in order, and then has the source at Seq.
	Others [][]textedit.Replacement `json:"others"`
	// Sum is the CRC-32 (IEEE) of the UTF-8 bytes of the source at Seq.
	Sum uint32 `json:"sum"`
	// Applied is the operation as it applied to the source at Seq - 1.
	Applied []textedit.Replacement `json:"-"`
	// Announced is set when the repository stored the document event of the
	// operation: the operation opened its version.
	Announced bool `json:"-"`
	// Repeated is set when the log held the operation already: this is a
	// retry, and the first attempt told the pages.
	Repeated bool `json:"-"`
}

// DocumentChanges tells how the live document differs from an earlier state.
type DocumentChanges struct {
	Seq       int64  `json:"seq"`
	VersionID string `json:"version_id"`
	// Ops are the operations after the earlier seq, in order. Each one is a
	// list of replacements on the source before it.
	Ops []json.RawMessage `json:"ops" swaggertype:"array,array,object"`
	// Typed is set when the browser editor made every one of them.
	Typed bool `json:"typed"`
	// Authors made those operations. The author of the newest comes first.
	Authors []auth.Principal `json:"authors"`
	// Sum is the CRC-32 (IEEE) of the UTF-8 bytes of the source at Seq.
	Sum uint32 `json:"sum"`
}

// DocumentPosition is the data of a document event: the seq of the live
// document and its current version.
type DocumentPosition struct {
	Seq       int64  `json:"seq"`
	VersionID string `json:"version_id"`
	// Sealed is set on the stored event of a seal: the seq and the version
	// can be the same as before, but History and the approvals changed.
	Sealed bool `json:"sealed,omitempty"`
	// Restored is set on the stored event of a restore: the document has the
	// content of an earlier version again.
	Restored bool `json:"restored,omitempty"`
	// Typed is set on the event of an operation of the browser editor. The
	// author of the event typed.
	Typed bool `json:"typed,omitempty"`
}

// SavedOn tells what SaveVersion saved a version on: the version before it,
// and whether the document had operations after the base of the change.
// Unchanged says that the change left the document as it is. SaveVersion
// then saved no version. It returns the version and the seq at which the
// document is the content of the caller: the live document when the content
// is the live document, and else the base of the caller. VersionID is that
// version too.
type SavedOn struct {
	VersionID string
	Rebased   bool
	Unchanged bool
}

// VersionChange makes the new content of a document from the content of the
// base version, with the change summary of the new version.
type VersionChange func(base []byte) (html []byte, summary string, err error)

// Upload is the change to html, whatever the base version holds.
func Upload(html []byte, summary string) VersionChange {
	return func([]byte) ([]byte, string, error) { return html, summary, nil }
}

// VersionPreview is what a link preview shows of a version besides its
// document's title and owner.
type VersionPreview struct {
	// Text is the start of what a reader sees in the version. It is empty
	// until the version is indexed.
	Text      string
	CreatedAt time.Time
}

type GitHubConnection struct {
	UserID                string `json:"-"`
	GitHubUserID          int64  `json:"github_user_id"`
	Login                 string `json:"login"`
	AvatarURL             string `json:"avatar_url,omitempty"`
	AccessTokenCiphertext []byte `json:"-"`
	UpdatedAt             string `json:"updated_at,omitempty"`
}

// GitHubAuthorAccess tells if one author of a document, who created a
// version or wrote an operation, can read a GitHub repository.
type GitHubAuthorAccess struct {
	Author auth.Principal
	// UserID is the user whose GitHub access counts for the author: the author,
	// or the owner of a service account.
	UserID string
	// AccessTokenCiphertext is empty when that user has no GitHub connection.
	AccessTokenCiphertext []byte
	// CanRead is nil when no fresh answer is cached.
	CanRead *bool
}

type Anchor struct {
	Quote       string `json:"quote"`
	Prefix      string `json:"prefix"`
	Suffix      string `json:"suffix"`
	DOMPath     string `json:"dom_path"`
	StartOffset int    `json:"start_offset"`
	EndOffset   int    `json:"end_offset"`
	// Point pins the comment to a spot in an element instead of to the quoted
	// text. The text fields then hold the start of the element's own text,
	// which finds the element again after the document changes.
	Point *AnchorPoint `json:"point,omitempty"`
}

// AnchorPoint is a spot in a rendered document: the element under it and
// fractions of that element's box, below 0 or above 1 for a spot outside the
// box. Target is the element's data-slashdocs-target value or id, when it has
// one. Path is the element's child-index path under the body, as live cursors
// name places. A point with neither is on the body. Label names the element
// for lists, such as an image's alt text, a section's heading, or its tag.
//
// PageX and PageY are the spot in CSS pixels from the top left of the page,
// in a viewport ViewportW pixels wide. They place the pin, marked as moved,
// in a version that no longer has the element. Old points do not have them.
type AnchorPoint struct {
	Target    string   `json:"target,omitempty"`
	Path      string   `json:"path,omitempty"`
	Label     string   `json:"label,omitempty"`
	X         float64  `json:"x"`
	Y         float64  `json:"y"`
	PageX     *float64 `json:"page_x,omitempty"`
	PageY     *float64 `json:"page_y,omitempty"`
	ViewportW *float64 `json:"viewport_w,omitempty"`
}

type CLICredential struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Comment struct {
	ID              string            `json:"id"`
	DocumentID      string            `json:"document_id"`
	VersionID       string            `json:"version_id"`
	Author          auth.Principal    `json:"author"`
	Body            string            `json:"body"`
	SelectedText    string            `json:"selected_text"`
	Anchor          Anchor            `json:"anchor"`
	Status          string            `json:"status"`
	ParentCommentID string            `json:"parent_comment_id,omitempty"`
	RootCommentID   string            `json:"root_comment_id,omitempty"`
	Mentions        []CommentMention  `json:"mentions"`
	Reactions       []CommentReaction `json:"reactions"`
	Replies         []Comment         `json:"replies,omitempty"`
	CreatedAt       string            `json:"created_at,omitempty"`
	ResolvedAt      string            `json:"resolved_at,omitempty"`
	Edited          bool              `json:"edited,omitempty"`
}

// FollowedAnchor is the anchor of a text comment, on the document at Seq.
type FollowedAnchor struct {
	CommentID string
	Anchor    Anchor
	Seq       int64
}

// CommentReaction is one principal's acknowledgement of a comment with one
// emoji slug. The repository returns the raw rows in first-reaction order;
// grouping them into per-emoji counts, and deciding whether the current
// viewer is among them, is a presentation concern and happens in the API
// layer rather than here.
type CommentReaction struct {
	Principal auth.Principal `json:"principal"`
	Emoji     string         `json:"emoji"`
}

// CommentMention associates an exact UTF-16 range in a comment body with a
// concrete user or service-account principal. UTF-16 matches JavaScript string
// indexing, which is where mention ranges originate. The association grants no
// access; future notification delivery must re-check effective document access
// and apply recipient/rate limits before sending anything.
type CommentMention struct {
	Principal   auth.Principal `json:"principal"`
	OffsetUTF16 int64          `json:"offset"`
	LengthUTF16 int64          `json:"length"`
	// LabelText is the internal snapshot of the exact visible @label. It is not
	// exposed on the API; clients render the authoritative body slice.
	LabelText string `json:"-"`
}

// CommentUpdate distinguishes omitted mentions from an explicit empty list.
// See the PostgreSQL implementation for preservation/replacement semantics.
type CommentUpdate struct {
	Body     *string
	Status   string
	Mentions *[]CommentMention
	// Anchor moves a point comment, or follows the text of a text comment.
	// Callers validate it.
	Anchor *Anchor
	// BaseBody, when set, is the body that the edit started from. The update
	// fails with ErrConflict when the body is no longer this.
	BaseBody *string
}

type DocumentKVSnapshot struct {
	Revision int64                      `json:"revision"`
	Items    map[string]json.RawMessage `json:"items"`
}

type DocumentKVChange struct {
	Key       string          `json:"key"`
	Value     json.RawMessage `json:"value,omitempty"`
	Deleted   bool            `json:"deleted,omitempty"`
	Revision  int64           `json:"revision"`
	UpdatedAt string          `json:"updated_at,omitempty"`
	UpdatedBy *auth.Principal `json:"updated_by,omitempty"`
	Operation string          `json:"operation,omitempty"`
}

type DocumentKVPatchResult struct {
	Revision  int64              `json:"revision"`
	Changes   []DocumentKVChange `json:"changes"`
	UpdatedBy *auth.Principal    `json:"updated_by,omitempty"`
}

// Kinds of events in a document's live event log. KV changes carry Changes;
// the other kinds share the KV revision sequence and carry optional Data.
// Cursor events are relayed but never stored, so they carry no revision.
const (
	DocumentEventKV        = "kv"
	DocumentEventDocument  = "document"
	DocumentEventComments  = "comments"
	DocumentEventApprovals = "approvals"
	DocumentEventPresence  = "presence"
	DocumentEventCursor    = "cursor"
	// DocumentEventAccess tells the open streams of a document that its
	// access changed. With no document, it tells all open streams. A stream
	// examines the access of its viewer then, and does not send the event on.
	DocumentEventAccess = "access"
)

type DocumentKVEvent struct {
	DocumentID string             `json:"document_id"`
	Revision   int64              `json:"revision"`
	Kind       string             `json:"kind"`
	Changes    []DocumentKVChange `json:"changes"`
	Data       json.RawMessage    `json:"data,omitempty"`
	UpdatedAt  string             `json:"updated_at,omitempty"`
	UpdatedBy  *auth.Principal    `json:"updated_by,omitempty"`
}

// Repository is the application persistence boundary, implemented by the
// PostgreSQL store in repo/postgres. Tests exercise that same implementation
// against a disposable database (see api/internal/testdb) rather than an
// in-memory fake, so test behaviour cannot drift from production.
type Repository interface {
	NotificationPreferences(ctx context.Context, principal auth.Principal, documentID string) (NotificationPreferences, error)
	SetNotificationPreferences(ctx context.Context, principal auth.Principal, documentID string, enabled bool) (NotificationPreferences, error)
	RequestDocumentAccess(ctx context.Context, principal auth.Principal, documentID string) error
	ListAccessRequests(ctx context.Context, documentID string, requester *auth.Principal) ([]AccessRequest, error)
	DeclineAccessRequest(ctx context.Context, documentID string, requester auth.Principal) error
	// ListManagedAccessRequests returns the requests for every document on
	// which the principal manages access, the newest first.
	ListManagedAccessRequests(ctx context.Context, principal auth.Principal) ([]DocumentAccessRequest, error)
	ResolveBearerToken(ctx context.Context, tokenHash string) (auth.Principal, error)
	ResolveUser(ctx context.Context, id string) (auth.Principal, error)
	// UpsertGoogleUser returns *EmailIdentityConflictError when the email
	// belongs to a user with another identity key.
	UpsertGoogleUser(ctx context.Context, id, email, name, googleSub, pictureURL string) (auth.Principal, error)
	// RelinkUserIdentity moves the user with identity key from to key to. It
	// returns ErrNotFound when no user has key from, or a user already has key to.
	RelinkUserIdentity(ctx context.Context, from, to string) error
	CreateCLICredential(ctx context.Context, userID, name, tokenHash string) (string, error)
	ListCLICredentials(ctx context.Context, userID string) ([]CLICredential, error)
	RevokeCLICredential(ctx context.Context, userID, credentialID string) error
	// RoleForDocument and RoleForFolder return the principal's effective role
	// on the resource. RoleNone (never an error) means the resource is missing
	// or unshared -- the same permission verdict either way; a non-nil error is
	// always a lookup fault, so handlers can map it to a 500 rather than a 403.
	RoleForDocument(ctx context.Context, principal auth.Principal, documentID string) (Role, error)
	RoleForFolder(ctx context.Context, principal auth.Principal, folderID string) (Role, error)
	// FolderAccessChain returns a folder's ancestor chain (root first, the
	// folder itself last) with the principal's effective role at each level,
	// resolved in one query. Returns ErrNotFound when the folder is missing.
	FolderAccessChain(ctx context.Context, principal auth.Principal, folderID string) ([]FolderAccess, error)
	// CreateDocument puts the document in the folder, or at the root when
	// folderID is empty. It returns ErrNotFound when the folder does not exist.
	CreateDocument(ctx context.Context, owner auth.Principal, title, folderID string, html []byte) (Document, Version, error)
	// ListDocuments and SearchDocuments return one page of documents, and
	// whether more documents follow it.
	ListDocuments(ctx context.Context, principal auth.Principal, page Page, includeLabels bool) ([]Document, bool, error)
	SearchDocuments(ctx context.Context, principal auth.Principal, search DocumentSearch, includeOrgWide bool, page Page) ([]Document, bool, error)
	// RecordDocumentOpened notes that a principal opened a document, so a
	// broadly-shared ("anyone") document joins their workspace listing after
	// first open. Idempotent.
	RecordDocumentOpened(ctx context.Context, documentID string, principal auth.Principal) error
	GetDocument(ctx context.Context, id string) (Document, error)
	UpdateDocument(ctx context.Context, id, title string) (Document, error)
	DeleteDocument(ctx context.Context, id string) error
	ListDocumentsByLabel(ctx context.Context, principal auth.Principal, label string) ([]Document, error)
	ListDocumentLabels(ctx context.Context, documentID string) ([]string, error)
	ReplaceDocumentLabels(ctx context.Context, documentID string, labels []string, actor auth.Principal) ([]string, error)
	UpsertGitHubConnection(ctx context.Context, connection GitHubConnection) error
	GetGitHubConnection(ctx context.Context, userID string) (GitHubConnection, error)
	DeleteGitHubConnection(ctx context.Context, userID string) error
	// ListGitHubAuthorAccess returns every principal who created a version of
	// the document or wrote an operation of it. Cached answers older than freshAfter are not returned.
	ListGitHubAuthorAccess(ctx context.Context, documentID, owner, repo string, freshAfter time.Time) ([]GitHubAuthorAccess, error)
	RecordGitHubRepoAccess(ctx context.Context, userID, owner, repo string, canRead bool) error
	CreateServiceAccount(ctx context.Context, owner auth.Principal, name string) (ServiceAccount, error)
	ListServiceAccounts(ctx context.Context, owner auth.Principal) ([]ServiceAccount, error)
	GetServiceAccount(ctx context.Context, id string) (ServiceAccount, error)
	GetServiceAccountByName(ctx context.Context, name string) (ServiceAccount, error)
	UpdateServiceAccount(ctx context.Context, id, name string, disabled *bool) (ServiceAccount, error)
	CreateServiceAccountKey(ctx context.Context, saID, name, tokenHash string) (string, error)
	ListServiceAccountKeys(ctx context.Context, saID string) ([]ServiceAccountKey, error)
	RevokeServiceAccountKey(ctx context.Context, saID, keyID string) error
	CreateOwnershipTransfer(ctx context.Context, saID string, from auth.Principal, toEmail string) (OwnershipTransfer, error)
	ListOwnershipTransfers(ctx context.Context, user auth.Principal) ([]OwnershipTransfer, error)
	AcceptOwnershipTransfer(ctx context.Context, id string, user auth.Principal) (OwnershipTransfer, error)
	DeclineOwnershipTransfer(ctx context.Context, id string, user auth.Principal) error
	PrincipalExists(ctx context.Context, principal auth.Principal) (bool, error)
	UserByEmail(ctx context.Context, email string) (auth.Principal, error)
	SearchUsersByEmail(ctx context.Context, query string) ([]auth.Principal, error)
	SearchContacts(ctx context.Context, caller auth.Principal, query string) ([]auth.Principal, error)
	EnsureUserByEmail(ctx context.Context, email string) (auth.Principal, error)
	GoogleGroupMembershipSnapshot(ctx context.Context, userID string) (GoogleGroupMembershipSnapshot, error)
	ReplaceGoogleGroupMemberships(ctx context.Context, userID string, groups []GoogleGroup, syncedAt time.Time) error
	RecordGoogleGroupMembershipFailure(ctx context.Context, userID, errorCode string, attemptedAt time.Time) error
	UpsertGoogleGroup(ctx context.Context, group GoogleGroup) error
	CreateGrant(ctx context.Context, resourceType, resourceID string, principal auth.Principal, role Role, grantedBy auth.Principal) (Grant, error)
	ListGrants(ctx context.Context, documentID string) ([]Grant, error)
	UpdateGrant(ctx context.Context, documentID, grantID string, role Role, updatedBy auth.Principal) (Grant, error)
	DeleteGrant(ctx context.Context, documentID, grantID string, deletedBy auth.Principal) error
	// AppendOperation moves the replacements of the operation over the
	// operations after its BaseSeq, applies them to the live document, and
	// stores the operation as it applied. The first operation after a sealed
	// version opens the next version. A second call with the same ClientOpID
	// applies nothing and gives the answer of the first, or ErrApplied when
	// the log no longer gives that answer. It returns
	// ErrNoSuchSeq for a BaseSeq after the live document, ErrStale for one
	// that the log no longer serves, a *textedit.ReplacementError for
	// replacements that do not fit the state at BaseSeq, ErrNotUTF8 when the
	// document is not valid UTF-8, and ErrTooLarge.
	AppendOperation(ctx context.Context, documentID string, op Operation, author auth.Principal) (OperationResult, error)
	// ChangesAfter returns the operations of the document after the seq
	// after. It returns ErrNoSuchSeq and ErrStale as AppendOperation does.
	ChangesAfter(ctx context.Context, documentID string, after int64) (DocumentChanges, error)
	// SaveVersion seals the open version, applies a change that is not
	// typing as one operation, and seals the result as the next version. The
	// change is made on the version baseVersionID at baseSeq, or on the
	// live document when baseVersionID is empty. The base of a sealed
	// version is its content, with no baseSeq or with the seq of the
	// version. With a baseSeq before the seq of the version, the base is
	// the state at baseSeq: the caller read the version while it was open.
	// That is also the base when the version is no longer there, because
	// its sitting changed nothing in the end.
	// With operations after the base, the change moves over them. A change
	// that leaves the document as it is saves no version.
	// It returns the new version and what it was saved on. It returns
	// ErrBaseVersion when baseVersionID is not a version of the document
	// and no baseSeq names a state, and a *VersionConflictError when the change and an operation after
	// its base change the same text. It returns ErrEditing when the base is
	// the open version with no baseSeq, and ErrStale for a baseSeq that the
	// log no longer serves. It returns ErrNotUTF8 and ErrTooLarge for the
	// new content.
	SaveVersion(ctx context.Context, documentID, baseVersionID string, baseSeq *int64, author auth.Principal, change VersionChange) (Version, SavedOn, error)
	// RestoreVersion is SaveVersion of html on the live document. The event
	// of the new version says that it is a restore.
	RestoreVersion(ctx context.Context, documentID string, html []byte, summary string, author auth.Principal) (Version, SavedOn, error)
	// ListVersions returns the versions of the document. The open version
	// has the change summary that a seal gives it now, and is not in the
	// list while its content is that of the version before.
	ListVersions(ctx context.Context, documentID string) ([]Version, error)
	GetVersion(ctx context.Context, id string) (Version, error)
	// LiveChangeSummary returns the open version of the document, and the
	// change summary that a seal gives it now. The summary is empty while
	// the content of the version is that of the version before. It returns
	// no version when the current version is sealed.
	LiveChangeSummary(ctx context.Context, documentID string) (versionID, summary string, err error)
	// GetVersionHTML returns the content of a version. For an open version
	// that is the live document. Every reader of version HTML uses it or
	// GetVersionHTMLAt, and no read seals a version.
	GetVersionHTML(ctx context.Context, id string) ([]byte, error)
	// GetVersionHTMLAt returns the source of a version at a seq, and that
	// seq. With LiveSeq it returns the content of the version and its seq.
	// It returns ErrStale for a seq that the version cannot serve.
	GetVersionHTMLAt(ctx context.Context, id string, seq int64) ([]byte, int64, error)
	// VersionPreview returns the start of a version's text, for link previews.
	// Returns ErrNotFound when the version is missing.
	VersionPreview(ctx context.Context, id string) (VersionPreview, error)
	// CreateComment makes a comment. A text anchor is on the document at
	// seq, and follows its text from there (see MoveAnchors).
	CreateComment(ctx context.Context, documentID, versionID, body string, anchor Anchor, seq int64, author auth.Principal, mentions []CommentMention) (Comment, error)
	// AnchorsBehind returns the text comments of the document whose anchors
	// are on a seq before the live document, with the anchor and that seq.
	AnchorsBehind(ctx context.Context, documentID string) ([]FollowedAnchor, error)
	// MoveAnchors gives each text comment of moves its anchor, on the
	// document at seq, when its anchor is still on the seq of the move.
	MoveAnchors(ctx context.Context, moves []FollowedAnchor, seq int64) error
	CreateCommentReply(ctx context.Context, documentID, parentCommentID, body string, author auth.Principal, mentions []CommentMention) (Comment, error)
	GetComment(ctx context.Context, id string) (Comment, error)
	ListComments(ctx context.Context, documentID, status, versionID string) ([]Comment, error)
	UpdateComment(ctx context.Context, id string, update CommentUpdate) (Comment, error)
	DeleteComment(ctx context.Context, id string) error
	PutCommentReaction(ctx context.Context, commentID string, principal auth.Principal, emoji string) error
	DeleteCommentReaction(ctx context.Context, commentID string, principal auth.Principal, emoji string) error
	// MarkCommentThreadRead sets the reader's read time of a thread to now.
	// Returns ErrNotFound when threadID is not a thread of the document.
	MarkCommentThreadRead(ctx context.Context, documentID, threadID string, reader auth.Principal) error
	// UnreadCommentThreads returns the ids of the document's threads that
	// have a message by someone else, newer than the reader's read time.
	UnreadCommentThreads(ctx context.Context, documentID string, reader auth.Principal) ([]string, error)
	ListDocumentKV(ctx context.Context, documentID string) (DocumentKVSnapshot, error)
	// CurrentDocumentKVRevision returns the high-water mark of the document's
	// event log.
	CurrentDocumentKVRevision(ctx context.Context, documentID string) (int64, error)
	ListDocumentKVEvents(ctx context.Context, documentID string, afterRevision int64, limit int32) ([]DocumentKVEvent, error)
	PatchDocumentKV(ctx context.Context, documentID string, set map[string]json.RawMessage, deleteKeys []string, actor auth.Principal) (DocumentKVPatchResult, error)
	// AppendDocumentEvent appends a non-KV live event (document, comments, or
	// presence) to the document's event log and wakes its subscribers.
	AppendDocumentEvent(ctx context.Context, documentID, kind string, data json.RawMessage, actor auth.Principal) error
	// ListDocumentPresence returns the presence events newer than maxAge.
	ListDocumentPresence(ctx context.Context, documentID string, maxAge time.Duration) ([]DocumentKVEvent, error)
	CreateFolder(ctx context.Context, owner auth.Principal, title, parentFolderID string) (Folder, error)
	ListFolder(ctx context.Context, principal auth.Principal, folderID, path string) ([]FolderEntry, bool, *Folder, error)
	SearchFoldersByTitle(ctx context.Context, principal auth.Principal, query string, includeOrgWide bool, minRole Role, limit int32) ([]Folder, error)
	RecordFolderOpened(ctx context.Context, folderID string, principal auth.Principal) error
	GetFolder(ctx context.Context, id string) (Folder, error)
	UpdateFolder(ctx context.Context, id, title string, parentFolderID *string) (Folder, error)
	DeleteFolder(ctx context.Context, id string, principal auth.Principal) error
	// FolderMayBroadenAccess reports whether content of owner placed in the
	// folder may become visible to others.
	FolderMayBroadenAccess(ctx context.Context, folderID string, owner auth.Principal) (bool, error)
	// MoveDocumentToFolder reports whether the move may broaden access.
	MoveDocumentToFolder(ctx context.Context, principal auth.Principal, folderID, documentID string) (bool, error)
	MoveDocumentToRoot(ctx context.Context, folderID, documentID string) error
	ListFolderDocuments(ctx context.Context, principal auth.Principal, folderID string) ([]Document, error)
	ListEffectiveAccess(ctx context.Context, resourceType, resourceID string) ([]EffectiveAccessItem, error)
	ListPins(ctx context.Context, principal auth.Principal) ([]Pin, error)
	PutPin(ctx context.Context, principal auth.Principal, resourceType, resourceID string) error
	DeletePin(ctx context.Context, principal auth.Principal, resourceType, resourceID string) error
	ListHiddenFeaturedItems(ctx context.Context, principal auth.Principal) ([]string, error)
	HideFeaturedItem(ctx context.Context, principal auth.Principal, resourceID string) error
	// CreateApprovalRequest assigns an approver; ErrConflict when already
	// assigned. It seals no version.
	// DeleteApprovalRequest removes the assignment and revokes all of that
	// approver's decisions on the document.
	CreateApprovalRequest(ctx context.Context, documentID string, approver, requestedBy auth.Principal) (ApprovalRequest, error)
	ListApprovalRequests(ctx context.Context, documentID string) ([]ApprovalRequest, error)
	DeleteApprovalRequest(ctx context.Context, documentID, requestID string, removedBy auth.Principal) error
	// CreateOrUpdateApproval seals the open version first: an approval is
	// for a sealed version. seq, when set, is the seq that the page of the
	// caller shows: it returns a *VersionConflictError when it is not the
	// seq of the live document. With no seq, the decision is on the live
	// document. It returns ErrEditing while the version is open and another
	// person typed a moment ago. A
	// decision on an open version that the seal removes, because it holds
	// the text of the version before, is for that version.
	// CreateOrUpdateApproval upserts the approver's decision on the content of
	// a version. The bool reports whether a new decision row was created
	// (false = replaced). ErrNotFound when the version is not part of the
	// document; a *VersionConflictError when the document's content changed
	// since that version; ErrForbidden when they are not an assigned approver.
	CreateOrUpdateApproval(ctx context.Context, documentID, versionID string, seq *int64, decision, note string, approver auth.Principal) (Approval, bool, error)
	// DeleteApproval revokes the approver's own decision; ErrForbidden when the
	// decision belongs to someone else.
	DeleteApproval(ctx context.Context, documentID, approvalID string, approver auth.Principal) error
	// ListApprovals returns the active decisions on the given content.
	ListApprovals(ctx context.Context, documentID, sha256 string) ([]Approval, error)
	// ListLatestApprovals returns each approver's most recent active decision
	// on any content of the document. Only Approver, SHA256, Decision and
	// DecidedAt are set.
	ListLatestApprovals(ctx context.Context, documentID string) ([]Approval, error)
	// DocumentApprovalSummaries batch-computes each document's approval summary
	// for its current content. Documents without assigned approvers are absent
	// from the result map.
	DocumentApprovalSummaries(ctx context.Context, documentIDs []string) (map[string]ApprovalSummary, error)
}
