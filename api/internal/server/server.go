package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/oauth2"

	"github.com/razorpay/aidocs/api/internal/auth"
	"github.com/razorpay/aidocs/api/internal/googlegroups"
	"github.com/razorpay/aidocs/api/internal/kvevents"
	"github.com/razorpay/aidocs/api/internal/notifications"
	"github.com/razorpay/aidocs/api/internal/repo"
)

// Config holds static configuration for the server.
type Config struct {
	Environment         string
	AppOrigin           string
	RenderOrigin        string
	OIDC                auth.OIDC
	OIDCProviderName    string
	SessionSecret       string
	AllowedOAuthDomains []string
	// Deployment is "public" or "org". OrgName labels the org in UI copy.
	Deployment string
	OrgName    string
	// DefaultDocPermission is the role granted to the "anyone" principal on
	// newly created documents when the request does not override it via the
	// default_permission form field. repo.RoleNone means private: no grant.
	DefaultDocPermission      repo.Role
	GitHubClientID            string
	GitHubClientSecret        string
	GoogleGroupsEnabled       bool
	GoogleGroupsMembershipTTL time.Duration
	GoogleGroupsRetryCooldown time.Duration
	// DisableLabels and DisableSearchTags are temporary rollout switches. They
	// default to false so programmatic users of server.New retain the existing
	// feature set unless the application entrypoint explicitly disables them.
	DisableLabels     bool
	DisableSearchTags bool
}

// Server wraps the gin engine.
type Server struct {
	engine             *gin.Engine
	notificationWorker *notifications.Worker
}

type readinessCheck struct {
	name string
	fn   func(context.Context) error
}

type dependencies struct {
	commentNotificationSender notifications.Sender
	authenticator             auth.Authenticator
	repository                repo.Repository
	stateStore                auth.LoginStateStore
	oidc                      auth.OIDC
	oidcProviderName          string
	sessionSecret             string
	appOrigin                 string
	renderOrigin              string
	allowedOAuthDomains       []string
	deployment                string
	orgName                   string
	defaultDocPermission      repo.Role
	readinessChecks           []readinessCheck
	documentKVEvents          kvevents.Subscriber
	githubOAuth               *oauth2.Config
	githubHTTPClient          *http.Client
	googleGroupsEnabled       bool
	googleGroupDirectory      googlegroups.GoogleGroupDirectory
	googleGroupResolver       *googlegroups.Resolver
	labelsEnabled             bool
	searchTagsEnabled         bool
}

// Option configures the Server.
type Option func(*dependencies)

func WithAuthenticator(a auth.Authenticator) Option {
	return func(d *dependencies) { d.authenticator = a }
}

func WithCommentNotificationSender(sender notifications.Sender) Option {
	return func(d *dependencies) { d.commentNotificationSender = sender }
}

func (s *Server) RunCommentNotifications(ctx context.Context) {
	if s.notificationWorker != nil {
		s.notificationWorker.Run(ctx)
	}
}

func WithRepository(r repo.Repository) Option { return func(d *dependencies) { d.repository = r } }

func WithGoogleGroupDirectory(directory googlegroups.GoogleGroupDirectory) Option {
	return func(d *dependencies) { d.googleGroupDirectory = directory }
}

// WithDocumentKVEvents supplies the process-wide persisted-event broker used
// by document KV SSE streams.
func WithDocumentKVEvents(events kvevents.Subscriber) Option {
	return func(d *dependencies) { d.documentKVEvents = events }
}

func WithStateStore(st auth.LoginStateStore) Option {
	return func(d *dependencies) { d.stateStore = st }
}

func WithReadinessCheck(name string, fn func(context.Context) error) Option {
	return func(d *dependencies) {
		if name != "" && fn != nil {
			d.readinessChecks = append(d.readinessChecks, readinessCheck{name: name, fn: fn})
		}
	}
}

// denyAllAuthenticator rejects every request. It is the default authenticator,
// so a server constructed without WithAuthenticator denies all requests instead
// of silently trusting them.
type denyAllAuthenticator struct{}

