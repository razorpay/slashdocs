package server

import (
	"slices"
	"strings"
	"unicode/utf16"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

// minContextScoreForAmbiguousQuote is the least prefix/suffix agreement that
// places a comment on a copy of a repeated quote. It matches
// MIN_CONTEXT_SCORE_FOR_AMBIGUOUS_QUOTE in frontend/bridge/anchoring/index.ts,
// so the API reports the placement that the viewer shows.
const minContextScoreForAmbiguousQuote = 0.65

// placementDoc is the version that comments are placed on. Its rendered text
// is extracted at most once, and only for a comment that needs it.
type placementDoc struct {
	html     string
	text     renderedText
	textDone bool
}

// renderedText is a version's body text as the viewer anchors against it
// (renderedTextOf in frontend/bridge/anchoring/rendered-text.ts). It is held
// in UTF-16 code units, like a JavaScript string, so that stored offsets and
// edit distances mean the same as in the viewer.
type renderedText struct {
	units []uint16
	// brs are the positions in units of the spaces that stand for <br>
	// elements, which raw textContent offsets do not count.
	brs []int
}

func newPlacementDoc(placementHTML []byte) *placementDoc {
	if len(placementHTML) == 0 {
		return nil
	}
	return &placementDoc{html: string(placementHTML)}
}

func (d *placementDoc) renderedText() renderedText {
	if !d.textDone {
		d.textDone = true
		d.text = renderedBodyText(d.html)
	}
	return d.text
}

// renderedBodyText returns the body's textContent with each <br> read as a
// space and the text of script, style and noscript elements replaced by NUL
// characters of the same length, so that it never matches a quote.
func renderedBodyText(doc string) renderedText {
	var out renderedText
	root, err := html.Parse(strings.NewReader(doc))
	if err != nil {
		return out
	}
	var body *html.Node
	for n := range root.Descendants() {
		if n.Type == html.ElementNode && n.DataAtom == atom.Body {
			body = n
			break
		}
	}
	if body == nil {
		return out
	}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			switch {
			case c.Type == html.TextNode:
				out.units = append(out.units, utf16.Encode([]rune(c.Data))...)
			case c.Type != html.ElementNode:
			case c.DataAtom == atom.Br:
				out.brs = append(out.brs, len(out.units))
				out.units = append(out.units, ' ')
			case c.DataAtom == atom.Script, c.DataAtom == atom.Style, c.DataAtom == atom.Noscript:
				out.units = append(out.units, make([]uint16, utf16Len(textContent(c)))...)
			// A template's content is not part of the DOM's textContent.
			case c.DataAtom != atom.Template:
				walk(c)
			}
		}
	}
	walk(body)
	return out
}

func textContent(n *html.Node) string {
	var s strings.Builder
	for c := range n.Descendants() {
		if c.Type == html.TextNode {
			s.WriteString(c.Data)
		}
	}
	return s.String()
}

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

// placedOn reports whether a comment's quote can be placed on doc, following
// the viewer's resolveAnchor. A quote that is repeated, in doc or in its own
// stored context, is placed at its stored position when the quote is still
// there, or else on a copy whose surrounding text agrees with the stored
// context, so that editing the commented copy does not leave the comment on
// another one.
func placedOn(cm repo.Comment, doc *placementDoc) bool {
	if !strings.Contains(doc.html, cm.SelectedText) {
		return false
	}
	a := cm.Anchor
	if a.Quote == "" {
		return true
	}
	window := a.Prefix + a.Quote + a.Suffix
	repeatedInContext := occursMoreThanOnce(window, a.Quote)
	if !repeatedInContext && !occursMoreThanOnce(doc.html, a.Quote) {
		// One copy in the whole version, and it is the only candidate.
		return true
	}
	text := doc.renderedText()
	quote := utf16.Encode([]rune(a.Quote))
	if atStoredPosition(text, a, quote) {
		return true
	}
	copies := indexAll(text.units, quote)
	switch {
	case len(copies) == 0:
		// The quote is only in markup that the viewer never matches, such as
		// an attribute or a script.
		return false
	case len(copies) == 1 && !repeatedInContext:
		return true
	}
	prefix := utf16.Encode([]rune(a.Prefix))
	suffix := utf16.Encode([]rune(a.Suffix))
	for _, start := range copies {
		if contextScore(text.units, start, start+len(quote), prefix, suffix) >= minContextScoreForAmbiguousQuote {
			return true
		}
	}
	return false
}

// atStoredPosition reports whether the quote is still at the anchor's stored
// offsets, the viewer's first tier. The offsets count raw textContent, which
// has no character for a <br>.
func atStoredPosition(text renderedText, a repo.Anchor, quote []uint16) bool {
	if a.StartOffset < 0 || a.EndOffset <= a.StartOffset {
		return false
	}
	start := rawOffsetToRendered(text.brs, a.StartOffset)
	end := rawOffsetToRendered(text.brs, a.EndOffset)
	if end > len(text.units) {
		return false
	}
	at := text.units[start:end]
	return slices.Equal(at, quote) ||
		normalizeSpace(string(utf16.Decode(at))) == normalizeSpace(string(utf16.Decode(quote)))
}

// rawOffsetToRendered mirrors rawOffsetToRendered in rendered-text.ts.
func rawOffsetToRendered(brs []int, raw int) int {
	rendered := raw
	for _, br := range brs {
		if br >= rendered {
			break
		}
		rendered++
	}
	return rendered
}

func normalizeSpace(s string) string { return strings.Join(strings.Fields(s), " ") }

// occursMoreThanOnce reports whether sub occurs in s more than once, overlaps
// included.
func occursMoreThanOnce(s, sub string) bool {
	if sub == "" {
		return false
	}
	first := strings.Index(s, sub)
	return first >= 0 && strings.Contains(s[first+1:], sub)
}

// indexAll returns the start of every occurrence of sub in s, overlaps
// included, and nothing for an empty sub.
func indexAll(s, sub []uint16) []int {
	var out []int
	if len(sub) == 0 {
		return out
	}
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i] == sub[0] && slices.Equal(s[i:i+len(sub)], sub) {
			out = append(out, i)
		}
	}
	return out
}

// contextScore is how well the text around text[start:end] agrees with the
// stored prefix and suffix, from 0 to 1.0, and 1.0 for an absent side. It
// mirrors Match.contextScore in frontend/bridge/anchoring/match-quote.ts.
func contextScore(text []uint16, start, end int, prefix, suffix []uint16) float64 {
	prefixScore, suffixScore := 1.0, 1.0
	if len(prefix) > 0 {
		prefixScore = textMatchScore(text[max(0, start-len(prefix)):start], prefix)
	}
	if len(suffix) > 0 {
		suffixScore = textMatchScore(text[end:min(len(text), end+len(suffix))], suffix)
	}
	return (prefixScore + suffixScore) / 2
}

// textMatchScore is 1 minus the fewest edits that turn str into any substring
// of text, as a fraction of len(str). An empty text or str scores 0.
func textMatchScore(text, str []uint16) float64 {
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
