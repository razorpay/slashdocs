package guidelines

import (
	"strings"
	"testing"
)

func TestGuidelinesAskForStableHeadingIDs(t *testing.T) {
	var all strings.Builder
	for _, p := range Pages {
		all.WriteString(p.Body)
	}
	if !strings.Contains(all.String(), "stable heading ids") {
		t.Fatalf("guidelines must tell authors to keep stable heading ids across versions")
	}
	review, ok := Find([]string{"review"})
	if !ok || !strings.Contains(review.Body, "stable heading ids") {
		t.Fatalf("review page must mention stable heading ids")
	}
}

func TestPublishingGuidelinesMentionBooks(t *testing.T) {
	p, ok := Find([]string{"core", "publishing"})
	if !ok || !strings.Contains(p.Body, "slashdocs books outline push") {
		t.Fatalf("publishing page must mention book chapters and books outline push")
	}
}
