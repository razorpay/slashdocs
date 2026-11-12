package server

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func TestParseDocumentSearch(t *testing.T) {
	t.Parallel()
	kolkata, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.March, 15, 1, 30, 0, 0, kolkata)
	day := func(month time.Month, d int) time.Time { return time.Date(2026, month, d, 0, 0, 0, 0, kolkata) }
	me := auth.Principal{Type: auth.PrincipalUser, ID: "usr_Me"}
	tests := []struct {
		name string
		raw  string
		want repo.DocumentSearch
	}{
		{
			name: "words match separately",
			raw:  "Payments  incident",
			want: repo.DocumentSearch{Terms: []string{"payments", "incident"}},
		},
		{
			name: "phrases and exclusions",
			raw:  `"Error budget" -draft -"old plan" it's`,
			want: repo.DocumentSearch{Terms: []string{"error budget", "it's"}, ExcludedTerms: []string{"draft", "old plan"}},
		},
		{
			name: "people, folders, and labels",
			raw:  `from:@Alice author:me in:"Product Specs" in:#fld_1 labels:api,review label:ops`,
			want: repo.DocumentSearch{
				Owners:  []string{"alice", "usr_me"},
				Folders: []string{"product specs", "fld_1"},
				Labels:  []string{"api", "review", "ops"},
			},
		},
		{
			name: "day bounds",
			raw:  "after:2026-03-01 before:today",
			want: repo.DocumentSearch{UpdatedSince: day(time.March, 2), UpdatedBefore: day(time.March, 15)},
		},
		{
			name: "on a day",
			raw:  "on:yesterday",
			want: repo.DocumentSearch{UpdatedSince: day(time.March, 14), UpdatedBefore: day(time.March, 15)},
		},
		{
			name: "during a month name is its most recent occurrence",
			raw:  "during:december",
			want: repo.DocumentSearch{UpdatedSince: time.Date(2025, time.December, 1, 0, 0, 0, 0, kolkata), UpdatedBefore: day(time.January, 1)},
		},
		{
			name: "during a month and a year narrow each other",
			raw:  "during:2026 during:2026-02",
			want: repo.DocumentSearch{UpdatedSince: day(time.February, 1), UpdatedBefore: day(time.March, 1)},
		},
		{
			name: "a date goes on over date words",
			raw:  "after:last week budget on:monday may",
			want: repo.DocumentSearch{Terms: []string{"budget", "may"}, UpdatedSince: day(time.March, 9), UpdatedBefore: day(time.March, 10)},
		},
		{
			name: "a quoted date",
			raw:  `before:"5 march"`,
			want: repo.DocumentSearch{UpdatedBefore: day(time.March, 5)},
		},
		{
			name: "partly typed modifiers have no effect",
			raw:  `plan from: on:2026-0 in:"Product`,
			want: repo.DocumentSearch{Terms: []string{"plan"}, Folders: []string{"product"}},
		},
		{
			name: "unknown modifiers and quoted modifiers are title text",
			raw:  `status:draft "from:me" -`,
			want: repo.DocumentSearch{Terms: []string{"status:draft", "from:me", "-"}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := parseDocumentSearch(tc.raw, me, now)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("parseDocumentSearch(%q) = %#v, want %#v", tc.raw, got, tc.want)
			}
		})
	}
}

func TestParseDocumentSearchRejectsLargeQueries(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{
		strings.Repeat("a", maxSearchQueryBytes+1),
		strings.Repeat("from:a ", maxSearchValues+1),
	} {
		if _, err := parseDocumentSearch(raw, auth.Principal{}, time.Now()); !errors.Is(err, errInvalidSearch) {
			t.Fatalf("parseDocumentSearch(%.20q...) error = %v, want errInvalidSearch", raw, err)
		}
	}
}
