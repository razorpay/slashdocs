package textedit

import (
	"bytes"
	"cmp"
	"fmt"
	"slices"
	"strings"
	"unicode"
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
	// ReasonTags says that the replacements, as they apply to the live
	// document, put text into a tag or leave a tag that does not end.
	ReasonTags = "breaks_tags"
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
	case ReasonTags:
		return "the replacements would put text into a tag of the live document, or leave a tag that does not end"
	}
	return fmt.Sprintf("replacement %d: %s", e.Index, e.Reason)
}

// fit reports the first replacement that does not fit base, the state that
// the replacements were made on.
func fit(base Text, rs []Replacement) error {
	from := 0
	for i, r := range rs {
		switch {
		case r.Start < from || r.End < r.Start || r.End > base.Len() || !starts(base, r.Start) || !starts(base, r.End):
			return &ReplacementError{Index: i, Reason: ReasonRange}
		case !utf8.ValidString(r.OldHTML) || !utf8.ValidString(r.NewHTML):
			return &ReplacementError{Index: i, Reason: ReasonInvalid}
		case string(base.Slice(r.Start, r.End)) != r.OldHTML:
			return &ReplacementError{Index: i, Reason: ReasonMismatch}
		}
		from = r.End
	}
	return nil
}

// starts reports whether a character of t starts at i, or t ends there.
func starts(t Text, i int) bool {
	return i == t.Len() || utf8.RuneStart(t.Slice(i, i+1)[0])
}

// boundary reports whether a character of b starts at i, or b ends there.
func boundary(b []byte, i int) bool { return starts(Bytes(b), i) }

// ChangeSummary describes the change from before to after in one line. A
// change of one block of text, as one edit makes, is named by what a reader
// sees change first: a new or removed block, then a link or a format, then
// the words. A change of more blocks, as a sitting of typing makes, is named
// by the sections that changed. The line never shows markup or code.
func ChangeSummary(before, after []byte) string {
	a, b := outline(before), outline(after)
	changed := blockHunks(a.blocks, b.blocks)
	// The same words in other blocks are one change of structure, such as a
	// paragraph that was split.
	if a.words != b.words {
		if line := sectionChange(a.blocks, b.blocks, changed); line != "" {
			return line
		}
	}
	return describe(a, b, changed)
}

// Excerpt returns the sentence of base that holds the text that the
// replacement r changes, as a reader sees it: whole words with no tags, so
// that a person can find the place. A sentence ends at a stop that a space
// follows, or at the edge of a block. A long sentence is cut at whole words
// to about runes characters around that text.
func Excerpt(base Text, r Replacement, runes int) string {
	start, end := words(base, r.Start, r.End)
	from, to := max(start-excerptReach, 0), min(end+excerptReach, base.Len())
	for !starts(base, from) {
		from++
	}
	for !starts(base, to) {
		to--
	}
	before, part, after := shown(base, from, start), shown(base, start, end), shown(base, end, to)
	if i := strings.LastIndex(before, blockEdge); i >= 0 {
		before = before[i+len(blockEdge):]
	}
	if i := strings.Index(after, blockEdge); i >= 0 {
		after = after[:i]
	}
	for i := len(before) - 2; i >= 0; i-- {
		if stops(before, i) {
			before = before[i+1:]
			break
		}
	}
	for i := range len(after) - 1 {
		if stops(after, i) {
			after = after[:i+1]
			break
		}
	}
	before, part, after = squeeze(before), squeeze(part), squeeze(after)
	n := utf8.RuneCountInString(part)
	if n >= runes {
		return clip(strings.TrimSpace(part), runes)
	}
	before = clipStart(before, (runes-n)/2)
	after = clipEnd(after, runes-n-utf8.RuneCountInString(before))
	return strings.TrimSpace(before + part + after)
}

// excerptReach bounds the bytes on each side of a change in which Excerpt
// looks for the edges of its sentence.
const excerptReach = 1 << 10

// stops reports whether s has a stop at i that a space follows: the end of
// a sentence.
func stops(s string, i int) bool {
	return strings.IndexByte(".!?", s[i]) >= 0 && unicode.IsSpace(rune(s[i+1]))
}

