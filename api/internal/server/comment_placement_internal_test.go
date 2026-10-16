package server

import (
	"math"
	"testing"
	"unicode/utf16"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

// The anchors below are what the viewer's describeAnchor records for these
// documents, so the API and the viewer are checked against the same cases
// (frontend/tests/anchoring-repeated-text.test.ts).

const plansV1 = "<p>Plan A: TBD</p><p>Plan B: TBD</p><p>Plan C: done</p>"

// planBComment is on the "TBD" after "Plan B:" in plansV1.
var planBComment = repo.Comment{
	VersionID:    "ver_1",
	SelectedText: "TBD",
	Anchor:       repo.Anchor{Quote: "TBD", Prefix: "Plan A: TBDPlan B: ", Suffix: "Plan C: done", StartOffset: 19, EndOffset: 22},
}

const ownersV1 = "<p>Payments: the owner is TBD until finance replies.</p>" +
	"<p>Search: the owner is TBD until the vendor replies.</p>" +
	"<p>Notes.</p>"

// searchOwnerComment is on the "TBD" in the Search paragraph of ownersV1.
var searchOwnerComment = repo.Comment{
	VersionID:    "ver_1",
	SelectedText: "TBD",
	Anchor:       repo.Anchor{Quote: "TBD", Prefix: "ce replies.Search: the owner is ", Suffix: " until the vendor replies.Notes.", StartOffset: 70, EndOffset: 73},
}

// launchComment is on a sentence that appears once.
var launchComment = repo.Comment{
	VersionID:    "ver_1",
	SelectedText: "The launch date is 14 November.",
	Anchor:       repo.Anchor{Quote: "The launch date is 14 November.", Prefix: "Old intro that was there before.", Suffix: "Old closing text.", StartOffset: 32, EndOffset: 63},
}

func TestCommentPlacementOnRepeatedText(t *testing.T) {
	for _, tc := range []struct {
		name    string
		comment repo.Comment
		html    string
		want    string
	}{
		{"unchanged", planBComment, plansV1, placementAttached},
		{"commented copy edited", planBComment, "<p>Plan A: TBD</p><p>Plan B: shipped 12 Oct</p><p>Plan C: done</p>", placementOrphaned},
		{"neighbouring copy edited", planBComment, "<p>Plan A: shipped 12 Oct</p><p>Plan B: TBD</p><p>Plan C: done</p>", placementAttached},
		{"content added above", planBComment, "<h1>Roadmap</h1>" + plansV1, placementAttached},
		// The quote is still at its stored offsets, so the viewer anchors it
		// there whatever the context says.
		{"text after the commented copy rewritten", planBComment, "<p>Plan A: TBD</p><p>Plan B: TBD</p><p>X</p>", placementAttached},
		{"every copy removed", planBComment, "<p>Plan A: done</p><p>Plan B: done</p>", placementOrphaned},
		{"paragraph unchanged", searchOwnerComment, ownersV1, placementAttached},
		{"paragraph moved", searchOwnerComment, "<p>Payments: the owner is TBD until finance replies.</p><p>Notes.</p><p>Search: the owner is TBD until the vendor replies.</p>", placementAttached},
		{"unique quote, context rewritten", launchComment, "<p>Completely new intro text here.</p><p>The launch date is 14 November.</p><p>Totally different closing words.</p>", placementAttached},
		// Neither copy is at the stored position; the nearer one's context
		// scores just below the floor and the farther one's clears it.
		{"a farther copy whose context agrees", repo.Comment{VersionID: "ver_1", SelectedText: "TBD", Anchor: repo.Anchor{Quote: "TBD", Prefix: "Owner for the payments team: ", Suffix: " until finance replies here.", StartOffset: 27, EndOffset: 30}}, "<p>Owner for the payment group: TBD until the vendor replies.</p><p>Owner for payments: TBD until finance says so.</p>", placementAttached},
		{"repeated quote without stored context", repo.Comment{VersionID: "ver_1", SelectedText: "TBD", Anchor: repo.Anchor{Quote: "TBD"}}, "<p>Plan A: TBD</p><p>Plan B: shipped</p><p>Plan C: TBD</p>", placementAttached},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, _, _ := commentPlacement(tc.comment, "ver_2", newPlacementDoc([]byte(tc.html)))
			if status != tc.want {
				t.Errorf("status = %q, want %q", status, tc.want)
			}
		})
	}
}

// The viewer never matches a quote inside script, style or noscript, so a
// copy there must not count as a second copy, or as a copy at all.
func TestCommentPlacementIgnoresScriptsAndStyles(t *testing.T) {
	visible := repo.Comment{
		VersionID:    "ver_1",
		SelectedText: "TBD",
		Anchor:       repo.Anchor{Quote: "TBD", Prefix: "Old intro ", Suffix: " old outro.", StartOffset: 10, EndOffset: 13},
	}
	for _, tc := range []struct {
		name string
		html string
		want string
	}{
		{"script copy beside the visible one", `<p>New words here TBD and different words.</p><script>const x = "TBD";</script>`, placementAttached},
		{"style and noscript copies beside the visible one", `<p>New words here TBD and different words.</p><style>/* TBD */</style><noscript>TBD</noscript>`, placementAttached},
		{"only a script copy left", `<p>New words here and different words.</p><script>const x = "TBD"; const y = "TBD";</script>`, placementOrphaned},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, _, _ := commentPlacement(visible, "ver_2", newPlacementDoc([]byte(tc.html)))
			if status != tc.want {
				t.Errorf("status = %q, want %q", status, tc.want)
			}
		})
	}
}

