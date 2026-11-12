package render

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

func requireEmbeddedBridge(t *testing.T) string {
	t.Helper()
	if err := validateEmbeddedBridgeSource(bridgeJSSource, bridgeSourceHash, bridgeBundleHash, currentBridgeSourceHash(t)); err != nil {
		if os.Getenv("CI") != "" {
			t.Fatalf("%v (CI must run the frontend build before Go tests)", err)
		}
		t.Skipf("%v; make test builds it before running canonical checks", err)
	}
	return bridgeJSSource
}

// currentBridgeSourceHash runs the canonical fingerprint helper (the same one
// `make backend` and the Docker build use), so the expected hash can never
// drift from the generated one by way of a duplicated implementation. Node is
// guaranteed wherever this check must be authoritative: CI installs it before
// the Go step and `make test` builds the frontend first.
func currentBridgeSourceHash(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve bridge test source path")
	}
	cmd := exec.Command("node", "scripts/bridge-source-hash.mjs")
	cmd.Dir = filepath.Join(filepath.Dir(filename), "..", "..", "frontend")
	out, err := cmd.Output()
	if err != nil {
		if os.Getenv("CI") != "" {
			t.Fatalf("compute bridge source fingerprint: %v", err)
		}
		t.Skipf("bridge fingerprint helper unavailable (%v); make test runs the frontend build first", err)
	}
	hash := strings.TrimSpace(string(out))
	if len(hash) != sha256.Size*2 {
		t.Fatalf("unexpected bridge fingerprint output %q", hash)
	}
	return hash
}

func requireBridgePattern(t *testing.T, pattern string) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(requireEmbeddedBridge(t)) {
		t.Fatalf("embedded bridge is missing pattern %q", pattern)
	}
}

func TestRenderWrapperPreservesInlineScriptClosingTag(t *testing.T) {
	userHTML := []byte(`<html><body><script>window.__slashdocsRegression=42;</script></body></html>`)
	out := string(Wrap(userHTML, "https://app.example"))

	for _, needle := range []string{`<\/script`, `&lt;\/script`, `<\\/script`} {
		if strings.Contains(out, needle) {
			t.Fatalf("rendered wrapper contains %q, which corrupts user inline <script>: %s", needle, out)
		}
	}

	if !strings.Contains(out, `&lt;/script&gt;`) {
		t.Fatalf("expected user's </script> close to be HTML-entity-encoded inside srcdoc; got: %s", out)
	}
}

func TestBridgeImplementsThemeContract(t *testing.T) {
	bridge := requireEmbeddedBridge(t)
	for _, needle := range []string{
		"data-slashdocs-theme",
		"slashdocs_theme",
		"slashdocs:theme",
	} {
		if !strings.Contains(bridge, needle) {
			t.Fatalf("bridge.js missing theme-handshake hook %q", needle)
		}
	}
	requireBridgePattern(t, `readyState\s*!==\s*["']loading["']`)
}

func TestBridgePreservesPostMessageSecurityBoundary(t *testing.T) {
	for _, pattern := range []string{
		`e\.source\s*!==\s*parent`,
		`e\.origin\s*===\s*origin`,
		`new URL\(appOrigin,\s*window\.location\.href\)\.origin`,
		`parent\.postMessage\(`,
	} {
		requireBridgePattern(t, pattern)
	}
}

func TestBridgePreservesWireMessageFamilies(t *testing.T) {
	bridge := requireEmbeddedBridge(t)
	for _, messageType := range []string{
		"slashdocs:activate",
		"slashdocs:github-connect",
		"slashdocs:keydown",
		"slashdocs:kv-event",
		"slashdocs:kv-request",
		"slashdocs:kv-response",
		"slashdocs:paint",
		"slashdocs:ready",
		"slashdocs:selection",
		"slashdocs:theme",
		"slashdocs:viewport",
		"slashdocs:zoom",
	} {
		if !strings.Contains(bridge, messageType) {
			t.Fatalf("embedded bridge is missing wire message %q", messageType)
		}
	}
}

