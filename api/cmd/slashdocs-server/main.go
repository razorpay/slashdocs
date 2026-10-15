package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/oauth2/google"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/blob"
	"github.com/razorpay/slashdocs/api/internal/db"
	"github.com/razorpay/slashdocs/api/internal/googlegroups"
	"github.com/razorpay/slashdocs/api/internal/kvevents"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/server"
)

// HTTP server timeouts. WriteTimeout is deliberately absent (zero): the KV
// event stream holds SSE responses open indefinitely, and a write deadline
// would sever them.
const (
	readHeaderTimeout = 10 * time.Second
	readTimeout       = 60 * time.Second
	idleTimeout       = 120 * time.Second
	shutdownTimeout   = 15 * time.Second
)

// @title slashdocs API
// @version v1
// @description This API powers slashdocs, a collaborative workspace where agents and people publish self-contained HTML documents, comment on specific text ranges inside them, and publish new versions.
// @BasePath /
// @securityDefinitions.apikey cookieAuth
// @in cookie
// @name slashdocs_session
// @securityDefinitions.apikey bearerAuth
// @in header
// @name Authorization
func main() {
	slog.SetDefault(slog.New(newLogHandler(os.Stderr)))
	if err := run(); err != nil {
		slog.Error("server exiting", slog.Any("error", err))
		os.Exit(1)
	}
}

// newLogHandler picks the log format: human-readable text on a terminal
// (local development), JSON otherwise (production, where logs feed a
// structured pipeline).
func newLogHandler(f *os.File) slog.Handler {
	if info, err := f.Stat(); err == nil && info.Mode()&os.ModeCharDevice != 0 {
		return slog.NewTextHandler(f, nil)
	}
	return slog.NewJSONHandler(f, nil)
}

func run() error {
	if err := server.ValidateEmbeddedBridge(); err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	databaseURL, err := requiredEnv("DATABASE_URL")
	if err != nil {
		return err
	}
	kvEventsMode, err := kvevents.ParseMode(os.Getenv("SLASHDOCS_KV_EVENTS_MODE"))
	if err != nil {
		return err
	}
	if os.Getenv("SLASHDOCS_MIGRATE") != "false" {
		if err := db.Migrate(databaseURL); err != nil {
			return err
		}
	}
	blobs, err := newBlobStore(ctx)
	if err != nil {
		return err
	}
	store, err := pgrepo.ConnectWithBlob(ctx, databaseURL, blobs)
	if err != nil {
		return err
	}
	defer store.Close()

	listenerFactory := newKVEventListenerFactory(
		kvEventsMode,
		databaseURL,
		os.Getenv("SLASHDOCS_KV_EVENTS_LISTENER_DATABASE_URL"),
		store.Pool(),
	)
	kvEvents, err := kvevents.New(ctx, kvevents.Config{Mode: kvEventsMode}, store, listenerFactory)
	if err != nil {
		return err
	}
	defer kvEvents.Close()
	slog.Info("document KV event delivery ready",
		slog.String("requested_mode", string(kvEvents.RequestedMode())),
		slog.String("active_mode", string(kvEvents.ActiveMode())))

	srv, err := newApplicationServer(ctx, store, blobs, kvEvents)
	if err != nil {
		return err
	}
	workerCtx, cancelWorkers := context.WithCancel(ctx)
	var workers sync.WaitGroup
	workers.Go(func() { srv.RunCommentNotifications(workerCtx) })
	workers.Go(func() { indexVersions(workerCtx, store) })
	defer func() { cancelWorkers(); workers.Wait() }()
	return serve(ctx, srv.Handler(), ":"+envOrDefault("SLASHDOCS_PORT", "8080"), ":"+envOrDefault("SLASHDOCS_METRICS_PORT", "9090"))
}

// indexVersions gives search text to versions that were created before
// content search. After the first run, it finds nothing to do.
func indexVersions(ctx context.Context, store *pgrepo.Store) {
	indexed, err := store.IndexVersions(ctx)
	if err != nil && ctx.Err() == nil {
		slog.ErrorContext(ctx, "version indexing stopped", slog.Int("indexed", indexed), slog.Any("error", err))
	} else if indexed > 0 {
		slog.InfoContext(ctx, "versions indexed for search", slog.Int("indexed", indexed))
	}
}

