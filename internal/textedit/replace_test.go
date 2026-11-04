package textedit

import (
	"bytes"
	crand "crypto/rand"
	"errors"
	"math/rand/v2"
	"strings"
	"testing"
	"time"
)

// at returns the replacement of the first old in base with with.
func at(base, old, with string) Replacement {
	start := strings.Index(base, old)
	return Replacement{Start: start, End: start + len(old), OldHTML: old, NewHTML: with}
}

func TestReplaceAppliesByPositionOnTheBase(t *testing.T) {
	base := "<p>Try it.</p><p>Try it.</p><p>Try it.</p>"
	// The second of three equal labels, and an insertion after the last.
	got, err := Replace([]byte(base), []byte(base), []Replacement{
		{Start: 17, End: 24, OldHTML: "Try it.", NewHTML: "Run it."},
		{Start: len(base), End: len(base), NewHTML: "<p>New</p>"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := "<p>Try it.</p><p>Run it.</p><p>Try it.</p><p>New</p>"; string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestReplaceMovesReplacementsOntoANewerVersion(t *testing.T) {
	base := "<h1>Café 😀</h1>\n<p>One.</p>\n<p>Two.</p>\n<p>Three.</p>"
	ours := []Replacement{at(base, "One.", "Uno."), at(base, "Three.", "Tres.")}
	cases := []struct{ name, latest, want string }{
		// Multi-byte text before the ranges grows, so byte and rune offsets differ.
		{"before", strings.Replace(base, "Café 😀", "Crème brûlée 😀😀", 1),
			"<h1>Crème brûlée 😀😀</h1>\n<p>Uno.</p>\n<p>Two.</p>\n<p>Tres.</p>"},
		{"between", strings.Replace(base, "Two.", "Dos, señor.", 1),
			"<h1>Café 😀</h1>\n<p>Uno.</p>\n<p>Dos, señor.</p>\n<p>Tres.</p>"},
		{"after", base + "\n<p>Four.</p>",
			"<h1>Café 😀</h1>\n<p>Uno.</p>\n<p>Two.</p>\n<p>Tres.</p>\n<p>Four.</p>"},
		{"removed before", strings.Replace(base, "<h1>Café 😀</h1>\n", "", 1),
			"<p>Uno.</p>\n<p>Two.</p>\n<p>Tres.</p>"},
		{"inserted at the edge of a range", strings.Replace(base, "One.", "One.!", 1),
			"<h1>Café 😀</h1>\n<p>Uno.!</p>\n<p>Two.</p>\n<p>Tres.</p>"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Replace([]byte(base), []byte(tc.latest), ours)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tc.want {
				t.Fatalf("got %q\nwant %q", got, tc.want)
			}
		})
	}
}

func TestReplaceRefusesAReplacementThatANewerVersionChanged(t *testing.T) {
	base := "<p>One two three.</p><p>Four.</p>"
	cases := []struct {
		name   string
		latest string
		ours   []Replacement
		index  int
	}{
		{"same words", strings.Replace(base, "two", "2", 1), []Replacement{at(base, "One", "1"), at(base, "two three", "2 3")}, 1},
		{"strictly inside", strings.Replace(base, "two", "two and a half", 1), []Replacement{at(base, "One two three", "1 2 3")}, 0},
		{"overlap at the start", strings.Replace(base, "One two", "Zero", 1), []Replacement{at(base, "two three", "2 3")}, 0},
		{"insertion at the same point", strings.Replace(base, "Four", "XFour", 1),
			[]Replacement{{Start: strings.Index(base, "Four"), End: strings.Index(base, "Four"), NewHTML: "Only "}}, 0},
		{"insertion inside an empty range is a deletion", strings.Replace(base, "<p>Four.</p>", "", 1),
			[]Replacement{{Start: strings.Index(base, "Four"), End: strings.Index(base, "Four"), NewHTML: "Only "}}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Replace([]byte(base), []byte(tc.latest), tc.ours)
			var conflict *ConflictError
			if !errors.As(err, &conflict) || conflict.Index != tc.index {
				t.Fatalf("err = %v, want a conflict on replacement %d", err, tc.index)
			}
		})
	}
}

func TestReplaceRefusesReplacementsThatDoNotFitTheBase(t *testing.T) {
	base := "<p>é and e</p>"
	ok := at(base, "and", "or")
	cases := []struct {
		name   string
		rs     []Replacement
		index  int
		reason string
	}{
		{"mismatch", []Replacement{ok, {Start: 10, End: 11, OldHTML: "x", NewHTML: "y"}}, 1, ReasonMismatch},
		{"out of order", []Replacement{at(base, "e<", "E<"), ok}, 1, ReasonRange},
		{"overlapping", []Replacement{ok, {Start: ok.End - 1, End: ok.End + 1, OldHTML: "d ", NewHTML: ""}}, 1, ReasonRange},
		{"past the end", []Replacement{{Start: len(base), End: len(base) + 1, OldHTML: "x"}}, 0, ReasonRange},
		{"negative", []Replacement{{Start: -1, End: 0, NewHTML: "x"}}, 0, ReasonRange},
		{"inside a character", []Replacement{{Start: 4, End: 4, NewHTML: "x"}}, 0, ReasonRange},
		{"invalid UTF-8", []Replacement{{Start: 3, End: 3, NewHTML: "\xff"}}, 0, ReasonInvalid},
		{"nothing changes", []Replacement{at(base, "and", "and")}, 0, ReasonUnchanged},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Replace([]byte(base), []byte(base), tc.rs)
			var e *ReplacementError
			if !errors.As(err, &e) || e.Index != tc.index || e.Reason != tc.reason {
				t.Fatalf("err = %#v, want %s on replacement %d", err, tc.reason, tc.index)
			}
		})
	}
}

