package textedit

import (
	"bytes"
	"cmp"
	"slices"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Transform moves the replacements a, made on base, to the state after the
// replacements b, also made on base. Each list fits base. first says that a
// is the later write, whose text comes first when both put text in at one
// point. The result fits that state, and has no replacement that changes
// nothing.
//
// Each list is in its one form (normal) on the state that it was made on:
// two writers who type at one caret then put their text in at one point.
// Transform does not move a replacement back again (settle), because the
// characters before it can be text that the other list put in, and the text
// of one writer would then go into the word of the other. Each replacement
// counts without the characters that start or end both its old and its new
// HTML (exact), so that two writers who type in one word do not replace the
// same word. A replacement of a moves by the
// size of the changes of b before it. Text that goes in at a point comes
// before a change that takes out the text from that point. Text that goes in
// at a point that b took out goes in after the text that b put there. A
// replacement of a takes out only the bytes that b left, and text that b
// only put in between them stays, with the tags of the elements around it
// that a takes out whole (sheltered).
//
// A change in one tag, as of an attribute, has no place when the other list
// takes out the text around it, as the attribute or the whole tag: it goes,
// and the replacement that takes out that text also takes out the change
// (removes). Text outside tags that goes in at a place that b took out
// stays, as above.
//
// When a replacement of a and one of b both take out text and put in other
// text, and their ranges overlap, both count as replacements of the same
// whole words (whole). That text goes out one time, and both new texts go
// in, the later one first.
//
// An insertion or a deletion gives the same text at more than one place.
// Of those places, a deletion first takes the ones where it overlaps most
// with a deletion of the other list, and an insertion or a deletion takes
// one out of the text that the other list changes (aligned).
func Transform(base Text, a, b []Replacement, first bool) []Replacement {
	a, b = aligned(base, exact(base, a), exact(base, b))
	a = sheltered(base, a, b)
	a, b = whole(base, a, b)
	t := transformed{base: base, out: make([]Replacement, 0, len(a))}
	// b[:j] end before the replacement of a, and shift is how far they moved
	// the bytes after them.
	j, shift := 0, 0
	for _, r := range a {
		for ; j < len(b) && b[j].before(r, first); j++ {
			shift += len(b[j].NewHTML) - (b[j].End - b[j].Start)
		}
		// A change in a tag has no place when b takes out the text around it.
		if j < len(b) && removes(base, b[j], r) {
			continue
		}
		if r.Start != r.End {
			t.replace(r, b[j:], shift, first)
			continue
		}
		// Text that goes in at a point that b took out goes in after the
		// text that b put there.
		at, moved := r.Start, shift
		if j < len(b) && b[j].Start < r.Start {
			at, moved = b[j].Start, shift+len(b[j].NewHTML)
		}
		t.add(at, at, moved, r.NewHTML)
	}
	// Two writers who took out the same text leave a replacement of text
	// with itself.
	return slices.DeleteFunc(t.out, func(r Replacement) bool { return r.OldHTML == r.NewHTML })
}

// transformed collects the replacements that Transform makes on base.
type transformed struct {
	base Text
	out  []Replacement
}

// add replaces the bytes of base from from to to, which b left and moved by
// moved, with text.
func (t *transformed) add(from, to, moved int, text string) {
	t.put(from+moved, string(t.base.Slice(from, to)), text)
}

// put replaces old, at start of the state after b, with text.
func (t *transformed) put(start int, old, text string) {
	if n := len(t.out); n > 0 && t.out[n-1].End == start {
		last := &t.out[n-1]
		last.End, last.OldHTML, last.NewHTML = start+len(old), last.OldHTML+old, last.NewHTML+text
	} else if old != "" || text != "" {
		t.out = append(t.out, Replacement{Start: start, End: start + len(old), OldHTML: old, NewHTML: text})
	}
}

// replace adds r, which takes out text, around the replacements of b from
// the first one that does not end before r. moved is how far the
// replacements of b before them moved the bytes. r takes out only the bytes
// that b left, and its text goes in one time, at the first change that it
// meets. Of a tag that r takes out, r also takes out the change of b.
func (t *transformed) replace(r Replacement, b []Replacement, moved int, first bool) {
	text, cur := r.NewHTML, r.Start
	for _, y := range b {
		if y.Start >= r.End {
			break
		}
		switch {
		case removes(t.base, r, y):
			t.add(cur, y.Start, moved, text)
			t.put(y.Start+moved, y.NewHTML, "")
		case y.Start > cur:
			t.add(cur, y.Start, moved, text)
		case first && y.Start == r.Start:
			t.add(y.Start, y.Start, moved, text)
		default:
			t.add(y.Start, y.Start, moved+len(y.NewHTML), text)
		}
		text = ""
		moved += len(y.NewHTML) - (y.End - y.Start)
		cur = max(cur, y.End)
	}
	if cur < r.End {
		t.add(cur, r.End, moved, text)
	}
}

// Normal returns the replacements rs, made on base, each in its one form
// (normal). It reports the first one that does not fit base, or that every
// one keeps its HTML the same.
func Normal(base Text, rs []Replacement) ([]Replacement, error) {
	if err := fit(base, rs); err != nil {
		return nil, err
	}
	out := normal(base, rs)
	if len(out) == 0 {
		return nil, &ReplacementError{Reason: ReasonUnchanged}
	}
	return out, nil
}

// normal returns the replacements rs, which fit base, each in its one form:
// minimal, at the first of the places where it gives the same text (settle),
// and with no end in a tag that it does not stay in (outside).
func normal(base Text, rs []Replacement) []Replacement { return forms(base, rs, true) }

// exact returns the replacements rs, which fit base, without the characters
// that start or end both the old and the new HTML of each (minimal), in
// parts at the edges of tags (apart), and with no end in a tag that it does
// not stay in (outside). Each stays where it is. A replacement that changes
// nothing is not in the result.
func exact(base Text, rs []Replacement) []Replacement { return forms(base, rs, false) }

// forms returns the replacements rs, which fit base, each exact, and also
// settled when settled is true.
func forms(base Text, rs []Replacement, settled bool) []Replacement {
	out := make([]Replacement, 0, len(rs))
	for _, r := range rs {
		r.OldHTML = string(base.Slice(r.Start, r.End))
		out = append(out, apart(base, r)...)
	}
	if settled {
		each(base, out, settle)
	}
	each(base, out, outside)
	return out
}

// each moves the replacements rs, in order, with move, each one between from,
// the end of the one before it, and to, the start of the one after it.
func each(base Text, rs []Replacement, move func(base Text, r Replacement, from, to int) Replacement) {
	for i := range rs {
		from, to := around(base, rs, i)
		rs[i] = move(base, rs[i], from, to)
	}
}

// around returns from, the end of the replacement before rs[i], and to, the
// start of the one after it. With no such replacement, it is the start or
// the end of base.
func around(base Text, rs []Replacement, i int) (from, to int) {
	from, to = 0, base.Len()
	if i > 0 {
		from = rs[i-1].End
	}
	if i+1 < len(rs) {
		to = rs[i+1].Start
	}
	return from, to
}

// settleReach is how many characters settle moves a replacement back, at
// most. A run of one character can be as long as the document.
const settleReach = 1024

// settle moves an insertion or a deletion back while the character before it
// is its last character, which gives the same text, but not to before from,
// the end of the change before it, and not more than settleReach characters.
// It stops where its text starts with a tag.
//
// Each step takes the last character of the text to its start: "ab" put in
// after "xab" is also "ba" put in one character before, between that "a" and
// "b". Both give "xabab".
//
// Text typed at a caret is then at one point, whatever spaces are around it:
// " Alpha." before " Two." is also "Alpha. " one character later. And a new
// paragraph before "<p>omega" is the text "<p>new</p>" before that tag, not
// "new</p><p>" after it, which is at the point where a writer types at the
// start of "omega".
//
// From a place with an end in a tag that it does not stay in (across), it
// then moves on, but not to after to, to the first place with no such end.
// A removed paragraph, with the start tag of the next one that it joins,
// then starts after the start tag that stays, not in it.
func settle(base Text, r Replacement, from, to int) Replacement {
	text := r.OldHTML + r.NewHTML
	if r.OldHTML != "" && r.NewHTML != "" || text == "" {
		return r
	}
	// The text of r at its place is text[cut:] + text[:cut].
	cut := 0
	for range settleReach {
		end := cmp.Or(cut, len(text))
		_, n := utf8.DecodeLastRuneInString(text[:end])
		if text[cut] == '<' || r.Start-n < from || string(base.Slice(r.Start-n, r.Start)) != text[end-n:end] {
			break
		}
		r.Start, r.End, cut = r.Start-n, r.End-n, end-n
	}
	// Both ends step over the same character, and their tags change only
	// where it is a "<" or a ">". So each scan for a tag starts at the edge
	// that the one before stopped at, and the move is linear.
	head, tail := tagAt(base, r.Start), tagAt(base, r.End)
	for i := 0; i < settleReach && head != tail; i++ {
		_, n := utf8.DecodeRuneInString(text[cut:])
		next := text[cut : cut+n]
		if r.End+n > to || string(base.Slice(r.End, r.End+n)) != next {
			break
		}
		r.Start, r.End, cut = r.Start+n, r.End+n, (cut+n)%len(text)
		if strings.ContainsAny(next, "<>") {
			head, tail = tagAt(base, r.Start), tagAt(base, r.End)
		}
	}
	text = text[cut:] + text[:cut]
	if r.OldHTML != "" {
		r.OldHTML = text
	} else {
		r.NewHTML = text
	}
	return r
}

// tag returns the start of the tag of base that at is in, at its "<", and
// its end, after its ">". in is false when at is not between the two.
func tag(base Text, at int) (start, end int, in bool) {
	start, open := edge(base, at, -1)
	end, shut := edge(base, at, 1)
	return start, end + 1, open == '<' && shut == '>'
}

// tagAt returns the start of the tag of base that at is in, or -1 when at
// is not in a tag.
func tagAt(base Text, at int) int {
	if start, _, in := tag(base, at); in {
		return start
	}
	return -1
}

// removes tells whether x takes out the text around y, which stays in one
// tag of base, as the attribute that y changes or the whole tag. The change
// of y then has no place: in the tag that x leaves, it can join the name of
// the tag or of another attribute. x takes out all the text of y and more,
// or the text on both sides of an insertion y. x can end where y ends:
// settle can move a removed attribute to start at the quote before it.
func removes(base Text, x, y Replacement) bool {
	if !x.covers(y) {
		return false
	}
	_, end, in := tag(base, y.Start)
	return in && y.End < end
}

// covers tells whether r takes out the text of y and more, or the text on
// both sides of y when y only puts in text.
func (r Replacement) covers(y Replacement) bool {
	return r.Start <= y.Start && y.End <= r.End && r.Start < y.End && y.Start < r.End && r.End-r.Start > y.End-y.Start
}

// edge returns the offset of the nearest "<" or ">" of base before at, when
// step is -1, or from at on, when step is 1, and that byte. When there is
// none, the byte is 0, and the offset is the start or the end of base.
func edge(base Text, at, step int) (int, byte) {
	const chunk = 256
	for at > 0 && step < 0 || at < base.Len() && step > 0 {
		lo, hi := max(at-chunk, 0), at
		if step > 0 {
			lo, hi = at, min(at+chunk, base.Len())
		}
		part := base.Slice(lo, hi)
		i := bytes.IndexAny(part, "<>")
		if step < 0 {
			i = bytes.LastIndexAny(part, "<>")
		}
		if i >= 0 {
			return lo + i, part[i]
		}
		at += step * len(part)
	}
	return at, 0
}

// across tells whether a change of base from start to end has an end in a
// tag that it does not stay in. A change in one tag, as of an attribute,
// stays there. Text that another writer puts in at the place of such a
// change would go into the tag.
func across(base Text, start, end int) bool { return tagAt(base, start) != tagAt(base, end) }

// apart returns the parts of r, minimal and with no part that changes
// nothing. r has its old HTML. An end of r in a tag that r does not stay in
// cuts r at the edge of that tag, when the new HTML has that edge too:
// "b>bold</b" to "i>BOLD</i" is "b" to "i" in the start tag, "bold" to
// "BOLD" between the tags, and "/b" to "/i" in the end tag. A part then
// changes one tag or only text. So a change of a tag has no place when the
// other list takes out that tag (see removes), and the change of the text
// stays. An end that does not cut stays for outside.
func apart(base Text, r Replacement) []Replacement {
	if r = minimal(r); r.OldHTML == r.NewHTML {
		return nil
	}
	if !across(base, r.Start, r.End) {
		return []Replacement{r}
	}
	// at is the "<" or ">" of the tag in the old HTML, and cut is the same
	// edge in the new HTML.
	at, cut := -1, -1
	if _, end, in := tag(base, r.Start); in {
		at, cut = end-1, strings.IndexByte(r.NewHTML, '>')
	}
	if start, _, in := tag(base, r.End); cut < 0 && in {
		at, cut = start, strings.LastIndexByte(r.NewHTML, '<')
	}
	if cut < 0 {
		return []Replacement{r}
	}
	n := at - r.Start
	return append(
		apart(base, Replacement{Start: r.Start, End: at, OldHTML: r.OldHTML[:n], NewHTML: r.NewHTML[:cut]}),
		apart(base, Replacement{Start: at + 1, End: r.End, OldHTML: r.OldHTML[n+1:], NewHTML: r.NewHTML[cut+1:]})...)
}

// outside widens each end of r that is in a tag that r does not stay in to
// the edge of that tag, with the bytes of the tag in its old and its new
// HTML, but not to before from or to after to.
func outside(base Text, r Replacement, from, to int) Replacement {
	if !across(base, r.Start, r.End) {
		return r
	}
	if start, _, in := tag(base, r.Start); in && start >= from {
		head := string(base.Slice(start, r.Start))
		r.Start, r.OldHTML, r.NewHTML = start, head+r.OldHTML, head+r.NewHTML
	}
	if _, end, in := tag(base, r.End); in && end <= to {
		tail := string(base.Slice(r.End, end))
		r.End, r.OldHTML, r.NewHTML = end, r.OldHTML+tail, r.NewHTML+tail
	}
	return r
}

// Keeps tells whether the replacements rs stay where they were in tags
// after op. op changes before into after, and rs fit after. An end of a
// replacement that was outside tags before op must be outside tags after it.
// Two ends that were in one tag must be in one tag. A replacement that a
// move over op does not keep so puts text into a tag that its writer did not
// change, or cuts the change of one tag in two.
func Keeps(before Text, op []Replacement, after Text, rs []Replacement) bool {
	from := origin(op)
	for _, r := range rs {
		head, start := tagAt(before, from(r.Start)), tagAt(after, r.Start)
		// An insertion starts and ends at one point, so the tags are read
		// one time.
		tail, end := head, start
		if r.End > r.Start {
			tail, end = tagAt(before, from(r.End)), tagAt(after, r.End)
		}
		into := head < 0 && start >= 0 || tail < 0 && end >= 0
		if into || head >= 0 && head == tail && (start < 0 || start != end) {
			return false
		}
	}
	return true
}

// origin returns a function that gives the offset of base that an offset of
// the state after rs, which fit base, comes from. It takes offsets in order.
// An offset in the text that a replacement puts in comes from the end of the
// text that it takes out.
func origin(rs []Replacement) func(at int) int {
	i, shift := 0, 0
	return func(at int) int {
		for ; i < len(rs) && rs[i].Start+shift+len(rs[i].NewHTML) < at; i++ {
			shift += len(rs[i].NewHTML) - (rs[i].End - rs[i].Start)
		}
		if i < len(rs) && rs[i].Start+shift < at {
			return rs[i].End
		}
		return at - shift
	}
}

// Breaks tells whether the replacements rs, which fit base, leave a tag
// that does not end where the tags around them in base end. It looks at the
// HTML from the nearest "<" or ">" before each replacement to the one after
// it, and at replacements that are near as one.
func Breaks(base Text, rs []Replacement) bool {
	for i := 0; i < len(rs); {
		lo, _ := edge(base, rs[i].Start, -1)
		var after []byte
		at, hi := lo, lo
		for first := i; i < len(rs) && (i == first || rs[i].Start < hi); i++ {
			r := rs[i]
			after = append(append(after, base.Slice(at, r.Start)...), r.NewHTML...)
			next, _ := edge(base, r.End, 1)
			// The window holds the character after the edge, which tells
			// whether a "<" there starts a tag.
			at, hi = r.End, max(hi, min(next+2, base.Len()))
		}
		after = append(after, base.Slice(at, hi)...)
		if ended(base.Slice(lo, hi)) && !ended(after) {
			return true
		}
	}
	return false
}

// ended tells whether each tag that starts in html ends before the next one
// starts. A "<" before a letter, "/", "!" or "?" starts a tag, and a ">"
// ends it. In a tag, a "<" or ">" in quotes is part of an attribute. A tag
// that is open at the end of html can end after it.
func ended(html []byte) bool {
	open := false
	var quote byte
	for i, c := range html {
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case open && (c == '"' || c == '\''):
			quote = c
		case c == '>':
			open = false
		case c == '<' && i+1 < len(html) && opens(html[i+1]):
			if open {
				return false
			}
			open = true
		}
	}
	return true
}