// newKVEventListenerFactory returns the interface type, not the concrete
// *kvevents.PostgresListenerFactory: returning a nil concrete pointer here
// would box into a non-nil interface, defeat the broker's nil-factory
// fallback, and panic on Open in the default auto-mode configuration.
func newKVEventListenerFactory(mode kvevents.Mode, databaseURL, configuredListenerURL string, sender kvevents.NotificationSender) kvevents.ListenerFactory {
	listenerURL := strings.TrimSpace(configuredListenerURL)
	switch mode {
	case kvevents.ModeAuto:
		// Auto mode never probes an unknown DATABASE_URL because it may point at
		// a transaction-pooling proxy that cannot safely preserve LISTEN state.
		if listenerURL == "" {
			return nil
		}
	case kvevents.ModeNotify:
		// Forced notify is an explicit operator assertion that DATABASE_URL is
		// safe when no dedicated listener URL is supplied.
		if listenerURL == "" {
			listenerURL = databaseURL
		}
	case kvevents.ModePoll:
		return nil
	}
	return kvevents.NewPostgresListenerFactory(listenerURL, sender)
}

type originSettings struct {
	appOrigin     string
	renderOrigin  string
	sessionSecret string
}

func loadOriginSettings() (originSettings, error) {
	appOrigin, err := requiredEnv("SLASHDOCS_APP_ORIGIN")
	if err != nil {
		return originSettings{}, err
	}
	if err := validateOrigin("SLASHDOCS_APP_ORIGIN", appOrigin); err != nil {
		return originSettings{}, err
	}
	renderOrigin, err := requiredEnv("SLASHDOCS_RENDER_ORIGIN")
	if err != nil {
		return originSettings{}, err
	}
	if err := validateOrigin("SLASHDOCS_RENDER_ORIGIN", renderOrigin); err != nil {
		return originSettings{}, err
	}
	if err := server.ValidateRenderOrigin(appOrigin, renderOrigin); err != nil {
		if !errors.Is(err, server.ErrUnsafeRenderOrigin) || os.Getenv("SLASHDOCS_ALLOW_UNSAFE_RENDER_ORIGIN") != "true" {
			return originSettings{}, err
		}
		slog.Warn("UNSAFE: SLASHDOCS_RENDER_ORIGIN shares a hostname with SLASHDOCS_APP_ORIGIN; scheme and port do not isolate host-scoped cookies, so uploaded document HTML can script against the app. Never run production like this.",
			slog.String("app_origin", appOrigin),
			slog.String("render_origin", renderOrigin))
	}
	sessionSecret := os.Getenv("SESSION_SECRET")
	if len(sessionSecret) < 32 {
		return originSettings{}, errors.New("SESSION_SECRET must be at least 32 bytes")
	}
	return originSettings{appOrigin: appOrigin, renderOrigin: renderOrigin, sessionSecret: sessionSecret}, nil
}

type deploymentSettings struct {
	name                 string
	orgName              string
	allowedOAuthDomains  []string
	defaultDocPermission repo.Role
}

func loadDeploymentSettings() (deploymentSettings, error) {
	deployment := envOrDefault("SLASHDOCS_DEPLOYMENT", server.DeploymentPublic)
	allowedOAuthDomains := splitCSV(os.Getenv("ALLOWED_OAUTH_DOMAINS"))
	switch deployment {
	case server.DeploymentPublic:
	case server.DeploymentOrg:
		allowedOAuthDomains = splitCSV(os.Getenv("SLASHDOCS_ORG_DOMAINS"))
		if len(allowedOAuthDomains) == 0 {
			return deploymentSettings{}, errors.New("SLASHDOCS_ORG_DOMAINS is required when SLASHDOCS_DEPLOYMENT=org")
		}
	default:
		return deploymentSettings{}, fmt.Errorf("SLASHDOCS_DEPLOYMENT must be %q or %q (got %q)", server.DeploymentPublic, server.DeploymentOrg, deployment)
	}
	defaultDocPermission, err := loadDefaultDocPermission(deployment)
	if err != nil {
		return deploymentSettings{}, err
	}
	return deploymentSettings{
		name:                 deployment,
		orgName:              os.Getenv("SLASHDOCS_ORG_NAME"),
		allowedOAuthDomains:  allowedOAuthDomains,
		defaultDocPermission: defaultDocPermission,
	}, nil
}

