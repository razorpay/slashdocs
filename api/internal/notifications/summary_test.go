package notifications

import (
	"strings"
	"testing"
)

func TestDocumentSummary(t *testing.T) {
	for _, tc := range []struct {
		name, title, text, want string
	}{
		{"collapses whitespace", "T", "  a\n\tb  ", "a b"},
		{"removes leading title copies", "Launch  plan", "Launch plan launch PLAN — We ship Friday.", "We ship Friday."},
		{"keeps a word that starts with the title", "a", "apple pie", "apple pie"},
		{"title only", "fixture", "fixture", ""},
		{"redacts sensitive values", "", "The OTP is 482913, use it.", "The OTP is [redacted], use it."},
		{"cuts a long word", "", strings.Repeat("x", 300), strings.Repeat("x", 199) + "…"},
		{"cuts after a word", "", strings.Repeat("word ", 50), strings.TrimSpace(strings.Repeat("word ", 40)) + "…"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := DocumentSummary(tc.title, tc.text); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestFirstWords(t *testing.T) {
	for _, tc := range []struct {
		name, text string
		limit      int
		want       string
	}{
		{"short text", "aaa bbb", 8, "aaa bbb"},
		{"cuts at a word boundary", "aaa bbb ccc", 8, "aaa bbb…"},
		{"backs up to a word boundary", "aaa bbbb ccc", 8, "aaa…"},
		{"drops trailing punctuation", "aaa, bbbb ccc", 8, "aaa…"},
		{"counts characters, not bytes", "héllo wörld ünïcode", 10, "héllo…"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := firstWords(tc.text, tc.limit); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}
