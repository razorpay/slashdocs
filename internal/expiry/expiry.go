// Package expiry reads the expiry of a document from a request: a period from
// now, or a time. The server and the CLI share it, so that they agree on what
// a period is.
package expiry

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

const (
	// MinTTL is the shortest period, and the least time from now to an
	// expiry time.
	MinTTL = time.Minute
	// MaxTTL is the longest period, and the most time from now to an expiry
	// time.
	MaxTTL = 3650 * 24 * time.Hour
)

// Error tells what is wrong with a period or a time that a caller gave. Its
// text is for that caller.
type Error struct{ msg string }

func (e *Error) Error() string { return e.msg }

const day = 24 * time.Hour

// units are the units of a period. A month is 30 days. There is no m: a
// person reads 3m as three months, and Go reads it as three minutes.
var units = map[string]time.Duration{
	"min": time.Minute,
	"h":   time.Hour,
	"d":   day,
	"w":   7 * day,
	"mo":  30 * day,
}

var (
	errPeriod   = &Error{"a period is a whole number and a unit, such as 7d: the units are min, h, d, w and mo"}
	errBareM    = &Error{`m is not a unit of a period: use min for minutes and mo for months`}
	errTooShort = &Error{"a period is at least 1 minute"}
	errTooLong  = &Error{"a period is at most 3650 days"}
	errBoth     = &Error{"give expires_in or expires_at, not both"}
)

// ParseTTL reads a period: a whole number and a unit, as in 30min, 12h, 7d,
// 2w and 3mo. It returns an *Error for another text, and for a period that is
// shorter than MinTTL or longer than MaxTTL.
func ParseTTL(s string) (time.Duration, error) {
	digits := strings.TrimRight(s, "abcdefghijklmnopqrstuvwxyz")
	suffix := s[len(digits):]
	unit, ok := units[suffix]
	switch {
	case digits != "" && suffix == "m":
		return 0, errBareM
	case !ok || digits == "" || strings.Trim(digits, "0123456789") != "":
		return 0, errPeriod
	}
	n, err := strconv.ParseInt(digits, 10, 64)
	// The check comes before the product, so that the product cannot
	// overflow.
	if err != nil || n > int64(MaxTTL/unit) {
		return 0, errTooLong
	}
	ttl := time.Duration(n) * unit
	if ttl < MinTTL {
		return 0, errTooShort
	}
	return ttl, nil
}

// Resolve returns the expiry time that a request asks for, in UTC and in
// whole seconds. The request gives a period from now (expiresIn) or an
// RFC 3339 time (expiresAt). With neither, ok is false: the request asks for
// no expiry. It returns an *Error for both, and for a value that is wrong.
func Resolve(now time.Time, expiresIn, expiresAt string) (at time.Time, ok bool, err error) {
	switch {
	case expiresIn != "" && expiresAt != "":
		return time.Time{}, false, errBoth
	case expiresIn != "":
		ttl, err := ParseTTL(expiresIn)
		if err != nil {
			return time.Time{}, false, err
		}
		at = now.Add(ttl)
	case expiresAt != "":
		if at, err = time.Parse(time.RFC3339, expiresAt); err != nil {
			return time.Time{}, false, &Error{"expires_at is not an RFC 3339 time, such as 2027-01-31T09:00:00Z"}
		}
		if at.Before(now.Add(MinTTL)) {
			return time.Time{}, false, &Error{"expires_at is less than 1 minute from now"}
		}
		if at.After(now.Add(MaxTTL)) {
			return time.Time{}, false, &Error{"expires_at is more than 3650 days from now"}
		}
	default:
		return time.Time{}, false, nil
	}
	return at.UTC().Truncate(time.Second), true, nil
}

// Text is a JSON text that tells three things apart: the field is not in
// the body, it is null, and it has a text. A change of a document gives
// expires_at as one: a null removes the expiry, and no field keeps it.
type Text struct {
	Set   bool
	Null  bool
	Value string
}

func (t *Text) UnmarshalJSON(b []byte) error {
	t.Set, t.Null = true, string(b) == "null"
	if t.Null {
		return nil
	}
	return json.Unmarshal(b, &t.Value)
}

// Change returns the expiry time that a change of a document asks for, from
// its expires_in and expires_at. changed is false when the change does not
// name the expiry. The zero time with changed removes the expiry. The server
// and the local server both read a change with it, so that they agree.
func Change(now time.Time, expiresIn string, expiresAt Text) (at time.Time, changed bool, err error) {
	switch {
	case expiresAt.Null && expiresIn != "":
		return time.Time{}, false, errBoth
	case expiresAt.Null:
		return time.Time{}, true, nil
	case expiresAt.Set && expiresAt.Value == "":
		return time.Time{}, false, &Error{"expires_at is empty: give an RFC 3339 time, or null to remove the expiry"}
	}
	return Resolve(now, expiresIn, expiresAt.Value)
}

// In adds a little before it counts, because a period that was set a moment
// ago is some seconds short: 7 days must read "7 days", and 1 minute "1
// minute".
const (
	inSlack       = 5 * time.Minute  // for hours and days
	inMinuteSlack = 10 * time.Second // for minutes
)

// In tells a time from now as a person reads it: "30 minutes", "36 hours",
// "7 days". It never tells more than the time that is left, but for the
// slack. The CLI and the MCP tools show it beside an expiry time, so that a
// wrong unit shows at once.
func In(d time.Duration) string {
	count := func(n time.Duration, unit string) string {
		if n == 1 {
			return "1 " + unit
		}
		return strconv.FormatInt(int64(n), 10) + " " + unit + "s"
	}
	switch {
	case d+inMinuteSlack < time.Minute:
		return "less than a minute"
	case d < 2*time.Hour:
		return count((d+inMinuteSlack)/time.Minute, "minute")
	case d+inSlack < 2*day:
		return count((d+inSlack)/time.Hour, "hour")
	default:
		return count((d+inSlack)/day, "day")
	}
}
