package server

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// A search date names a period [start, end): a day, a week, a month, a year,
// or a number of days. Days start at midnight in the searcher's time zone,
// and weeks start on Monday. A date is one of these, in any letter case:
//
//	25-09-26, 25/09/2026, 25-09   a day, with the day first
//	2026-09-25, 2026-09, 2026     a day, a month, or a year, with the year first
//	today, yesterday, monday      a day; a weekday is the most recent one
//	last monday                   the weekday before today
//	september, sep 2026           a month
//	5 september, sep 5th, 2026    a day
//	this week, last month         a week, a month, or a year
//	3 days ago, 2 weeks ago       a day
//	last 7 days, past 2 weeks     the days up to and including today
//
// A date without a year is its most recent occurrence, as in Slack.
func searchPeriod(phrase string, now time.Time) (start, end time.Time, ok bool) {
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	var words []string
	for _, word := range strings.Fields(strings.ReplaceAll(phrase, ",", " ")) {
		if word != "of" {
			words = append(words, ordinal.ReplaceAllString(word, "$1"))
		}
	}
	if start, end, ok = relativePeriod(words, today); ok {
		return start, end, true
	}
	if len(words) == 1 {
		if start, end, ok = numericPeriod(words[0], today); ok {
			return start, end, true
		}
	}
	return calendarPeriod(words, today)
}

var ordinal = regexp.MustCompile(`^(\d+)(?:st|nd|rd|th)$`)

// relativePeriod reads dates that count from today.
func relativePeriod(words []string, today time.Time) (start, end time.Time, ok bool) { //nolint:gocyclo // one branch per supported date phrase; a table would obscure the grammar.
	day := func(d time.Time) (time.Time, time.Time, bool) { return d, d.AddDate(0, 0, 1), true }
	switch len(words) {
	case 1:
		if words[0] == "today" {
			return day(today)
		}
		if words[0] == "yesterday" {
			return day(today.AddDate(0, 0, -1))
		}
		if weekday, ok := weekdayNamed(words[0]); ok {
			return day(today.AddDate(0, 0, -daysSince(today, weekday)))
		}
	case 2:
		if weekday, ok := weekdayNamed(words[1]); ok && words[0] == "last" {
			return day(today.AddDate(0, 0, -(daysSince(today.AddDate(0, 0, -1), weekday) + 1)))
		}
		unit, ok := unitNamed(words[1])
		if !ok {
			break
		}
		start := unitStart(today, unit)
		switch words[0] {
		case "this":
			return start, unit.add(start, 1), true
		case "last":
			return unit.add(start, -1), start, true
		}
	case 3:
		n, err := strconv.Atoi(words[1])
		if unit, ok := unitNamed(words[2]); ok && err == nil && (words[0] == "last" || words[0] == "past") {
			end := today.AddDate(0, 0, 1)
			return unit.add(end, -n), end, true
		}
		n, err = strconv.Atoi(words[0])
		if unit, ok := unitNamed(words[1]); ok && err == nil && words[2] == "ago" {
			return day(unit.add(today, -n))
		}
	}
	return start, end, false
}

// numericPeriod reads a date in digits. The year comes last unless it has
// four digits. A slash or a dot can take the place of a hyphen.
func numericPeriod(word string, today time.Time) (start, end time.Time, ok bool) {
	word = strings.NewReplacer("/", "-", ".", "-").Replace(word)
	for _, layout := range []string{"2006-1-2", "2-1-06", "2-1-2006", "2-1"} {
		if day, err := time.ParseInLocation(layout, word, today.Location()); err == nil {
			if layout == "2-1" {
				return calendarDay(today, day.Month(), day.Day(), 0)
			}
			return day, day.AddDate(0, 0, 1), true
		}
	}
	if month, err := time.ParseInLocation("2006-1", word, today.Location()); err == nil {
		return month, month.AddDate(0, 1, 0), true
	}
	if year, err := time.ParseInLocation("2006", word, today.Location()); err == nil {
		return year, year.AddDate(1, 0, 0), true
	}
	return start, end, false
}