func TestBridgePreludeExposesGitHubConnectBeforeDocumentScriptsRun(t *testing.T) {
	withPrelude := userHTMLWithBridgePrelude([]byte(`<html><head><script>window.slashdocs.github.connect()</script></head><body></body></html>`))
	for _, needle := range []string{"githubConnect", "__slashdocsGitHubConnectQueued", "connect:githubConnect"} {
		if !strings.Contains(withPrelude, needle) {
			t.Fatalf("bridge prelude is missing GitHub connect hook %q: %s", needle, withPrelude)
		}
	}
}

func TestRenderWrapperAllowsSafePopups(t *testing.T) {
	out := string(Wrap([]byte(`<html><body><a href="https://example.com">x</a></body></html>`), "https://app.example"))
	for _, needle := range []string{"allow-popups", "allow-popups-to-escape-sandbox"} {
		if !strings.Contains(out, needle) {
			t.Fatalf("render wrapper sandbox missing %q: %s", needle, out)
		}
	}
}

func TestBridgeHandlesDocumentLinks(t *testing.T) {
	bridge := requireEmbeddedBridge(t)
	for _, needle := range []string{
		"handleLinkClick",
		"prepareLinks",
		"scrollIntoView",
		"window.open",
		"noopener,noreferrer",
	} {
		if !strings.Contains(bridge, needle) {
			t.Fatalf("bridge.js missing document link handling hook %q", needle)
		}
	}
}

func TestBridgeDoesNotExposeManualEditContract(t *testing.T) {
	bridge := requireEmbeddedBridge(t)
	for _, needle := range []string{
		"slashdocs:edit-mode",
		"slashdocs:edit-dirty",
		"slashdocs:edit-request-html",
		"slashdocs:edit-html",
		"slashdocs-edit-mode",
	} {
		if strings.Contains(bridge, needle) {
			t.Fatalf("bridge.js still exposes manual edit hook %q", needle)
		}
	}
}

func TestBridgeImplementsDocumentKVContract(t *testing.T) {
	bridge := requireEmbeddedBridge(t)
	for _, needle := range []string{
		"w.slashdocs",
		"slashdocs:kv-request",
		"slashdocs:kv-response",
		"slashdocs:kv-event",
		"kvchange",
	} {
		if !strings.Contains(bridge, needle) {
			t.Fatalf("bridge.js missing KV hook %q", needle)
		}
	}
	for _, pattern := range []string{
		`get\(key\)`,
		`all\(\)`,
		`set\(key,\s*value\)`,
		`delete\(key\)`,
		`patch\(object\)`,
		`undo\(\)`,
		`redo\(\)`,
	} {
		requireBridgePattern(t, pattern)
	}
}

func TestBridgeImplementsDocumentKVUndoRedoContract(t *testing.T) {
	bridge := requireEmbeddedBridge(t)
	for _, needle := range []string{
		"kvUndoStack",
		"kvRedoStack",
		"kvInversePatch",
		"handleKVUndoRedoShortcut",
		"isTextEditingTarget",
		"ev.ctrlKey",
		"ev.metaKey",
		"ev.shiftKey",
	} {
		if !strings.Contains(bridge, needle) {
			t.Fatalf("bridge.js missing KV undo/redo hook %q", needle)
		}
	}
	requireBridgePattern(t, `kvOperation\s*:\s*operation`)
	requireBridgePattern(t, `kvApplyPatch\(entry\.inverse,\s*["']undo["']\)`)
	requireBridgePattern(t, `kvApplyPatch\(entry\.forward,\s*["']redo["']\)`)
}

