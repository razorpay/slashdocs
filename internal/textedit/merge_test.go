package textedit

import (
	"bytes"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"os"
	"strings"
	"testing"
	"unicode/utf8"
)

// whole returns the replacement of all of base with ours.
func whole(base, ours string) []Replacement {
	return []Replacement{{Start: 0, End: len(base), OldHTML: base, NewHTML: ours}}
}

// The browser reads the same cases, so both sides merge in the same way.
func TestMergeGivesTheResultsOfTheSharedCases(t *testing.T) {
	raw, err := os.ReadFile("../../frontend/src/lib/merge-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct{ Name, Base, Ours, Theirs, Merged string }
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no cases")
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			got, err := Merge([]byte(tc.Base), []byte(tc.Theirs), whole(tc.Base, tc.Ours))
			// Replacements that change nothing do not fit, so there the
			// result is the other text.
			var unchanged *ReplacementError
			if tc.Ours == tc.Base && errors.As(err, &unchanged) && unchanged.Reason == ReasonUnchanged {
				got, err = []byte(tc.Theirs), nil
			}
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tc.Merged {
				t.Fatalf("got %q, want %q", got, tc.Merged)
			}
		})
	}
}

func TestMergeKeepsBothChanges(t *testing.T) {
	base := "<h1>Plan</h1><p>The quick brown fox.</p><p>Last.</p>"
	cases := []struct {
		name   string
		latest string
		ours   []Replacement
		want   string
	}{
		{"whole words, two ends of one word", strings.Replace(base, "quick", "quickly", 1),
			[]Replacement{at(base, "quick", "very quick")}, "<h1>Plan</h1><p>The very quickly brown fox.</p><p>Last.</p>"},
		{"whole words, both replace the word", strings.Replace(base, "brown", "red", 1),
			[]Replacement{at(base, "brown", "black")}, "<h1>Plan</h1><p>The quick lacked fox.</p><p>Last.</p>"},
		{"several replacements", strings.Replace(strings.Replace(base, "Plan", "The plan", 1), "fox", "cat", 1),
			[]Replacement{at(base, "quick", "slow"), at(base, "fox", "fox and dog"), at(base, "Last.", "Last!")},
			"<h1>The plan</h1><p>The slow brown cat and dog.</p><p>Last!</p>"},
		{"a replacement that keeps its HTML", strings.Replace(base, "quick", "slow", 1),
			[]Replacement{at(base, "quick", "quick"), at(base, "Last", "First")}, "<h1>Plan</h1><p>The slow brown fox.</p><p>First.</p>"},
		{"latest deleted the paragraph", strings.Replace(base, "<p>The quick brown fox.</p>", "", 1),
			[]Replacement{at(base, "brown", "brown and red")}, "<h1>Plan</h1> and red<p>Last.</p>"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Merge([]byte(base), []byte(tc.latest), tc.ours)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tc.want {
				t.Fatalf("got %q\nwant %q", got, tc.want)
			}
		})
	}
}

// mutate returns a copy of s with a few random edits of whole characters.
func mutate(rng *rand.Rand, s string) string {
	runes := []rune(s)
	for range rng.IntN(4) {
		at := rng.IntN(len(runes) + 1)
		cut := min(rng.IntN(3), len(runes)-at)
		runes = append(runes[:at:at], append([]rune("éè😀a<"[:rng.IntN(4)]), runes[at+cut:]...)...)
	}
	return string(runes)
}