func (denyAllAuthenticator) Authenticate(_ *http.Request) (*auth.Principal, error) {
	return nil, auth.ErrUnauthorized
}

// New constructs and returns a configured Server. The authenticator defaults to
// one that denies every request, and a repository must be supplied via
// WithRepository outside of tests.
func New(cfg Config, opts ...Option) *Server {
	gin.SetMode(gin.ReleaseMode)
	deps := dependencies{
		authenticator:        denyAllAuthenticator{},
		stateStore:           auth.NewStateStore(),
		oidc:                 cfg.OIDC,
		oidcProviderName:     cfg.OIDCProviderName,
		sessionSecret:        cfg.SessionSecret,
		appOrigin:            cfg.AppOrigin,
		renderOrigin:         cfg.RenderOrigin,
		allowedOAuthDomains:  cfg.AllowedOAuthDomains,
		deployment:           cfg.Deployment,
		orgName:              cfg.OrgName,
		defaultDocPermission: cfg.DefaultDocPermission,
		githubHTTPClient:     http.DefaultClient,
		googleGroupsEnabled:  cfg.GoogleGroupsEnabled,
		labelsEnabled:        !cfg.DisableLabels,
		searchTagsEnabled:    !cfg.DisableSearchTags,
	}
	if cfg.GitHubClientID != "" && cfg.GitHubClientSecret != "" && cfg.AppOrigin != "" {
		deps.githubOAuth = &oauth2.Config{
			ClientID: cfg.GitHubClientID, ClientSecret: cfg.GitHubClientSecret,
			//nolint:gosec // G101 matches on the "access_token" path segment; these are GitHub's public OAuth endpoint URLs, not credentials.
			Endpoint:    oauth2.Endpoint{AuthURL: "https://github.com/login/oauth/authorize", TokenURL: "https://github.com/login/oauth/access_token"},
			RedirectURL: strings.TrimRight(cfg.AppOrigin, "/") + "/v1/integrations/github/callback",
			Scopes:      []string{"repo", "read:user"},
		}
	}
	for _, opt := range opts {
		opt(&deps)
	}
	// Missing storage is a startup wiring bug, not a recoverable request error.
	if deps.repository == nil {
		panic("server.New: repository is required (use server.WithRepository)")
	}
	if deps.documentKVEvents == nil {
		// Do not create an unowned background broker for programmatic callers.
		deps.documentKVEvents = unavailableDocumentKVEvents{}
	}
	if deps.googleGroupsEnabled && deps.googleGroupDirectory != nil {
		deps.googleGroupResolver = googlegroups.NewResolver(googlegroups.ResolverConfig{
			Store: deps.repository, Directory: deps.googleGroupDirectory,
			TTL: cfg.GoogleGroupsMembershipTTL, RetryCooldown: cfg.GoogleGroupsRetryCooldown,
			Observer: observeGoogleGroupMembership,
		})
	}
	r := gin.New()
	r.RedirectTrailingSlash = false
	r.Use(requestIDMiddleware())
	if cfg.Environment != envTest {
		r.Use(accessLogMiddleware())
	}
	r.Use(recoveryMiddleware())
	r.Use(prometheusMiddleware())
	s := &Server{engine: r}
	if deps.commentNotificationSender != nil {
		store, ok := deps.repository.(notifications.Store)
		if !ok {
			panic("notification sender requires an outbox store")
		}
		s.notificationWorker = &notifications.Worker{Store: store, Sender: deps.commentNotificationSender, AppOrigin: deps.appOrigin}
		if deps.googleGroupResolver != nil {
			s.notificationWorker.ResolvePrincipal = deps.googleGroupResolver.Resolve
		}
	}
	s.routes(deps)
	return s
}

type unavailableDocumentKVEvents struct{}

func (unavailableDocumentKVEvents) Subscribe(context.Context, string) (<-chan repo.DocumentKVEvent, func(), error) {
	return nil, func() {}, errors.New("repository does not support document KV event streaming")
}

