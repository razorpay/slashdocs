package server

import (
	"errors"
	"slices"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

var (
	errAnchorNotFound  = errors.New("anchor_not_found")
	errAnchorAmbiguous = errors.New("anchor_ambiguous")
)

const minContextScoreForAmbiguousQuote = 0.65

// validateCommentAnchor checks that the anchor's quote exists in the version HTML.
// If the quote does not appear, it returns errAnchorNotFound.
// If the quote appears multiple times without disambiguating prefix/suffix or offsets,
// it returns errAnchorAmbiguous.
func validateCommentAnchor(anchor repo.Anchor, htmlBytes []byte) error {
	quote := anchor.Quote
	if quote == "" {
		return errors.New("invalid comment")
	}
	htmlStr := string(htmlBytes)
	text := renderedBodyText(htmlStr)

	searchTarget := text
	copies := indexAll(text, quote)
	if len(copies) == 0 {
		searchTarget = htmlStr
		copies = indexAll(htmlStr, quote)
	}
	if len(copies) == 0 {
		normText := strings.Join(strings.Fields(text), " ")
		normQuote := strings.Join(strings.Fields(quote), " ")
		if normQuote != "" {
			searchTarget = normText
			copies = indexAll(normText, normQuote)
		}
	}
	if len(copies) == 0 {
		return errAnchorNotFound
	}
	if len(copies) == 1 {
		return nil
	}

	// Multiple occurrences: disambiguate by prefix/suffix or offsets.
	prefix := strings.TrimSpace(anchor.Prefix)
	suffix := strings.TrimSpace(anchor.Suffix)
	if prefix != "" || suffix != "" {
		prefixRunes := []rune(prefix)
		suffixRunes := []rune(suffix)
		bestScore := 0.0
		for _, start := range copies {
			score := contextScore(searchTarget, start, start+len(quote), prefixRunes, suffixRunes)
			if score > bestScore {
				bestScore = score
			}
		}
		if bestScore >= minContextScoreForAmbiguousQuote {
			return nil
		}
	}

	if anchor.StartOffset > 0 || anchor.EndOffset > 0 {
		return nil
	}

	return errAnchorAmbiguous
}

// renderedBodyText returns the document body text with <br> elements replaced
// by spaces and template content excluded, matching the client viewer text.
func renderedBodyText(doc string) string {
	root, err := html.Parse(strings.NewReader(doc))
	if err != nil {
		return ""
	}
	var body *html.Node
	for n := range root.Descendants() {
		if n.Type == html.ElementNode && n.DataAtom == atom.Body {
			body = n
			break
		}
	}
	target := body
	if target == nil {
		target = root
	}
	var text strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			switch {
			case c.Type == html.TextNode:
				text.WriteString(c.Data)
			case c.Type != html.ElementNode:
			case c.DataAtom == atom.Br:
				text.WriteByte(' ')
			case c.DataAtom != atom.Template:
				walk(c)
			}
		}
	}
	walk(target)
	return text.String()
}

// indexAll returns the byte offset of every occurrence of sub in s, overlaps
// included.
func indexAll(s, sub string) []int {
	if sub == "" {
		return nil
	}
	var out []int
	for from := 0; ; {
		i := strings.Index(s[from:], sub)
		if i < 0 {
			return out
		}
		out = append(out, from+i)
		_, size := utf8.DecodeRuneInString(s[from+i:])
		from += i + size
	}
}

// contextScore measures how well the text around text[start:end] matches the
// provided prefix and suffix runes (from 0 to 1.0).
func contextScore(text string, start, end int, prefix, suffix []rune) float64 {
	prefixScore, suffixScore := 1.0, 1.0
	if len(prefix) > 0 {
		beforeRunes := []rune(text[:start])
		if len(beforeRunes) > len(prefix) {
			beforeRunes = beforeRunes[len(beforeRunes)-len(prefix):]
		}
		prefixScore = textMatchScore(beforeRunes, prefix)
	}
	if len(suffix) > 0 {
		afterRunes := []rune(text[end:])
		if len(afterRunes) > len(suffix) {
			afterRunes = afterRunes[:len(suffix)]
		}
		suffixScore = textMatchScore(afterRunes, suffix)
	}
	return (prefixScore + suffixScore) / 2
}

// textMatchScore computes 1 minus normalized edit distance between text and str.
func textMatchScore(text, str []rune) float64 {
	if len(text) == 0 || len(str) == 0 {
		return 0
	}
	prev := make([]int, len(text)+1)
	cur := make([]int, len(text)+1)
	for i := 1; i <= len(str); i++ {
		cur[0] = i
		for j := 1; j <= len(text); j++ {
			cost := 1
			if str[i-1] == text[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j-1]+cost, prev[j]+1, cur[j-1]+1)
		}
		prev, cur = cur, prev
	}
	return 1 - float64(slices.Min(prev))/float64(len(str))
}