// Characters that share bytes make a byte diff that cuts them.
func TestMergeAndBetweenKeepCharactersWhole(t *testing.T) {
	//nolint:gosec // G404: a fixed seed makes the same texts on every run.
	rng := rand.New(rand.NewPCG(3, 4))
	for range 5000 {
		runes := make([]rune, rng.IntN(12))
		for i := range runes {
			runes[i] = []rune("éèê😀😁a<")[rng.IntN(7)]
		}
		base := string(runes)
		ours, theirs := mutate(rng, base), mutate(rng, base)

		rs := Between([]byte(base), []byte(theirs))
		from := 0
		for _, r := range rs {
			if r.Start < from || !utf8.ValidString(r.OldHTML) || !utf8.ValidString(r.NewHTML) || r.OldHTML == r.NewHTML {
				t.Fatalf("Between(%q, %q) = %+v", base, theirs, rs)
			}
			from = r.End
		}
		if got, err := Replace([]byte(base), []byte(base), rs); len(rs) > 0 && (err != nil || string(got) != theirs) {
			t.Fatalf("Between(%q, %q) = %+v, which gives %q, %v", base, theirs, rs, got, err)
		}
		if ours == base {
			continue
		}
		merged, err := Merge([]byte(base), []byte(theirs), whole(base, ours))
		if err != nil || !utf8.Valid(merged) {
			t.Fatalf("Merge(%q, %q, %q) = %q, %v", base, theirs, ours, merged, err)
		}
		// With no change in latest, a merge only applies the replacements.
		if alone, err := Merge([]byte(base), []byte(base), whole(base, ours)); err != nil || string(alone) != ours {
			t.Fatalf("Merge(%q, the same, %q) = %q, %v", base, ours, alone, err)
		}
		// With the same change on both sides, each side merges to one result.
		if back, err := Merge([]byte(base), []byte(ours), Between([]byte(base), []byte(ours))); err != nil || !utf8.Valid(back) {
			t.Fatalf("Merge(%q, %q, the same) = %q, %v", base, ours, back, err)
		}
	}
}

func TestBetweenOfEqualTextsIsEmpty(t *testing.T) {
	if rs := Between([]byte("<p>é</p>"), []byte("<p>é</p>")); rs == nil || len(rs) != 0 {
		t.Fatalf("got %#v, want an empty list", rs)
	}
}

func TestBetweenCutsAtCharacterBoundaries(t *testing.T) {
	// é and è share their first byte, and so do the two faces.
	got := Between([]byte("<p>héllo 😀</p>"), []byte("<p>hèllo 😁!</p>"))
	want := []Replacement{at("<p>héllo 😀</p>", "é", "è"), at("<p>héllo 😀</p>", "😀", "😁!")}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestMergeRefusesReplacementsThatDoNotFitTheBase(t *testing.T) {
	base := "<p>é and e</p>"
	for reason, rs := range map[string][]Replacement{
		ReasonMismatch:  {{Start: 10, End: 11, OldHTML: "x", NewHTML: "y"}},
		ReasonRange:     {{Start: 4, End: 4, NewHTML: "x"}},
		ReasonInvalid:   {{Start: 3, End: 3, NewHTML: "\xff"}},
		ReasonUnchanged: {at(base, "and", "and")},
	} {
		_, err := Merge([]byte(base), bytes.ToUpper([]byte(base)), rs)
		var e *ReplacementError
		if !errors.As(err, &e) || e.Reason != reason {
			t.Errorf("err = %v, want %s", err, reason)
		}
	}
}

// A byte diff can keep one byte of the old text inside a long insertion.
// The insertion must stay one replacement, so that text which another
// writer types at the same place does not go into the middle of it.
func TestBetweenKeepsAnInsertionWhole(t *testing.T) {
	base := "<p>starts here and ends there.</p>\n<p>Section 3 holds the notes.</p>"
	latest := "<p>starts here on Monday  and ends there.</p>\n<p>Section 3 now holds the notes.</p>"
	got := Between([]byte(base), []byte(latest))
	if len(got) != 2 || got[0].Start != 15 || got[0].OldHTML != "" || got[0].NewHTML != "on Monday  " {
		t.Fatalf("Between gave %+v, want the insertion of \"on Monday  \" at 15 and one more", got)
	}
}

// Two changes of latest around text that it keeps stay two changes, so that
// a replacement can still change that text.
func TestMergeChangesTextBetweenTwoChangesOfLatest(t *testing.T) {
	for _, tc := range []struct{ base, latest, old, new, want string }{
		{"one two three", "one big two fat three", "two", "", "one big  fat three"},
		{"I saw a cat today", "I saw the a big cat today", " a ", " one ", "I saw the one big cat today"},
	} {
		at := strings.Index(tc.base, tc.old)
		got, err := Merge([]byte(tc.base), []byte(tc.latest), []Replacement{{Start: at, End: at + len(tc.old), OldHTML: tc.old, NewHTML: tc.new}})
		if err != nil || string(got) != tc.want {
			t.Errorf("Merge(%q, %q, %q to %q) = %q, %v, want %q", tc.base, tc.latest, tc.old, tc.new, got, err, tc.want)
		}
	}
}