// blockEdge marks the edge of a block in the words that shown returns. It
// is the paragraph separator of Unicode, a space.
const blockEdge = "\u2029"

// shown returns the words of base from start to end, with blockEdge at the
// edge of each block. The words of a part that starts in a tag start
// after that tag. The part can end in a tag.
func shown(base Text, start, end int) string {
	part := string(base.Slice(start, end))
	if inTag(base, start) {
		_, part, _ = strings.Cut(part, ">")
	}
	var text strings.Builder
	for part != "" {
		words, rest, _ := strings.Cut(part, "<")
		text.WriteString(words)
		tag, rest, _ := strings.Cut(rest, ">")
		if name, _, _ := strings.Cut(strings.TrimPrefix(tag, "/"), " "); separates[atom.Lookup([]byte(strings.ToLower(name)))] {
			text.WriteString(blockEdge)
		}
		part = rest
	}
	return html.UnescapeString(text.String())
}

// inTag reports whether at is in a tag of t: the last "<" or ">" before it
// is a "<". A ">" in text is thus not the end of a tag.
func inTag(t Text, at int) bool {
	const step = 1 << 10
	for at > 0 {
		from := max(at-step, 0)
		part := t.Slice(from, at)
		if i := bytes.LastIndexAny(part, "<>"); i >= 0 {
			return part[i] == '<'
		}
		at = from
	}
	return false
}

// squeeze makes each run of white space in s one space, also at its edges.
func squeeze(s string) string {
	var out strings.Builder
	space := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			space = true
			continue
		}
		if space {
			out.WriteByte(' ')
			space = false
		}
		out.WriteRune(r)
	}
	if space {
		out.WriteByte(' ')
	}
	return out.String()
}

// clipStart keeps the words at the end of s that fit in runes characters,
// after a mark that words go before them. Text with no space, as a long URL
// or a run of CJK characters, keeps the characters that fit.
func clipStart(s string, runes int) string {
	r := []rune(s)
	if len(r) <= runes {
		return s
	}
	s = string(r[len(r)-runes:])
	if _, words, cut := strings.Cut(s, " "); cut {
		s = words
	}
	return "…" + s
}

