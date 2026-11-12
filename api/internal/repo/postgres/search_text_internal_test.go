package postgres

import (
	"strings"
	"testing"
	"unicode/utf8"
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

	long := searchText([]byte("<p>" + strings.Repeat("é", maxSearchTextBytes) + "</p>"))
	if len(long) > maxSearchTextBytes || !utf8.ValidString(long) {
		t.Fatalf("searchText() kept %d bytes, valid UTF-8 = %v", len(long), utf8.ValidString(long))
	}
}

func TestTSQuery(t *testing.T) {
	t.Parallel()
	if got, want := tsquery([]string{"error budget", `it's\`}, " & "), `'error budget':* & 'it''s\\':*`; got != want {
		t.Fatalf("tsquery() = %q, want %q", got, want)
	}
	if got := tsquery(nil, " | "); got != "" {
		t.Fatalf("tsquery(nil) = %q, want empty", got)
	}
}

func TestTsqueryWords(t *testing.T) {
	for _, tc := range []struct {
		terms []string
		want  string
	}{
		{terms: nil, want: ""},
		{terms: []string{"incident"}, want: "'incident':*"},
		{terms: []string{"error budget", "q3"}, want: "'error':* & 'budget':* & 'q3':*"},
		{terms: []string{" spaced   out "}, want: "'spaced':* & 'out':*"},
		{terms: []string{"it's"}, want: "'it''s':*"},
	} {
		if got := tsqueryWords(tc.terms); got != tc.want {
			t.Errorf("tsqueryWords(%q) = %q, want %q", tc.terms, got, tc.want)
		}
	}
}
