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

func TestSummaryShowsTheChangedWords(t *testing.T) {
	para := "6. The retry worker reads failed webhooks from the queue and add comments."
	for _, c := range []struct {
		name string
		edit Edit
		want string
	}{
		{"short", Edit{OldString: "TTL of 10 minutes", NewString: "TTL of 5 minutes"},
			`Replaced “TTL of 10 minutes” with “TTL of 5 minutes”`},
		{"insertion at the end", Edit{OldString: para, NewString: para + " R3"},
			`Replaced “…and add comments.” with “…and add comments. R3”`},
		{"deletion at the start", Edit{OldString: para, NewString: strings.TrimPrefix(para, "6. ")},
			`Replaced “6. The retry worker…” with “The retry worker…”`},
		{"replacement in the middle", Edit{OldString: para, NewString: strings.Replace(para, "failed", "dead", 1)},
			`Replaced “…retry worker reads failed webhooks from the…” with “…retry worker reads dead webhooks from the…”`},
		{"part of a word", Edit{OldString: para, NewString: strings.Replace(para, "add", "adds", 1)},
			`Replaced “…the queue and add comments.” with “…the queue and adds comments.”`},
		{"replace all", Edit{OldString: "draft", NewString: "final", ReplaceAll: true},
			`Replaced “draft” with “final” everywhere`},
		{"unicode", Edit{OldString: "Le café est très bon ce matin", NewString: "Le café est très chaud ce matin"},
			`Replaced “…café est très bon ce matin” with “…café est très chaud ce matin”`},
	} {
		if got := Summary([]Edit{c.edit}); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestSummaryClipsLongChanges(t *testing.T) {
	s := Summary([]Edit{
		{OldString: "10 minutes", NewString: "5 minutes"},
		{OldString: strings.Repeat("word ", 30), NewString: "short\n\n  text"},
	})
	lines := strings.Split(s, "\n")
	if len(lines) != 2 || lines[0] != "Replaced “10 minutes” with “5 minutes”" {
		t.Fatalf("got %q", s)
	}
	if !strings.Contains(lines[1], "…") || !strings.HasSuffix(lines[1], "word…” with “short text”") {
		t.Fatalf("got %q", lines[1])
	}
}