// opens tells whether c, after a "<", makes it the start of a tag.
func opens(c byte) bool {
	return 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || c == '/' || c == '!' || c == '?'
}

// whole widens the replacements of a and of b that conflict: both take out
// text and put in other text, in ranges that overlap. Each of the two then
// replaces the same text: the two ranges together, out to the ends of the
// words at their ends, with all the other changes in that text. Each keeps,
// in its place, the old text that it did not change. So the words of each
// writer stay whole, also when the two words have letters in common.
func whole(base Text, a, b []Replacement) ([]Replacement, []Replacement) {
	// a[:i] and b[:j] are in the result, and a[:x] and b[:y] have no conflict.
	var outA, outB []Replacement
	i, j, x, y := 0, 0, 0, 0
	for x < len(a) && y < len(b) {
		if !a[x].conflicts(b[y]) {
			if a[x].End <= b[y].End {
				x++
			} else {
				y++
			}
			continue
		}
		start, end := min(a[x].Start, b[y].Start), max(a[x].End, b[y].End)
		// Another change in the text makes the text larger, and its ends
		// are then in other words.
		for grown := true; grown; {
			start, end = words(base, start, end)
			grown = false
			for _, rs := range [][]Replacement{a, b} {
				if lo, hi := within(rs, start, end); lo < hi && (rs[lo].Start < start || rs[hi-1].End > end) {
					grown, start, end = true, min(start, rs[lo].Start), max(end, rs[hi-1].End)
				}
			}
		}
		outA, i = joined(base, outA, a, i, start, end)
		outB, j = joined(base, outB, b, j, start, end)
		x, y = i, j
	}
	if outA == nil {
		return a, b
	}
	return append(outA, a[i:]...), append(outB, b[j:]...)
}

