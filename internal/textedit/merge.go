package textedit

import (
	"bytes"
	"cmp"
	"slices"
	"strings"
	"unicode/utf8"
)

// Merge applies the replacements made on base to latest, a later version of
// the same document. It never refuses for a concurrent change: it puts the
// changes of latest and the replacements together, at their places in base.
// Text that both insert at one point stays twice, that of the replacements
// first: a writer who types on then adds to the end of their own text, and
// the text of the other writer is not in the way there. Text that goes in at
// a point comes before a change that takes out the bytes from that point.
// Bytes that either deletes go, and text that the other inserted between
// them stays.
func Merge(base, latest []byte, rs []Replacement) ([]byte, error) {
	if err := fit(base, rs); err != nil {
		return nil, err
	}
	all := make([]Replacement, len(rs))
	for i, r := range rs {
		all[i] = atTag(base, minimal(r))
	}
	// The sort is stable, so the replacements come first at a shared start.
	all = append(all, Between(base, latest)...)
	slices.SortStableFunc(all, func(a, b Replacement) int {
		return cmp.Or(cmp.Compare(a.Start, b.Start), cmp.Compare(min(a.End-a.Start, 1), min(b.End-b.Start, 1)))
	})
	var out bytes.Buffer
	copied := 0
	for _, r := range all {
		// A replacement can start in bytes that the one before deleted.
		out.Write(base[copied:max(copied, r.Start)])
		out.WriteString(r.NewHTML)
		copied = max(copied, r.End)
	}
	out.Write(base[copied:])
	return out.Bytes(), nil
}

// Between returns the replacements that turn a into b, in order and at byte
// offsets of a. Each one is minimal and starts and ends at character
// boundaries of both texts.
//
// A byte diff of a long insertion can keep a byte of the old text by chance,
// and the insertion is then in parts around that byte. Text that another
// writer types at that place would go between the parts. So two changes
// become one when that one is only an insertion or only a deletion. Two
// changes around text that both versions keep stay two, so that a writer
// can still change that text.
func Between(a, b []byte) []Replacement {
	rs := []Replacement{}
	shift := 0
	for _, c := range widen(a, b, diff(a, b)) {
		at := c.start + shift
		r := minimal(Replacement{Start: c.start, End: c.end, OldHTML: string(a[c.start:c.end]), NewHTML: string(b[at : at+c.size])})
		shift += c.size - (c.end - c.start)
		// Changes with no byte between them are one change.
		if n := len(rs); n > 0 && rs[n-1].End == r.Start {
			r = Replacement{Start: rs[n-1].Start, End: r.End, OldHTML: rs[n-1].OldHTML + r.OldHTML, NewHTML: rs[n-1].NewHTML + r.NewHTML}
			rs = rs[:n-1]
		}
		rs = append(rs, r)
	}
	out := rs[:0]
	for _, r := range rs {
		r = atTag(a, r)
		// Only a short run of kept bytes is there by chance.
		if n := len(out); n > 0 && r.Start-out[n-1].End <= min(out[n-1].span(), r.span()) {
			p := out[n-1]
			one := minimal(Replacement{Start: p.Start, End: r.End, OldHTML: string(a[p.Start:r.End]), NewHTML: p.NewHTML + string(a[p.End:r.Start]) + r.NewHTML})
			if one.OldHTML == "" || one.NewHTML == "" {
				out[n-1] = one
				continue
			}
		}
		out = append(out, r)
	}
	return out
}

// atTag moves an insertion or a deletion of markup to where it starts with
// a tag. A new paragraph before "<p>omega" can be the text "<p>new</p>"
// before that tag, or "new</p><p>" after it, with the same result. The
// second is at the point where a writer types at the start of "omega", so
// the first is the one to use: the two changes are then at two points.
func atTag(base []byte, r Replacement) Replacement {
	text := r.OldHTML + r.NewHTML
	if r.OldHTML != "" && r.NewHTML != "" || text == "" || text[0] == '<' {
		return r
	}
	// The change can move back while the byte before it is its last byte.
	for k := 1; k <= len(text) && k <= r.Start && base[r.Start-k] == text[len(text)-k]; k++ {
		if base[r.Start-k] != '<' {
			continue
		}
		text = text[len(text)-k:] + text[:len(text)-k]
		r.Start, r.End = r.Start-k, r.End-k
		if r.OldHTML != "" {
			r.OldHTML = text
		} else {
			r.NewHTML = text
		}
		break
	}
	return r
}

// span is the larger of the bytes that r takes out and the bytes that it
// puts in.
func (r Replacement) span() int { return max(len(r.OldHTML), len(r.NewHTML)) }

// minimal cuts from r the whole characters that start or end both its old
// and its new HTML. People who type in one word then do not replace the same
// word.
func minimal(r Replacement) Replacement {
	for {
		_, n := utf8.DecodeRuneInString(r.OldHTML)
		if n == 0 || !strings.HasPrefix(r.NewHTML, r.OldHTML[:n]) {
			break
		}
		r.Start, r.OldHTML, r.NewHTML = r.Start+n, r.OldHTML[n:], r.NewHTML[n:]
	}
	for {
		_, n := utf8.DecodeLastRuneInString(r.OldHTML)
		kept := len(r.OldHTML) - n
		if n == 0 || !strings.HasSuffix(r.NewHTML, r.OldHTML[kept:]) {
			break
		}
		r.End, r.OldHTML, r.NewHTML = r.End-n, r.OldHTML[:kept], r.NewHTML[:len(r.NewHTML)-n]
	}
	return r
}

// widen moves the ends of the changes from a to b to character boundaries of
// both texts. A byte diff can cut a character where two characters share a
// byte. Two changes with no boundary between them become one.
func widen(a, b []byte, changes []change) []change {
	out := make([]change, 0, len(changes)+1)
	// from is where the change before ends in a, and shift is how far the
	// changes before moved the bytes after them.
	from, shift := 0, 0
	// A change of no bytes at the end of a widens the end of the last change.
	for _, c := range append(changes, change{len(a), len(a), 0}) {
		// The bytes between two changes are the same in both texts.
		whole := func(i int) bool { return boundary(a, i) && boundary(b, i+shift) }
		lo, hi := from, c.start
		for lo < hi && !whole(lo) {
			lo++
		}
		for hi > lo && !whole(hi) {
			hi--
		}
		grown := c
		if n := len(out); n > 0 && !whole(lo) {
			grown.start, grown.size = out[n-1].start, out[n-1].size+c.start-from+c.size
			out = out[:n-1]
		} else {
			if n > 0 {
				out[n-1].end, out[n-1].size = lo, out[n-1].size+lo-from
			}
			grown.start, grown.size = hi, c.size+c.start-hi
		}
		out = append(out, grown)
		from, shift = c.end, shift+c.size-(c.end-c.start)
	}
	return out[:len(out)-1]
}
