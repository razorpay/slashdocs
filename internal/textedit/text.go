package textedit

import (
	"bytes"
	"sort"
)

// Text is a state of a document, as the functions that move replacements
// read it: only the bytes around the replacements.
type Text interface {
	Len() int
	// Slice returns the bytes from start to end. The caller does not change
	// them.
	Slice(start, end int) []byte
}

// Bytes is a text in one piece.
type Bytes []byte

func (b Bytes) Len() int                    { return len(b) }
func (b Bytes) Slice(start, end int) []byte { return b[start:end] }

// Rope is a text in parts. A replacement changes the parts around it and
// copies no other byte. A patch copies the list of the parts, so the Rope
// joins its parts into one when the list gets long (see Patch). Thus a
// patch costs about the square root of the size of the text times that of
// the patch, and not the size of the text.
type Rope struct {
	// No part is empty, and no part changes. ends[i] is where parts[i] ends
	// in the text.
	parts [][]byte
	ends  []int
}

// NewRope returns the text b, which must not change after the call.
func NewRope(b []byte) *Rope {
	t := &Rope{}
	t.add(b)
	return t
}

func (t *Rope) add(part []byte) {
	if len(part) > 0 {
		t.parts, t.ends = append(t.parts, part), append(t.ends, t.Len()+len(part))
	}
}

func (t *Rope) Len() int {
	if len(t.ends) == 0 {
		return 0
	}
	return t.ends[len(t.ends)-1]
}

func (t *Rope) Slice(start, end int) []byte {
	var out []byte
	t.span(start, end, func(part []byte) {
		if out == nil {
			// Most reads are in one part, and copy nothing.
			out = part[:len(part):len(part)]
		} else {
			out = append(out, part...)
		}
	})
	return out
}

// span gives the bytes from start to end to visit, part by part.
func (t *Rope) span(start, end int, visit func([]byte)) {
	for i := sort.SearchInts(t.ends, start+1); start < end; i++ {
		from := t.ends[i] - len(t.parts[i])
		part := t.parts[i][start-from : min(end, t.ends[i])-from]
		visit(part)
		start += len(part)
	}
}

// Patch applies the replacements to the text, which they must fit. A copy
// of the Rope value from before the call still is the text before.
func (t *Rope) Patch(rs []Replacement) error {
	if err := fit(t, rs); err != nil {
		return err
	}
	next := Rope{parts: make([][]byte, 0, len(t.parts)+2*len(rs)), ends: make([]int, 0, len(t.parts)+2*len(rs))}
	at := 0
	for _, r := range rs {
		t.span(at, r.Start, next.add)
		next.add([]byte(r.NewHTML))
		at = r.End
	}
	t.span(at, t.Len(), next.add)
	// A list of p parts costs p for each patch, and a join costs the size of
	// the text. With a join when p*p is more than the size of the text times
	// the size of the patch, the two costs stay about equal.
	if p := len(next.parts); p*p > (len(rs)+1)*next.Len() {
		next = *NewRope(next.Bytes())
	}
	*t = next
	return nil
}

// Bytes returns the text in one piece. The caller does not change it.
func (t *Rope) Bytes() []byte {
	if len(t.parts) == 1 {
		return t.parts[0]
	}
	return bytes.Join(t.parts, nil)
}