// aligned moves the insertions and the deletions of a and of b to the
// places that fit the changes of the other list. Such a change gives the
// same text at each place that settle moves it over, but its one form can
// start before the text that its person selected: "Remove it. " after
// "this." is also ". Remove it". It can then be in the text that the other
// list changes, where its person did not put it. The places depend only on
// the two changes, so both orders give the same places.
//
// Two deletions that overlap or touch at one of their places move to the
// places where they overlap most (toward). With another deletion that takes
// out the end of "it. ", the full stop of "this." would also go.
//
// Another insertion or deletion that is in the text that the other list
// changes moves on, out of that text (clear). When the other writer changes
// "this." to "this!", ". Remove it" would leave the full stop.
func aligned(base Text, a, b []Replacement) ([]Replacement, []Replacement) {
	a, b = slices.Clone(a), slices.Clone(b)
	for i, j := 0, 0; i < len(a) && j < len(b); {
		switch {
		case a[i].deletes() && b[j].deletes():
			// The deletion that starts first moves first.
			if b[j].Start < a[i].Start {
				toward(base, b, j, a[i])
				toward(base, a, i, b[j])
			} else {
				toward(base, a, i, b[j])
				toward(base, b, j, a[i])
			}
		case a[i].inside(b[j]) || b[j].inside(a[i]):
			// An insertion moves first, and a deletion moves when the
			// insertion cannot.
			if a[i].Start == a[i].End {
				clear(base, a, i, b[j])
				clear(base, b, j, a[i])
			} else {
				clear(base, b, j, a[i])
				clear(base, a, i, b[j])
			}
		}
		x, y := a[i].End, b[j].End
		if x <= y {
			i++
		}
		if y <= x {
			j++
		}
	}
	return a, b
}

