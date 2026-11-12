package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/notifications"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// Slack link previews. A link gets the live card only on an org deployment,
// for a doc the whole org can open, in a conversation without outsiders;
// anything else, including errors, gets the neutral card.

const (
	slackSignatureMaxAge  = 5 * time.Minute
	slackMaxLinksPerEvent = 10
)

// verifySlackSignature lets a request through only if Slack signed it:
// HMAC-SHA256 of v0:{timestamp}:{body}.
func verifySlackSignature(secret string, now func() time.Time) gin.HandlerFunc {
	return func(c *gin.Context) {
		// requestBodyMiddleware already caps the body size.
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			badRequest(c, "could not read request body")
			return
		}
		timestamp := c.GetHeader("X-Slack-Request-Timestamp")
		sent, err := strconv.ParseInt(timestamp, 10, 64)
		age := now().Sub(time.Unix(sent, 0))
		if err != nil || age > slackSignatureMaxAge || age < -slackSignatureMaxAge {
			rejectSlackRequest(c)
			return
		}
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write([]byte("v0:" + timestamp + ":"))
		mac.Write(body)
		want := "v0=" + hex.EncodeToString(mac.Sum(nil))
		if !hmac.Equal([]byte(want), []byte(c.GetHeader("X-Slack-Signature"))) {
			rejectSlackRequest(c)
			return
		}
		c.Request.Body = io.NopCloser(bytes.NewReader(body))
		c.Next()
	}
}

func rejectSlackRequest(c *gin.Context) {
	c.AbortWithStatusJSON(http.StatusUnauthorized, errorResponse("unauthorized", "invalid or expired Slack signature", nil))
}

type slackEnvelope struct {
	Type           string         `json:"type"`
	Challenge      string         `json:"challenge"`
	Event          slackLinkEvent `json:"event"`
	Authorizations []struct {
		UserID string `json:"user_id"`
		IsBot  bool   `json:"is_bot"`
	} `json:"authorizations"`
}

type slackLinkEvent struct {
	Type      string `json:"type"`
	Channel   string `json:"channel"`
	User      string `json:"user"`
	MessageTS string `json:"message_ts"`
	UnfurlID  string `json:"unfurl_id"`
	Source    string `json:"source"`
	Links     []struct {
		URL string `json:"url"`
	} `json:"links"`
}

// slackEvents replies at once and builds cards afterwards, because Slack
// retries any event not answered within 3 seconds.
func (h handlers) slackEvents(c *gin.Context) {
	var env slackEnvelope
	if err := json.NewDecoder(c.Request.Body).Decode(&env); err != nil {
		badRequest(c, "invalid event payload")
		return
	}
	if env.Type == "url_verification" {
		c.JSON(http.StatusOK, gin.H{"challenge": env.Challenge})
		return
	}
	c.Status(http.StatusOK)
	// A retry means the first delivery already did the work.
	if env.Type != "event_callback" || env.Event.Type != "link_shared" ||
		c.GetHeader("X-Slack-Retry-Num") != "" || postedByThisBot(env) {
		return
	}
	event := env.Event
	event.Links = event.Links[:min(len(event.Links), slackMaxLinksPerEvent)]
	ctx, cancel := context.WithTimeout(context.WithoutCancel(c.Request.Context()), 10*time.Second)
	go func() {
		defer cancel()
		defer func() {
			if r := recover(); r != nil {
				slog.ErrorContext(ctx, "slack unfurl panicked", slog.Any("panic", r))
			}
		}()
		h.unfurlLinks(ctx, event)
	}()
}

// postedByThisBot guards against our own messages; Slack should not send them.
func postedByThisBot(env slackEnvelope) bool {
	for _, a := range env.Authorizations {
		if a.IsBot && a.UserID != "" && a.UserID == env.Event.User {
			return true
		}
	}
	return false
}

