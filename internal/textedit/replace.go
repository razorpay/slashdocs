package textedit

import (
	"bytes"
	"fmt"
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

// ReplacementSummary describes the replacements in one line each, by the
// words they change, for version history when the caller gave no change
// summary.
func ReplacementSummary(rs []Replacement) string {
	lines := make([]string, 0, len(rs))
	for _, r := range rs {
		before, after := words(r.OldHTML), words(r.NewHTML)
		switch {
		case before == "" && after == "":
			lines = append(lines, "Changed the formatting")
		case before == after:
			lines = append(lines, fmt.Sprintf("Changed the formatting of %q", clip(before)))
		case before == "":
			lines = append(lines, fmt.Sprintf("Added %q", clip(after)))
		case after == "":
			lines = append(lines, fmt.Sprintf("Removed %q", clip(before)))
		default:
			before, after = excerpts(before, after)
			lines = append(lines, fmt.Sprintf("Replaced %q with %q", before, after))
		}
	}
	return strings.Join(lines, "\n")
}

// words returns the text of an HTML fragment with single spaces between its
// words. Tags and comments go, entities are decoded, and the edges of blocks
// and line breaks separate words.
func words(fragment string) string {
	var text strings.Builder
	z := html.NewTokenizer(strings.NewReader(fragment))
	for {
		switch z.Next() {
		case html.ErrorToken:
			return strings.Join(strings.Fields(text.String()), " ")
		case html.TextToken:
			text.Write(z.Text())
		case html.StartTagToken, html.EndTagToken, html.SelfClosingTagToken:
			if name, _ := z.TagName(); separates[atom.Lookup(name)] {
				text.WriteByte(' ')
			}
		}
	}
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
