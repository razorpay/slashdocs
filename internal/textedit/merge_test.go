package textedit

import (
	"bytes"
	"encoding/json"
	"math/rand/v2"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// merge applies ours, made on base, to latest, a later state of base, as the
// later write. It also makes sure that the other order gives the same text:
// the changes of latest, moved over ours, on base with ours.
func merge(t *testing.T, base, latest string, ours []Replacement) string {
	t.Helper()
	theirs := Between([]byte(base), []byte(latest))
	onto := func(state []byte, rs []Replacement) string {
		t.Helper()
		out, err := Patch(state, rs)
		if err != nil {
			t.Fatalf("base %q, ours %+v, theirs %+v: %+v do not fit %q: %v", base, ours, theirs, rs, state, err)
		}
		return string(out)
	}
	moved := Transform(Bytes(base), ours, theirs, true)
	got := onto([]byte(latest), moved)
	if !Keeps(Bytes(base), theirs, Bytes(latest), moved) {
		t.Errorf("base %q, ours %+v, theirs %+v: %+v do not keep their tags", base, ours, theirs, moved)
	}
	if other := onto(apply([]byte(base), ours), Transform(Bytes(base), theirs, ours, false)); other != got {
		t.Fatalf("base %q, ours %+v, theirs %+v: ours over theirs gives %q, theirs over ours gives %q", base, ours, theirs, got, other)
	}
	return got
}

// The browser reads the same cases, so both sides merge in the same way.
func TestTransformGivesTheResultsOfTheSharedCases(t *testing.T) {
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
			if got := merge(t, tc.Base, tc.Theirs, Between([]byte(tc.Base), []byte(tc.Ours))); got != tc.Merged {
				t.Fatalf("got %q, want %q", got, tc.Merged)
			}
		})
	}
}