// toward moves the deletion rs[i] toward the deletion o while that makes
// their overlap larger. It stays where it is when the two do not then
// overlap or touch.
func toward(base Text, rs []Replacement, i int, o Replacement) {
	r := slide(base, rs, i,
		func(r Replacement) bool { return r.Start < o.Start && r.End < o.End },
		func(r Replacement) bool { return r.Start > o.Start && r.End > o.End })
	if r.Start <= o.End && o.Start <= r.End {
		rs[i] = r
	}
}

// clear moves the insertion or deletion rs[i] on, to the first place out of
// the text that y changes. It stays where it is when it has no such place:
// at a place between, its text would go in in another order.
func clear(base Text, rs []Replacement, i int, y Replacement) {
	r := slide(base, rs, i, func(r Replacement) bool { return r.inside(y) }, func(Replacement) bool { return false })
	if !r.inside(y) {
		rs[i] = r
	}
}

// slide returns the insertion or deletion rs[i], moved on one character at
// a time while on tells, and then back while back tells. Each step gives the
// same text, and slide stops at a step that does not. It moves not more
// than settleReach characters each way, stays between the replacements of
// rs around rs[i], and does not take an end into a tag or out of it.
func slide(base Text, rs []Replacement, i int, on, back func(Replacement) bool) Replacement {
	r := rs[i]
	from, to := around(base, rs, i)
	text := r.OldHTML + r.NewHTML
	// The text of r at its place is text[cut:] + text[:cut].
	cut := 0
	// As in settle, both ends step over the same character, and their tags
	// change only where it is a "<" or a ">".
	head, tail := tagAt(base, r.Start), tagAt(base, r.End)
	step := func(n int, c string) bool {
		if strings.ContainsAny(c, "<>") && (tagAt(base, r.Start+n) != head || tagAt(base, r.End+n) != tail) {
			return false
		}
		r.Start, r.End = r.Start+n, r.End+n
		return true
	}
	for moves := 0; moves < settleReach && on(r); moves++ {
		_, n := utf8.DecodeRuneInString(text[cut:])
		next := text[cut : cut+n]
		if r.End+n > to || string(base.Slice(r.End, r.End+n)) != next || !step(n, next) {
			break
		}
		cut = (cut + n) % len(text)
	}
	for moves := 0; moves < settleReach && back(r); moves++ {
		end := cmp.Or(cut, len(text))
		_, n := utf8.DecodeLastRuneInString(text[:end])
		last := text[end-n : end]
		if r.Start-n < from || string(base.Slice(r.Start-n, r.Start)) != last || !step(-n, last) {
			break
		}
		cut = end - n
	}
	if text = text[cut:] + text[:cut]; r.OldHTML != "" {
		r.OldHTML = text
	} else {
		r.NewHTML = text
	}
	return r
}

