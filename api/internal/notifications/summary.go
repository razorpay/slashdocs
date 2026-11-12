package notifications

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// summaryLimit caps a document summary, ellipsis included.
const summaryLimit = 200

// DocumentSummary describes a document in a link preview with the start of
// its text: leading copies of the title removed (documents often repeat it in
// <title> and <h1>), sensitive values redacted, and cut at a word boundary.
func DocumentSummary(title, text string) string {
	return firstWords(redact(withoutTitle(text, title)), summaryLimit)
}

// withoutTitle collapses whitespace and removes the copies of title that
// text starts with.
func withoutTitle(text, title string) string {
	text, title = strings.Join(strings.Fields(text), " "), strings.Join(strings.Fields(title), " ")
	for title != "" && len(text) >= len(title) && strings.EqualFold(text[:len(title)], title) {
		rest := text[len(title):]
		// A word that only starts with the title stays.
		if r, _ := utf8.DecodeRuneInString(rest); unicode.IsLetter(r) || unicode.IsDigit(r) {
			break
		}
		text = strings.TrimLeft(rest, " -–—|:·")
	}
	return text
}

// firstWords cuts text at a word boundary to at most limit characters,
// ellipsis included.
func firstWords(text string, limit int) string {
	chars := []rune(text)
	if len(chars) <= limit {
		return text
	}
	cut := string(chars[:limit-1])
	if chars[limit-1] != ' ' {
		if i := strings.LastIndexByte(cut, ' '); i > 0 {
			cut = cut[:i]
		}
	}
	return strings.TrimRightFunc(cut, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsPunct(r) }) + "…"
}