// loadDefaultDocPermission parses SLASHDOCS_DEFAULT_DOC_PERMISSION, the
// server-wide default sharing applied at document create. Unset means
// private. Non-private defaults are only meaningful behind an org login
// gate, so they require SLASHDOCS_DEPLOYMENT=org.
func loadDefaultDocPermission(deployment string) (repo.Role, error) {
	raw := os.Getenv("SLASHDOCS_DEFAULT_DOC_PERMISSION")
	if raw == "" {
		return repo.RoleNone, nil
	}
	role, ok := server.ParseDefaultDocPermission(raw)
	if !ok {
		return repo.RoleNone, fmt.Errorf("SLASHDOCS_DEFAULT_DOC_PERMISSION must be %q, %q, %q or %q (got %q)", repo.RoleViewer, repo.RoleCommenter, repo.RoleEditor, "private", raw)
	}
	if role != repo.RoleNone && deployment != server.DeploymentOrg {
		return repo.RoleNone, fmt.Errorf("SLASHDOCS_DEFAULT_DOC_PERMISSION=%s requires SLASHDOCS_DEPLOYMENT=org: on a public server the default \"anyone\" grant admits anyone with the link, not just your org", role)
	}
	if role == repo.RoleEditor {
		slog.Warn("SLASHDOCS_DEFAULT_DOC_PERMISSION=editor grants org-wide write access to every newly created document")
	}
	return role, nil
}

func loadOIDC(ctx context.Context, appOrigin string) (auth.OIDC, string, error) {
	settings, err := auth.ResolveOIDCSettings(os.Getenv)
	if err != nil {
		return auth.OIDC{}, "", err
	}
	callbackPath := "/v1/auth/oidc/callback"
	if settings.IssuerURL == auth.GoogleIssuer {
		callbackPath = "/v1/auth/google/callback"
	}
	provider, err := auth.NewOIDC(ctx, auth.OIDCConfig{
		IssuerURL:         settings.IssuerURL,
		InternalIssuerURL: settings.InternalIssuerURL,
		ClientID:          settings.ClientID,
		ClientSecret:      settings.ClientSecret,
		RedirectURL:       appOrigin + callbackPath,
	})
	return provider, settings.ProviderName, err
}

func newApplicationServer(ctx context.Context, store *pgrepo.Store, blobs blob.Store, kvEvents kvevents.Subscriber) (*server.Server, error) {
	origins, err := loadOriginSettings()
	if err != nil {
		return nil, err
	}
	deployment, err := loadDeploymentSettings()
	if err != nil {
		return nil, err
	}
	featured, err := server.ParseFeatured(os.Getenv("SLASHDOCS_FEATURED"))
	if err != nil {
		return nil, fmt.Errorf("SLASHDOCS_FEATURED: %w", err)
	}
	googleGroups, err := loadGoogleGroupsConfig(ctx, deployment.name)
	if err != nil {
		return nil, err
	}
	labelsEnabled, err := boolEnv("SLASHDOCS_LABELS_ENABLED", false)
	if err != nil {
		return nil, err
	}
	oidcProvider, providerName, err := loadOIDC(ctx, origins.appOrigin)
	if err != nil {
		return nil, err
	}
	sender, err := loadNotificationSender(os.Getenv)
	if err != nil {
		return nil, err
	}
	store.SetNotificationsEnabled(sender != nil)
	options := []server.Option{
		server.WithCommentNotificationSender(sender),
		server.WithRepository(store),
		server.WithDocumentKVEvents(kvEvents),
		server.WithAuthenticator(auth.DBAuthenticator{Resolver: store, SessionSecret: origins.sessionSecret}),
		server.WithStateStore(auth.NewPostgresStateStore(store.Pool())),
		server.WithReadinessCheck("postgres", store.Ping),
	}
	if pinger, ok := blobs.(blob.Pinger); ok {
		options = append(options, server.WithReadinessCheck("blob", pinger.Ping))
	}
	if googleGroups.directory != nil {
		options = append(options, server.WithGoogleGroupDirectory(googleGroups.directory))
	}
	return server.New(server.Config{
		Environment:               server.EnvProduction,
		AppOrigin:                 origins.appOrigin,
		RenderOrigin:              origins.renderOrigin,
		PreviousOrigins:           splitCSV(os.Getenv("SLASHDOCS_PREVIOUS_ORIGINS")),
		OIDC:                      oidcProvider,
		OIDCProviderName:          providerName,
		SessionSecret:             origins.sessionSecret,
		AllowedOAuthDomains:       deployment.allowedOAuthDomains,
		Deployment:                deployment.name,
		OrgName:                   deployment.orgName,
		DefaultDocPermission:      deployment.defaultDocPermission,
		Featured:                  featured,
		GitHubClientID:            os.Getenv("SLASHDOCS_GITHUB_CLIENT_ID"),
		GitHubClientSecret:        os.Getenv("SLASHDOCS_GITHUB_CLIENT_SECRET"),
		GoogleGroupsEnabled:       googleGroups.enabled,
		GoogleGroupsMembershipTTL: googleGroups.membershipTTL,
		DisableLabels:             !labelsEnabled,
	}, options...), nil
}