// Stored offsets count UTF-16 code units of raw textContent, which has no
// character for a <br>, as the viewer records them.
func TestCommentPlacementReadsStoredOffsetsLikeTheViewer(t *testing.T) {
	for _, tc := range []struct {
		name    string
		comment repo.Comment
		html    string
	}{
		{
			"emoji before the quote",
			repo.Comment{VersionID: "ver_1", SelectedText: "TBD", Anchor: repo.Anchor{Quote: "TBD", Prefix: "🚀 Plan A: TBDPlan B: ", Suffix: "Plan C: done", StartOffset: 22, EndOffset: 25}},
			"<p>🚀 Plan A: TBD</p><p>Plan B: TBD</p><p>Rewritten entirely</p>",
		},
		{
			"br before the quote",
			repo.Comment{VersionID: "ver_1", SelectedText: "TBD", Anchor: repo.Anchor{Quote: "TBD", Prefix: "Plan A: TBD Plan B: ", Suffix: "Plan C: done", StartOffset: 19, EndOffset: 22}},
			"<p>Plan A: TBD<br>Plan B: TBD</p><p>Rewritten entirely</p>",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, _, _ := commentPlacement(tc.comment, "ver_2", newPlacementDoc([]byte(tc.html)))
			if status != placementAttached {
				t.Errorf("status = %q, want %q", status, placementAttached)
			}
		})
	}
}

func TestCommentPlacementOnTheCommentedVersionIsAttached(t *testing.T) {
	doc := newPlacementDoc([]byte("<p>Plan A: TBD</p><p>Plan B: shipped 12 Oct</p>"))
	if status, _, _ := commentPlacement(planBComment, planBComment.VersionID, doc); status != placementAttached {
		t.Errorf("status = %q, want %q", status, placementAttached)
	}
}

// The viewer measured these context scores for the same documents; the API
// must agree with it on which side of the threshold each case falls.
func TestContextScoreMatchesTheViewer(t *testing.T) {
	for _, tc := range []struct {
		name    string
		comment repo.Comment
		html    string
		copyAt  int // The index of the quote's copy to score, in body text.
		want    float64
	}{
		{"commented copy edited", planBComment, "<p>Plan A: TBD</p><p>Plan B: shipped 12 Oct</p><p>Plan C: done</p>", 0, 0.50},
		{"neighbouring copy edited", planBComment, "<p>Plan A: shipped 12 Oct</p><p>Plan B: TBD</p><p>Plan C: done</p>", 0, 0.76},
		{"later copy edited", planBComment, "<p>Plan A: TBD</p><p>Plan B: TBD</p><p>Plan C: shipped</p>", 1, 0.83},
		{"paragraph moved", searchOwnerComment, "<p>Payments: the owner is TBD until finance replies.</p><p>Notes.</p><p>Search: the owner is TBD until the vendor replies.</p>", 1, 0.80},
	} {
		t.Run(tc.name, func(t *testing.T) {
			text := renderedBodyText(tc.html).units
			quote := units(tc.comment.Anchor.Quote)
			start := indexAll(text, quote)[tc.copyAt]
			got := contextScore(text, start, start+len(quote), units(tc.comment.Anchor.Prefix), units(tc.comment.Anchor.Suffix))
			if math.Abs(got-tc.want) > 0.01 {
				t.Errorf("contextScore = %.3f, want %.2f", got, tc.want)
			}
		})
	}
}

func TestRenderedBodyText(t *testing.T) {
	got := renderedBodyText("<html><head><title>T</title></head><body><p>a<br>b</p><template>x</template><script>s()</script><p>c&amp;d</p></body></html>")
	if want := "a b\x00\x00\x00c&d"; string(utf16.Decode(got.units)) != want {
		t.Errorf("text = %q, want %q", string(utf16.Decode(got.units)), want)
	}
	if want := []int{1}; len(got.brs) != 1 || got.brs[0] != want[0] {
		t.Errorf("brs = %v, want %v", got.brs, want)
	}
}

func TestIndexAll(t *testing.T) {
	if got := indexAll(units("aaa"), units("aa")); len(got) != 2 || got[0] != 0 || got[1] != 1 {
		t.Errorf("indexAll overlapping = %v, want [0 1]", got)
	}
	if got := indexAll(units("abc"), nil); len(got) != 0 {
		t.Errorf("indexAll empty sub = %v, want none", got)
	}
	if occursMoreThanOnce("", "") || occursMoreThanOnce("abc", "") {
		t.Error("occursMoreThanOnce with an empty sub = true, want false")
	}
}

func TestTextMatchScore(t *testing.T) {
	for _, tc := range []struct {
		text, str string
		want      float64
	}{
		{"hello world", "world", 1},
		{"hello wrld", "world", 0.8},
		{"", "world", 0},
		{"world", "", 0},
	} {
		if got := textMatchScore(units(tc.text), units(tc.str)); math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("textMatchScore(%q, %q) = %v, want %v", tc.text, tc.str, got, tc.want)
		}
	}
}

func units(s string) []uint16 { return utf16.Encode([]rune(s)) }