// patch applies the changes of a diff of a and b, taking the new bytes from b.
func patch(a, b []byte, changes []change) []byte {
	var out []byte
	copied, shift := 0, 0
	for _, c := range changes {
		out = append(out, a[copied:c.start]...)
		out = append(out, b[c.start+shift:c.start+shift+c.size]...)
		shift += c.size - (c.end - c.start)
		copied = c.end
	}
	return append(out, a[copied:]...)
}

func TestDiffTurnsOneTextIntoTheOther(t *testing.T) {
	//nolint:gosec // G404: a fixed seed makes the same texts on every run.
	rng := rand.New(rand.NewPCG(1, 2))
	for range 2000 {
		a := make([]byte, rng.IntN(40))
		for i := range a {
			a[i] = "ab<>"[rng.IntN(4)]
		}
		b := slicesMutate(rng, a)
		changes := diff(a, b)
		if got := patch(a, b, changes); !bytes.Equal(got, b) {
			t.Fatalf("diff(%q, %q) = %v patches to %q", a, b, changes, got)
		}
	}
}

// slicesMutate returns a copy of a with a few random edits.
func slicesMutate(rng *rand.Rand, a []byte) []byte {
	b := append([]byte(nil), a...)
	for range rng.IntN(4) {
		at := rng.IntN(len(b) + 1)
		cut := min(rng.IntN(4), len(b)-at)
		b = append(b[:at:at], append([]byte("xé"[:rng.IntN(3)]), b[at+cut:]...)...)
	}
	return b
}

func TestDiffStaysCheapOnLargeDocuments(t *testing.T) {
	if testing.Short() {
		t.Skip("large documents")
	}
	page := bytes.Repeat([]byte("<p>Some words of a long document, with é and 😀.</p>\n"), 50<<20/56)
	// Two small changes at the two ends of 50 MiB need a long walk.
	far := append([]byte("<p>New</p>"), page[:len(page)-4]...)
	// Random bytes against random bytes have no short diff at all.
	noise := func() []byte {
		b := make([]byte, 4<<20)
		_, _ = crand.Read(b)
		return b
	}
	for name, texts := range map[string][2][]byte{"far apart": {page, far}, "unrelated": {noise(), noise()}} {
		started := time.Now()
		changes := diff(texts[0], texts[1])
		took := time.Since(started)
		if !bytes.Equal(patch(texts[0], texts[1], changes), texts[1]) {
			t.Fatalf("%s: the diff does not turn the texts into each other", name)
		}
		t.Logf("%s: %d changes in %v", name, len(changes), took)
		if took > 5*time.Second {
			t.Fatalf("%s: diff took %v", name, took)
		}
	}
}