// calendarPeriod reads a month name with an optional day and year, in any
// order: september, sep 2026, 5 september, september 5 2026.
func calendarPeriod(words []string, today time.Time) (start, end time.Time, ok bool) {
	var month time.Month
	day, year := 0, 0
	for _, word := range words {
		n, err := strconv.Atoi(word)
		switch m, isMonth := monthNamed(word); {
		case isMonth && month == 0:
			month = m
		case err == nil && len(word) == 4 && year == 0:
			year = n
		case err == nil && len(word) <= 2 && day == 0:
			day = n
		default:
			return start, end, false
		}
	}
	if month == 0 {
		return start, end, false
	}
	if day > 0 {
		return calendarDay(today, month, day, year)
	}
	if year == 0 {
		year = today.Year()
		if month > today.Month() {
			year--
		}
	}
	start = time.Date(year, month, 1, 0, 0, 0, 0, today.Location())
	return start, start.AddDate(0, 1, 0), true
}

// calendarDay returns a day. Without a year, it is the most recent one.
func calendarDay(today time.Time, month time.Month, day, year int) (start, end time.Time, ok bool) {
	if year == 0 {
		year = today.Year()
		if month > today.Month() || (month == today.Month() && day > today.Day()) {
			year--
		}
	}
	start = time.Date(year, month, day, 0, 0, 0, 0, today.Location())
	if start.Day() != day {
		return time.Time{}, time.Time{}, false // The month has no such day.
	}
	return start, start.AddDate(0, 0, 1), true
}

// daysSince returns how many days before day the most recent weekday was.
func daysSince(day time.Time, weekday time.Weekday) int {
	return (int(day.Weekday()) - int(weekday) + 7) % 7
}

type dateUnit struct{ years, months, days int }

func (u dateUnit) add(t time.Time, n int) time.Time {
	return t.AddDate(n*u.years, n*u.months, n*u.days)
}

var dateUnits = map[string]dateUnit{"day": {days: 1}, "week": {days: 7}, "month": {months: 1}, "year": {years: 1}}

func unitNamed(word string) (dateUnit, bool) {
	unit, ok := dateUnits[strings.TrimSuffix(word, "s")]
	return unit, ok
}

// unitStart returns the start of the unit that holds today.
func unitStart(today time.Time, unit dateUnit) time.Time {
	switch {
	case unit.years > 0:
		return time.Date(today.Year(), time.January, 1, 0, 0, 0, 0, today.Location())
	case unit.months > 0:
		return time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, today.Location())
	case unit.days == 7:
		return today.AddDate(0, 0, -daysSince(today, time.Monday))
	}
	return today
}

// monthNamed and weekdayNamed accept a full name or its first three or more
// letters: sep, sept, and september.
func monthNamed(word string) (time.Month, bool) {
	for m := time.January; m <= time.December; m++ {
		if namePrefix(strings.ToLower(m.String()), word) {
			return m, true
		}
	}
	return 0, false
}

func weekdayNamed(word string) (time.Weekday, bool) {
	for d := time.Sunday; d <= time.Saturday; d++ {
		if namePrefix(strings.ToLower(d.String()), word) {
			return d, true
		}
	}
	return 0, false
}

func namePrefix(name, word string) bool {
	return len(word) >= 3 && strings.HasPrefix(name, word)
}

// isDateWord reports whether a word can continue a date, as "week" does in
// after:last week.
func isDateWord(word string) bool {
	_, isMonth := monthNamed(word)
	_, isWeekday := weekdayNamed(word)
	_, isUnit := unitNamed(word)
	return isMonth || isWeekday || isUnit || dateConnectors[word] || dateNumber.MatchString(word)
}

var (
	dateConnectors = map[string]bool{"today": true, "yesterday": true, "this": true, "last": true, "past": true, "ago": true, "of": true}
	dateNumber     = regexp.MustCompile(`^\d+(st|nd|rd|th)?,?$|^\d{1,4}([-/.]\d{1,4}){1,2}$`)
)
