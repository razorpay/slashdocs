package server

import (
	"testing"
	"time"
)

func TestSearchPeriod(t *testing.T) {
	t.Parallel()
	kolkata, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.March, 15, 1, 30, 0, 0, kolkata) // A Sunday.
	date := func(year int, month time.Month, day int) time.Time {
		return time.Date(year, month, day, 0, 0, 0, 0, kolkata)
	}
	oneDay := func(year int, month time.Month, day int) [2]time.Time {
		return [2]time.Time{date(year, month, day), date(year, month, day+1)}
	}
	for phrase, want := range map[string][2]time.Time{
		"25-09-25":         oneDay(2025, time.September, 25),
		"25/09/2025":       oneDay(2025, time.September, 25),
		"5.3.26":           oneDay(2026, time.March, 5),
		"25-09":            oneDay(2025, time.September, 25),
		"2026-03-05":       oneDay(2026, time.March, 5),
		"2026-02":          {date(2026, time.February, 1), date(2026, time.March, 1)},
		"2025":             {date(2025, time.January, 1), date(2026, time.January, 1)},
		"today":            oneDay(2026, time.March, 15),
		"yesterday":        oneDay(2026, time.March, 14),
		"monday":           oneDay(2026, time.March, 9),
		"sunday":           oneDay(2026, time.March, 15),
		"last sunday":      oneDay(2026, time.March, 8),
		"last mon":         oneDay(2026, time.March, 9),
		"september":        {date(2025, time.September, 1), date(2025, time.October, 1)},
		"mar":              {date(2026, time.March, 1), date(2026, time.April, 1)},
		"sept 2024":        {date(2024, time.September, 1), date(2024, time.October, 1)},
		"5th of september": oneDay(2025, time.September, 5),
		"sep 5, 2024":      oneDay(2024, time.September, 5),
		"march 20":         oneDay(2025, time.March, 20),
		"this week":        {date(2026, time.March, 9), date(2026, time.March, 16)},
		"last week":        {date(2026, time.March, 2), date(2026, time.March, 9)},
		"this month":       {date(2026, time.March, 1), date(2026, time.April, 1)},
		"last year":        {date(2025, time.January, 1), date(2026, time.January, 1)},
		"3 days ago":       oneDay(2026, time.March, 12),
		"2 weeks ago":      oneDay(2026, time.March, 1),
		"last 7 days":      {date(2026, time.March, 9), date(2026, time.March, 16)},
		"past 1 month":     {date(2026, time.February, 16), date(2026, time.March, 16)},
	} {
		start, end, ok := searchPeriod(phrase, now)
		if !ok || !start.Equal(want[0]) || !end.Equal(want[1]) {
			t.Errorf("searchPeriod(%q) = %v, %v, %v; want %v, %v", phrase, start, end, ok, want[0], want[1])
		}
	}
	for _, phrase := range []string{"", "budget", "last", "2026-0", "32-01-26", "31 feb", "5 6 march"} {
		if _, _, ok := searchPeriod(phrase, now); ok {
			t.Errorf("searchPeriod(%q) is a date, want none", phrase)
		}
	}
}
