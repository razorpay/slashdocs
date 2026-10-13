package server

import (
	"slices"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

// minContextScoreForAmbiguousQuote is the least prefix/suffix agreement that
// places a comment on a copy of a repeated quote. It matches
// MIN_CONTEXT_SCORE_FOR_AMBIGUOUS_QUOTE in frontend/bridge/anchoring/index.ts,
// so the API reports the placement that the viewer shows.
const minContextScoreForAmbiguousQuote = 0.65

// placementDoc is the version that comments are placed on. Its visible text
// is extracted at most once, and only for a comment that needs it.
type placementDoc struct {
	html     string
	text     string
	textDone bool
}

func newPlacementDoc(placementHTML []byte) *placementDoc {
	if len(placementHTML) == 0 {
		return nil
	}
	return &placementDoc{html: string(placementHTML)}
}

// renderedText returns the body text as the viewer anchors against it: the
// body's textContent with each <br> read as a space.
func (d *placementDoc) renderedText() string {
	if !d.textDone {
		d.textDone = true
		d.text = renderedBodyText(d.html)
	}
	return d.text
}

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
	if body == nil {
		return ""
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
			// A template's content is not part of the DOM's textContent.
			case c.DataAtom != atom.Template:
				walk(c)
			}
		}
	}
	walk(body)
	return text.String()
}

// placedOn reports whether a comment's quote can be placed on doc. A quote
// that is repeated, in doc or in its own stored context, is placed only when
// the text around one of its copies agrees with the stored context, so that
// editing the commented copy does not leave the comment on another one.
func placedOn(cm repo.Comment, doc *placementDoc) bool {
	if !strings.Contains(doc.html, cm.SelectedText) {
		return false
	}
	a := cm.Anchor
	if a.Quote == "" {
		return true
	}
	text := doc.renderedText()
	copies := indexAll(text, a.Quote)
	if len(copies) <= 1 && len(indexAll(a.Prefix+a.Quote+a.Suffix, a.Quote)) <= 1 {
		return true
	}
	if len(copies) == 0 {
		// The quote is in the markup but not the body text, so its context
		// cannot be checked. Keep the placement that a plain search gives.
		return true
	}
	prefix, suffix := []rune(a.Prefix), []rune(a.Suffix)
	for _, start := range copies {
		if contextScore(text, start, start+len(a.Quote), prefix, suffix) >= minContextScoreForAmbiguousQuote {
			return true
		}
	}
	return false
}

// indexAll returns the byte offset of every occurrence of sub in s, overlaps
// included.
func indexAll(s, sub string) []int {
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

// contextScore is how well the text around text[start:end] agrees with the
// stored prefix and suffix, from 0 to 1.0, and 1.0 for an absent side. It
// mirrors Match.contextScore in frontend/bridge/anchoring/match-quote.ts.
func contextScore(text string, start, end int, prefix, suffix []rune) float64 {
	prefixScore, suffixScore := 1.0, 1.0
	if len(prefix) > 0 {
		before := []rune(text[max(0, start-utf8.UTFMax*(len(prefix)+1)):start])
		prefixScore = textMatchScore(before[max(0, len(before)-len(prefix)):], prefix)
	}
	if len(suffix) > 0 {
		after := []rune(text[end:min(len(text), end+utf8.UTFMax*(len(suffix)+1))])
		suffixScore = textMatchScore(after[:min(len(after), len(suffix))], suffix)
	}
	return (prefixScore + suffixScore) / 2
}

// textMatchScore is 1 minus the fewest edits that turn str into any substring
// of text, as a fraction of len(str). An empty text or str scores 0.
func textMatchScore(text, str []rune) float64 {
	if len(text) == 0 || len(str) == 0 {
		return 0
	}
	// Approximate substring matching (Sellers): prev[j] is the fewest edits
	// that turn str[:i] into a substring of text that ends at j.
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