func (s *Server) Handler() http.Handler { return s.engine }

func (s *Server) routes(deps dependencies) {
	h := handlers{deps: deps}
	s.engine.GET("/.well-known/aidocs.json", h.discovery)
	s.engine.GET("/.well-known/oauth-protected-resource", h.mcpProtectedResourceMetadata)
	s.engine.GET("/.well-known/oauth-protected-resource/mcp", h.mcpProtectedResourceMetadata)
	s.engine.GET("/.well-known/oauth-authorization-server", h.mcpAuthorizationServerMetadata)
	s.engine.POST("/oauth/register", h.mcpRegisterClient)
	s.engine.POST("/oauth/token", h.mcpToken)
	mcpOAuth := s.engine.Group("/oauth", requireAuth(deps.authenticator, deps.appOrigin, deps.googleGroupResolver))
	mcpOAuth.GET("/authorize", h.mcpAuthorize)
	mcpOAuth.POST("/authorize", h.mcpAuthorize)
	registerMCPRoutes(s.engine, deps)
	s.engine.GET("/commit.txt", h.commitTXT)
	s.engine.GET("/version.json", h.versionJSON)
	s.engine.GET("/install.sh", h.installScript)
	s.engine.GET("/skills/:name/SKILL.md", h.downloadSkill)
	s.engine.GET("/cli/:os/:arch", h.downloadCLI)
	registerAPIDocsRoutes(s.engine, deps)
	s.engine.GET("/v/:id/:version_id", h.renderVersion)
	s.engine.GET("/print/:id/:version_id", h.renderPrintVersion)
	registerFrontendRoutes(s.engine, deps.appOrigin)

	s.engine.GET("/livez", h.livez)
	s.engine.GET("/readyz", h.readyz)

	v1 := s.engine.Group("/v1")
	v1.GET("/config", h.config)
	// The /auth/google/* paths predate generic OIDC support and stay
	// registered so existing Google redirect URIs, CLIs, and bookmarks keep
	// working; /auth/oidc/* is the provider-neutral spelling.
	v1.GET("/auth/google/start", h.oauthStart)
	v1.GET("/auth/google/callback", h.oauthCallback)
	v1.GET("/auth/oidc/start", h.oauthStart)
	v1.GET("/auth/oidc/callback", h.oauthCallback)
	v1.POST("/auth/cli/exchange", h.cliExchange)

	// Every route below requires authentication.
	authed := v1.Group("", requireAuth(deps.authenticator, deps.appOrigin, deps.googleGroupResolver))
	activityLimit := activityRateLimit()
	authed.GET("/me", h.me)
	authed.GET("/users", h.searchUsers)
	authed.GET("/google-groups", h.searchGoogleGroups)
	authed.GET("/auth/cli/credentials", h.listCLICredentials)
	authed.DELETE("/auth/cli/credentials/:id", h.revokeCLICredential)
	authed.POST("/service-accounts", h.createServiceAccount)
	authed.GET("/service-accounts", h.listServiceAccounts)
	authed.PATCH("/service-accounts/:id", h.patchServiceAccount)
	authed.POST("/service-accounts/:id/keys", h.createServiceAccountKey)
	authed.GET("/service-accounts/:id/keys", h.listServiceAccountKeys)
	authed.DELETE("/service-accounts/:id/keys/:key_id", h.revokeServiceAccountKey)
	authed.POST("/service-accounts/:id/transfer", h.createOwnershipTransfer)
	authed.GET("/service-accounts/transfers", h.listOwnershipTransfers)
	authed.POST("/service-accounts/transfers/:id/accept", h.acceptOwnershipTransfer)
	authed.POST("/service-accounts/transfers/:id/decline", h.declineOwnershipTransfer)
	authed.POST("/documents", h.createDocument)
	authed.GET("/documents", h.listDocuments)
	authed.GET("/documents/:id", h.getDocument)
	authed.POST("/documents/:id/access-requests", activityLimit, h.requestDocumentAccess)
	authed.GET("/documents/:id/access", h.documentAccess)
	authed.PATCH("/documents/:id", h.patchDocument)
	authed.DELETE("/documents/:id", h.deleteDocument)
	authed.POST("/documents/:id/grants", h.createGrant)
	authed.PATCH("/documents/:id/grants/:grant_id", h.patchGrant)
	authed.DELETE("/documents/:id/grants/:grant_id", h.deleteGrant)
	authed.POST("/documents/:id/versions", h.createVersion)
	authed.GET("/documents/:id/versions", h.listVersions)
	authed.GET("/documents/:id/versions/:version_id", h.getVersion)
	authed.GET("/documents/:id/versions/:version_id/html", h.getVersionHTML)
	authed.POST("/documents/:id/versions/:version_id/render-token", h.createRenderToken)
	authed.POST("/documents/:id/versions/:version_id/print-token", h.createPrintToken)
	authed.GET("/documents/:id/labels", h.listDocumentLabels)
	authed.PUT("/documents/:id/labels", h.replaceDocumentLabels)
	authed.POST("/documents/:id/github/raw", h.githubRawContent)
	authed.POST("/documents/:id/comments", h.createComment)
	authed.GET("/documents/:id/comments", h.listComments)
	authed.GET("/me/notifications", activityLimit, h.notificationPreferences)
	authed.PUT("/me/notifications", activityLimit, h.setNotificationPreferences)
	authed.GET("/documents/:id/notifications", activityLimit, h.documentNotificationPreferences)
	authed.GET("/documents/:id/headings", activityLimit, h.documentHeadings)
	authed.GET("/documents/:id/link", activityLimit, h.documentLink)
	authed.PUT("/documents/:id/notifications", activityLimit, h.setDocumentNotificationPreferences)
	authed.GET("/documents/:id/kv", h.listDocumentKV)
	authed.GET("/documents/:id/kv/events", h.streamDocumentKVEvents)
	authed.PATCH("/documents/:id/kv", h.patchDocumentKV)
	authed.POST("/documents/:id/comments/:comment_id/replies", h.createCommentReply)
	authed.PATCH("/documents/:id/comments/:comment_id", h.patchComment)
	authed.DELETE("/documents/:id/comments/:comment_id", h.deleteComment)
	authed.PUT("/documents/:id/comments/:comment_id/reactions/:emoji", h.putCommentReaction)
	authed.DELETE("/documents/:id/comments/:comment_id/reactions/:emoji", h.deleteCommentReaction)
	authed.POST("/folders", h.createFolder)
	authed.GET("/folders", h.listFolders)
	authed.GET("/folders/:id", h.getFolder)
	authed.PATCH("/folders/:id", h.patchFolder)
	authed.DELETE("/folders/:id", h.deleteFolder)
	authed.GET("/folders/:id/access", h.folderAccess)
	authed.POST("/folders/:id/grants", h.createFolderGrant)
	authed.PATCH("/folders/:id/grants/:grant_id", h.patchFolderGrant)
	authed.DELETE("/folders/:id/grants/:grant_id", h.deleteFolderGrant)
	authed.GET("/folders/:id/documents", h.listFolderDocs)
	authed.POST("/folders/:id/documents", h.moveDocToFolder)
	authed.DELETE("/folders/:id/documents/:doc_id", h.moveDocToRoot)
	authed.GET("/pins", h.listPins)
	authed.PUT("/pins/:resource_type/:resource_id", h.putPin)
	authed.DELETE("/pins/:resource_type/:resource_id", h.deletePin)
	authed.GET("/integrations/github", h.githubStatus)
	authed.GET("/integrations/github/start", h.githubOAuthStart)
	authed.GET("/integrations/github/callback", h.githubOAuthCallback)
	authed.DELETE("/integrations/github", h.githubDisconnect)
}