func TestTransformKeepsBothChanges(t *testing.T) {
	base := "<h1>Plan</h1><p>The quick brown fox.</p><p>Last.</p>"
	cases := []struct {
		name   string
		latest string
		ours   []Replacement
		want   string
	}{
		{"whole words, two ends of one word", strings.Replace(base, "quick", "quickly", 1),
			[]Replacement{at(base, "quick", "very quick")}, "<h1>Plan</h1><p>The very quickly brown fox.</p><p>Last.</p>"},
		// Both words stay whole, also where one has a letter of the old word.
		{"whole words, both replace letters of the word", strings.Replace(base, "brown", "red", 1),
			[]Replacement{at(base, "brown", "black")}, "<h1>Plan</h1><p>The quick blackred fox.</p><p>Last.</p>"},
		{"whole words, each changes other letters of the word", strings.Replace(base, "brown", "crown", 1),
			[]Replacement{at(base, "brown", "brows")}, "<h1>Plan</h1><p>The quick crows fox.</p><p>Last.</p>"},
		{"whole words, both replace the word", strings.Replace(base, "fox", "cat", 1),
			[]Replacement{at(base, "fox", "dog")}, "<h1>Plan</h1><p>The quick brown dogcat.</p><p>Last.</p>"},
		{"a whole word that latest typed in", strings.Replace(base, "brown", "browns", 1),
			[]Replacement{at(base, "brown", "black")}, "<h1>Plan</h1><p>The quick blacks fox.</p><p>Last.</p>"},
		{"several replacements", strings.Replace(strings.Replace(base, "Plan", "The plan", 1), "fox", "cat", 1),
			[]Replacement{at(base, "quick", "slow"), at(base, "fox", "fox and dog"), at(base, "Last.", "Last!")},
			"<h1>The plan</h1><p>The slow brown cat and dog.</p><p>Last!</p>"},
		{"a replacement that keeps its HTML", strings.Replace(base, "quick", "slow", 1),
			[]Replacement{at(base, "quick", "quick"), at(base, "Last", "First")}, "<h1>Plan</h1><p>The slow brown fox.</p><p>First.</p>"},
		{"latest deleted the paragraph", strings.Replace(base, "<p>The quick brown fox.</p>", "", 1),
			[]Replacement{at(base, "brown", "brown and red")}, "<h1>Plan</h1><p> and red</p><p>Last.</p>"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := merge(t, base, tc.latest, tc.ours); got != tc.want {
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
		if got, err := Patch([]byte(base), rs); len(rs) > 0 && (err != nil || string(got) != theirs) {
			t.Fatalf("Between(%q, %q) = %+v, which gives %q, %v", base, theirs, rs, got, err)
		}
		if ours == base {
			continue
		}
		// The replacements of a writer are a diff or one whole replacement.
		// Both orders give one text, which merge makes sure of.
		for _, mine := range [][]Replacement{Between([]byte(base), []byte(ours)), {{End: len(base), OldHTML: base, NewHTML: ours}}} {
			if merged := merge(t, base, theirs, mine); !utf8.ValidString(merged) {
				t.Fatalf("merge(%q, %q, %+v) = %q", base, theirs, mine, merged)
			}
			// With no change in latest, the replacements only apply.
			if alone := merge(t, base, base, mine); alone != ours {
				t.Fatalf("merge(%q, the same, %+v) = %q", base, mine, alone)
			}
			// Invert gives the state before.
			if back, err := Patch([]byte(ours), Invert(mine)); err != nil || string(back) != base {
				t.Fatalf("Invert(%+v) on %q gives %q, %v", mine, ours, back, err)
			}
		}
	}
}

// The cases that a diff of two states got wrong. The exact replacements of
// the other writer give the right text.
func TestTransformUsesTheExactChangesOfTheOtherWriter(t *testing.T) {
	// over gives base with theirs, and then mine moved over theirs.
	over := func(base string, mine, theirs []Replacement) string {
		t.Helper()
		after := apply([]byte(base), theirs)
		out, err := Patch(after, Transform(Bytes(base), mine, theirs, true))
		if err != nil {
			t.Fatal(err)
		}
		return string(out)
	}
	// Another person deletes the first of two equal list items, while I
	// replace a word in the second.
	list := "<ul><li>buy milk</li><li>buy milk</li></ul>"
	second := strings.LastIndex(list, "milk")
	mine := []Replacement{{Start: second, End: second + 4, OldHTML: "milk", NewHTML: "bread"}}
	if got := over(list, mine, []Replacement{{Start: 4, End: 21, OldHTML: "<li>buy milk</li>"}}); got != "<ul><li>buy bread</li></ul>" {
		t.Fatalf("got %q, want my word in my item", got)
	}

	// A person replaces one word while another operation rewrote a far part.
	text := "<p>A quick brown fox jumps over the lazy dog.</p><p>The end is near.</p>"
	theirs := []Replacement{at(text, "A quick brown fox jumps", "A fast black wolf leaps")}
	if got := over(text, []Replacement{at(text, "near", "here")}, theirs); got != "<p>A fast black wolf leaps over the lazy dog.</p><p>The end is here.</p>" {
		t.Fatalf("got %q, want no text lost", got)
	}
}

// Two people select one word and type another word, key by key. Only the
// first key of each replaces the word, and the next keys put text in. Both
// words must stay whole.
func TestTransformKeepsBothWordsThatReplaceOneWordKeyByKey(t *testing.T) {
	// type sends the keys of each writer in turns, each made on the source
	// that its writer has, and returns the document.
	doc := []byte("<p>We decided it.</p>")
	type writer struct {
		source []byte
		caret  int
		word   string
	}
	word := strings.Index(string(doc), "decided")
	writers := []*writer{
		{source: doc, caret: word, word: "agreed"},
		{source: doc, caret: word, word: "rejected"},
	}
	for key := range len("rejected") {
		// Both type the key before either gets the key of the other.
		var ops [][]Replacement
		for _, w := range writers {
			if key >= len(w.word) {
				ops = append(ops, nil)
				continue
			}
			r := Replacement{Start: w.caret, End: w.caret, NewHTML: w.word[key : key+1]}
			if key == 0 {
				r.End, r.OldHTML = w.caret+len("decided"), "decided"
			}
			ops = append(ops, []Replacement{r})
		}
		// The operation of the first writer arrives first.
		a, b := ops[0], ops[1]
		onA := Transform(Bytes(writers[0].source), b, a, true)
		onB := Transform(Bytes(writers[1].source), a, b, false)
		for i, w := range writers {
			own, other := ops[i], [][]Replacement{onA, onB}[i]
			var err error
			if w.source, err = Patch(apply(w.source, own), other); err != nil {
				t.Fatal(err)
			}
			// The caret is after the key of the writer, and text that the
			// other puts in before it moves it.
			if len(own) > 0 {
				w.caret++
			}
			for _, r := range other {
				if r.Start < w.caret || r.Start == w.caret && i == 0 {
					w.caret += len(r.NewHTML) - (r.End - r.Start)
				}
			}
		}
		if !bytes.Equal(writers[0].source, writers[1].source) {
			t.Fatalf("after key %d the writers have %q and %q", key, writers[0].source, writers[1].source)
		}
	}
	if got := string(writers[0].source); got != "<p>We rejectedagreed it.</p>" {
		t.Fatalf("got %q, want both words whole", got)
	}
}

// The inputs of the review for which the move of markup to a tag went
// before the change before it, and Between then cut outside its text.
func TestBetweenDoesNotMoveAChangeBeforeTheChangeBeforeIt(t *testing.T) {
	a, b := "red<li>two </ul><b>", "</ul><li>two </ul></p><b>"
	got, err := Patch([]byte(a), Between([]byte(a), []byte(b)))
	if err != nil || string(got) != b {
		t.Fatalf("Between gives %q, %v; want %q", got, err, b)
	}
}

// markup returns a short random text of tags and words that repeat.
func markup(rng *rand.Rand) []byte {
	parts := []string{"<p>", "</p>", "<li>", "</li>", "</ul>", "<b>", "two", "two ", "red", " ", "a", "é", "x"}
	var out []byte
	for range rng.IntN(10) {
		out = append(out, parts[rng.IntN(len(parts))]...)
	}
	return out
}

func TestBetweenOfRandomHTMLAppliesBack(t *testing.T) {
	//nolint:gosec // G404: a fixed seed makes the same texts on every run.
	rng := rand.New(rand.NewPCG(5, 6))
	for range 200000 {
		a, b := markup(rng), markup(rng)
		rs := Between(a, b)
		if got, err := Patch(a, rs); err != nil || !bytes.Equal(got, b) {
			t.Fatalf("Between(%q, %q) = %+v, which gives %q, %v", a, b, rs, got, err)
		}
		if again := normal(Bytes(a), rs); !slices.Equal(again, rs) {
			t.Fatalf("Between(%q, %q) = %+v is not in its one form: %+v", a, b, rs, again)
		}
	}
}

func FuzzBetween(f *testing.F) {
	f.Add("red<li>two </ul><b>", "</ul><li>two </ul></p><b>")
	f.Add("<p>One. Two.</p>", "<p>One. Alpha. Two.</p>")
	f.Fuzz(func(t *testing.T, a, b string) {
		rs := Between([]byte(a), []byte(b))
		if got, err := Patch([]byte(a), rs); utf8.ValidString(a) && utf8.ValidString(b) && (err != nil || string(got) != b) {
			t.Fatalf("Between(%q, %q) = %+v, which gives %q, %v", a, b, rs, got, err)
		}
	})
}

// A diff can put typed text at more than one place with the same result.
// Its one form is the first of them.
func TestBetweenPutsTypedTextAtOnePlace(t *testing.T) {
	for _, tc := range []struct {
		a, b string
		want Replacement
	}{
		{"<p>One. Two.</p>", "<p>One. Alpha. Two.</p>", Replacement{Start: 6, End: 6, NewHTML: ". Alpha"}},
		{"<p>One two</p>", "<p>One red two</p>", Replacement{Start: 6, End: 6, NewHTML: " red"}},
		{"<p>hello</p>", "<p>helllo</p>", Replacement{Start: 5, End: 5, NewHTML: "l"}},
		{"<p>a b b c</p>", "<p>a b c</p>", Replacement{Start: 4, End: 6, OldHTML: " b"}},
		// Markup stops where it starts with a tag.
		{"<p>alpha</p>\n<p>omega</p>", "<p>alpha</p>\n<p>new</p>\n<p>omega</p>", Replacement{Start: 13, End: 13, NewHTML: "<p>new</p>\n"}},
	} {
		if got := Between([]byte(tc.a), []byte(tc.b)); len(got) != 1 || got[0] != tc.want {
			t.Errorf("Between(%q, %q) = %+v, want %+v", tc.a, tc.b, got, tc.want)
		}
	}
}

// replacements returns a random list of replacements that fit base.
func replacements(rng *rand.Rand, base []byte) []Replacement {
	var rs []Replacement
	for at := 0; at <= len(base) && len(rs) < 4; {
		start := at + rng.IntN(4)
		end := start + rng.IntN(4)
		for start < len(base) && !boundary(base, start) {
			start++
		}
		for end < len(base) && !boundary(base, end) {
			end++
		}
		if end > len(base) {
			break
		}
		rs = append(rs, Replacement{Start: start, End: end, OldHTML: string(base[start:end]), NewHTML: []string{"", "x", "two", " ", "é", "<b>"}[rng.IntN(6)]})
		at = end
	}
	return rs
}

// Two writers who each apply their own replacements and then those of the
// other, moved over their own, have the same text.
func TestTransformGivesOneTextInBothOrders(t *testing.T) {
	//nolint:gosec // G404: a fixed seed makes the same texts on every run.
	rng := rand.New(rand.NewPCG(7, 8))
	for range 300000 {
		base := markup(rng)
		a, b := replacements(rng, base), replacements(rng, base)
		onto := func(mine, theirs []Replacement, first bool) []byte {
			moved := Transform(Bytes(base), mine, theirs, first)
			out, err := Patch(apply(base, theirs), moved)
			if err != nil {
				t.Fatalf("base %q, a %+v, b %+v: %v", base, a, b, err)
			}
			if slices.ContainsFunc(moved, func(r Replacement) bool { return r.OldHTML == r.NewHTML }) {
				t.Fatalf("base %q, a %+v, b %+v: %+v has a replacement that changes nothing", base, a, b, moved)
			}
			return out
		}
		if x, y := onto(a, b, true), onto(b, a, false); !bytes.Equal(x, y) {
			t.Fatalf("base %q, a %+v, b %+v: a over b gives %q, b over a gives %q", base, a, b, x, y)
		}
	}
}

// A writer who takes out a range, and another who changes or types one
// character next to it, as "this." to "this!", both keep their change, and
// no other character goes or stays. A deletion or an insertion gives the
// same text at more than one place, and the merge must not take a place in
// the text that the other writer changes.
func TestTransformKeepsTheTextAroundADeletion(t *testing.T) {
	//nolint:gosec // G404: a fixed seed makes the same texts on every run.
	rng := rand.New(rand.NewPCG(9, 10))
	words := []string{"this.", "it.", "Remove", "a", "aa", "is", ".", "!", ",", "s.", "<b>it.</b>", "<br>", "é"}
	for range 30000 {
		body := ""
		for range 2 + rng.IntN(8) {
			body += words[rng.IntN(len(words))] + []string{" ", ""}[rng.IntN(2)]
		}
		base := "<p>" + body + "</p>"
		// text tells whether base has whole characters of text from start
		// to end, outside tags.
		text := func(start, end int) bool {
			return 3 <= start && start <= end && end <= len(base)-4 && boundary([]byte(base), start) &&
				boundary([]byte(base), end) && tagAt(Bytes(base), start) < 0 && !strings.ContainsAny(base[start:end], "<>")
		}
		// Ours takes out from i to j. Theirs puts with in place of the
		// character from k to l, or in at k, near an end of ours.
		i := 3 + rng.IntN(len(base)-6)
		j := i + 1 + rng.IntN(12)
		k := []int{i, j}[rng.IntN(2)] + rng.IntN(7) - 3
		if !text(i, j) || !text(k, k) {
			continue
		}
		_, n := utf8.DecodeRuneInString(base[k:])
		l, with := k+n*rng.IntN(2), string(".!?,a"[rng.IntN(5)])
		if !text(k, l) || l > i && k < j || base[k:l] == with {
			continue
		}
		var want string
		if k < j {
			want = base[:k] + with + base[l:i] + base[j:]
		} else {
			want = base[:i] + base[j:k] + with + base[l:]
		}
		theirs := base[:k] + with + base[l:]
		if got := merge(t, base, theirs, Between([]byte(base), []byte(base[:i]+base[j:]))); len(got) != len(want) {
			t.Fatalf("base %q, ours takes out %q at %d, theirs %q: got %q, want %q", base, base[i:j], i, theirs, got, want)
		}
	}
}

// One writer selects all and deletes it while the other types in a
// paragraph. The replacements are those that the frame sends. In both
// orders of arrival, the typed text stays in its paragraph, after the empty
// heading that the select-all leaves.
func TestTransformKeepsTypingInItsParagraphAfterASelectAllDelete(t *testing.T) {
	base := "<!doctype html><html><head><title>T</title></head><body>\n<h1>Title</h1>\n<p id=\"c\">Third paragraph here.</p>\n<p id=\"d\">After.</p>\n</body></html>\n"
	deleteAll, err := Normal(Bytes(base), []Replacement{
		at(base, "Title", ""),
		at(base, ">\n<p id=\"c\">Third paragraph here.</p>\n<p id=\"d\">After.</p", ""),
	})
	if err != nil {
		t.Fatal(err)
	}
	typing, err := Normal(Bytes(base), []Replacement{at(base, "here.", "here typing.")})
	if err != nil {
		t.Fatal(err)
	}
	want := "<!doctype html><html><head><title>T</title></head><body>\n<h1></h1><p id=\"c\"> typing</p>\n</body></html>\n"
	for _, order := range [][2][]Replacement{{deleteAll, typing}, {typing, deleteAll}} {
		first, later := order[0], order[1]
		got, err := Patch(apply([]byte(base), first), Transform(Bytes(base), later, first, true))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != want {
			t.Fatalf("got %q\nwant %q", got, want)
		}
	}
}

func TestTouchingFindsChangesOfTheSameText(t *testing.T) {
	base := "one two three"
	two := at(base, "two", "2")
	for name, tc := range map[string]struct {
		other Replacement
		want  bool
	}{
		"the same word":            {at(base, "two", "deux"), true},
		"a part of the word":       {at(base, "wo", "WO"), true},
		"another word":             {at(base, "three", "3"), false},
		"text put in at its end":   {Replacement{Start: two.End, End: two.End, NewHTML: "!"}, true},
		"text put in after a word": {Replacement{Start: two.End + 1, End: two.End + 1, NewHTML: "!"}, false},
		"text put in in the word":  {Replacement{Start: two.Start + 1, End: two.Start + 1, NewHTML: "!"}, true},
	} {
		if got := Touching(Bytes(base), []Replacement{two}, []Replacement{tc.other}) == 0; got != tc.want {
			t.Errorf("%s: touches = %v, want %v", name, got, tc.want)
		}
	}
	point := []Replacement{at(base, "one", "1"), {Start: 3, End: 3, NewHTML: "a"}}
	if got := Touching(Bytes(base), point, []Replacement{{Start: 3, End: 3, NewHTML: "b"}}); got != 0 {
		t.Errorf("two insertions at one point: touching = %d, want the rewrite that holds both replacements", got)
	}
}

// A diff of a rewritten sentence keeps the words that the old and the new
// sentence have in common. Text that another person put in between them is
// in the rewrite. A change of other words of the paragraph is not.
func TestTouchingFindsChangesInARewrite(t *testing.T) {
	base := "<p>Omega paragraph sits here at the very bottom of the document. It has a second sentence that stays as it is.</p>"
	rewrite := Between([]byte(base), []byte(strings.Replace(base, "Omega paragraph sits here at the very bottom of the document.", "Omega is now a short line from the agent.", 1)))
	for name, tc := range map[string]struct {
		before string
		want   bool
	}{
		"text in a word of the rewrite":         {"the docu", true},
		"text between two words of the rewrite": {"bottom of ", true},
		"text in the second sentence":           {"that stays", false},
		"text at the end of the paragraph":      {"as it is.", false},
	} {
		at := strings.Index(base, tc.before) + len(tc.before)
		human := []Replacement{{Start: at, End: at, NewHTML: "HUMANCHANGE "}}
		if got := Touching(Bytes(base), rewrite, human) >= 0; got != tc.want {
			t.Errorf("%s: touching = %v, want %v", name, got, tc.want)
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

// A byte diff can keep one byte of the old text inside a long insertion.
// The insertion must stay one replacement, so that text which another
// writer types at the same place does not go into the middle of it.
func TestBetweenKeepsAnInsertionWhole(t *testing.T) {
	base := "<p>starts here and ends there.</p>\n<p>Section 3 holds the notes.</p>"
	latest := "<p>starts here on Monday  and ends there.</p>\n<p>Section 3 now holds the notes.</p>"
	got := Between([]byte(base), []byte(latest))
	if len(got) != 2 || got[0].Start != 14 || got[0].OldHTML != "" || got[0].NewHTML != " on Monday " {
		t.Fatalf("Between gave %+v, want the insertion of \" on Monday \" at 14 and one more", got)
	}
}

// A request that moves over the log in steps does not move back again over
// text that a step put in. Q replaces "a" with "cb" and then types "Y" in
// that word, before its "b". The "b" of P, which goes in after "xa", must not
// go into the word of Q.
func TestTransformDoesNotMoveARequestIntoTheTextOfALaterStep(t *testing.T) {
	state := NewRope([]byte("xa"))
	mine := []Replacement{{Start: 2, End: 2, NewHTML: "b"}}
	for _, op := range [][]Replacement{
		{{Start: 1, End: 2, OldHTML: "a", NewHTML: "cb"}},
		{{Start: 2, End: 2, NewHTML: "Y"}},
	} {
		mine = Transform(state, mine, op, true)
		if err := state.Patch(op); err != nil {
			t.Fatal(err)
		}
	}
	if err := state.Patch(mine); err != nil || string(state.Bytes()) != "xcYbb" {
		t.Fatalf("got %q, %v; want %q", state.Bytes(), err, "xcYbb")
	}
}

// Two changes of latest around text that it keeps stay two changes, so that
// a replacement can still change that text.
func TestTransformChangesTextBetweenTwoChangesOfLatest(t *testing.T) {
	for _, tc := range []struct{ base, latest, old, new, want string }{
		{"one two three", "one big two fat three", "two", "", "one big  fat three"},
		{"I saw a cat today", "I saw the a big cat today", " a ", " one ", "I saw the one big cat today"},
	} {
		if got := merge(t, tc.base, tc.latest, []Replacement{at(tc.base, tc.old, tc.new)}); got != tc.want {
			t.Errorf("merge(%q, %q, %q to %q) = %q, want %q", tc.base, tc.latest, tc.old, tc.new, got, tc.want)
		}
	}
}

// Two writers take out the same text, one of them as a part of a
// replacement. What is left of the replacement puts in the text that is
// there, and that is no change: the log must not hold it.
func TestTransformDropsAReplacementThatChangesNothing(t *testing.T) {
	base := "<p>abc</p>"
	theirs := []Replacement{at(base, "a", ""), {Start: 5, End: 6, OldHTML: "c"}}
	if got := Transform(Bytes(base), []Replacement{at(base, "abc", "b")}, theirs, true); len(got) != 0 {
		t.Fatalf("got %+v, want no replacement: the text is %q in both orders", got, "<p>b</p>")
	}
	// The other order takes out nothing more.
	if got := Transform(Bytes(base), theirs, []Replacement{at(base, "abc", "b")}, false); len(got) != 0 {
		t.Fatalf("got %+v, want no replacement", got)
	}
}

func TestNormalDropsAReplacementThatChangesNothing(t *testing.T) {
	base := "<p>abc</p>"
	got, err := Normal(Bytes(base), []Replacement{{}, at(base, "abc", "abXc"), at(base, "</p>", "</p>")})
	if want := (Replacement{Start: 5, End: 5, NewHTML: "X"}); err != nil || len(got) != 1 || got[0] != want {
		t.Fatalf("got %+v, %v; want only %+v", got, err, want)
	}
}

// A run of letters and digits can be as long as an image in a data URI.
// Two replacements in it are widened by wordReach characters, and not to
// the ends of the run.
func TestTransformWidensAConflictByAFewCharactersOnly(t *testing.T) {
	run := strings.Repeat("0123456789", 30)
	base := `<img src="data:image/png;base64,` + run + `">`
	at := strings.Index(base, run) + 150
	ours := []Replacement{{Start: at, End: at + 2, OldHTML: base[at : at+2], NewHTML: "Q"}}
	theirs := []Replacement{{Start: at + 1, End: at + 3, OldHTML: base[at+1 : at+3], NewHTML: "R"}}
	got := Transform(Bytes(base), ours, theirs, true)
	if len(got) != 1 || len(got[0].NewHTML) > 2*wordReach+3 {
		t.Fatalf("got %+v, want one replacement of at most %d characters on each side", got, wordReach)
	}
	from, to := at-wordReach, at+3+wordReach
	want := base[:from] + base[from:at] + "Q" + base[at+2:to] + base[from:at+1] + "R" + base[at+3:]
	if merged := merge(t, base, string(apply([]byte(base), theirs)), ours); merged != want {
		t.Fatalf("got %q\nwant %q", merged, want)
	}
}

// A Rope gives the same text as one piece does, for the reads of Transform
// and after each Patch.
func TestRopeIsTheTextOfItsPatches(t *testing.T) {
	//nolint:gosec // G404: a fixed seed makes the same texts on every run.
	rng := rand.New(rand.NewPCG(3, 4))
	for range 2000 {
		flat := markup(rng)
		rope := NewRope(flat)
		for range 8 {
			a, b := replacements(rng, flat), replacements(rng, flat)
			if got, want := Transform(rope, a, b, true), Transform(Bytes(flat), a, b, true); !slices.Equal(got, want) {
				t.Fatalf("on %q: a rope moves %+v over %+v to %+v, one piece to %+v", flat, a, b, got, want)
			}
			before := *rope
			if err := rope.Patch(a); err != nil {
				t.Fatal(err)
			}
			if next := apply(flat, a); !bytes.Equal(rope.Bytes(), next) || !bytes.Equal(before.Bytes(), flat) || rope.Len() != len(next) {
				t.Fatalf("%q with %+v: the rope has %q, and its copy from before %q", flat, a, rope.Bytes(), before.Bytes())
			} else {
				flat = next
			}
		}
	}
	if err := NewRope([]byte("abc")).Patch([]Replacement{{Start: 1, End: 2, OldHTML: "x"}}); err == nil {
		t.Fatal("a replacement that does not fit applied")
	}
}

func TestExcerptGivesTheSentenceInWholeWordsWithoutTags(t *testing.T) {
	base := `<h2 class="t">Cache</h2><p>The TTL is <b>10 minutes</b> &amp; no more.</p>`
	long := "<p>" + strings.Repeat("word ", 30) + "</p>"
	// Paragraphs that start with the same word.
	same := "<p>Paragraph one is here.</p>\n<p>Paragraph two has the\n  changed words. Paragraph three ends it!</p>"
	sentence := "<p>Start " + strings.Repeat("alpha ", 12) + "middle " + strings.Repeat("omega ", 12) + "end.</p>"
	// Text with no space keeps the characters that fit.
	url := "<p>See https://example.com/" + strings.Repeat("abc/", 30) + "x" + strings.Repeat("/def", 30) + " now.</p>"
	for _, tc := range []struct {
		base string
		r    Replacement
		want string
	}{
		{base, at(base, "0 min", "5 min"), "The TTL is 10 minutes & no more."},
		{base, at(base, `t">Cache</h2><p>The`, `t">Store</h2><p>A`), "Cache The TTL is 10 minutes & no more."},
		{base, at(base, "<b>10 minutes</b> &amp; no", "x"), "The TTL is 10 minutes & no more."},
		{base, Replacement{Start: len(base), End: len(base), NewHTML: "<p>new</p>"}, ""},
		// A ">" in text is not the end of a tag.
		{"<p>Use it when a > b holds.</p>", at("<p>Use it when a > b holds.</p>", "a > b", "x"), "Use it when a > b holds."},
		{`<p>Wait</p><a href="/x" title="t">Link</a>`, at(`<p>Wait</p><a href="/x" title="t">Link</a>`, `x" title="t">Link`, "y"), "Link"},
		{long, at(long, strings.Repeat("word ", 30), "x"), strings.TrimSpace(strings.Repeat("word ", 15)) + "…"},
		{same, at(same, "Paragraph two", "Paragraph 2"), "Paragraph two has the changed words."},
		{same, at(same, "three", "3"), "Paragraph three ends it!"},
		{sentence, at(sentence, "middle", "center"), "…" + strings.Repeat("alpha ", 6) + "middle" + strings.Repeat(" omega", 6) + "…"},
		{url, at(url, "/x/", "/y/"), "…bc" + strings.Repeat("/abc", 9) + "/x/" + strings.Repeat("def/", 9) + "de…"},
	} {
		if got := Excerpt(Bytes(tc.base), tc.r, 80); got != tc.want {
			t.Errorf("Excerpt(%+v) = %q, want %q", tc.r, got, tc.want)
		}
	}
}

// A replacement that changes nothing is dropped first, as the browser does,
// so the replacement after it moves back over its range.
func TestNormalMovesAnInsertionBackOverAReplacementThatChangesNothing(t *testing.T) {
	got, err := Normal(Bytes("abcc"), []Replacement{{Start: 2, End: 3, OldHTML: "c", NewHTML: "c"}, {Start: 4, End: 4, NewHTML: "c"}})
	if want := []Replacement{{Start: 2, End: 2, NewHTML: "c"}}; err != nil || !slices.Equal(got, want) {
		t.Fatalf("got %+v, %v; want %+v", got, err, want)
	}
}

// A person removes the paragraph c with the start tag of d, so that c holds
// the text of d, while another person types in c. The removal can also be
// read from inside the start tag of c to inside that of d. Text typed in c
// would then go into the tag, so the removal stays out of tags, and the
// typed text stays text. A person who replaces all the text with a new
// heading gives a replacement that can end inside the last end tag, as
// "Title</h1>…</p" with "New</h1". Its change of that end tag is a part of
// its own (see apart), and the typed text goes after the new text.
func TestNormalKeepsTheEndsOfAChangeOutOfTags(t *testing.T) {
	base := "<h1>Title</h1>\n<p id=\"c\">Third mid paragraph.</p>\n<p id=\"d\">After.</p>"
	cases := []struct {
		name string
		ours Replacement
		want string
	}{
		{"a removal", at(base, "Third mid paragraph.</p>\n<p id=\"d\">", ""), "<h1>Title</h1>\n<p id=\"c\">ZAfter.</p>"},
		{"a removal from inside the tags", at(base, "\">Third mid paragraph.</p>\n<p id=\"d", ""), "<h1>Title</h1>\n<p id=\"c\">ZAfter.</p>"},
		{"a replacement that ends in a tag", at(base, "Title</h1>\n<p id=\"c\">Third mid paragraph.</p>\n<p id=\"d\">After.</p", "New</h1"), "<h1>NewZ</h1>"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ours, err := Normal(Bytes(base), []Replacement{tc.ours})
			if err != nil {
				t.Fatal(err)
			}
			if got := merge(t, base, strings.Replace(base, "mid", "midZ", 1), ours); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// The net of the server finds a tag that does not end, and lets the changes
// of the editor pass: text, new elements, links, and attributes.
func TestBreaksFindsTagsThatDoNotEnd(t *testing.T) {
	base := `<h1>Title</h1>` + "\n" + `<p id="c">Read <a href="/a">the plan</a> now.</p>` + "\n" + `<p>x < y</p>`
	cases := []struct {
		name   string
		rs     []Replacement
		breaks bool
	}{
		{"typed text", []Replacement{at(base, "now", "now and later")}, false},
		{"a new paragraph", []Replacement{at(base, "\n<p>x", "\n<p>New.</p>\n<p>x")}, false},
		{"a new link", []Replacement{at(base, "Read ", `<a href="/r">Read</a> `)}, false},
		{"a link removed", []Replacement{at(base, `<a href="/a">the plan</a>`, "the plan")}, false},
		{"a link that changes", []Replacement{at(base, "/a", "/b")}, false},
		{"an attribute that goes", []Replacement{at(base, ` id="c"`, "")}, false},
		{"bold as two replacements", []Replacement{at(base, "the ", "<b>the "), at(base, "plan", "plan</b>")}, false},
		{"text in an end tag", []Replacement{at(base, "</h1>", "</h1mi>")}, false},
		{"a tag that does not end", []Replacement{at(base, "Title", "fresh</h1")}, true},
		{"a start tag cut", []Replacement{at(base, `"/a">the`, "")}, true},
		{"a tag that did not end before", []Replacement{at(base, "x < y", "x < z")}, false},
		{"a link with a quoted \"<\"", []Replacement{at(base, "/a", "/a?q=<b>")}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Breaks(Bytes(base), tc.rs); got != tc.breaks {
				t.Fatalf("Breaks = %v, want %v", got, tc.breaks)
			}
		})
	}
}

// The net of the server finds a moved replacement that puts text into a tag,
// or that takes the ends of a change of a tag out of that tag. It lets a
// change of a tag pass that stays in its tag.
func TestKeepsFindsReplacementsThatLeaveTheirPlacesInTags(t *testing.T) {
	cases := []struct {
		name, before string
		op, rs       []Replacement
		keeps        bool
	}{
		{"typed text after a new tag", "ab", []Replacement{{Start: 1, End: 1, NewHTML: "<i>"}}, []Replacement{{Start: 4, End: 4, NewHTML: "x"}}, true},
		{"an attribute next to a new attribute", `<p id="a">x</p>`, []Replacement{{Start: 2, End: 2, NewHTML: ` class="b"`}}, []Replacement{{Start: 18, End: 19, OldHTML: "a", NewHTML: "c"}}, true},
		{"typed text in a new tag", "ab", []Replacement{{Start: 1, End: 1, NewHTML: "<i>"}}, []Replacement{{Start: 3, End: 3, NewHTML: "x"}}, false},
		{"a change of a tag across two tags", `<p id="a">x</p>`, []Replacement{{Start: 6, End: 6, NewHTML: `">y<b x="`}}, []Replacement{{Start: 5, End: 16, OldHTML: `"">y<b x="a`}}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			after := apply([]byte(tc.before), tc.op)
			if got := Keeps(Bytes(tc.before), tc.op, Bytes(after), tc.rs); got != tc.keeps {
				t.Fatalf("Keeps = %v, want %v", got, tc.keeps)
			}
		})
	}
}

// A change of a tag goes with the tag that another writer takes out, and
// text that the writer typed in the element goes in at the place of it.
func TestTransformDropsTheChangeOfATagThatGoes(t *testing.T) {
	base := "<p>a</p><p>b</p><p>c</p>"
	ours := Between([]byte(base), []byte("<p>a</p><h2>bZ</h2><p>c</p>"))
	if got, want := merge(t, base, "<p>a</p><p>c</p>", ours), "<p>a</p>Z<p>c</p>"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// The move of a deletion out of a tag reads each tag one time. A long
// attribute has no "<" or ">" in it, and a read for each step of the move
// would read it all.
func TestNormalOfADeletionOutOfALongAttributeIsLinear(t *testing.T) {
	value := strings.Repeat("a", 4<<20)
	base := `<i title="` + value + `">` + strings.Repeat("a", 3000) + `</i>`
	at := len(`<i title="`) + len(value) - 1500
	end := at + 1500 + len(`">`) + 1500
	started := time.Now()
	if _, err := Normal(NewRope([]byte(base)), []Replacement{{Start: at, End: end, OldHTML: base[at:end]}}); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(started); took > time.Second {
		t.Fatalf("Normal took %v", took)
	}
}

// Two deletions that overlap in a long run of one character move toward each
// other by at most settleReach characters, and read the tags only where they
// step over a "<" or a ">". Else each step reads the whole run.
func TestTransformOfDeletionsInALongRunIsLinear(t *testing.T) {
	n := 1 << 20
	base := "<p>" + strings.Repeat("a", n) + "</p>"
	ours := []Replacement{{Start: 3, End: 3 + n/2, OldHTML: base[3 : 3+n/2]}}
	theirs := []Replacement{{Start: 3 + n/4, End: 3 + 3*n/4, OldHTML: base[3+n/4 : 3+3*n/4]}}
	started := time.Now()
	moved := Transform(NewRope([]byte(base)), ours, theirs, true)
	other := Transform(NewRope([]byte(base)), theirs, ours, false)
	if took := time.Since(started); took > time.Second {
		t.Fatalf("Transform took %v", took)
	}
	got, err := Patch(apply([]byte(base), theirs), moved)
	want, err2 := Patch(apply([]byte(base), ours), other)
	if err != nil || err2 != nil || !bytes.Equal(got, want) {
		t.Fatalf("the two orders give %d and %d bytes, %v, %v", len(got), len(want), err, err2)
	}
}

// A run of one character can be as long as the document. The walk back over
// it has an end.
func TestNormalMovesAnInsertionBackALimitedCountOfCharacters(t *testing.T) {
	for _, c := range []string{"a", "é"} {
		base := "<p>" + strings.Repeat(c, 5000)
		got, err := Normal(Bytes(base), []Replacement{{Start: len(base), End: len(base), NewHTML: c}})
		if at := len(base) - settleReach*len(c); err != nil || len(got) != 1 || got[0].Start != at || got[0].NewHTML != c {
			t.Fatalf("an insertion of %q after 5000 of it = %+v, %v; want it %d characters back", c, got, err, settleReach)
		}
	}
	// Text of more than one character turns as it moves back.
	got, err := Normal(Bytes("xab"), []Replacement{{Start: 3, End: 3, NewHTML: "ab"}})
	if want := []Replacement{{Start: 1, End: 1, NewHTML: "ab"}}; err != nil || !slices.Equal(got, want) {
		t.Fatalf("got %+v, %v; want %+v", got, err, want)
	}
	if got, err = Normal(Bytes("xab"), []Replacement{{Start: 3, End: 3, NewHTML: "cb"}}); err != nil || got[0] != (Replacement{Start: 2, End: 2, NewHTML: "bc"}) {
		t.Fatalf("got %+v, %v; want the text bc one character back", got, err)
	}
}

// longReplay patches a text of 1 MB with 2000 operations of 100
// replacements each, as a rewind of a long sitting does.
func longReplay() *Rope {
	text := bytes.Repeat([]byte("abcdefghij"), 100_000)
	rope := NewRope(text)
	for op := range 2000 {
		rs := make([]Replacement, 100)
		for i := range rs {
			at := i*len(text)/len(rs) + op*7919%(len(text)/len(rs)-1)
			rs[i] = Replacement{Start: at, End: at + 1, OldHTML: string(rope.Slice(at, at+1)), NewHTML: "x"}
		}
		if err := rope.Patch(rs); err != nil {
			panic(err)
		}
	}
	return rope
}

// A Rope joins its parts, so a long replay does not copy a list of parts
// that grows with each operation.
func TestALongReplayTakesLittleTime(t *testing.T) {
	start := time.Now()
	rope := longReplay()
	if took := time.Since(start); took > time.Second {
		t.Fatalf("the replay took %v, want less than a second", took)
	}
	if p := len(rope.parts); p*p > 101*rope.Len() {
		t.Fatalf("the rope has %d parts", p)
	}
}

func BenchmarkLongReplay(b *testing.B) {
	for b.Loop() {
		longReplay()
	}
}
