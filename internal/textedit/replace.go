package textedit

import (
	"bytes"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// Replacement replaces the bytes from Start to End of the version it was made
// on, which must be OldHTML, with NewHTML. Offsets count UTF-8 bytes, and End
// is exclusive. Unlike an Edit, OldHTML need not be unique: the position
// finds it.
type Replacement struct {
	Start   int    `json:"start"`
	End     int    `json:"end"`
	OldHTML string `json:"old_html"`
	NewHTML string `json:"new_html"`
}

// Reasons a replacement does not fit its version, besides ReasonUnchanged and
// ReasonInvalid.
const (
	ReasonRange    = "invalid_range"
	ReasonMismatch = "old_html_mismatch"
)

// ReplacementError reports the replacement that does not fit the version it
// was made on. Index counts from zero.
type ReplacementError struct {
	Index  int    `json:"index"`
	Reason string `json:"reason"`
}

func (e *ReplacementError) Error() string {
	switch e.Reason {
	case ReasonRange:
		return fmt.Sprintf("replacement %d: start and end must be in order, after the replacement before, and on character boundaries of the base version", e.Index)
	case ReasonMismatch:
		return fmt.Sprintf("replacement %d: old_html is not the HTML from start to end of the base version", e.Index)
	case ReasonInvalid:
		return fmt.Sprintf("replacement %d: old_html or new_html is not valid UTF-8", e.Index)
	case ReasonUnchanged:
		return "every replacement keeps its HTML the same"
	}
	return fmt.Sprintf("replacement %d: %s", e.Index, e.Reason)
}

// ConflictError reports a replacement whose HTML a later version changed.
type ConflictError struct {
	Index int
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("replacement %d: a newer version changed the same part of the document", e.Index)
}

// Replace applies replacements made on base to latest, a later version of the
// same document, and returns the result. The replacements must be in order
// and must not overlap. When latest differs from base, a byte diff of the two
// moves each replacement to where its HTML is in latest. A replacement that a
// change overlaps is refused, and so is an insertion at the point where the
// change inserts. Either all replacements apply or none do.
func Replace(base, latest []byte, rs []Replacement) ([]byte, error) {
	if err := fit(base, rs); err != nil {
		return nil, err
	}
	var changes []change
	if !bytes.Equal(base, latest) {
		changes = diff(base, latest)
	}
	var out bytes.Buffer
	// copied counts the bytes of latest in out, and shift is how far the
	// changes before the current replacement moved it.
	copied, shift := 0, 0
	for i, r := range rs {
		for ; len(changes) > 0 && changes[0].end <= r.Start && !changes[0].touches(r); changes = changes[1:] {
			shift += changes[0].size - (changes[0].end - changes[0].start)
		}
		start, end := r.Start+shift, r.End+shift
		if len(changes) > 0 && changes[0].touches(r) || end > len(latest) || string(latest[start:end]) != r.OldHTML {
			return nil, &ConflictError{Index: i}
		}
		out.Write(latest[copied:start])
		out.WriteString(r.NewHTML)
		copied = end
	}
	out.Write(latest[copied:])
	return out.Bytes(), nil
}

// touches reports whether c changes bytes of r, or inserts at the point
// where r inserts.
func (c change) touches(r Replacement) bool {
	return c.start < r.End && r.Start < c.end || c.start == c.end && r.Start == r.End && c.start == r.Start
}

// fit reports the first replacement that does not fit base, or that every
// replacement keeps its HTML.
func fit(base []byte, rs []Replacement) error {
	changed, from := false, 0
	for i, r := range rs {
		switch {
		case r.Start < from || r.End < r.Start || r.End > len(base) || !boundary(base, r.Start) || !boundary(base, r.End):
			return &ReplacementError{Index: i, Reason: ReasonRange}
		case !utf8.ValidString(r.OldHTML) || !utf8.ValidString(r.NewHTML):
			return &ReplacementError{Index: i, Reason: ReasonInvalid}
		case string(base[r.Start:r.End]) != r.OldHTML:
			return &ReplacementError{Index: i, Reason: ReasonMismatch}
		}
		changed, from = changed || r.OldHTML != r.NewHTML, r.End
	}
	if !changed {
		return &ReplacementError{Reason: ReasonUnchanged}
	}
	return nil
}

// boundary reports whether a character of b starts at i, or b ends there.
func boundary(b []byte, i int) bool {
	return i == len(b) || utf8.RuneStart(b[i])
}

// ReplacementSummary describes the replacements made on base in one line
// for each edit, by what a reader sees change, for version history when the
// caller gave no change summary. An edit is one replacement, or the
// replacements from one that opens an element to the one that closes it,
// such as the start and end tags of a new bold. A replacement can start
// inside a tag or a script, so each line compares the whole document before
// and after the edit, and never shows markup or code.
func ReplacementSummary(base []byte, rs []Replacement) string {
	before := outline(base)
	var lines []string
	for len(rs) > 0 {
		n, open := 1, opens(base, rs[0])
		for ; open != 0 && n < len(rs); n++ {
			open += opens(base, rs[n])
		}
		lines = append(lines, describe(before, outline(apply(base, rs[:n]))))
		rs = rs[n:]
	}
	return strings.Join(lines, "\n")
}

// ChangeSummary describes the change from before to after in one line, by
// what a reader sees change first, as ReplacementSummary does for an edit.
func ChangeSummary(before, after []byte) string {
	return describe(outline(before), outline(after))
}

// apply makes the replacements on base, which they fit.
func apply(base []byte, rs []Replacement) []byte {
	var out bytes.Buffer
	copied := 0
	for _, r := range rs {
		out.Write(base[copied:r.Start])
		out.WriteString(r.NewHTML)
		copied = r.End
	}
	out.Write(base[copied:])
	return out.Bytes()
}

// opens counts the elements that a replacement opens and does not close,
// less those that it closes and does not open. The tags that it starts or
// ends inside are made whole from base.
func opens(base []byte, r Replacement) int {
	head, tail := base[:r.Start], base[r.End:]
	if lt := bytes.LastIndexByte(head, '<'); lt > bytes.LastIndexByte(head, '>') {
		head = head[lt:]
	} else {
		head = nil
	}
	if gt, lt := bytes.IndexByte(tail, '>'), bytes.IndexByte(tail, '<'); gt >= 0 && (lt < 0 || gt < lt) {
		tail = tail[:gt+1]
	} else {
		tail = nil
	}
	depth := func(fragment string) (n int) {
		z := html.NewTokenizer(bytes.NewReader(slices.Concat(head, []byte(fragment), tail)))
		for {
			switch z.Next() {
			case html.ErrorToken:
				return n
			case html.StartTagToken:
				if name, _ := z.TagName(); !void[atom.Lookup(name)] {
					n++
				}
			case html.EndTagToken:
				n--
			}
		}
	}
	return depth(r.NewHTML) - depth(r.OldHTML)
}

// void holds the elements that have no end tag.
var void = map[atom.Atom]bool{
	atom.Area: true, atom.Base: true, atom.Br: true, atom.Col: true, atom.Embed: true, atom.Hr: true,
	atom.Img: true, atom.Input: true, atom.Link: true, atom.Meta: true, atom.Source: true,
	atom.Track: true, atom.Wbr: true,
}

// page is what a reader sees of a document: its words, the words of each
// element that the editor makes, by kind, and the tag and words of every
// element with words. The content of hidden elements, such as scripts, is
// kept only to tell that it changed.
type page struct {
	words    string
	elements map[string][]string
	marked   []element
	code     map[atom.Atom]string
}

// element is an element with words: its tag, its attributes and its words.
type element struct {
	tag   atom.Atom
	attrs string
	words string
}

// kinds names the elements that a summary names, by what they make.
var kinds = map[atom.Atom]string{
	atom.P: "paragraph", atom.Li: "list item", atom.Ul: "bulleted list", atom.Ol: "numbered list",
	atom.A: "link", atom.B: "bold", atom.Strong: "bold", atom.I: "italic", atom.Em: "italic",
}

// hidden holds the elements whose content a reader does not see as text.
var hidden = map[atom.Atom]bool{
	atom.Script: true, atom.Style: true, atom.Noscript: true, atom.Template: true,
	atom.Iframe: true, atom.Noembed: true, atom.Noframes: true, atom.Xmp: true,
}

// outline reads the page that doc shows.
func outline(doc []byte) page {
	p := page{elements: map[string][]string{}, code: map[atom.Atom]string{}}
	root, err := html.Parse(bytes.NewReader(doc))
	if err != nil {
		return p
	}
	var text strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			text.WriteString(n.Data)
			return
		}
		if hidden[n.DataAtom] {
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				p.code[n.DataAtom] += c.Data
			}
			return
		}
		block := separates[n.DataAtom]
		if block {
			text.WriteByte(' ')
		}
		from := text.Len()
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		words := spaced(text.String()[from:])
		if kind, ok := kinds[n.DataAtom]; ok {
			p.elements[kind] = append(p.elements[kind], words)
		}
		if n.Type == html.ElementNode && words != "" {
			p.marked = append(p.marked, element{tag: n.DataAtom, attrs: fmt.Sprint(n.Attr), words: words})
		}
		if block {
			text.WriteByte(' ')
		}
	}
	walk(root)
	p.words = spaced(text.String())
	return p
}