// clipEnd keeps the words at the start of s that fit in runes characters,
// before a mark that words follow them. Text with no space keeps the
// characters that fit.
func clipEnd(s string, runes int) string {
	r := []rune(s)
	if len(r) <= runes {
		return s
	}
	s = string(r[:runes])
	if space := strings.LastIndexByte(s, ' '); space >= 0 {
		s = s[:space]
	}
	return s + "…"
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

// page is what a reader sees of a document: its words, its blocks of text,
// the words of each element that the editor makes, by kind, and the tag and
// words of every element with words. The content of hidden elements, such
// as scripts, is kept only to tell that it changed.
type page struct {
	words    string
	blocks   []block
	elements map[string][]string
	marked   []element
	code     map[atom.Atom]string
}

// block is a block of text: the words between the edges of two block
// elements, and the words of the nearest heading before them. A heading is
// its own heading. intro says that the heading is the title of the document,
// the block is not that title, and sections come after it. A block under a
// title with no sections after it has no heading: it is in no part of the
// document.
type block struct {
	heading, words string
	intro          bool
}

// introduction names the blocks under the title of a document. The title
// names the document and not a part of it.
const introduction = "the introduction"

// section names the part of the document that k is in.
func (k block) section() string {
	if k.intro {
		return introduction
	}
	return clip(k.heading, headingRunes)
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

// headings holds the elements that name the blocks after them.
var headings = map[atom.Atom]bool{atom.H1: true, atom.H2: true, atom.H3: true, atom.H4: true, atom.H5: true, atom.H6: true}

// outline reads the page that doc shows.
func outline(doc []byte) page {
	o := outliner{page: page{elements: map[string][]string{}, code: map[atom.Atom]string{}}}
	root, err := html.Parse(bytes.NewReader(doc))
	if err != nil {
		return o.page
	}
	o.text.Grow(len(doc))
	o.walk(root)
	o.endBlock()
	o.words = o.wordsFrom(0)
	if !o.sectioned {
		for i, k := range o.blocks {
			if k.intro {
				o.blocks[i] = block{words: k.words}
			}
		}
	}
	return o.page
}

// outliner reads a page from the nodes of a document, in order.
type outliner struct {
	page
	// text holds the words so far, with one space between two words. The
	// words of an element are thus a part of it and not a copy, and a deep
	// document costs its text one time.
	text strings.Builder
	// The text from blockStart on is of the block that is not complete yet.
	blockStart int
	heading    string
	// titled says that the document has a title: its first h1. intro says
	// that heading is that title. sectioned says that the document has a
	// heading that is not the title.
	titled, intro, sectioned bool
}

// space writes a space after the last word, when there is none.
func (o *outliner) space() {
	if s := o.text.String(); s != "" && s[len(s)-1] != ' ' {
		o.text.WriteByte(' ')
	}
}

// wordsFrom returns the words of the text from the byte from on.
func (o *outliner) wordsFrom(from int) string { return strings.Trim(o.text.String()[from:], " ") }

// endBlock completes the block that the text from blockStart on holds.
func (o *outliner) endBlock() {
	if words := o.wordsFrom(o.blockStart); words != "" {
		o.blocks = append(o.blocks, block{heading: o.heading, words: words, intro: o.intro && words != o.heading})
	}
	o.blockStart = o.text.Len()
}

// walk reads n and the nodes in it.
func (o *outliner) walk(n *html.Node) {
	switch {
	case n.Type == html.TextNode:
		o.addText(n.Data)
		return
	case hidden[n.DataAtom]:
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			o.code[n.DataAtom] += c.Data
		}
		return
	}
	block := separates[n.DataAtom]
	// A line break separates words in one block.
	edge := block && n.DataAtom != atom.Br
	if block {
		o.space()
	}
	if edge {
		o.endBlock()
	}
	from := o.text.Len()
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		o.walk(c)
	}
	words := o.wordsFrom(from)
	if headings[n.DataAtom] && words != "" {
		o.heading = words
		o.intro = n.DataAtom == atom.H1 && !o.titled
		o.titled = o.titled || o.intro
		o.sectioned = o.sectioned || !o.intro
	}
	if edge {
		o.endBlock()
	}
	o.addElement(n, words)
	if block {
		o.space()
	}
}

// addText adds the words of a text node, with a space where it starts or
// ends with a space.
func (o *outliner) addText(data string) {
	words := strings.Fields(data)
	if first, _ := utf8.DecodeRuneInString(data); len(words) == 0 || unicode.IsSpace(first) {
		o.space()
	}
	o.text.WriteString(strings.Join(words, " "))
	if last, _ := utf8.DecodeLastRuneInString(data); unicode.IsSpace(last) {
		o.space()
	}
}

// addElement adds n, whose words are words, to the elements of its kind and
// to the elements with words.
func (o *outliner) addElement(n *html.Node, words string) {
	if kind, ok := kinds[n.DataAtom]; ok {
		o.elements[kind] = append(o.elements[kind], words)
	}
	if n.Type == html.ElementNode && words != "" {
		o.marked = append(o.marked, element{tag: n.DataAtom, attrs: fmt.Sprint(n.Attr), words: words})
	}
}

// hunk is a run of blocks that differ between two pages: gone became come.
type hunk struct{ gone, come []block }

// blockHunks returns the runs of blocks that differ between a and b, in
// order.
func blockHunks(a, b []block) []hunk {
	var out []hunk
	hunks(blockWords(a), blockWords(b), func(a0, a1, b0, b1 int) {
		out = append(out, hunk{gone: a[a0:a1], come: b[b0:b1]})
	})
	return out
}

