package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"
)

func TestEnvFallsBackToLegacyName(t *testing.T) {
	t.Setenv("SLASHDOCS_TOKEN", "")
	t.Setenv("AIDOCS_TOKEN", "legacy")
	if got := env("SLASHDOCS_TOKEN"); got != "legacy" {
		t.Fatalf("env = %q, want the AIDOCS_TOKEN value", got)
	}
	t.Setenv("SLASHDOCS_TOKEN", "current")
	if got := env("SLASHDOCS_TOKEN"); got != "current" {
		t.Fatalf("env = %q, want the SLASHDOCS_TOKEN value", got)
	}
}

func TestInvokedAsLegacy(t *testing.T) {
	for arg0, want := range map[string]bool{
		"aidocs":                   true,
		"/usr/local/bin/aidocs":    true,
		"aidocs.exe":               true,
		"slashdocs":                false,
		"/usr/local/bin/slashdocs": false,
	} {
		if got := InvokedAsLegacy(arg0); got != want {
			t.Errorf("InvokedAsLegacy(%q) = %v, want %v", arg0, got, want)
		}
	}
}

func TestMigrateLegacyInstallMovesConfigAndSkills(t *testing.T) {
	home, config := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", config)
	writeTree(t, filepath.Join(config, "aidocs", "config.json"), "legacy config")
	writeTree(t, filepath.Join(home, ".agents", "skills", "aidocs", "SKILL.md"), "legacy skill")
	writeTree(t, filepath.Join(home, ".claude", "skills", "aidocs", "SKILL.md"), "stale skill")
	writeTree(t, filepath.Join(home, ".claude", "skills", "slashdocs", "SKILL.md"), "current skill")

	MigrateLegacyInstall()

	assertFile(t, filepath.Join(config, "slashdocs", "config.json"), "legacy config")
	assertFile(t, filepath.Join(home, ".agents", "skills", "slashdocs", "SKILL.md"), "legacy skill")
	assertFile(t, filepath.Join(home, ".claude", "skills", "slashdocs", "SKILL.md"), "current skill")
	for _, gone := range []string{
		filepath.Join(config, "aidocs"),
		filepath.Join(home, ".agents", "skills", "aidocs"),
		filepath.Join(home, ".claude", "skills", "aidocs"),
	} {
		if _, err := os.Lstat(gone); !os.IsNotExist(err) {
			t.Errorf("%s still exists after migration", gone)
		}
	}
}

func TestMigrateLegacyInstallRemovesSymlinkedSkill(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeTree(t, filepath.Join(home, ".agents", "skills", "aidocs", "SKILL.md"), "shared skill")
	claude := filepath.Join(home, ".claude", "skills")
	if err := os.MkdirAll(claude, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "..", ".agents", "skills", "aidocs"), filepath.Join(claude, "aidocs")); err != nil {
		t.Fatal(err)
	}

	MigrateLegacyInstall()

	assertFile(t, filepath.Join(home, ".agents", "skills", "slashdocs", "SKILL.md"), "shared skill")
	for _, gone := range []string{filepath.Join(claude, "aidocs"), filepath.Join(claude, "slashdocs")} {
		if _, err := os.Lstat(gone); !os.IsNotExist(err) {
			t.Errorf("%s exists after migration; a dangling link would block the next skill install", gone)
		}
	}
}

func TestRenameNoticeGivesInstallCommandWhenSlashdocsIsMissing(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("SLASHDOCS_SERVER", "https://docs.example.com")
	if got := RenameNotice(); !strings.Contains(got, "curl -fsSL https://docs.example.com/install.sh | sh") {
		t.Fatalf("notice = %q, want the install command", got)
	}
}

func TestMigrateLegacyInstallKeepsBothConfigs(t *testing.T) {
	config := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", config)
	writeTree(t, filepath.Join(config, "aidocs", "config.json"), "legacy config")
	writeTree(t, filepath.Join(config, "slashdocs", "config.json"), "current config")

	MigrateLegacyInstall()

	assertFile(t, filepath.Join(config, "slashdocs", "config.json"), "current config")
	assertFile(t, filepath.Join(config, "aidocs", "config.json"), "legacy config")
}

func TestMigrateLegacyBinaryLeavesSymlink(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "aidocs")
	writeTree(t, legacy, "binary")

	migrateLegacyBinary(legacy)

	assertFile(t, filepath.Join(dir, "slashdocs"), "binary")
	if target, err := os.Readlink(legacy); err != nil || target != "slashdocs" {
		t.Fatalf("aidocs link = %q, %v; want a symlink to slashdocs", target, err)
	}
	migrateLegacyBinary(legacy) // A second run through the symlink is a no-op.
	assertFile(t, filepath.Join(dir, "slashdocs"), "binary")
}

func TestCredentialTokenMovesLegacyKeychainEntry(t *testing.T) {
	keyring.MockInit()
	t.Setenv("SLASHDOCS_NO_KEYCHAIN", "")
	t.Setenv("AIDOCS_NO_KEYCHAIN", "")
	ref := tokenRef("docs.example.com")
	if err := keyring.Set("aidocs", ref, "secret"); err != nil {
		t.Fatal(err)
	}

	if got := credentialToken("docs.example.com", map[string]any{"token_ref": ref}); got != "secret" {
		t.Fatalf("credentialToken = %q, want the legacy keychain token", got)
	}
	if got, err := keyring.Get("slashdocs", ref); err != nil || got != "secret" {
		t.Fatalf("slashdocs keychain entry = %q, %v", got, err)
	}
	if _, err := keyring.Get("aidocs", ref); err == nil {
		t.Fatal("legacy keychain entry still exists")
	}
}

func TestDeleteCredentialTokenRemovesLegacyKeychainEntry(t *testing.T) {
	keyring.MockInit()
	t.Setenv("SLASHDOCS_NO_KEYCHAIN", "")
	t.Setenv("AIDOCS_NO_KEYCHAIN", "")
	ref := tokenRef("docs.example.com")
	if err := keyring.Set("aidocs", ref, "secret"); err != nil {
		t.Fatal(err)
	}

	deleteCredentialToken("docs.example.com", map[string]any{"token_ref": ref})

	if _, err := keyring.Get("aidocs", ref); err == nil {
		t.Fatal("legacy keychain entry still exists after logout")
	}
}

func writeTree(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, path, []byte(contents))
}

func assertFile(t *testing.T, path, want string) {
	t.Helper()
	if got := string(readTestFile(t, path)); got != want {
		t.Fatalf("%s = %q, want %q", path, got, want)
	}
}
