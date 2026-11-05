package guidelines

import (
	"strings"
	"testing"
)

func TestGuidelinesAskForStableHeadingIDs(t *testing.T) {
	review, ok := Find([]string{"review"})
	if !ok || !strings.Contains(review.Body, "stable heading ids") {
		t.Fatalf("review page must tell authors to keep stable heading ids across versions")
	}
}

func TestPublishingGuidelinesMentionBooks(t *testing.T) {
	p, ok := Find([]string{"core", "publishing"})
	if !ok || !strings.Contains(p.Body, "slashdocs books outline push") {
		t.Fatalf("publishing page must mention book chapters and books outline push")
	}
}

// The book tools exist only when the server has Book mode on, and a push's
// base version is the outline's version_id, never its number: an agent that
// passes the number gets a conflict on every push.
func TestPublishingGuidelinesBookOutlineContract(t *testing.T) {
	p, ok := Find([]string{"core", "publishing"})
	if !ok {
		t.Fatal("publishing page not found")
	}
	for _, want := range []string{"when Book mode is enabled on the server", "version_id"} {
		if !strings.Contains(p.Body, want) {
			t.Errorf("publishing page must say %q", want)
		}
	}
	if strings.Contains(p.Body, "--base-version <n>") {
		t.Error("publishing page must not suggest a number for --base-version")
	}
}
