package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"syscall"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/kvevents"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/server"
)

func TestServeShutsDownSiblingWhenListenerFails(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve listener address: %v", err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatalf("release listener address: %v", err)
	}

	// Both servers race to bind the same address. One succeeds and the other
	// reports EADDRINUSE; serve must close the successful sibling before it
	// returns the original listener error.
	err = serve(context.Background(), http.NewServeMux(), addr, addr)
	if !errors.Is(err, syscall.EADDRINUSE) {
		t.Fatalf("serve error = %v, want EADDRINUSE", err)
	}

	rebound, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("sibling listener still owns %s after serve returned: %v", addr, err)
	}
	if err := rebound.Close(); err != nil {
		t.Fatalf("close rebound listener: %v", err)
	}
}

func TestLoadDeploymentSettingsDefaultDocPermission(t *testing.T) {
	cases := []struct {
		name       string
		deployment string
		orgDomains string
		value      string
		want       repo.Role
		wantErr    string
	}{
		{name: "unset means private", deployment: "org", orgDomains: "example.com", want: repo.RoleNone},
		{name: "explicit private", deployment: "org", orgDomains: "example.com", value: "private", want: repo.RoleNone},
		{name: "viewer on org", deployment: "org", orgDomains: "example.com", value: "viewer", want: repo.RoleViewer},
		{name: "editor on org warns but loads", deployment: "org", orgDomains: "example.com", value: "editor", want: repo.RoleEditor},
		{name: "private allowed on public", deployment: "public", value: "private", want: repo.RoleNone},
		{name: "non-private requires org", deployment: "public", value: "viewer", wantErr: "requires SLASHDOCS_DEPLOYMENT=org"},
		{name: "invalid value", deployment: "org", orgDomains: "example.com", value: "everyone", wantErr: "SLASHDOCS_DEFAULT_DOC_PERMISSION must be"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SLASHDOCS_DEPLOYMENT", tc.deployment)
			t.Setenv("SLASHDOCS_ORG_DOMAINS", tc.orgDomains)
			t.Setenv("SLASHDOCS_DEFAULT_DOC_PERMISSION", tc.value)
			settings, err := loadDeploymentSettings()
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("loadDeploymentSettings() error = %v, want containing %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("loadDeploymentSettings() error = %v", err)
			}
			if settings.defaultDocPermission != tc.want {
				t.Fatalf("defaultDocPermission = %q, want %q", settings.defaultDocPermission, tc.want)
			}
		})
	}
}

func TestBoolEnv(t *testing.T) {
	t.Setenv("SLASHDOCS_TEST_FEATURE_ENABLED", "")
	if got, err := boolEnv("SLASHDOCS_TEST_FEATURE_ENABLED", false); err != nil || got {
		t.Fatalf("unset boolEnv = %v, %v; want false, nil", got, err)
	}
	t.Setenv("SLASHDOCS_TEST_FEATURE_ENABLED", "true")
	if got, err := boolEnv("SLASHDOCS_TEST_FEATURE_ENABLED", false); err != nil || !got {
		t.Fatalf("true boolEnv = %v, %v; want true, nil", got, err)
	}
	t.Setenv("SLASHDOCS_TEST_FEATURE_ENABLED", "yes")
	if _, err := boolEnv("SLASHDOCS_TEST_FEATURE_ENABLED", false); err == nil {
		t.Fatal("boolEnv accepted a non-boolean value")
	}
}

func TestValidateOrigin(t *testing.T) {
	t.Parallel()

	for _, origin := range []string{
		"https://example.com",
		"https://EXAMPLE.com:443",
		"http://localhost:8080",
		"http://[::1]:8080",
	} {
		t.Run("accepts "+origin, func(t *testing.T) {
			t.Parallel()
			if err := validateOrigin("TEST_ORIGIN", origin); err != nil {
				t.Fatalf("validateOrigin(%q) returned %v", origin, err)
			}
		})
	}

	for _, origin := range []string{
		"example.com",
		"ftp://example.com",
		"https://",
		"https://:443",
		"https://user@example.com",
		"https://example.com/path",
		"https://example.com/",
		"https://example.com?mode=login",
		"https://example.com?",
		"https://example.com#fragment",
		"https://example.com#",
		"https://example.com:65536",
	} {
		t.Run("rejects "+origin, func(t *testing.T) {
			t.Parallel()
			if err := validateOrigin("TEST_ORIGIN", origin); err == nil {
				t.Fatalf("validateOrigin(%q) unexpectedly succeeded", origin)
			}
		})
	}
}