func (h handlers) unfurlLinks(ctx context.Context, event slackLinkEvent) {
	target := notifications.UnfurlTarget{Channel: event.Channel, TS: event.MessageTS, UnfurlID: event.UnfurlID, Source: event.Source}
	// Composer previews and failed lookups count as external.
	isExternal := sync.OnceValue(func() bool {
		if target.IsComposer() {
			return true
		}
		external, err := h.deps.slackUnfurler.IsExternalChannel(ctx, target.Channel)
		if err != nil {
			slog.WarnContext(ctx, "slack conversation lookup failed",
				slog.String("channel", target.Channel), slog.String("delivery_code", slackErrorCode(err)))
			return true
		}
		return external
	})
	unfurls := map[string]any{}
	var docIDs []string
	for _, link := range event.Links {
		docID, versionID, ok := h.parseSlashDocsLink(link.URL)
		if !ok {
			continue
		}
		unfurls[link.URL] = h.docUnfurl(ctx, docID, versionID, isExternal)
		docIDs = append(docIDs, docID)
	}
	if len(unfurls) == 0 {
		return
	}
	if err := h.deps.slackUnfurler.Unfurl(ctx, target, unfurls); err != nil {
		// Ids and the Slack error code only, never titles or summaries.
		slog.WarnContext(ctx, "slack unfurl failed", slog.String("channel", target.Channel),
			slog.Any("document_ids", docIDs), slog.String("delivery_code", slackErrorCode(err)))
	}
}

func slackErrorCode(err error) string {
	var de *notifications.DeliveryError
	if errors.As(err, &de) {
		return de.Code
	}
	return "internal"
}

// docUnfurl gives the neutral card on any failed lookup, so a live card never
// shows wrong facts.
func (h handlers) docUnfurl(ctx context.Context, docID, versionID string, isExternal func() bool) map[string]any {
	neutral := notifications.NeutralUnfurl()
	// Rule 1: on a public deployment "anyone" means anyone with a Google account.
	if h.deps.deployment != DeploymentOrg {
		return neutral
	}
	// Rule 2: the whole org can open it; folder grants count, and a missing doc is RoleNone.
	role, err := h.deps.repository.RoleForDocument(ctx, auth.Principal{Type: auth.PrincipalAnyone}, docID)
	if err != nil || !atLeast(role, repo.RoleViewer) {
		return neutral
	}
	// Rule 3: nobody from another organization is in the conversation.
	if isExternal() {
		return neutral
	}
	doc, err := h.deps.repository.GetDocument(ctx, docID)
	if err != nil {
		return neutral
	}
	card := notifications.DocCard{
		Title: doc.Title,
		URL:   notifications.DocumentURL(h.deps.appOrigin, docID),
		Owner: doc.Owner.Name,
	}
	if version, ok := h.shownVersion(ctx, doc, versionID); ok {
		html, err := h.deps.repository.GetVersionHTML(ctx, version.ID)
		if err != nil {
			return neutral
		}
		card.Version, card.HTML = version.Number, html
	} else if doc.CurrentVersionID != "" {
		return neutral
	}
	comments, err := h.deps.repository.ListComments(ctx, docID, "open", "")
	if err != nil {
		return neutral
	}
	// Replies are stored as open, so count threads.
	for _, cm := range comments {
		if cm.ParentCommentID == "" {
			card.OpenThreads++
		}
	}
	return notifications.LiveUnfurl(card)
}

// shownVersion is the ?version= version when it belongs to the doc, otherwise the current one.
func (h handlers) shownVersion(ctx context.Context, doc repo.Document, versionID string) (repo.Version, bool) {
	if versionID != "" {
		if v, err := h.deps.repository.GetVersion(ctx, versionID); err == nil && v.DocumentID == doc.ID {
			return v, true
		}
	}
	if doc.CurrentVersionID == "" {
		return repo.Version{}, false
	}
	v, err := h.deps.repository.GetVersion(ctx, doc.CurrentVersionID)
	return v, err == nil
}

var docIDPattern = regexp.MustCompile(`^doc_[a-z0-9]{1,64}$`)

// parseSlashDocsLink returns the doc and ?version= ids of a document link on
// the app origin or a previous origin.
func (h handlers) parseSlashDocsLink(raw string) (docID, versionID string, ok bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return "", "", false
	}
	origins := append([]string{h.deps.appOrigin}, h.deps.previousOrigins...)
	if !slices.ContainsFunc(origins, func(origin string) bool { return hostMatchesOrigin(u.Host, origin) }) {
		return "", "", false
	}
	path := strings.TrimSuffix(u.Path, "/")
	switch {
	case strings.HasPrefix(path, "/app/d/"):
		docID = strings.TrimPrefix(path, "/app/d/")
	case strings.HasPrefix(path, "/documents/"):
		docID = strings.TrimPrefix(path, "/documents/")
	default:
		return "", "", false
	}
	if !docIDPattern.MatchString(docID) {
		return "", "", false
	}
	return docID, u.Query().Get("version"), true
}