// describe names the change from a to b. A new or removed block comes
// first, then a link or a format, then the words.
func describe(a, b page) string {
	if line := blockChange(a, b); line != "" {
		return line
	}
	if line := formatChange(a, b); line != "" {
		return line
	}
	return wordChange(a, b)
}

// blockChange names a paragraph, list item or list that the change adds or
// removes. With the same words, a new block splits one, and so on.
func blockChange(a, b page) string {
	same := a.words == b.words
	for _, kind := range []string{"bulleted list", "numbered list", "paragraph", "list item"} {
		list := strings.HasSuffix(kind, " list")
		switch more := len(b.elements[kind]) - len(a.elements[kind]); {
		case more > 0 && same && list:
			return named("Made a "+kind, only(b, a, kind))
		case more > 0 && same && only(b, a, kind) != "":
			return named("Split a "+kind, only(a, b, kind))
		case more > 0:
			return named("Added a "+kind, only(b, a, kind))
		case more < 0 && same && list:
			return named("Changed a "+kind+" to paragraphs", only(a, b, kind))
		case more < 0 && same:
			return named("Joined two "+kind+"s", only(b, a, kind))
		case more < 0:
			return named("Removed a "+kind, only(a, b, kind))
		}
	}
	return ""
}

// formatChange names a link, bold or italic that the change adds or removes,
// or, with the same words, one that it moves.
func formatChange(a, b page) string {
	same := a.words == b.words
	for _, f := range []struct{ kind, made, unmade string }{
		{"link", "Linked %s", "Removed the link from %s"},
		{"bold", "Made %s bold", "Removed bold from %s"},
		{"italic", "Made %s italic", "Removed italic from %s"},
	} {
		more := len(b.elements[f.kind]) - len(a.elements[f.kind])
		switch added, removed := only(b, a, f.kind), only(a, b, f.kind); {
		case added != "" && (more > 0 || more == 0 && same):
			return fmt.Sprintf(f.made, quote(added))
		case removed != "" && more < 0:
			return fmt.Sprintf(f.unmade, quote(removed))
		}
	}
	return ""
}

