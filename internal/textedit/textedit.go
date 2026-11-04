// Package textedit applies exact edits to document HTML: find-and-replace
// edits for agents, and replacements by position for the browser editor.
//
// An edit names a string that must occur exactly once in the document, or
// every occurrence of it when ReplaceAll is set, and the string that replaces
// it. The HTML is treated as bytes and never parsed, so
// everything outside the replaced strings stays byte-for-byte the same. Edits
// apply in order, each to the result of the one before, and either all of them
// apply or none do.
package textedit

import (
	"bytes"
	"fmt"
	"strings"
	"unicode/utf8"
)

// MaxEdits caps the edits in one request.
const MaxEdits = 100

// Edit replaces the only occurrence of OldString with NewString, or every
// occurrence when ReplaceAll is set.
type Edit struct {
	OldString  string `json:"old_string"`
	NewString  string `json:"new_string"`
	ReplaceAll bool   `json:"replace_all,omitempty"`
}

// Reasons an edit can fail.
const (
	ReasonEmpty     = "empty_old_string"
	ReasonUnchanged = "unchanged"
	ReasonNotFound  = "not_found"
	ReasonAmbiguous = "ambiguous"
	ReasonInvalid   = "invalid_utf8"
)

// Error reports the edit that could not apply. Index counts from zero.
type Error struct {
	Index   int    `json:"index"`
	Reason  string `json:"reason"`
	Matches int    `json:"matches"`
}

func (e *Error) Error() string {
	switch e.Reason {
	case ReasonEmpty:
		return fmt.Sprintf("edit %d: old_string is empty", e.Index)
	case ReasonUnchanged:
		return fmt.Sprintf("edit %d: new_string is the same as old_string", e.Index)
	case ReasonNotFound:
		return fmt.Sprintf("edit %d: old_string was not found in the document", e.Index)
	case ReasonAmbiguous:
		return fmt.Sprintf("edit %d: old_string occurs %d times; include more surrounding text so it matches exactly once, or set replace_all to replace every one", e.Index, e.Matches)
	case ReasonInvalid:
		return fmt.Sprintf("edit %d: old_string or new_string is not valid UTF-8", e.Index)
	}
	return fmt.Sprintf("edit %d: %s", e.Index, e.Reason)
}

// Apply returns html with every edit applied. It never changes html.
func Apply(html []byte, edits []Edit) ([]byte, error) {
	out := html
	for i, e := range edits {
		if err := validate(i, e); err != nil {
			return nil, err
		}
		old := []byte(e.OldString)
		at := bytes.Index(out, old)
		if at < 0 {
			return nil, &Error{Index: i, Reason: ReasonNotFound}
		}
		if e.ReplaceAll {
			out = bytes.ReplaceAll(out, old, []byte(e.NewString))
			continue
		}
		// Overlapping matches count too: "aa" is ambiguous in "aaa".
		if bytes.Contains(out[at+1:], old) {
			return nil, &Error{Index: i, Reason: ReasonAmbiguous, Matches: matches(out, old)}
		}
		next := make([]byte, 0, len(out)-len(old)+len(e.NewString))
		next = append(next, out[:at]...)
		next = append(next, e.NewString...)
		next = append(next, out[at+len(old):]...)
		out = next
	}
	return out, nil
}

// matches counts the occurrences of old in b, overlapping ones included.
func matches(b, old []byte) int {
	n := 0
	for {
		at := bytes.Index(b, old)
		if at < 0 {
			return n
		}
		n++
		b = b[at+1:]
	}
}

func validate(i int, e Edit) error {
	switch {
	case e.OldString == "":
		return &Error{Index: i, Reason: ReasonEmpty}
	case e.OldString == e.NewString:
		return &Error{Index: i, Reason: ReasonUnchanged}
	case !utf8.ValidString(e.OldString) || !utf8.ValidString(e.NewString):
		return &Error{Index: i, Reason: ReasonInvalid}
	}
	return nil
}

// Summary describes the edits in one line each, for version history when the
// caller gave no change summary.
func Summary(edits []Edit) string {
	lines := make([]string, 0, len(edits))
	for _, e := range edits {
		before, after := excerpts(e.OldString, e.NewString)
		line := "Changed " + quote(before) + " to " + quote(after)
		if e.ReplaceAll {
			line += " everywhere"
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

const (
	summaryRunes = 60
	contextWords = 3
)

// excerpts shows the words that differ between the old and new strings, with
// a few of the words they share on each side, so that a small change in a long
// string stays visible. An ellipsis marks the text that is cut.
func excerpts(oldString, newString string) (string, string) {
	a, b := strings.Fields(oldString), strings.Fields(newString)
	head, tail := shared(a, b)
	from, cut := max(head-contextWords, 0), max(tail-contextWords, 0)
	excerpt := func(words []string) string {
		s := strings.Join(words[from:len(words)-cut], " ")
		if from > 0 {
			s = "…" + s
		}
		if cut > 0 {
			s += "…"
		}
		return s
	}
	return excerpt(a), excerpt(b)
}

// differing returns only the words that differ between the old and new
// strings.
func differing(oldString, newString string) (string, string) {
	a, b := strings.Fields(oldString), strings.Fields(newString)
	head, tail := shared(a, b)
	return strings.Join(a[head:len(a)-tail], " "), strings.Join(b[head:len(b)-tail], " ")
}

// shared counts the words that a and b both start with, and then the words
// that they both end with.
func shared(a, b []string) (head, tail int) {
	for head < len(a) && head < len(b) && a[head] == b[head] {
		head++
	}
	for tail < len(a)-head && tail < len(b)-head && a[len(a)-1-tail] == b[len(b)-1-tail] {
		tail++
	}
	return head, tail
}

// quote puts a change in curly quotes, shortened at a word edge to at most
// summaryRunes runes.
func quote(s string) string {
	if r := []rune(s); len(r) > summaryRunes {
		s = string(r[:summaryRunes-1])
		if space := strings.LastIndexByte(s, ' '); space > 0 {
			s = s[:space]
		}
		s += "…"
	}
	return "“" + s + "”"
}
