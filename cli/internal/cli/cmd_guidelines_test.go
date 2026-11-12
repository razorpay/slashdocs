package cli

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestGuidelinesIndexPointsToSections(t *testing.T) {
	got, err := Execute([]string{"guidelines"})
	if err != nil {
		t.Fatalf("guidelines returned error: %v", err)
	}
	for _, want := range []string{
		"slashdocs document authoring guidelines",
		"slashdocs guidelines core",
		"slashdocs guidelines rendering theme",
		"slashdocs guidelines interactivity kv",
		"slashdocs guidelines interactivity github",
		"slashdocs guidelines all",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("index output missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "window.slashdocs.kv.get") {
		t.Fatalf("index should not include full KV detail:\n%s", got)
	}
}

func TestGuidelinesGitHubAliasDocumentsPrimitive(t *testing.T) {
	got, err := Execute([]string{"guidelines", "github"})
	if err != nil {
		t.Fatalf("GitHub guidelines returned error: %v", err)
	}
	for _, want := range []string{
		"slashdocs guidelines: interactivity github",
		"window.slashdocs.github.getRawContent",
		"window.slashdocs.github.connect",
		"branch, tag, or commit SHA",
		"Prefer a stable commit ref unless",
		"a floating branch or tag",
		"Every reader loads the file using their own connected GitHub account",
		"Content added after the fetch remains commentable",
		"Do not eval source code",
		"Files are limited to 50 MiB",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("GitHub output missing %q:\n%s", want, got)
		}
	}
}

func TestGuidelinesSectionLookup(t *testing.T) {
	got, err := Execute([]string{"guidelines", "rendering", "theme"})
	if err != nil {
		t.Fatalf("theme guidelines returned error: %v", err)
	}
	for _, want := range []string{
		"slashdocs guidelines: rendering theme",
		`<html data-slashdocs-theme="light">`,
		"window.addEventListener('slashdocs:theme'",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("theme output missing %q:\n%s", want, got)
		}
	}
}

func TestGuidelinesKVAliasDocumentsPrimitive(t *testing.T) {
	got, err := Execute([]string{"guidelines", "kv"})
	if err != nil {
		t.Fatalf("KV guidelines returned error: %v", err)
	}
	for _, want := range []string{
		"window.slashdocs.kv.get",
		"window.slashdocs.kv.all",
		"window.slashdocs.kv.set",
		"window.slashdocs.kv.delete",
		"window.slashdocs.kv.patch",
		"window.slashdocs.kv.undo",
		"window.slashdocs.kv.redo",
		`window.slashdocs.on("kvchange"`,
		"KV writes persist immediately",
		"KV writes do not create document versions",
		"One document's keys are not visible to another",
		"Template/HTML updates still go through the ordinary publish/version flow",
		"Editors can write KV values",
		"set(key, null) deletes key",
		"event.changes exists on writes",
		"Ctrl/Cmd+Z undoes the last local KV write",
		`operation "undo" or "redo"`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("KV output missing %q:\n%s", want, got)
		}
	}
}

func TestGuidelinesPublishingExamplesMatchCLIFlags(t *testing.T) {
	got, err := Execute([]string{"guidelines", "core", "publishing"})
	if err != nil {
		t.Fatalf("publishing guidelines returned error: %v", err)
	}
	for _, want := range []string{
		"slashdocs docs create report.html --title 'Report'",
		"slashdocs docs push <doc_id> report.html --base-version <version_id> --summary 'Address comments'",
		"slashdocs docs pull <doc_id>",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("publishing output missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "--visibility") {
		t.Fatalf("publishing output should not mention unsupported --visibility flag:\n%s", got)
	}
}

func TestGuidelinesUnknownSectionIsUsageError(t *testing.T) {
	_, err := Execute([]string{"guidelines", "missing"})
	if err == nil {
		t.Fatal("expected unknown section error")
	}
	var uerr usageError
	if !errors.As(err, &uerr) {
		t.Fatalf("expected usageError, got %T %v", err, err)
	}
	if got := ExitCode(err); got != 2 {
		t.Fatalf("ExitCode = %d, want 2", got)
	}
	if !strings.Contains(err.Error(), `unknown guidelines section "missing"`) || !strings.Contains(err.Error(), "slashdocs guidelines interactivity kv") {
		t.Fatalf("unknown section error should be helpful, got %q", err.Error())
	}
}

func TestGuidelinesDoesNotCallUpdateEndpoints(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		http.Error(w, "unexpected request", http.StatusInternalServerError)
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_DISABLE_AUTO_UPDATE", "")

	if _, err := Execute([]string{"guidelines"}); err != nil {
		t.Fatalf("guidelines returned error: %v", err)
	}
	if got := atomic.LoadInt32(&hits); got != 0 {
		t.Fatalf("guidelines should not make network requests, got %d", got)
	}
}