func TestUnsafeRenderOriginOverrideDoesNotAllowInvalidOrigins(t *testing.T) {
	t.Setenv("SLASHDOCS_APP_ORIGIN", "http://127.1:8080")
	t.Setenv("SLASHDOCS_RENDER_ORIGIN", "http://127.0.0.1:8080")
	t.Setenv("SLASHDOCS_ALLOW_UNSAFE_RENDER_ORIGIN", "true")
	t.Setenv("SESSION_SECRET", "test-session-secret-at-least-32-bytes")

	if _, err := loadOriginSettings(); err == nil {
		t.Fatal("loadOriginSettings accepted a browser-ambiguous invalid origin")
	}
}

func TestUnsafeRenderOriginOverrideAllowsValidSameHostname(t *testing.T) {
	t.Setenv("SLASHDOCS_APP_ORIGIN", "http://localhost:8080")
	t.Setenv("SLASHDOCS_RENDER_ORIGIN", "https://LOCALHOST:9090")
	t.Setenv("SLASHDOCS_ALLOW_UNSAFE_RENDER_ORIGIN", "true")
	t.Setenv("SESSION_SECRET", "test-session-secret-at-least-32-bytes")

	if _, err := loadOriginSettings(); err != nil {
		t.Fatalf("loadOriginSettings rejected the explicit valid same-origin override: %v", err)
	}
}

func TestOriginSettingsRejectSameHostnameAcrossSchemeAndPort(t *testing.T) {
	t.Setenv("SLASHDOCS_APP_ORIGIN", "https://app.example")
	t.Setenv("SLASHDOCS_RENDER_ORIGIN", "http://APP.EXAMPLE:8080")
	t.Setenv("SLASHDOCS_ALLOW_UNSAFE_RENDER_ORIGIN", "")
	t.Setenv("SESSION_SECRET", "test-session-secret-at-least-32-bytes")

	if _, err := loadOriginSettings(); !errors.Is(err, server.ErrUnsafeRenderOrigin) {
		t.Fatalf("loadOriginSettings error = %v, want ErrUnsafeRenderOrigin", err)
	}
}

func TestKVEventListenerFactorySelection(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name        string
		mode        kvevents.Mode
		listenerURL string
		wantFactory bool
	}{
		{name: "auto without explicit listener URL polls", mode: kvevents.ModeAuto},
		{name: "auto with explicit listener URL probes notify", mode: kvevents.ModeAuto, listenerURL: "postgres://listener", wantFactory: true},
		{name: "notify falls back to database URL", mode: kvevents.ModeNotify, wantFactory: true},
		{name: "notify accepts dedicated listener URL", mode: kvevents.ModeNotify, listenerURL: "postgres://listener", wantFactory: true},
		{name: "poll never creates listener", mode: kvevents.ModePoll, listenerURL: "postgres://listener"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			factory := newKVEventListenerFactory(tc.mode, "postgres://application", tc.listenerURL, nil)
			// factory is the kvevents.ListenerFactory interface, so this nil
			// comparison asserts interface nilness: a nil concrete pointer boxed
			// into the interface would compare non-nil, defeat the broker's
			// nil-factory guard, and panic on Open at boot.
			if got := factory != nil; got != tc.wantFactory {
				t.Fatalf("factory present = %v (%T), want %v", got, factory, tc.wantFactory)
			}
		})
	}
}

type stubKVEventSource struct{}

func (stubKVEventSource) CurrentDocumentKVRevision(context.Context, string) (int64, error) {
	return 0, nil
}

func (stubKVEventSource) ListDocumentKVEvents(context.Context, string, int64, int32) ([]repo.DocumentKVEvent, error) {
	return nil, nil
}

// Regression test for the default configuration (auto mode, no dedicated
// listener database URL): the constructed factory must wire through
// kvevents.New as a true nil interface so the broker falls back to polling
// instead of panicking on a typed-nil listener factory.
func TestAutoModeWithoutListenerURLFallsBackToPolling(t *testing.T) {
	t.Parallel()

	factory := newKVEventListenerFactory(kvevents.ModeAuto, "postgres://application", "", nil)
	if factory != nil {
		t.Fatalf("factory = %T, want nil interface in auto mode without a listener URL", factory)
	}

	broker, err := kvevents.New(context.Background(), kvevents.Config{Mode: kvevents.ModeAuto}, stubKVEventSource{}, factory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(broker.Close)
	if broker.ActiveMode() != kvevents.ModePoll {
		t.Fatalf("active mode = %q, want %q", broker.ActiveMode(), kvevents.ModePoll)
	}
	_, unsubscribe, err := broker.Subscribe(context.Background(), "doc_boot")
	if err != nil {
		t.Fatal(err)
	}
	unsubscribe()
}