func serve(ctx context.Context, handler http.Handler, addr, metricsAddr string) error {
	appServer := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		IdleTimeout:       idleTimeout,
	}
	// Prometheus metrics get a separate listener so /metrics stays off the
	// public app port (expose only addr publicly; scrape metricsAddr over
	// private networking).
	metricsServer := &http.Server{
		Addr:              metricsAddr,
		Handler:           server.MetricsHandler(),
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		IdleTimeout:       idleTimeout,
	}

	serverErr := make(chan error, 2)
	var serverWG sync.WaitGroup
	serverWG.Add(2)
	go func() {
		defer serverWG.Done()
		slog.Info("metrics listening", slog.String("addr", metricsAddr))
		if err := metricsServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- fmt.Errorf("metrics server: %w", err)
		}
	}()
	go func() {
		defer serverWG.Done()
		slog.Info("server listening", slog.String("addr", addr))
		if err := appServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- fmt.Errorf("app server: %w", err)
		}
	}()

	var serveErr error
	select {
	case serveErr = <-serverErr:
	case <-ctx.Done():
	}

	// Graceful shutdown: stop accepting connections, then drain in-flight
	// requests (SSE streams included) for up to shutdownTimeout.
	slog.Info("shutting down", slog.Duration("timeout", shutdownTimeout))
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	appShutdownErr := shutdownHTTPServer(shutdownCtx, appServer)
	metricsShutdownErr := shutdownHTTPServer(shutdownCtx, metricsServer)
	serverWG.Wait()
	return errors.Join(serveErr, appShutdownErr, metricsShutdownErr)
}

// shutdownHTTPServer drains in-flight requests until ctx expires, then forces
// any remaining long-lived connections closed so the listener goroutine can
// always terminate.
func shutdownHTTPServer(ctx context.Context, srv *http.Server) error {
	shutdownErr := srv.Shutdown(ctx)
	if shutdownErr == nil {
		return nil
	}
	closeErr := srv.Close()
	if errors.Is(closeErr, http.ErrServerClosed) {
		closeErr = nil
	}
	return errors.Join(shutdownErr, closeErr)
}

func requiredEnv(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}

func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func boolEnv(name string, fallback bool) (bool, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	if raw != "true" && raw != "false" {
		return false, fmt.Errorf("%s must be true or false", name)
	}
	return raw == "true", nil
}

type googleGroupsConfig struct {
	enabled       bool
	membershipTTL time.Duration
	directory     googlegroups.GoogleGroupDirectory
}

// googleGroupsWorkspace is the validated Workspace identity that group
// sharing needs once it is switched on.
type googleGroupsWorkspace struct {
	customerID      string
	adminEmail      string
	credentialsFile string
}

// readGoogleGroupsWorkspaceEnv validates the three Workspace settings that
// become mandatory when SLASHDOCS_GOOGLE_GROUPS_ENABLED is true.
func readGoogleGroupsWorkspaceEnv() (googleGroupsWorkspace, error) {
	workspace := googleGroupsWorkspace{
		customerID:      os.Getenv("GOOGLE_GROUPS_CUSTOMER_ID"),
		adminEmail:      strings.TrimSpace(os.Getenv("GOOGLE_GROUPS_ADMIN_EMAIL")),
		credentialsFile: os.Getenv("GOOGLE_GROUPS_CREDENTIALS_FILE"),
	}
	if !strings.HasPrefix(workspace.customerID, "C") || strings.ContainsAny(workspace.customerID, " /\\\t\r\n") {
		return workspace, fmt.Errorf("GOOGLE_GROUPS_CUSTOMER_ID must be a Workspace customer ID beginning with C")
	}
	if workspace.adminEmail == "" || !strings.Contains(workspace.adminEmail, "@") {
		return workspace, fmt.Errorf("GOOGLE_GROUPS_ADMIN_EMAIL must be a valid delegated administrator email")
	}
	if workspace.credentialsFile == "" {
		return workspace, fmt.Errorf("GOOGLE_GROUPS_CREDENTIALS_FILE is required when Google Groups are enabled")
	}
	return workspace, nil
}