type handlers struct{ deps dependencies }

const principalContextKey = "principal"

func (h handlers) needDocRole(c *gin.Context, docID string, need repo.Role) bool {
	role, err := h.deps.repository.RoleForDocument(c.Request.Context(), *current(c), docID)
	if err != nil {
		// A lookup failure is a server fault, not a permission verdict.
		internalErr(c, err)
		return false
	}
	if !atLeast(role, need) {
		if groupMembershipUnavailable(current(c)) {
			groupMembershipUnavailableResponse(c)
			return false
		}
		forbidden(c, string(need)+" role required")
		return false
	}
	return true
}

func requireAuth(a auth.Authenticator, appOrigin string, groups *googlegroups.Resolver) gin.HandlerFunc {
	return func(c *gin.Context) {
		p, err := a.Authenticate(c.Request)
		if err != nil {
			incAuth("request", "failure")
			if wantsBrowserLogin(c) {
				redirect := c.Request.URL.RequestURI()
				if !safeWebRedirect(redirect) {
					redirect = "/"
				}
				c.Abort()
				c.Redirect(http.StatusFound, "/v1/auth/google/start?mode=web&redirect="+url.QueryEscape(redirect))
				return
			}
			c.AbortWithStatusJSON(http.StatusUnauthorized, errorResponse("unauthorized", "authentication required", nil))
			return
		}
		if !allowCookieUnsafeRequest(c, appOrigin) {
			incAuth("request", "failure")
			c.Abort()
			forbidden(c, "csrf check failed")
			return
		}
		if groups != nil {
			p = groups.Resolve(c.Request.Context(), p)
		}
		incAuth("request", "success")
		c.Set(principalContextKey, p)
		c.Next()
	}
}

