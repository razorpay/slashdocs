package cli

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// TestMain points HOME and XDG_CONFIG_HOME at a temporary directory, so no test
// can write config or agent skills into the real home directory.
func TestMain(m *testing.M) {
	home, err := os.MkdirTemp("", "slashdocs-cli-test-")
	if err != nil {
		panic(err)
	}
	if os.Setenv("HOME", home) != nil || os.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config")) != nil {
		panic("set test home")
	}
	code := m.Run()
	_ = os.RemoveAll(home)
	os.Exit(code)
}

func writeTestJSON(t *testing.T, w io.Writer, value any) {
	t.Helper()
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Errorf("write JSON fixture response: %v", err)
	}
}

func writeTestString(t *testing.T, w io.Writer, value string) {
	t.Helper()
	if _, err := io.WriteString(w, value); err != nil {
		t.Errorf("write fixture response: %v", err)
	}
}

func writeTestFile(t *testing.T, path string, contents []byte) {
	t.Helper()
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatalf("write test file %s: %v", path, err)
	}
}

func readTestFile(t *testing.T, path string) []byte {
	t.Helper()
	contents, err := os.ReadFile(path) //nolint:gosec // Test callers provide paths rooted in t.TempDir.
	if err != nil {
		t.Fatalf("read test file %s: %v", path, err)
	}
	return contents
}
