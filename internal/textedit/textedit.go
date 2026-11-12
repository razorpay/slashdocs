// Package textedit applies exact find-and-replace edits to document HTML.
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
		line := fmt.Sprintf("Replaced %q with %q", clip(e.OldString), clip(e.NewString))
		if e.ReplaceAll {
			line += " everywhere"
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

const summaryRunes = 60

// clip shortens s to a readable single line.
func clip(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= summaryRunes {
		return s
	}
	r := []rune(s)
	return string(r[:summaryRunes-1]) + "…"
}