// sectionChange names a change of more than one block by where it is. A run
// of new blocks that starts with a heading which a does not have is a new
// section, and the reverse is a removed one. Else the line names the
// headings above the changed blocks, in the order of the document. It
// returns "" for a change of one block.
func sectionChange(a, b []block, changed []hunk) string {
	if len(changed) == 1 {
		if line := wholeSection(a, b, changed[0]); line != "" {
			return line
		}
	}
	var names []string
	count, unnamed := 0, false
	for _, h := range changed {
		count += max(len(h.gone), len(h.come))
		// The blocks that a hunk only removes are no longer in b.
		blocks := h.come
		if len(blocks) == 0 {
			blocks = h.gone
		}
		for _, k := range blocks {
			switch name := k.section(); {
			case name == "":
				unnamed = true
			case !slices.Contains(names, name):
				names = append(names, name)
			}
		}
	}
	last := len(names) - 1
	switch {
	case count < 2:
		return ""
	case last < 0:
		return "Edited the document"
	case last > 2 || unnamed:
		return "Edited " + strings.Join(names[:min(len(names), 2)], ", ") + " and other sections"
	case last == 0:
		return "Edited " + names[0]
	}
	return "Edited " + strings.Join(names[:last], ", ") + " and " + names[last]
}

// wholeSection names h when it adds a section that a does not have, or
// removes one that b does not have. Else it returns "".
func wholeSection(a, b []block, h hunk) string {
	if name := section(h.come, a); len(h.gone) == 0 && name != "" {
		return "Added the section " + quote(name)
	}
	if name := section(h.gone, b); len(h.come) == 0 && name != "" {
		return "Removed the section " + quote(name)
	}
	return ""
}

// section returns the heading that starts blocks, when no block of rest is
// under that heading. Else it returns "".
func section(blocks, rest []block) string {
	start := first(blocks)
	if start.words == "" || start.words != start.heading || slices.ContainsFunc(rest, func(k block) bool { return k.heading == start.heading }) {
		return ""
	}
	return start.heading
}

// first returns the first of blocks, or a block with no words.
func first(blocks []block) block {
	if len(blocks) == 0 {
		return block{}
	}
	return blocks[0]
}

func blockWords(blocks []block) []string {
	out := make([]string, len(blocks))
	for i, k := range blocks {
		out[i] = k.words
	}
	return out
}

// hunkCells caps the table of hunks, which is 4 bytes for each cell.
const hunkCells = 1 << 22

// hunks calls change for each run of items that differ between a and b, in
// order: a[a0:a1] became b[b0:b1]. The items between the runs are a longest
// list of items that a and b both have, in order. Lists that are too long
// to compare differ in all that is between the items that start both and
// the items that end both.
func hunks(a, b []string, change func(a0, a1, b0, b1 int)) {
	head, tail := shared(a, b)
	x, y := a[head:len(a)-tail], b[head:len(b)-tail]
	if len(x)*len(y) > hunkCells {
		change(head, len(a)-tail, head, len(b)-tail)
		return
	}
	length := common(x, y)
	differ := func(i, j int) bool { return i == len(x) || j == len(y) || x[i] != y[j] }
	for i, j := 0, 0; i < len(x) || j < len(y); i, j = i+1, j+1 {
		a0, b0 := i, j
		for (i < len(x) || j < len(y)) && differ(i, j) {
			if j == len(y) || i < len(x) && length[i+1][j] >= length[i][j+1] {
				i++
			} else {
				j++
			}
		}
		if i > a0 || j > b0 {
			change(head+a0, head+i, head+b0, head+j)
		}
	}
}

// common returns the table length: length[i][j] is the number of items
// that x[i:] and y[j:] both have, in order.
func common(x, y []string) [][]int32 {
	length := make([][]int32, len(x)+1)
	for i := range length {
		length[i] = make([]int32, len(y)+1)
	}
	for i := len(x) - 1; i >= 0; i-- {
		for j := len(y) - 1; j >= 0; j-- {
			if x[i] == y[j] {
				length[i][j] = length[i+1][j+1] + 1
			} else {
				length[i][j] = max(length[i+1][j], length[i][j+1])
			}
		}
	}
	return length
}

