package expiry

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestParseTTLReadsANumberAndAUnit(t *testing.T) {
	day := 24 * time.Hour
	for in, want := range map[string]time.Duration{
		"1min":  time.Minute,
		"30min": 30 * time.Minute,
		"12h":   12 * time.Hour,
		"1d":    day,
		"7d":    7 * day,
		"2w":    14 * day,
		"1mo":   30 * day,
		"3mo":   90 * day,
		"07d":   7 * day,
		"3650d": 3650 * day,
	} {
		got, err := ParseTTL(in)
		if err != nil {
			t.Errorf("ParseTTL(%q) failed: %v", in, err)
		} else if got != want {
			t.Errorf("ParseTTL(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestParseTTLRefusesWhatIsNotAPeriod(t *testing.T) {
	for _, in := range []string{
		"", "7", "d", "-1d", "+1d", "1.5d", "7 d", " 7d", "7d ", "7D", "7days", "1y", "never",
		"0d", "0min", "59s", "3651d", "522w", "122mo", "99999999999999999999d", "9223372036854775807h",
	} {
		_, err := ParseTTL(in)
		var bad *Error
		if !errors.As(err, &bad) {
			t.Errorf("ParseTTL(%q) = %v, want an *Error", in, err)
		}
	}
}

// A person reads 3m as three months, and a parser of Go durations reads it
// as three minutes. A wrong guess deletes a document, so m is no unit.
func TestParseTTLRefusesABareMAndNamesBothUnits(t *testing.T) {
	_, err := ParseTTL("3m")
	var bad *Error
	if !errors.As(err, &bad) {
		t.Fatalf("ParseTTL(3m) = %v, want an *Error", err)
	}
	if !strings.Contains(err.Error(), "min") || !strings.Contains(err.Error(), "mo") {
		t.Fatalf("the error %q does not name min and mo", err)
	}
}

func TestResolve(t *testing.T) {
	now := time.Date(2026, 11, 18, 10, 30, 15, 987654321, time.FixedZone("IST", 5*3600+1800))
	at := func(s string) time.Time {
		t.Helper()
		v, err := time.Parse(time.RFC3339, s)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	t.Run("a period counts from now", func(t *testing.T) {
		got, ok, err := Resolve(now, "7d", "")
		if err != nil || !ok {
			t.Fatalf("Resolve = %v, %v, %v", got, ok, err)
		}
		if want := at("2026-11-25T05:00:15Z"); !got.Equal(want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		if got.Location() != time.UTC || got.Nanosecond() != 0 {
			t.Fatalf("got %v, want UTC and whole seconds", got)
		}
	})
	t.Run("a time is taken as it is, in UTC", func(t *testing.T) {
		got, ok, err := Resolve(now, "", "2026-12-01T09:00:00+05:30")
		if err != nil || !ok {
			t.Fatalf("Resolve = %v, %v, %v", got, ok, err)
		}
		if want := at("2026-12-01T03:30:00Z"); !got.Equal(want) || got.Location() != time.UTC {
			t.Fatalf("got %v, want %v in UTC", got, want)
		}
	})
	t.Run("neither is no expiry", func(t *testing.T) {
		got, ok, err := Resolve(now, "", "")
		if err != nil || ok || !got.IsZero() {
			t.Fatalf("Resolve = %v, %v, %v, want no expiry", got, ok, err)
		}
	})
	for name, in := range map[string][2]string{
		"both":                         {"7d", "2026-12-01T09:00:00Z"},
		"a bad period":                 {"3m", ""},
		"a bad time":                   {"", "tomorrow"},
		"a date without a time":        {"", "2026-12-01"},
		"a time in the past":           {"", "2026-11-18T04:00:00Z"},
		"a time in under a minute":     {"", "2026-11-18T05:00:45Z"},
		"a time after the maximum":     {"", "2036-11-17T05:00:15Z"},
		"a time far after the maximum": {"", "9999-12-31T23:59:59Z"},
	} {
		t.Run(name+" is refused", func(t *testing.T) {
			_, ok, err := Resolve(now, in[0], in[1])
			var bad *Error
			if !errors.As(err, &bad) || ok {
				t.Fatalf("Resolve(%q, %q) = %v, %v, want an *Error", in[0], in[1], ok, err)
			}
		})
	}
	t.Run("the shortest and the longest time are taken", func(t *testing.T) {
		for _, s := range []string{"2026-11-18T05:01:16Z", "2036-11-15T05:00:15Z"} {
			if _, ok, err := Resolve(now, "", s); err != nil || !ok {
				t.Fatalf("Resolve(%q) = %v, %v", s, ok, err)
			}
		}
	})
}

// A PATCH body can leave expires_at out, give a time, or give null. Text
// tells the three apart.
func TestTextTellsAMissingFieldANullAndATextApart(t *testing.T) {
	for name, tc := range map[string]struct {
		body string
		want Text
	}{
		"not in the body": {`{}`, Text{}},
		"null":            {`{"expires_at":null}`, Text{Set: true, Null: true}},
		"a text":          {`{"expires_at":"2027-01-01T00:00:00Z"}`, Text{Set: true, Value: "2027-01-01T00:00:00Z"}},
		"an empty text":   {`{"expires_at":""}`, Text{Set: true}},
	} {
		var in struct {
			ExpiresAt Text `json:"expires_at"`
		}
		if err := json.Unmarshal([]byte(tc.body), &in); err != nil || in.ExpiresAt != tc.want {
			t.Errorf("%s: got %+v, %v, want %+v", name, in.ExpiresAt, err, tc.want)
		}
	}
	var in struct {
		ExpiresAt Text `json:"expires_at"`
	}
	if err := json.Unmarshal([]byte(`{"expires_at":5}`), &in); err == nil {
		t.Errorf("a number was taken as a time: %+v", in.ExpiresAt)
	}
}

func TestChangeReadsTheExpiryThatAPatchAsksFor(t *testing.T) {
	now := time.Date(2026, 11, 18, 5, 0, 0, 0, time.UTC)
	text := func(s string) Text { return Text{Set: true, Value: s} }
	null := Text{Set: true, Null: true}
	for name, tc := range map[string]struct {
		in      string
		at      Text
		want    time.Time
		changed bool
	}{
		"no field keeps the expiry": {"", Text{}, time.Time{}, false},
		"a period":                  {"7d", Text{}, now.Add(7 * 24 * time.Hour), true},
		"a time":                    {"", text("2026-12-01T00:00:00Z"), time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC), true},
		"a null removes the expiry": {"", null, time.Time{}, true},
	} {
		got, changed, err := Change(now, tc.in, tc.at)
		if err != nil || changed != tc.changed || !got.Equal(tc.want) {
			t.Errorf("%s: Change = %v, %v, %v, want %v, %v", name, got, changed, err, tc.want, tc.changed)
		}
	}
	for name, tc := range map[string]struct {
		in string
		at Text
	}{
		"a period and a null": {"7d", null},
		"a period and a time": {"7d", text("2026-12-01T00:00:00Z")},
		"an empty time":       {"", text("")},
		"a bad period":        {"3m", Text{}},
		"a time in the past":  {"", text("2020-01-01T00:00:00Z")},
	} {
		_, changed, err := Change(now, tc.in, tc.at)
		var bad *Error
		if !errors.As(err, &bad) || changed {
			t.Errorf("%s: Change = %v, %v, want an *Error", name, changed, err)
		}
	}
}

// The CLI and the MCP tools tell a period back as a person reads it, so that
// a wrong unit shows at once: 30min for a month reads "30 minutes".
func TestInTellsAPeriodAsAPersonReadsIt(t *testing.T) {
	const day = 24 * time.Hour
	for d, want := range map[time.Duration]string{
		-time.Hour:                        "less than a minute",
		0:                                 "less than a minute",
		45 * time.Second:                  "less than a minute",
		time.Minute - 20*time.Millisecond: "1 minute", // a minute that was set a moment ago
		time.Minute:                       "1 minute",
		30*time.Minute - 2*time.Second:    "30 minutes",
		30 * time.Minute:                  "30 minutes",
		119 * time.Minute:                 "119 minutes",
		2 * time.Hour:                     "2 hours",
		day - 2*time.Second:               "24 hours", // a day that was set a moment ago
		36 * time.Hour:                    "36 hours",
		2*day - 2*time.Second:             "2 days",
		7*day - 2*time.Second:             "7 days", // a week that was set a moment ago
		7*day - time.Hour:                 "6 days", // never more than the time that is left
		90 * day:                          "90 days",
	} {
		if got := In(d); got != want {
			t.Errorf("In(%v) = %q, want %q", d, got, want)
		}
	}
}
