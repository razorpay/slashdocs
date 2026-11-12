package server

import (
	"cmp"
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
	// targets holds the data-slashdocs-target values and ids of the
	// version's elements, for point comments.
	targets map[string]bool
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

func (d *placementDoc) hasTarget(target string) bool {
	if d.targets == nil {
		d.targets = elementTargets(d.html)
	}
	return d.targets[target]
}

// elementTargets returns the data-slashdocs-target values and ids of the
// elements in doc, the names that a point comment gives its element.
func elementTargets(doc string) map[string]bool {
	out := map[string]bool{}
	root, err := html.Parse(strings.NewReader(doc))
	if err != nil {
		return out
	}
	for n := range root.Descendants() {
		for _, a := range n.Attr {
			if a.Namespace == "" && (a.Key == "data-slashdocs-target" || a.Key == "id") {
				out[a.Val] = true
			}
		}
	}
	return out
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
//
// A point is placed while its element is there: by its target, or else by
// the start of its text, as a quote. A point with neither is placed by its
// path, which only the viewer can follow, or is on the body, so it counts as
// placed.
func placedOn(cm repo.Comment, doc *placementDoc) bool {
	if p := cm.Anchor.Point; p != nil {
		if p.Target != "" && doc.hasTarget(p.Target) {
			return true
		}
		if cm.SelectedText == "" {
			return p.Target == ""
		}
	}
	_, _, ok := textPlace(doc.renderedText(), cm.Anchor, cmp.Or(cm.Anchor.Quote, cm.SelectedText))
	return ok
}

// textPlace returns where the viewer places a quote of the anchor a in
// text, as start and end in its units. Like the viewer, only verbatim text
// places a comment. The text is the rendered text of a version, so a quote
// across tags or with entities is found too.
func textPlace(text renderedText, a repo.Anchor, quote string) (start, end int, ok bool) {
	units := utf16.Encode([]rune(quote))
	if start, end, ok := storedPlace(text, a, units); ok {
		return start, end, true
	}
	copies := indexAll(text.units, units)
	repeatedInContext := occursMoreThanOnce(a.Prefix+quote+a.Suffix, quote)
	switch {
	case len(copies) == 0:
		return 0, 0, false
	case len(copies) == 1 && !repeatedInContext:
		return copies[0], copies[0] + len(units), true
	}
	prefix := utf16.Encode([]rune(a.Prefix))
	suffix := utf16.Encode([]rune(a.Suffix))
	for _, start := range copies {
		if contextScore(text.units, start, start+len(units), prefix, suffix) >= minContextScoreForAmbiguousQuote {
			return start, start + len(units), true
		}
	}
	return 0, 0, false
}

// storedPlace returns the stored offsets of the anchor in text when the
// quote is still there, the first tier of the viewer. The offsets count raw
// textContent, which has no character for a <br>.
func storedPlace(text renderedText, a repo.Anchor, quote []uint16) (start, end int, ok bool) {
	if a.StartOffset < 0 || a.EndOffset <= a.StartOffset {
		return 0, 0, false
	}
	start = rawOffsetToRendered(text.brs, a.StartOffset)
	end = rawOffsetToRendered(text.brs, a.EndOffset)
	if end > len(text.units) {
		return 0, 0, false
	}
	at := text.units[start:end]
	ok = slices.Equal(at, quote) || normalizeSpace(string(utf16.Decode(at))) == normalizeSpace(string(utf16.Decode(quote)))
	return start, end, ok
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