// sheltered keeps text that one writer types in an element that the other
// writer deletes whole, as with a select-all, in that element. The text then
// stays in its paragraph, list item or cell, and does not go in bare between
// the blocks that are left. Each deletion keeps the start and end tags of the
// elements around such text that it takes out whole (shelter). sheltered
// splits each deletion of a around those tags. And it puts the tags around
// the text of the changes of a in a deletion of b, which took the tags out:
// that text goes in at the place of the deletion.
func sheltered(base Text, a, b []Replacement) []Replacement {
	out := make([]Replacement, 0, len(a))
	for i := 0; i < len(a); {
		r := a[i]
		if tags := shelter(base, r, b); tags != nil {
			at := r.Start
			for _, tag := range append(tags, [2]int{r.End, r.End}) {
				if tag[0] > at {
					out = append(out, Replacement{Start: at, End: tag[0], OldHTML: string(base.Slice(at, tag[0]))})
				}
				at = max(at, tag[1])
			}
			i++
			continue
		}
		var tags [][2]int
		lo, hi := within(b, r.Start, r.End)
		if hi-lo == 1 {
			tags = shelter(base, b[lo], a)
		}
		if tags == nil {
			out = append(out, r)
			i++
			continue
		}
		// The changes of a in the deletion are one insertion: their texts
		// between the tags, in order.
		var text strings.Builder
		for ; i < len(a) && a[i].Start < b[lo].End; i++ {
			for ; len(tags) > 0 && tags[0][0] < a[i].Start; tags = tags[1:] {
				text.Write(base.Slice(tags[0][0], tags[0][1]))
			}
			text.WriteString(a[i].NewHTML)
		}
		for _, tag := range tags {
			text.Write(base.Slice(tag[0], tag[1]))
		}
		out = append(out, Replacement{Start: r.Start, End: r.Start, NewHTML: text.String()})
	}
	return out
}