func TestReplacementSummaryNamesWhatAReaderSeesChange(t *testing.T) {
	base := `<html><head><style>p { color: red }</style></head><body>
<p>Clients retry <b>twice</b> before the owner. The end.</p>
<ul><li>Read the notes</li></ul>
<p id="health">Build health: <b id="status"></b></p>
<script>const LABEL = "Green"; document.getElementById("status").textContent = LABEL;</script>
</body></html>`
	end := strings.Index(base, "\n<p id=")
	for _, c := range []struct {
		name string
		r    Replacement
		want string
	}{
		{"words", at(base, "twice", "three times"), "Changed “twice” to “three times”"},
		{"added words", at(base, "The end.", "The end. More words."), "Added “More words.”"},
		{"removed words", at(base, " The end.", ""), "Removed “The end.”"},
		// The editor saves the bytes that changed, which can start inside a tag.
		{"paragraph", Replacement{Start: end - 1, End: end - 1, NewHTML: "><p>A new paragraph.</p"},
			"Added a paragraph: “A new paragraph.”"},
		{"list item", at(base, "</li></ul>", "</li><li>Write the notes</li></ul>"), "Added a list item: “Write the notes”"},
		{"empty list item", at(base, "</li></ul>", "</li><li><br></li></ul>"), "Added a list item"},
		{"split", at(base, " The end.", "</p><p>The end."), "Split a paragraph: “Clients retry twice before the owner. The end.”"},
		{"list", at(base, "<ul><li>Read the notes</li></ul>", "<p>Read the notes</p>"), "Changed a bulleted list to paragraphs: “Read the notes”"},
		{"link", at(base, "owner. The", `<a href="https://example.com">owner. The</a>`), "Linked “owner. The”"},
		{"bold", at(base, "Clients", "<b>Clients</b>"), "Made “Clients” bold"},
		{"italic", at(base, "twice", "<em>twice</em>"), "Made “twice” italic"},
		{"unbold", at(base, "<b>twice</b>", "twice"), "Removed bold from “twice”"},
		{"script", at(base, `"Green"`, `"Amber"`), "Changed a script"},
		{"script and tag", at(base, `id="status"></b></p>
<script>const LABEL = "Green";`, `>Amber</b></p>
<script>const LABEL = "G";`), "Added “Amber”"},
		{"style", at(base, "red", "blue"), "Changed the styles"},
		{"attribute", at(base, `id="health"`, `id="health" class="note"`), "Changed the formatting of “Build health:”"},
		{"bold moved", at(base, "<b>twice</b> before", "<b>twice before</b>"), "Made “twice before” bold"},
		{"link target", at(base, "owner.", `<a href="https://a.example">owner.</a>`), "Linked “owner.”"},
	} {
		if got := ReplacementSummary([]byte(base), []Replacement{c.r}); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestReplacementSummaryHasALinePerReplacement(t *testing.T) {
	base := "<p>Try it.</p><p>Try it.</p>"
	got := ReplacementSummary([]byte(base), []Replacement{
		{Start: 3, End: 6, OldHTML: "Try", NewHTML: "Run"},
		{Start: len(base), End: len(base), NewHTML: "<p>" + strings.Repeat("word ", 20) + "</p>"},
	})
	want := "Changed “Try” to “Run”\nAdded a paragraph: “" + strings.TrimSpace(strings.Repeat("word ", 11)) + "…”"
	if got != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

// The editor sends a new bold of part of a sentence as two replacements: its
// start tag and its end tag. One line names the words between them.
func TestReplacementSummaryNamesAFormatFromItsStartTagToItsEndTag(t *testing.T) {
	base := `<p>Select only these words today.</p><p>Clients retry twice before giving up.</p>`
	tags := func(word, start, end string) []Replacement {
		r := at(base, word, "")
		return []Replacement{
			{Start: r.Start, End: r.Start, NewHTML: start},
			{Start: r.End, End: r.End, NewHTML: end},
		}
	}
	for _, c := range []struct {
		name string
		rs   []Replacement
		want string
	}{
		{"bold", tags("these words", "<strong>", "</strong>"), "Made “these words” bold"},
		{"one word", tags("twice", "<strong>", "</strong>"), "Made “twice” bold"},
		{"italic", tags("these words", "<em>", "</em>"), "Made “these words” italic"},
		{"link", tags("these words", `<a href="https://example.com">`, "</a>"), "Linked “these words”"},
		{"two edits", append(tags("these words", "<b>", "</b>"), at(base, "twice", "three times")),
			"Made “these words” bold\nChanged “twice” to “three times”"},
	} {
		if got := ReplacementSummary([]byte(base), c.rs); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}

	linked := `<p>Read <a href="https://a.example">the notes</a> first.</p>`
	for _, c := range []struct {
		name string
		rs   []Replacement
		want string
	}{
		{"unlink", []Replacement{at(linked, `<a href="https://a.example">`, ""), at(linked, "</a>", "")},
			"Removed the link from “the notes”"},
		{"link target", []Replacement{at(linked, "a.example", "b.example")}, "Changed the link on “the notes”"},
		{"markup", []Replacement{at(linked, "<p>", "<p >")}, "Changed the HTML only"},
	} {
		if got := ReplacementSummary([]byte(linked), c.rs); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}