// describe names the change from a to b. A new or removed block comes
// first, then a link or a format, then the words.
func describe(a, b page, changed []hunk) string {
	if line := blockChange(a, b); line != "" {
		return line
	}
	if line := formatChange(a, b); line != "" {
		return line
	}
	if a.words != b.words {
		return wordChange(a, b, changed)
	}
	return markupChange(a, b)
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

// wordChange names the words that a change of one block adds, removes or
// replaces. A quote holds only words that are together. A paragraph with
// more than half of its words changed, in more than one place or in more
// words than a quote holds, is rewritten. Else words that changed in more
// than one place are named by their heading.
func wordChange(a, b page, changed []hunk) string {
	before, after := differing(a.words, b.words)
	added, removed := grown(before, after), grown(after, before)
	if added == "" && removed == "" {
		var line string
		if removed, added, line = blockWordChange(changed); line != "" {
			return line
		}
	}
	switch {
	case removed == "":
		return "Added " + quote(added)
	case added == "":
		return "Removed " + quote(removed)
	}
	removed, added = withoutSharedEnd(removed, added)
	return "Changed " + quote(removed) + " to " + quote(added)
}

// withoutSharedEnd takes the punctuation that a and b both end with off
// them, as the stop of a sentence: the person did not change it. Each keeps
// a character.
func withoutSharedEnd(a, b string) (string, string) {
	for {
		r, n := utf8.DecodeLastRuneInString(a)
		if s, _ := utf8.DecodeLastRuneInString(b); r != s || !unicode.IsPunct(r) || n == len(a) || n == len(b) {
			return a, b
		}
		a, b = a[:len(a)-n], b[:len(b)-n]
	}
}

// blockWordChange returns the words that a change of one block removes and
// adds. When the change is not at one place, or rewrites the block, line
// names it by its heading.
func blockWordChange(changed []hunk) (removed, added, line string) {
	// The change is of one block, or of a block that came or went.
	var old, now block
	if len(changed) == 1 {
		old, now = first(changed[0].gone), first(changed[0].come)
	}
	x, y := strings.Fields(old.words), strings.Fields(now.words)
	var gone, come []string
	places := 0
	hunks(x, y, func(x0, x1, y0, y1 int) {
		places++
		gone, come = append(gone, x[x0:x1]...), append(come, y[y0:y1]...)
	})
	removed, added = strings.Join(gone, " "), strings.Join(come, " ")
	most := 2*max(len(gone), len(come)) > max(len(x), len(y))
	long := clip(removed, summaryRunes) != removed || clip(added, summaryRunes) != added
	// One quote of each side holds a change at one place, when it is not
	// too long. A heading is not a paragraph.
	rewrote := most && (places > 1 || long) && now.words != now.heading
	heading := cmp.Or(now.section(), old.section())
	switch {
	case places == 1 && !rewrote:
	case rewrote && heading == "":
		line = "Rewrote a paragraph"
	case rewrote && heading == introduction:
		line = "Rewrote a paragraph in " + heading
	case rewrote:
		line = "Rewrote a paragraph in " + quote(heading)
	case heading == "":
		line = "Edited the document"
	default:
		line = "Edited " + heading
	}
	return removed, added, line
}

// markupChange names the hidden content or the element that a change of no
// words changes.
func markupChange(a, b page) string {
	switch {
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

// grown returns the words that long has and short does not, when long is
// short with text put in at one place. Else it returns "". A word that the
// text starts, completes or ends counts whole: "whil" to "while the agent"
// gives "while the agent". Text that goes in between the letters of a word
// on both of its sides is not only new words: "the" to "tx The lohe" changes
// a word. Punctuation next to the text is not a part of it: "end." to "end
// of it." gives "of it".
func grown(short, long string) string {
	if len(long) <= len(short) {
		return ""
	}
	head := 0
	for head < len(short) && short[head] == long[head] {
		head++
	}
	tail := 0
	for tail < len(short)-head && short[len(short)-1-tail] == long[len(long)-1-tail] {
		tail++
	}
	if head+tail < len(short) {
		return ""
	}
	from, to := head, len(long)-tail
	for from > 0 && (!utf8.RuneStart(long[from]) || inWord(long, from)) {
		from--
	}
	for to < len(long) && (!utf8.RuneStart(long[to]) || inWord(long, to)) {
		to++
	}
	if from < head && to > len(long)-tail {
		return ""
	}
	return strings.TrimSpace(long[from:to])
}

// inWord reports whether the characters of s before i and at i are letters
// or numbers: i is in a word.
func inWord(s string, i int) bool {
	before, _ := utf8.DecodeLastRuneInString(s[:i])
	after, _ := utf8.DecodeRuneInString(s[i:])
	return letter(before) && letter(after)
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