// shelter returns, in order, the start and end tags that the deletion d
// keeps: those of the elements around the changes of others in d that d
// takes out whole. It returns none when a change of others is not all in d,
// or has a tag in its old HTML, or is in a tag, where it has no place (see
// removes).
func shelter(base Text, d Replacement, others []Replacement) [][2]int {
	if !d.deletes() {
		return nil
	}
	var tags [][2]int
	lo, hi := within(others, d.Start, d.End)
	for _, o := range others[lo:hi] {
		if o.Start < d.Start || o.End > d.End || strings.ContainsAny(o.OldHTML, "<>") || tagAt(base, o.Start) >= 0 {
			return nil
		}
		tags = append(tags, sheltering(base, d, o.Start)...)
	}
	slices.SortFunc(tags, func(x, y [2]int) int { return x[0] - y[0] })
	return slices.Compact(tags)
}

// sheltering returns the start and end tags of the elements that are open
// at the offset at, which is outside tags, and that the deletion r takes out
// whole. A start tag opens its element, and an end tag closes the nearest
// open element of its name. An element with no end tag in r, as a br, is not
// one of them.
func sheltering(base Text, r Replacement, at int) [][2]int {
	type element struct {
		name string
		tag  [2]int
	}
	var open []element
	var tags [][2]int
	// open[:around] are the elements that are open at at.
	around := -1
	html := base.Slice(r.Start, r.End)
	for i := 0; i < len(html); i++ {
		if around < 0 && r.Start+i >= at {
			around = len(open)
		}
		if html[i] != '<' || i+1 == len(html) || !opens(html[i+1]) {
			continue
		}
		end := tagEnd(html, i)
		tag, name := [2]int{r.Start + i, r.Start + end}, tagName(html[i+1:end])
		i = end - 1
		switch {
		case name == "":
		case name[0] != '/':
			open = append(open, element{name, tag})
		default:
			for k := len(open) - 1; k >= 0; k-- {
				if open[k].name != name[1:] {
					continue
				}
				if k < around {
					tags, around = append(tags, open[k].tag, tag), k
				}
				open = open[:k]
				break
			}
		}
	}
	return tags
}

