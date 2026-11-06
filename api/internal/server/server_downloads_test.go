package server_test

import (
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/server"
)

func TestInstallScriptUsesConfiguredAppOriginNotForwardedHost(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", AppOrigin: "https://slashdocs.example", SessionSecret: "test-secret"})
	req := httptest.NewRequest(http.MethodGet, "/install.sh", nil)
	req.Host = "slashdocs.example"
	req.Header.Set("X-Forwarded-Host", "evil.example")
	req.Header.Set("X-Forwarded-Proto", "https")
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)

	assertStatus(t, rr, http.StatusOK)
	body := rr.Body.String()
	if strings.Contains(body, "evil.example") {
		t.Fatalf("install script reflected attacker-controlled forwarded host: %q", body)
	}
	if !strings.Contains(body, `BASE_URL="${SLASHDOCS_BASE_URL:-https://slashdocs.example}"`) {
		t.Fatalf("install script did not use configured app origin: %q", body)
	}
}

func TestInstallScriptInstallsBundledSkill(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", AppOrigin: "https://slashdocs.example", SessionSecret: "test-secret"})
	req := httptest.NewRequest(http.MethodGet, "/install.sh", nil)
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)

	assertStatus(t, rr, http.StatusOK)
	body := rr.Body.String()
	for _, want := range []string{
		`$BASE_URL/skills/slashdocs/SKILL.md`,
		`$HOME/.agents/skills/slashdocs`,
		`$HOME/.claude/skills/slashdocs`,
		`ln -sf slashdocs "$BIN_DIR/aidocs"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("install script missing %q in:\n%s", want, body)
		}
	}
}

// TestInstallScriptSeedsCLIConfig locks in that the served installer points a
// fresh CLI at the serving instance (and never clobbers an existing config),
// since the CLI has no baked-in default server.
func TestInstallScriptSeedsCLIConfig(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", AppOrigin: "https://slashdocs.example", SessionSecret: "test-secret"})
	req := httptest.NewRequest(http.MethodGet, "/install.sh", nil)
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)

	assertStatus(t, rr, http.StatusOK)
	body := rr.Body.String()
	for _, want := range []string{
		`configure_default_context`,
		`config_path="$config_dir/config.json"`,
		`if [ -e "$config_path" ]; then`,
		`"server": "$BASE_URL",`,
		`"active_context": "$host",`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("install script missing %q in:\n%s", want, body)
		}
	}
}

func TestInstallScriptIsValidPOSIXShell(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", AppOrigin: "https://slashdocs.example", SessionSecret: "test-secret"})
	req := httptest.NewRequest(http.MethodGet, "/install.sh", nil)
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)

	assertStatus(t, rr, http.StatusOK)
	body := rr.Body.String()
	cmd := exec.Command("sh", "-n")
	cmd.Stdin = strings.NewReader(body)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install script is not valid sh: %v\n%s\nscript:\n%s", err, out, body)
	}
}

func TestInstallScriptAddsInstallDirToPath(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", AppOrigin: "https://slashdocs.example", SessionSecret: "test-secret"})
	req := httptest.NewRequest(http.MethodGet, "/install.sh", nil)
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)

	assertStatus(t, rr, http.StatusOK)
	body := rr.Body.String()
	for _, want := range []string{
		`ensure_bin_dir_on_path`,
		`export PATH="$BIN_DIR:$PATH"`,
		`echo "# Added by slashdocs installer"`,
		`echo "Added $BIN_DIR to PATH in $profile."`,
		`echo "$HOME/.zshrc"`,
		`echo "$HOME/.bashrc"`,
		`echo "$HOME/.bash_profile"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("install script missing %q in:\n%s", want, body)
		}
	}
}

func TestInstallScriptRequiresConfiguredAppOriginForNonLocalHost(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", SessionSecret: "test-secret"})
	req := httptest.NewRequest(http.MethodGet, "/install.sh", nil)
	req.Host = "slashdocs.example"
	req.Header.Set("X-Forwarded-Host", "evil.example")
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)

	assertStatus(t, rr, http.StatusInternalServerError)
	if strings.Contains(rr.Body.String(), "evil.example") || strings.Contains(rr.Body.String(), "slashdocs.example") {
		t.Fatalf("misconfigured installer response reflected request host: %q", rr.Body.String())
	}
}

func TestDownloadSkillServesSlashdocsSkill(t *testing.T) {
	h := newTestEnv(t).h
	// CLIs released before the rename fetch the skill by its aidocs name.
	for _, name := range []string{"slashdocs", "aidocs"} {
		rr := do(t, h, http.MethodGet, "/skills/"+name+"/SKILL.md", "", nil)

		assertStatus(t, rr, http.StatusOK)
		if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/markdown") {
			t.Fatalf("Content-Type = %q, want text/markdown", ct)
		}
		body := rr.Body.String()
		if !strings.Contains(body, "name: slashdocs") || !strings.Contains(body, "slashdocs docs create") {
			t.Fatalf("unexpected skill body: %q", body)
		}
	}
}

func TestDownloadSkillRejectsUnknownSkill(t *testing.T) {
	rr := do(t, newTestEnv(t).h, http.MethodGet, "/skills/unknown/SKILL.md", "", nil)

	assertStatus(t, rr, http.StatusNotFound)
}
