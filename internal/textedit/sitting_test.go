package textedit

import (
	"strings"
	"testing"
)

// report is a document as an agent writes one: headings, paragraphs of
// several sentences, a list and a table.
const report = `<!doctype html><html><head><title>Q3 report</title><style>body { font: 16px sans-serif }</style></head><body>
<h1>Payments platform: third quarter</h1>
<p>The payments platform closed the third quarter with steady growth. Card volume grew in each month, and refunds stayed flat.</p>
<h2>Summary</h2>
<p>The team shipped the new retry worker in July. It cut failed webhooks by a third. The on-call load went down in the same period.</p>
<h2>Volume</h2>
<p>Volume grew in each month of the quarter. July was the slowest month, and September was the best one.</p>
<table><tr><th>Month</th><th>Payments</th></tr><tr><td>July</td><td>1.2 million</td></tr><tr><td>August</td><td>1.4 million</td></tr></table>
<h2>Support</h2>
<ul><li>Tickets went down by 12 percent.</li><li>The median answer time is 4 hours.</li></ul>
<h2>Risks</h2>
<p>The card network changes its fees in January. The admin opens the page each morning.</p>
<h2>Next steps</h2>
<p>Move the last two services to the new worker. Then remove the old queue.</p>
</body></html>`

// sitting returns the report after each change of old text to new text.
func sitting(t *testing.T, changes ...string) string {
	t.Helper()
	after := report
	for i := 0; i < len(changes); i += 2 {
		if strings.Count(after, changes[i]) != 1 {
			t.Fatalf("%q is not one time in the report", changes[i])
		}
		after = strings.Replace(after, changes[i], changes[i+1], 1)
	}
	return after
}

// A version is a sitting with many changes. Its line in History says what a
// reader sees: the words of one change, or the sections of more.
func TestChangeSummaryOfASitting(t *testing.T) {
	for _, tc := range []struct {
		name    string
		changes []string
		want    string
	}{
		// A sentence with a new paragraph, two people in five paragraphs, and
		// text typed in a word.
		{"a sentence and a new paragraph", []string{"refunds stayed flat.</p>", "refunds stayed flat. Disputes went down too.</p>\n<p>The finance team signed the numbers on Monday.</p>"},
			"Edited the introduction"},
		{"two people in five paragraphs", []string{
			"refunds stayed flat.", "refunds stayed flat for the whole quarter.",
			"by a third.", "by a third, as planned.",
			"<p>Volume grew", "<p>The finance team signed the numbers on Monday. Volume grew",
			"The median answer time is 4 hours.", "The median answer time is 3 hours.",
			"Then remove the old queue.", "Then remove the old queue in November."},
			"Edited the introduction, Summary and other sections"},
		{"text typed in a word", []string{"The admin opens the page", "The admin opens tx The admin types a lohe page"},
			"Changed “the” to “tx The admin types a lohe”"},

		{"a sentence", []string{"by a third.", "by a third. No customer saw an error."}, "Added “No customer saw an error.”"},
		{"a sentence removed", []string{" The on-call load went down in the same period.", ""}, "Removed “The on-call load went down in the same period.”"},
		{"a word", []string{"by a third", "by a half"}, "Changed “third” to “half”"},
		{"two words of one paragraph", []string{"July was the slowest", "August was the slowest", "September was the best", "October was the best"},
			"Edited Volume"},
		// The text under the title is not a section that the title names.
		{"words added in two places of one paragraph", []string{"Card volume", "Card and wallet volume", "stayed flat.", "stayed almost flat."},
			"Edited the introduction"},
		{"the introduction and a section", []string{"Card volume", "Card and wallet volume", "in January.", "in March."},
			"Edited the introduction and Risks"},
		{"the introduction rewritten", []string{"The payments platform closed the third quarter with steady growth. Card volume grew in each month, and refunds stayed flat.", "Our platform ended September well ahead of plan, and the new wallet doubled its users."},
			"Rewrote a paragraph in the introduction"},
		{"the title and its text", []string{"third quarter</h1>", "the third quarter</h1>", "with steady growth.", "with strong growth."},
			"Edited Payments platform: the third quarter and the introduction"},
		{"a long sentence", []string{"Then remove the old queue.", "Then remove the old queue. The platform team owns this work, and it reports the state of each service in the weekly review until the last one moved."},
			"Added “The platform team owns this work, and it reports the state…”"},
		{"a new paragraph", []string{"<h2>Risks</h2>", "<p>Chat is the channel that grew most.</p>\n<h2>Risks</h2>"}, "Added a paragraph: “Chat is the channel that grew most.”"},
		{"a paragraph removed", []string{"<p>Move the last two services to the new worker. Then remove the old queue.</p>", ""},
			"Removed a paragraph: “Move the last two services to the new worker. Then remove…”"},
		{"a list item", []string{"4 hours.</li>", "4 hours.</li><li>Chat answers in 10 minutes.</li>"}, "Added a list item: “Chat answers in 10 minutes.”"},
		{"a table cell", []string{"1.4 million", "1.5 million"}, "Changed “1.4” to “1.5”"},
		{"a table row", []string{"</td></tr></table>", "</td></tr><tr><td>September</td><td>1.7 million</td></tr></table>"}, "Edited Volume"},
		{"a heading", []string{"<h2>Risks</h2>", "<h2>Open risks</h2>"}, "Changed “Risks” to “Open risks”"},
		{"a heading and its text", []string{"<h2>Risks</h2>", "<h2>Open risks</h2>", "in January.", "in February."}, "Edited Open risks"},
		{"two sections", []string{"in July.", "in August.", "12 percent", "15 percent"}, "Edited Summary and Support"},
		{"three sections", []string{"in July.", "in August.", "1.2 million", "1.3 million", "12 percent", "15 percent"}, "Edited Summary, Volume and Support"},
		{"four sections", []string{"in July.", "in August.", "1.2 million", "1.3 million", "12 percent", "15 percent", "in January.", "in March."},
			"Edited Summary, Volume and other sections"},
		{"a paragraph split and nothing else", []string{" It cut failed", "</p><p>It cut failed"},
			"Split a paragraph: “The team shipped the new retry worker in July. It cut…”"},
		{"a section removed", []string{"<h2>Support</h2>\n<ul><li>Tickets went down by 12 percent.</li><li>The median answer time is 4 hours.</li></ul>", ""}, "Removed the section “Support”"},
		{"a new section", []string{"<h2>Risks</h2>", "<h2>41. Glossary</h2>\n<p>A refund is money that goes back.</p>\n<p>A dispute is a claim of a buyer.</p>\n<h2>Risks</h2>"},
			"Added the section “41. Glossary”"},
		{"a new heading", []string{"<h2>Risks</h2>", "<h2>Glossary</h2>\n<h2>Risks</h2>"}, "Added the section “Glossary”"},
		{"paragraphs under a heading that is there", []string{"<h2>Risks</h2>", "<p>Chat grew most.</p><p>Mail went down.</p>\n<h2>Risks</h2>"}, "Edited Support"},
		{"a paragraph rewritten", []string{"The card network changes its fees in January. The admin opens the page each morning.", "From the new year on, every payment by card costs more, and the admin page shows the cost of each one."},
			"Rewrote a paragraph in “Risks”"},
		{"most words of a paragraph, in many places", []string{"Move the last two services to the new worker. Then remove the old queue.", "Move all four services to our worker. Now drop that queue."},
			"Rewrote a paragraph in “Next steps”"},
		{"a few words that are together", []string{"its fees in January", "its prices from March"}, "Changed “fees in January” to “prices from March”"},
		{"a heading rewritten", []string{"<h2>Next steps</h2>", "<h2>What the team does in the fourth quarter of this year, and who owns it</h2>"},
			"Changed “Next steps” to “What the team does in the fourth quarter of this year, and…”"},
	} {
		if got := ChangeSummary([]byte(report), []byte(sitting(t, tc.changes...))); got != tc.want {
			t.Errorf("%s:\n got %s\nwant %s", tc.name, got, tc.want)
		}
	}
}