func groupMembershipUnavailable(p *auth.Principal) bool {
	return p != nil && p.Type == auth.PrincipalUser && p.GoogleGroupMembershipState == auth.GoogleGroupMembershipUnavailable
}

func groupMembershipUnavailableResponse(c *gin.Context) {
	incGoogleGroupAuthorizationFailure()
	c.JSON(http.StatusServiceUnavailable, errorResponse(
		"group_membership_unavailable",
		"Google Group membership could not be refreshed; try again shortly",
		nil,
	))
}

func requireResolvedGroupsForAggregate(c *gin.Context) bool {
	if groupMembershipUnavailable(current(c)) {
		groupMembershipUnavailableResponse(c)
		return false
	}
	return true
}

func allowCookieUnsafeRequest(c *gin.Context, appOrigin string) bool {
	switch c.Request.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return true
	}
	if auth.BearerFromHeader(c.GetHeader("Authorization")) != "" {
		return true
	}
	if _, err := c.Request.Cookie(sessionCookieName); err != nil {
		return true
	}
	if appOrigin == "" {
		return true
	}
	if origin := c.GetHeader("Origin"); origin != "" {
		return sameHTTPOrigin(origin, appOrigin)
	}
	if referer := c.GetHeader("Referer"); referer != "" {
		return sameHTTPOrigin(referer, appOrigin)
	}
	return false
}

func wantsBrowserLogin(c *gin.Context) bool {
	if c.Request.Method != http.MethodGet {
		return false
	}
	accept := c.GetHeader("Accept")
	return strings.Contains(accept, "text/html") && !strings.Contains(accept, "application/json")
}

func current(c *gin.Context) *auth.Principal {
	p, ok := c.Get(principalContextKey)
	if !ok {
		return nil
	}
	principal, _ := p.(*auth.Principal)
	return principal
}

var errPayloadTooLarge = errors.New("payload too large")

const maxHTMLBytes = 50 * 1024 * 1024

func readMultipartFile(c *gin.Context, field string) ([]byte, error) {
	f, err := c.FormFile(field)
	if err != nil {
		return nil, err
	}
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = rc.Close()
	}()
	b, err := io.ReadAll(io.LimitReader(rc, maxHTMLBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxHTMLBytes {
		return nil, errPayloadTooLarge
	}
	return b, nil
}