// tagName returns the name of a tag in lower case, with the "/" of an end
// tag. html is the text of the tag after its "<". A comment or a declaration
// has no name.
func tagName(html []byte) string {
	if html[0] == '!' || html[0] == '?' {
		return ""
	}
	end := bytes.IndexFunc(html[1:], func(c rune) bool { return !letter(c) && c != '-' })
	if end < 0 {
		end = len(html) - 1
	}
	return strings.ToLower(string(html[:end+1]))
}

// tagEnd returns the offset after the ">" that ends the tag that starts at
// html[i], or the end of html. In a tag, a ">" in quotes is part of an
// attribute.
func tagEnd(html []byte, i int) int {
	var quote byte
	for i++; i < len(html); i++ {
		switch c := html[i]; {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == '>':
			return i + 1
		}
	}
	return len(html)
}

// within returns the indexes lo to hi of the replacements of rs that change
// text between start and end. Text that goes in at start or at end is not
// between them.
func within(rs []Replacement, start, end int) (lo, hi int) {
	lo = sort.Search(len(rs), func(i int) bool { return rs[i].End > start })
	hi = lo
	for hi < len(rs) && rs[hi].Start < end {
		hi++
	}
	return lo, hi
}

// joined adds rs[from:] to out, up to the replacements between start and
// end, as one replacement of that range. It returns the index of the first
// replacement of rs after them.
func joined(base Text, out, rs []Replacement, from, start, end int) ([]Replacement, int) {
	lo, hi := within(rs, start, end)
	one := Replacement{Start: start, End: end, OldHTML: string(base.Slice(start, end))}
	at := start
	for _, r := range rs[lo:hi] {
		one.NewHTML += string(base.Slice(at, r.Start)) + r.NewHTML
		at = r.End
	}
	one.NewHTML += string(base.Slice(at, end))
	return append(append(out, rs[from:lo]...), one), hi
}

// wordReach is how many characters words widens each end by, at most. A run
// of letters and digits can be very long, as in a data URI.
const wordReach = 64

// words widens start and end to the ends of the words that they are in, by
// at most wordReach characters each. A word is a run of letters and digits.
func words(base Text, start, end int) (int, int) {
	// before and after are the characters around at, and their sizes.
	before := func(at int) (rune, int) { return utf8.DecodeLastRune(base.Slice(max(at-utf8.UTFMax, 0), at)) }
	after := func(at int) (rune, int) { return utf8.DecodeRune(base.Slice(at, min(at+utf8.UTFMax, base.Len()))) }
	inWord := func(at int) bool {
		b, _ := before(at)
		a, _ := after(at)
		return letter(b) && letter(a)
	}
	for i := 0; i < wordReach && inWord(start); i++ {
		_, n := before(start)
		start -= n
	}
	for i := 0; i < wordReach && inWord(end); i++ {
		_, n := after(end)
		end += n
	}
	return start, end
}

func letter(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }

// before reports whether r, a replacement of the other list, ends before
// next starts. Text that r puts in at the point where next puts in text is
// before next only when the text of next does not come first.
func (r Replacement) before(next Replacement, first bool) bool {
	if r.End == next.Start && r.Start == r.End && next.Start == next.End {
		return !first
	}
	return r.End <= next.Start
}

// replaces reports whether r takes out text and puts in other text.
func (r Replacement) replaces() bool { return r.End > r.Start && r.NewHTML != "" }

// deletes reports whether r takes out text and puts in none.
func (r Replacement) deletes() bool { return r.End > r.Start && r.NewHTML == "" }

// inside reports whether r, an insertion or a deletion, is in the text that y
// changes. A deletion is in a replacement that it overlaps, and around an
// insertion in its text: two deletions move toward each other instead. An
// insertion is in a change that takes out the text from its point on,
// because its text goes in before the new text of that change.
func (r Replacement) inside(y Replacement) bool {
	if r.deletes() {
		return r.Start < y.End && y.Start < r.End && (y.replaces() || y.Start == y.End)
	}
	return r.Start == r.End && r.NewHTML != "" && y.Start <= r.Start && r.Start < y.End
}

