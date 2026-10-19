package repo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
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

// ErrVersionConflict indicates an optimistic-concurrency failure when creating
// a new version: the supplied base_version_id is stale. The concrete error
// returned is a *VersionConflictError carrying the latest version id; callers
// can match it with errors.Is(err, ErrVersionConflict) or extract details with
// errors.As(&VersionConflictError{}).
var ErrVersionConflict = errors.New("version_conflict")

// VersionConflictError carries the current/latest version id alongside the
// sentinel ErrVersionConflict.
type VersionConflictError struct {
	LatestVersionID string
}

func (e *VersionConflictError) Error() string        { return "version_conflict" }
func (e *VersionConflictError) Is(target error) bool { return target == ErrVersionConflict }

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

type Document struct {
	ID               string            `json:"id"`
	Title            string            `json:"title"`
	Owner            auth.Principal    `json:"owner"`
	CurrentVersionID string            `json:"current_version_id"`
	ParentFolderID   string            `json:"parent_folder_id,omitempty"`
	ParentFolder     *FolderBreadcrumb `json:"parent_folder,omitempty"`
	UpdatedAt        string            `json:"updated_at,omitempty"`
	Labels           []string          `json:"labels,omitempty"`
	// Snippet is set in search results when the text matches. U+0002 and
	// U+0003 surround each match.
	Snippet string `json:"snippet,omitempty"`
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

type FolderEntry struct {
	Type       string    `json:"type"`
	Folder     *Folder   `json:"folder,omitempty"`
	Document   *Document `json:"document,omitempty"`
	LastActive string    `json:"last_active,omitempty"`
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
}

type GitHubConnection struct {
	UserID                string `json:"-"`
	GitHubUserID          int64  `json:"github_user_id"`
	Login                 string `json:"login"`
	AvatarURL             string `json:"avatar_url,omitempty"`
	AccessTokenCiphertext []byte `json:"-"`
	UpdatedAt             string `json:"updated_at,omitempty"`
}

// GitHubAuthorAccess tells if one version creator of a document can read a
// GitHub repository.
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
	EditedAt        string            `json:"edited_at,omitempty"`
	ResolvedAt      string            `json:"resolved_at,omitempty"`
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
	DocumentEventKV       = "kv"
	DocumentEventDocument = "document"
	DocumentEventComments = "comments"
	DocumentEventPresence = "presence"
	DocumentEventCursor   = "cursor"
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
	ResolveBearerToken(ctx context.Context, tokenHash string) (auth.Principal, error)
	ResolveUser(ctx context.Context, id string) (auth.Principal, error)
	UpsertGoogleUser(ctx context.Context, id, email, name, googleSub, pictureURL string) (auth.Principal, error)
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
	CreateDocument(ctx context.Context, owner auth.Principal, title string, html []byte) (Document, Version, error)
	ListDocuments(ctx context.Context, principal auth.Principal) ([]Document, error)
	SearchDocuments(ctx context.Context, principal auth.Principal, search DocumentSearch, includeOrgWide bool, limit int32) ([]Document, error)
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
	// the document. Cached answers older than freshAfter are not returned.
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
	CreateVersion(ctx context.Context, documentID, baseVersionID, changeSummary string, html []byte, createdBy auth.Principal) (Version, error)
	ListVersions(ctx context.Context, documentID string) ([]Version, error)
	GetVersion(ctx context.Context, id string) (Version, error)
	GetVersionHTML(ctx context.Context, id string) ([]byte, error)
	CreateComment(ctx context.Context, documentID, versionID, body string, anchor Anchor, author auth.Principal, mentions []CommentMention) (Comment, error)
	CreateCommentReply(ctx context.Context, documentID, parentCommentID, body string, author auth.Principal, mentions []CommentMention) (Comment, error)
	GetComment(ctx context.Context, id string) (Comment, error)
	ListComments(ctx context.Context, documentID, status, versionID string) ([]Comment, error)
	UpdateComment(ctx context.Context, id string, update CommentUpdate) (Comment, error)
	DeleteComment(ctx context.Context, id string) error
	PutCommentReaction(ctx context.Context, commentID string, principal auth.Principal, emoji string) error
	DeleteCommentReaction(ctx context.Context, commentID string, principal auth.Principal, emoji string) error
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
	SearchFoldersByTitle(ctx context.Context, principal auth.Principal, query string, includeOrgWide bool, limit int32) ([]Folder, error)
	RecordFolderOpened(ctx context.Context, folderID string, principal auth.Principal) error
	GetFolder(ctx context.Context, id string) (Folder, error)
	UpdateFolder(ctx context.Context, id, title string, parentFolderID *string) (Folder, error)
	DeleteFolder(ctx context.Context, id string, principal auth.Principal) error
	FolderHasGrants(ctx context.Context, folderID string) (bool, error)
	MoveDocumentToFolder(ctx context.Context, principal auth.Principal, folderID, documentID string) (bool, error)
	MoveDocumentToRoot(ctx context.Context, folderID, documentID string) error
	ListFolderDocuments(ctx context.Context, principal auth.Principal, folderID string) ([]Document, error)
	ListEffectiveAccess(ctx context.Context, resourceType, resourceID string) ([]EffectiveAccessItem, error)
	ListPins(ctx context.Context, principal auth.Principal) ([]Pin, error)
	PutPin(ctx context.Context, principal auth.Principal, resourceType, resourceID string) error
	DeletePin(ctx context.Context, principal auth.Principal, resourceType, resourceID string) error
	ListHiddenFeaturedItems(ctx context.Context, principal auth.Principal) ([]string, error)
	HideFeaturedItem(ctx context.Context, principal auth.Principal, resourceID string) error
}