func TestValidateEmbeddedBridgeSource(t *testing.T) {
	for _, source := range []string{"", " \n\t"} {
		if err := validateEmbeddedBridgeSource(source, "", "", ""); !errors.Is(err, errMissingBridgeBundle) {
			t.Fatalf("validateEmbeddedBridgeSource(%q) error = %v, want errMissingBridgeBundle", source, err)
		}
	}

	source := "(()=>{})()"
	bundleSum := sha256.Sum256([]byte(source))
	bundleHash := hex.EncodeToString(bundleSum[:])
	sourceHash := strings.Repeat("a", sha256.Size*2)
	otherSourceHash := strings.Repeat("b", sha256.Size*2)
	for _, tc := range []struct {
		name, source, generatedSourceHash, generatedBundleHash, expectedSourceHash string
		wantErr                                                                    error
	}{
		{
			name:               "missing integrity metadata",
			source:             source,
			expectedSourceHash: sourceHash,
			wantErr:            errMissingBridgeHash,
		},
		{
			name:                "binary lacks source fingerprint",
			source:              source,
			generatedSourceHash: sourceHash,
			generatedBundleHash: bundleHash,
			wantErr:             errUnlinkedBridgeBuild,
		},
		{
			name:                "stale bundle",
			source:              source,
			generatedSourceHash: sourceHash,
			generatedBundleHash: bundleHash,
			expectedSourceHash:  otherSourceHash,
			wantErr:             errStaleBridgeBundle,
		},
		{
			name:                "corrupt bundle",
			source:              source + "corrupt",
			generatedSourceHash: sourceHash,
			generatedBundleHash: bundleHash,
			expectedSourceHash:  sourceHash,
			wantErr:             errCorruptBridgeBundle,
		},
		{
			name:                "valid bundle",
			source:              source,
			generatedSourceHash: sourceHash,
			generatedBundleHash: bundleHash,
			expectedSourceHash:  sourceHash,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateEmbeddedBridgeSource(tc.source, tc.generatedSourceHash, tc.generatedBundleHash, tc.expectedSourceHash)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("validateEmbeddedBridgeSource() error = %v, want %v", err, tc.wantErr)
			}
		})
	}
}

func TestRenderWrapperInstallsKVBootstrap(t *testing.T) {
	out := string(Wrap([]byte(`<html><body>hello</body></html>`), "https://app.example"))
	for _, needle := range []string{
		"slashdocs-bootstrap",
		"__slashdocsKVQueue",
		"window.slashdocs=window.aidocs=", // Documents written before the rename use window.aidocs.
		`undo:function(){return enqueue(&#34;undo&#34;,arguments);}`,
		`redo:function(){return enqueue(&#34;redo&#34;,arguments);}`,
	} {
		if !strings.Contains(out, needle) {
			t.Fatalf("render wrapper missing KV bootstrap hook %q: %s", needle, out)
		}
	}
}

func TestBridgePreludePreservesDocumentDoctype(t *testing.T) {
	userHTML := []byte(`<!doctype html><html><head><title>doc</title></head><body>hello</body></html>`)
	withPrelude := userHTMLWithBridgePrelude(userHTML)
	if !strings.HasPrefix(strings.ToLower(withPrelude), "<!doctype html>") {
		t.Fatalf("bridge prelude moved the user doctype out of first position: %s", withPrelude)
	}
	preludeAt := strings.Index(withPrelude, "slashdocs-bootstrap")
	titleAt := strings.Index(withPrelude, "<title>")
	if preludeAt < 0 || titleAt < 0 || preludeAt > titleAt {
		t.Fatalf("bridge prelude should be installed before user head scripts/content: %s", withPrelude)
	}
}

func TestRenderWrapperScrubsOnlyRenderToken(t *testing.T) {
	out := string(Wrap([]byte(`<html><body>hello</body></html>`), "https://app.example"))
	for _, needle := range []string{
		`searchParams.has("token")`,
		`searchParams.delete("token")`,
		`u.pathname+(u.search||"")+u.hash`,
	} {
		if !strings.Contains(out, needle) {
			t.Fatalf("render wrapper missing token-only URL scrub hook %q: %s", needle, out)
		}
	}
}

func TestRenderWrapperLeavesScriptSubstringInJSAlone(t *testing.T) {
	userHTML := []byte(`<html><body><script>var s = "</script>oops";</script></body></html>`)
	out := string(Wrap(userHTML, "https://app.example"))
	if strings.Contains(out, `\/script`) {
		t.Fatalf("rendered wrapper still injects backslash before /script: %s", out)
	}
	if !strings.Contains(out, `&lt;/script&gt;oops&#34;;&lt;/script&gt;`) {
		t.Fatalf("expected both inline </script> occurrences to be HTML-entity-encoded; got: %s", out)
	}
}
