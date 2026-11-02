package textedit

import (
	"errors"
	"strings"
	"testing"
)

func TestApplyReplacesOnlyTheMatchedText(t *testing.T) {
	html := []byte("<p>Cache TTL of 10 minutes.</p>\n<!-- keep   this -->")
	got, err := Apply(html, []Edit{{OldString: "TTL of 10 minutes", NewString: "TTL of 5 minutes"}})
	if err != nil {
		t.Fatal(err)
	}
	if want := "<p>Cache TTL of 5 minutes.</p>\n<!-- keep   this -->"; string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if string(html) != "<p>Cache TTL of 10 minutes.</p>\n<!-- keep   this -->" {
		t.Fatalf("Apply changed its input: %q", html)
	}
}

func TestApplyRunsEditsInOrder(t *testing.T) {
	got, err := Apply([]byte("alpha beta"), []Edit{
		{OldString: "alpha", NewString: "gamma"},
		{OldString: "gamma beta", NewString: "delta"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "delta" {
		t.Fatalf("got %q", got)
	}
}

func TestApplyReplaceAllChangesEveryOccurrence(t *testing.T) {
	html := []byte("<title>Cache design</title><h1>Cache design</h1>")
	got, err := Apply(html, []Edit{{OldString: "Cache design", NewString: "Cache plan", ReplaceAll: true}})
	if err != nil {
		t.Fatal(err)
	}
	if want := "<title>Cache plan</title><h1>Cache plan</h1>"; string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if _, err := Apply(html, []Edit{{OldString: "Cache plan", NewString: "x", ReplaceAll: true}}); err == nil {
		t.Fatal("replace_all with no match succeeded")
	}
}

func TestApplyFailsWithoutChangingAnything(t *testing.T) {
	cases := []struct {
		name    string
		edits   []Edit
		reason  string
		index   int
		matches int
	}{
		{"missing", []Edit{{OldString: "nope", NewString: "x"}}, ReasonNotFound, 0, 0},
		{"ambiguous", []Edit{{OldString: "a", NewString: "b"}}, ReasonAmbiguous, 0, 3},
		{"overlapping", []Edit{{OldString: "ana", NewString: "x"}}, ReasonAmbiguous, 0, 2},
		{"empty", []Edit{{OldString: "", NewString: "x"}}, ReasonEmpty, 0, 0},
		{"unchanged", []Edit{{OldString: "banana", NewString: "banana"}}, ReasonUnchanged, 0, 0},
		{"later edit", []Edit{{OldString: "banana", NewString: "kiwi"}, {OldString: "banana", NewString: "x"}}, ReasonNotFound, 1, 0},
		{"invalid utf8", []Edit{{OldString: "banana", NewString: "\xff"}}, ReasonInvalid, 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Apply([]byte("banana"), tc.edits)
			var e *Error
			if !errors.As(err, &e) {
				t.Fatalf("got %q, %v; want an *Error", got, err)
			}
			if e.Reason != tc.reason || e.Index != tc.index || e.Matches != tc.matches {
				t.Fatalf("got %+v, want reason %s index %d matches %d", e, tc.reason, tc.index, tc.matches)
			}
			if got != nil {
				t.Fatalf("got output %q with an error", got)
			}
		})
	}
}

func TestSummaryClipsLongText(t *testing.T) {
	s := Summary([]Edit{
		{OldString: "10 minutes", NewString: "5 minutes"},
		{OldString: "draft", NewString: "final", ReplaceAll: true},
		{OldString: strings.Repeat("word ", 30), NewString: "short\n\n  text"},
	})
	lines := strings.Split(s, "\n")
	if len(lines) != 3 || lines[0] != `Replaced "10 minutes" with "5 minutes"` || lines[1] != `Replaced "draft" with "final" everywhere` {
		t.Fatalf("got %q", s)
	}
	if !strings.Contains(lines[2], "…") || !strings.HasSuffix(lines[2], `with "short text"`) {
		t.Fatalf("got %q", lines[2])
	}
}
