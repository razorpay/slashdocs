package postgres

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

func TestSearchText(t *testing.T) {
	t.Parallel()
	doc := `<html><head><title>Plan</title><style>p{color:red}</style>
<script>const secret = "<p>hidden</p>";</script></head>
<body><h1>Error&nbsp;budget</h1><p>Checkout <b>was</b>
exceeded.</p><noscript>Enable JS</noscript><template><p>later</p></template><p>End` + "\x02\x03" + `</p></body></html>`
	if got, want := searchText([]byte(doc)), "Plan Error budget Checkout was exceeded. End"; got != want {
		t.Fatalf("searchText() = %q, want %q", got, want)
	}

	if got, want := searchText([]byte("<p>caf\xe9 \xd3\xeb ok</p>")), "caf  ok"; got != want {
		t.Fatalf("searchText() = %q, want %q", got, want)
	}

	long := searchText([]byte("<p>" + strings.Repeat("abcdé ", maxSearchTextBytes/6+10) + "</p>"))
	if len(long) > maxSearchTextBytes || !strings.HasSuffix(long, " abcdé") || !utf8.ValidString(long) {
		t.Fatalf("searchText() kept %d bytes ending in %q, want whole words", len(long), long[len(long)-10:])
	}

	unspaced := searchText([]byte("<p>" + strings.Repeat("é", maxSearchTextBytes) + "</p>"))
	if len(unspaced) == 0 || len(unspaced) > maxSearchTextBytes || !utf8.ValidString(unspaced) {
		t.Fatalf("searchText() kept %d bytes, valid UTF-8 = %v", len(unspaced), utf8.ValidString(unspaced))
	}
}

func TestSearchQueries(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		search repo.DocumentSearch
		want   tsqueries
	}{
		{},
		{
			search: repo.DocumentSearch{Terms: []string{"error budget", `it's\`}, ExcludedTerms: []string{"draft", "old"}},
			want: tsqueries{
				match: `'error budget':* & 'it''s\\':*`, words: `'error':* & 'budget':* & 'it''s\\':*`,
				exclude: `'draft':* | 'old':*`, rank: `'error budget':* | 'it''s\\':*`, snippet: `'error budget':* & 'it''s\\':*`,
			},
		},
		{
			search: repo.DocumentSearch{Terms: []string{"q3"}, TitleTerms: []string{"rollout plan"}},
			want: tsqueries{
				match: `'q3':* & 'rollout plan':*A`, words: `'q3':* & 'rollout':*A & 'plan':*A`,
				rank: `'q3':* | 'rollout plan':*`, snippet: `'q3':*`,
			},
		},
	} {
		if got := searchQueries(tc.search); got != tc.want {
			t.Errorf("searchQueries(%+v) = %+v, want %+v", tc.search, got, tc.want)
		}
	}
}
