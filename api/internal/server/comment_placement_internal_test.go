package server

import (
	"math"
	"testing"

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
		{"every copy removed", planBComment, "<p>Plan A: done</p><p>Plan B: done</p>", placementOrphaned},
		{"paragraph moved", searchOwnerComment, "<p>Payments: the owner is TBD until finance replies.</p><p>Notes.</p><p>Search: the owner is TBD until the vendor replies.</p>", placementAttached},
		{"unique quote, context rewritten", launchComment, "<p>Completely new intro text here.</p><p>The launch date is 14 November.</p><p>Totally different closing words.</p>", placementAttached},
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
			text := renderedBodyText(tc.html)
			copies := indexAll(text, tc.comment.Anchor.Quote)
			start := copies[tc.copyAt]
			got := contextScore(text, start, start+len(tc.comment.Anchor.Quote), []rune(tc.comment.Anchor.Prefix), []rune(tc.comment.Anchor.Suffix))
			if math.Abs(got-tc.want) > 0.01 {
				t.Errorf("contextScore = %.3f, want %.2f", got, tc.want)
			}
		})
	}
}

func TestRenderedBodyTextReadsBrAsSpaceAndSkipsTemplates(t *testing.T) {
	got := renderedBodyText("<html><head><title>T</title></head><body><p>a<br>b</p><template>x</template><p>c&amp;d</p></body></html>")
	if want := "a bc&d"; got != want {
		t.Errorf("renderedBodyText = %q, want %q", got, want)
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
		if got := textMatchScore([]rune(tc.text), []rune(tc.str)); math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("textMatchScore(%q, %q) = %v, want %v", tc.text, tc.str, got, tc.want)
		}
	}
}