// conflicts reports whether r and y both replace text, in ranges that overlap.
func (r Replacement) conflicts(y Replacement) bool {
	return r.replaces() && y.replaces() && r.Start < y.End && y.Start < r.End
}

// rewriteGap is how many unchanged words, at most, a diff keeps between two
// replacements of one rewritten text: the words that the old and the new
// sentence have in common.
const rewriteGap = 3

// Touching returns the index of the first replacement of a that changes
// text that a replacement of b changes, or -1. Both lists are on base.
//
// The replacements of a with a few unchanged words between them, in one
// block, are one rewrite (rewrite). A replacement of b changes its text when
// it is in the rewrite, or at an edge of a rewrite that puts in text: the
// text of b would then go into the new text of a, or next to it, where it
// can be wrong. A change of other words of the block stays apart.
func Touching(base Text, a, b []Replacement) int {
	j := 0
	for i, next := 0, 0; i < len(a); i = next {
		next = rewrite(base, a, i)
		r := Replacement{Start: a[i].Start, End: a[next-1].End}
		puts := slices.ContainsFunc(a[i:next], func(r Replacement) bool { return r.NewHTML != "" })
		for j < len(b) && b[j].End < r.Start {
			j++
		}
		for _, y := range b[j:] {
			if y.Start > r.End {
				break
			}
			if y.Start < r.End && r.Start < y.End || puts && (y.Start == r.End || y.End == r.Start) {
				return i
			}
		}
	}
	return -1
}

// rewrite returns the end of the rewrite of a that starts at a[i]: the
// replacements after it with at most rewriteGap words, and no tag, before
// each one.
func rewrite(base Text, a []Replacement, i int) int {
	next := i + 1
	for ; next < len(a) && a[next].Start-a[next-1].End <= wordReach; next++ {
		gap := string(base.Slice(a[next-1].End, a[next].Start))
		if strings.Contains(gap, "<") || len(strings.Fields(gap)) > rewriteGap {
			break
		}
	}
	return next
}

// Invert returns the replacements that undo rs: on the state after rs, they
// give the state that rs were made on.
func Invert(rs []Replacement) []Replacement {
	out := make([]Replacement, len(rs))
	shift := 0
	for i, r := range rs {
		start := r.Start + shift
		out[i] = Replacement{Start: start, End: start + len(r.NewHTML), OldHTML: r.NewHTML, NewHTML: r.OldHTML}
		shift += len(r.NewHTML) - (r.End - r.Start)
	}
	return out
}

// Patch applies replacements to base, the text that they were made on.
func Patch(base []byte, rs []Replacement) ([]byte, error) {
	if err := fit(Bytes(base), rs); err != nil {
		return nil, err
	}
	return apply(base, rs), nil
}

// Between returns the replacements that turn a into b, in order and at byte
// offsets of a. Each one is in its one form (normal) and starts and ends at
// character boundaries of both texts.
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
	return normal(Bytes(a), out)
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
// byte: from "é" (C3 A9) to "è" (C3 A8) it changes only the second byte, and
// widen makes that a change of the whole character. Two changes with no
// boundary between them, as the first and the last byte of one character,
// become one change with the bytes between them.
func widen(a, b []byte, changes []change) []change {
	out := make([]change, 0, len(changes)+1)
	// from is where the change before ends in a, and shift is how far the
	// changes before moved the bytes after them.
	from, shift := 0, 0
	// A change of no bytes at the end of a widens the end of the last change.
	for _, c := range append(changes, change{len(a), len(a), 0}) {
		// The bytes of a from from to c.start are the same in both texts. lo
		// is the first boundary of both texts in them, and hi is the last.
		whole := func(i int) bool { return boundary(a, i) && boundary(b, i+shift) }
		lo, hi := from, c.start
		for lo < hi && !whole(lo) {
			lo++
		}
		for hi > lo && !whole(hi) {
			hi--
		}
		if n := len(out); !whole(lo) {
			// No boundary: c joins the change before, with the bytes
			// between them.
			out[n-1].end, out[n-1].size = c.end, out[n-1].size+c.start-from+c.size
		} else {
			// The change before grows to lo, and c grows back to hi. Each
			// takes the bytes that it grows over.
			if n > 0 {
				out[n-1].end, out[n-1].size = lo, out[n-1].size+lo-from
			}
			out = append(out, change{hi, c.end, c.size + c.start - hi})
		}
		from, shift = c.end, shift+c.size-(c.end-c.start)
	}
	return out[:len(out)-1]
}
