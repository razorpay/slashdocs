package server

import (
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func TestDocumentExcerpt(t *testing.T) {
	for _, tc := range []struct {
		name, title, text string
		max               int
		want              string
	}{
		{"collapses whitespace", "T", "  a\n\tb  ", 200, "a b"},
		{"removes leading title copies", "Launch plan", "Launch plan launch PLAN — We ship Friday.", 200, "We ship Friday."},
		{"keeps a word that starts with the title", "a", "apple pie", 200, "apple pie"},
		{"title only", "fixture", "fixture", 200, ""},
		{"cuts at a word boundary", "", "aaa bbb ccc", 8, "aaa bbb…"},
		{"backs up to a word boundary", "", "aaa bbbb ccc", 8, "aaa…"},
		{"cuts a long word", "", strings.Repeat("x", 300), 200, strings.Repeat("x", 199) + "…"},
		{"counts characters, not bytes", "", "héllo wörld ünïcode", 10, "héllo…"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := documentExcerpt(tc.title, tc.text, tc.max); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDocumentDescriptionFallsBackToAByline(t *testing.T) {
	updated := time.Date(2026, 10, 28, 7, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name    string
		owner   string
		preview repo.DocumentPreview
		want    string
	}{
		{"excerpt", "Owner", repo.DocumentPreview{Text: "fixture Body text.", UpdatedAt: updated}, "Body text."},
		{"byline", "Owner", repo.DocumentPreview{Text: "fixture", UpdatedAt: updated}, "By Owner · Updated 28 Oct 2026"},
		{"no owner name", "", repo.DocumentPreview{UpdatedAt: updated}, "Updated 28 Oct 2026"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := repo.Document{Title: "fixture", Owner: auth.Principal{Name: tc.owner}}
			if got := documentDescription(d, tc.preview); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}