// Text above the first heading has no name, and a document can have no
// heading at all.
func TestChangeSummaryOfASittingWithoutHeadings(t *testing.T) {
	plain := "<p>One sentence here.</p><p>Two sentences here.</p><h2>Notes</h2><p>Three sentences here.</p>"
	for _, tc := range []struct{ after, want string }{
		{strings.NewReplacer("One", "A", "Two", "B").Replace(plain), "Edited the document"},
		{strings.NewReplacer("One", "A", "Three", "C").Replace(plain), "Edited Notes and other sections"},
		{strings.NewReplacer("Three sentences", "Three sentences<br>on two lines").Replace(plain), "Added “on two lines”"},
		{strings.NewReplacer("One sentence here.", "Now this text has all other words.").Replace(plain), "Changed “One sentence here” to “Now this text has all other words”"},
		{strings.NewReplacer("One sentence here.", "Now this text has all other words, and so many of them that no quote can hold the change.").Replace(plain), "Rewrote a paragraph"},
	} {
		if got := ChangeSummary([]byte(plain), []byte(tc.after)); got != tc.want {
			t.Errorf("ChangeSummary to %q:\n got %s\nwant %s", tc.after, got, tc.want)
		}
	}
}

// A document with a title and no section after it has no introduction:
// its text is in no part of the document.
func TestChangeSummaryOfATitleWithNoSections(t *testing.T) {
	const titled = "<h1>Launch plan</h1><p>We start in May with two teams.</p><p>The pilot ends in June, and the review follows it.</p>"
	for _, tc := range []struct{ old, new, want string }{
		{"We start in May with two teams.", "Our launch starts late in the spring, with every team that signs up.", "Rewrote a paragraph"},
		{"in May with two", "in April with three", "Edited the document"},
		{"two teams.", "two teams. Each team has a lead.", "Added “Each team has a lead.”"},
	} {
		if got := ChangeSummary([]byte(titled), []byte(strings.Replace(titled, tc.old, tc.new, 1))); got != tc.want {
			t.Errorf("ChangeSummary of %q to %q:\n got %s\nwant %s", tc.old, tc.new, got, tc.want)
		}
	}
}

// A quote holds the words that the person typed, and not the punctuation
// beside them that was there before.
func TestChangeSummaryQuotesNoPunctuationThatThePersonDidNotType(t *testing.T) {
	const before = "<p>Read the notes.</p>"
	for _, tc := range []struct{ after, want string }{
		{"<p>Read the notes of the reviewer.</p>", "Added “of the reviewer”"},
		{"<p>Read the reviewer notes.</p>", "Added “reviewer”"},
		{"<p>Read the notes. Then sign.</p>", "Added “Then sign.”"},
		{"<p>Read the plan.</p>", "Changed “notes” to “plan”"},
	} {
		if got := ChangeSummary([]byte(before), []byte(tc.after)); got != tc.want {
			t.Errorf("ChangeSummary to %q:\n got %s\nwant %s", tc.after, got, tc.want)
		}
	}
}

// Words that are not together are never in one quote.
func TestChangeSummaryNamesWordsInTwoPlacesByTheirBlock(t *testing.T) {
	const before = "<p>One long sentence of many words stands here today.</p>"
	if got, want := ChangeSummary([]byte(before), []byte(strings.NewReplacer("One", "A", "today", "now").Replace(before))), "Edited the document"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