// wordChange names the words that the change adds, removes or replaces, or
// else the hidden content or the element that it changes.
func wordChange(a, b page) string {
	before, after := differing(a.words, b.words)
	switch {
	case before == "" && after != "":
		return "Added " + quote(after)
	case after == "" && before != "":
		return "Removed " + quote(before)
	case a.words != b.words:
		return "Changed " + quote(before) + " to " + quote(after)
	case a.code[atom.Script] != b.code[atom.Script]:
		return "Changed a script"
	case a.code[atom.Style] != b.code[atom.Style]:
		return "Changed the styles"
	}
	switch e := extra(b.marked, a.marked); {
	case e.tag == atom.A:
		return "Changed the link on " + quote(e.words)
	case e.words != "":
		return "Changed the formatting of " + quote(e.words)
	}
	return "Changed the HTML only"
}

// only returns the words of the first element of kind that a has more of
// than b.
func only(a, b page, kind string) string {
	return extra(a.elements[kind], b.elements[kind])
}

// extra returns the first item of a that b has fewer of, or else the zero
// value.
func extra[T comparable](a, b []T) T {
	left := map[T]int{}
	for _, item := range b {
		left[item]++
	}
	for _, item := range a {
		if left[item] == 0 {
			return item
		}
		left[item]--
	}
	var none T
	return none
}

// named adds the words of an element to the start of a line, when it has
// words.
func named(line, words string) string {
	if words == "" {
		return line
	}
	return line + ": " + quote(words)
}

// spaced returns s with single spaces between its words.
func spaced(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// separates holds the elements whose edges separate words: blocks and br.
var separates = map[atom.Atom]bool{
	atom.Address: true, atom.Article: true, atom.Aside: true, atom.Blockquote: true, atom.Br: true,
	atom.Caption: true, atom.Dd: true, atom.Details: true, atom.Div: true, atom.Dl: true, atom.Dt: true,
	atom.Fieldset: true, atom.Figcaption: true, atom.Figure: true, atom.Footer: true, atom.Form: true,
	atom.H1: true, atom.H2: true, atom.H3: true, atom.H4: true, atom.H5: true, atom.H6: true,
	atom.Header: true, atom.Hr: true, atom.Li: true, atom.Main: true, atom.Nav: true, atom.Ol: true,
	atom.P: true, atom.Pre: true, atom.Section: true, atom.Summary: true, atom.Table: true,
	atom.Td: true, atom.Th: true, atom.Tr: true, atom.Ul: true,
}
