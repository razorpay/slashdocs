package server

import "time"

// Cookie / session
const (
	sessionCookieName = "slashdocs_session"
	sessionTTLSeconds = int(30 * 24 * time.Hour / time.Second) // 30 days
)

// Auth modes
const (
	authModeWeb = "web"
	authModeCLI = "cli"
)

// Deployment types. A public deployment lets anyone who can authenticate with
// the identity provider in; an org deployment gates login to the org's
// domains. The only authz difference is the login gate — the document ACL is
// identical.
const (
	DeploymentPublic = "public"
	DeploymentOrg    = "org"
)

// Comment / transfer statuses
const (
	commentStatusAll      = "all"
	commentStatusOpen     = "open"
	commentStatusResolved = "resolved"
	// commentMentionsMediaType is a rolling-upgrade sentinel: old servers reject
	// it before writing, so structured metadata can never be silently dropped.
	commentMentionsMediaType = "application/vnd.slashdocs.comment-mentions+json"
	// legacyCommentMentionsMediaType is the same sentinel as sent by clients
	// released before the rename from aidocs.
	legacyCommentMentionsMediaType = "application/vnd.aidocs.comment-mentions+json"
)

// Comment placement statuses relative to the rendered version.
const (
	placementAttached = "attached"
	placementOrphaned = "orphaned"
)

// Render audience prefix used in render tokens.
const renderAudiencePrefix = "render:"

// labelUnknown is the metric label value used when a dimension is not
// meaningful for an event (e.g. a comment's status after it is deleted).
const labelUnknown = "unknown"

// User IDs are minted from the OIDC subject. Google subjects keep the
// historical usr_google_ prefix so accounts created before generic OIDC
// support resolve to the same user.
const (
	googleUserIDPrefix = "usr_google_"
	oidcUserIDPrefix   = "usr_oidc_"
)

// Environment values for Config.Environment.
const (
	EnvProduction = "production"
	envTest       = "test"
)

// Retry bounds for allocating a unique service-account name.
const (
	saNameMaxAttempts         = 8
	saNameShortDomainAttempts = 5
)
