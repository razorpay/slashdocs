package server

import (
	"strings"
	"unicode"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

// maxDescriptionRunes caps a link preview description, ellipsis included.
const maxDescriptionRunes = 200

// documentExcerpt returns the start of a document's text for a link preview:
// whitespace collapsed, leading copies of the title removed (documents often
// repeat it in <title> and <h1>), and cut at a word boundary to at most max
// characters, ellipsis included.
func documentExcerpt(title, text string, max int) string {
	r := []rune(strings.Join(strings.Fields(text), " "))
	if t := []rune(strings.Join(strings.Fields(title), " ")); len(t) > 0 {
		for len(r) >= len(t) && strings.EqualFold(string(r[:len(t)]), string(t)) &&
			(len(r) == len(t) || !unicode.IsLetter(r[len(t)]) && !unicode.IsDigit(r[len(t)])) {
			r = []rune(strings.TrimLeft(string(r[len(t):]), " -–—|:·"))
		}
	}
	if len(r) <= max {
		return string(r)
	}
	cut := r[:max-1]
	if r[max-1] != ' ' {
		if i := lastSpace(cut); i > 0 {
			cut = cut[:i]
		}
	}
	return strings.TrimRight(string(cut), " ,;:-–—") + "…"
}

func lastSpace(r []rune) int {
	for i := len(r) - 1; i >= 0; i-- {
		if r[i] == ' ' {
			return i
		}
	}
	return -1
}

// documentDescription describes a document in a link preview: an excerpt of
// its text, or who owns it and when it changed if it has no indexed text yet.
func documentDescription(d repo.Document, preview repo.DocumentPreview) string {
	if excerpt := documentExcerpt(d.Title, preview.Text, maxDescriptionRunes); excerpt != "" {
		return excerpt
	}
	var parts []string
	if d.Owner.Name != "" {
		parts = append(parts, "By "+d.Owner.Name)
	}
	if !preview.UpdatedAt.IsZero() {
		parts = append(parts, "Updated "+preview.UpdatedAt.UTC().Format("2 Jan 2006"))
	}
	return strings.Join(parts, " · ")
}