func loadGoogleGroupsConfig(ctx context.Context, deployment string) (googleGroupsConfig, error) {
	var cfg googleGroupsConfig
	enabledRaw := os.Getenv("SLASHDOCS_GOOGLE_GROUPS_ENABLED")
	if enabledRaw == "" {
		enabledRaw = "false"
	}
	if enabledRaw != "true" && enabledRaw != "false" {
		return cfg, fmt.Errorf("SLASHDOCS_GOOGLE_GROUPS_ENABLED must be true or false")
	}
	enabled := enabledRaw == "true"
	cfg.enabled = enabled
	if !enabled {
		return cfg, nil
	}
	if deployment != server.DeploymentOrg {
		return cfg, fmt.Errorf("SLASHDOCS_GOOGLE_GROUPS_ENABLED requires SLASHDOCS_DEPLOYMENT=org")
	}
	workspace, err := readGoogleGroupsWorkspaceEnv()
	if err != nil {
		return cfg, err
	}
	credentials, err := os.ReadFile(workspace.credentialsFile)
	if err != nil {
		return cfg, fmt.Errorf("GOOGLE_GROUPS_CREDENTIALS_FILE must be present and readable")
	}
	ttl, err := positiveDurationEnv("GOOGLE_GROUPS_MEMBERSHIP_TTL", time.Minute)
	if err != nil {
		return cfg, err
	}
	requestTimeout, err := positiveDurationEnv("GOOGLE_GROUPS_REQUEST_TIMEOUT", 5*time.Second)
	if err != nil {
		return cfg, err
	}
	jwtConfig, err := google.JWTConfigFromJSON(credentials, googlegroups.ReadOnlyScope)
	if err != nil {
		return cfg, fmt.Errorf("GOOGLE_GROUPS_CREDENTIALS_FILE does not contain valid service-account credentials")
	}
	jwtConfig.Subject = workspace.adminEmail
	directory, err := googlegroups.NewHTTPDirectory(googlegroups.HTTPDirectoryConfig{
		Client: jwtConfig.Client(ctx), CustomerID: workspace.customerID, Timeout: requestTimeout,
		Observer: server.ObserveGoogleGroupRequest,
	})
	if err != nil {
		return cfg, err
	}
	cfg.membershipTTL = ttl
	cfg.directory = directory
	return cfg, nil
}

func positiveDurationEnv(name string, fallback time.Duration) (time.Duration, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	duration, err := time.ParseDuration(raw)
	if err != nil || duration <= 0 {
		return 0, fmt.Errorf("%s must be a positive Go duration", name)
	}
	return duration, nil
}

func validateOrigin(name, value string) error {
	if strings.HasSuffix(value, "/") {
		return fmt.Errorf("%s must not end with a trailing slash (got %q). Set it to something like https://example.com", name, value)
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme == "" || u.Host == "" || u.Hostname() == "" {
		return fmt.Errorf("%s must be an absolute URL with scheme http:// or https:// (got %q). Set it to something like https://example.com", name, value)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("%s must use http:// or https:// (got scheme %q in %q)", name, u.Scheme, value)
	}
	if !validOriginPort(u.Port()) {
		return fmt.Errorf("%s has an invalid port in %q", name, value)
	}
	if u.Path != "" && u.Path != "/" {
		return fmt.Errorf("%s must not include a path (got %q). Set it to something like https://example.com", name, value)
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || strings.Contains(value, "#") {
		return fmt.Errorf("%s must be an origin without credentials, query parameters, or a fragment (got %q). Set it to something like https://example.com", name, value)
	}
	return nil
}

func validOriginPort(port string) bool {
	if port == "" {
		return true
	}
	_, err := strconv.ParseUint(port, 10, 16)
	return err == nil
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func newBlobStore(ctx context.Context) (blob.Store, error) {
	bucket := os.Getenv("BLOB_BUCKET")
	if bucket == "" {
		return nil, fmt.Errorf("BLOB_BUCKET is required")
	}
	region := os.Getenv("BLOB_REGION")
	if region == "" {
		region = os.Getenv("AWS_REGION")
	}
	if region == "" {
		region = "us-east-1"
	}
	return blob.NewS3(ctx, blob.S3Config{Bucket: bucket, Region: region, Endpoint: os.Getenv("BLOB_ENDPOINT"), AccessKeyID: os.Getenv("BLOB_ACCESS_KEY_ID"), SecretAccessKey: os.Getenv("BLOB_SECRET_ACCESS_KEY"), ForcePathStyle: os.Getenv("BLOB_FORCE_PATH_STYLE") == "true"})
}
