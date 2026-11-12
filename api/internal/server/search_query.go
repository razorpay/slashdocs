package server

import (
	"errors"
	"fmt"
	"strings"
	"time"
	_ "time/tzdata" // Searchers send IANA time zones, and the image has no zoneinfo.
	"unicode"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// Document search follows Slack's search language. Every word must appear in
// the title or the text, "quoted text" matches its words in order, and -word
// excludes documents that contain the word. Modifiers filter the results:
//
//	from:<person>    the owner: an email, the name before the @, or me
//	in:<folder>      a folder title or ID, or a folder above it
//	label:<name>     a label; every label is required
//	before:<date>    updated before the date
//	after:<date>     updated after the date
//	on:<date>        updated on the date
//	during:<date>    the same as on:
//
// Repeated from: and in: modifiers match any of their values. A date can be a
// phrase, as in after:last week: search_dates.go tells which words it can
// have. As in Slack, a modifier without a usable value has no effect, so a
// partly typed query never fails.

const (
	maxSearchQueryBytes = 512
	maxSearchValues     = 10
)

var errInvalidSearch = errors.New("invalid search query")

// searchAliases keeps the earlier author: and labels: names working.
var searchAliases = map[string]string{"author": "from", "labels": "label"}

func parseDocumentSearch(raw string, me auth.Principal, now time.Time) (repo.DocumentSearch, error) {
	if len(raw) > maxSearchQueryBytes {
		return repo.DocumentSearch{}, fmt.Errorf("%w: query is too long", errInvalidSearch)
	}
	var out repo.DocumentSearch
	tokens := searchTokens(raw)
	for i := 0; i < len(tokens); i++ {
		token := tokens[i]
		text := strings.ToLower(token.text)
		if token.phrase {
			out.Terms = append(out.Terms, text)
			continue
		}
		if len(text) > 1 && text[0] == '-' {
			out.ExcludedTerms = append(out.ExcludedTerms, text[1:])
			continue
		}
		key, value, hasKey := strings.Cut(text, ":")
		if alias, ok := searchAliases[key]; ok {
			key = alias
		}
		if hasKey && dateModifiers[key] {
			i += applyDateModifier(&out, key, value, tokens[i+1:], now)
			continue
		}
		if !hasKey || !applySearchModifier(&out, key, value, me, now) {
			out.Terms = append(out.Terms, text)
		}
	}
	for _, values := range [][]string{out.Terms, out.ExcludedTerms, out.Owners, out.Folders, out.Labels} {
		if len(values) > maxSearchValues {
			return repo.DocumentSearch{}, fmt.Errorf("%w: use at most %d of each search term", errInvalidSearch, maxSearchValues)
		}
	}
	return out, nil
}

// applySearchModifier reports false when key is not a modifier, so the token
// stays title text. Values are lowercase.
func applySearchModifier(out *repo.DocumentSearch, key, value string, me auth.Principal, now time.Time) bool {
	value = strings.TrimSpace(value)
	switch key {
	case "from":
		value = strings.TrimPrefix(value, "@")
		if value == "me" {
			value = strings.ToLower(me.ID)
		}
		out.Owners = appendNonEmpty(out.Owners, value)
	case "in":
		out.Folders = appendNonEmpty(out.Folders, strings.TrimPrefix(value, "#"))
	case "label":
		for _, label := range strings.Split(value, ",") {
			out.Labels = appendNonEmpty(out.Labels, strings.TrimSpace(label))
		}
	default:
		return false
	}
	return true
}

var dateModifiers = map[string]bool{"before": true, "after": true, "on": true, "during": true}

// applyDateModifier reads the longest date that starts with value and goes
// on into the next words, as in after:last week. It returns the number of
// next words that the date used. Words that are not part of the date stay
// search terms.
func applyDateModifier(out *repo.DocumentSearch, key, value string, next []searchToken, now time.Time) (used int) {
	words := []string{value}
	for _, token := range next {
		word := strings.ToLower(token.text)
		if token.phrase || !isDateWord(word) {
			break
		}
		words = append(words, word)
	}
	for n := len(words); n > 0; n-- {
		start, end, ok := searchPeriod(strings.Join(words[:n], " "), now)
		if !ok {
			continue
		}
		switch key {
		case "before":
			narrowUpdated(out, time.Time{}, start)
		case "after":
			narrowUpdated(out, end, time.Time{})
		default:
			narrowUpdated(out, start, end)
		}
		return n - 1
	}
	return 0
}

// narrowUpdated limits results to documents updated in [since, before). A
// zero bound leaves that side open. Date modifiers combine with AND.
func narrowUpdated(out *repo.DocumentSearch, since, before time.Time) {
	if since.After(out.UpdatedSince) {
		out.UpdatedSince = since
	}
	if !before.IsZero() && (out.UpdatedBefore.IsZero() || before.Before(out.UpdatedBefore)) {
		out.UpdatedBefore = before
	}
}

func appendNonEmpty(values []string, value string) []string {
	if value == "" {
		return values
	}
	return append(values, value)
}

type searchToken struct {
	text   string
	phrase bool // The token started with a quote, so it is literal title text.
}

// searchTokens splits on whitespace outside double quotes and removes the
// quotes. A missing closing quote ends at the end of the query, because the
// searcher is often still typing.
func searchTokens(raw string) []searchToken {
	var tokens []searchToken
	var current strings.Builder
	quoted, phrase := false, false
	flush := func() {
		if current.Len() > 0 {
			tokens = append(tokens, searchToken{text: current.String(), phrase: phrase})
		}
		current.Reset()
		phrase = false
	}
	for _, r := range raw {
		switch {
		case r == '"':
			phrase = phrase || (!quoted && current.Len() == 0)
			quoted = !quoted
		case quoted || !unicode.IsSpace(r):
			current.WriteRune(r)
		default:
			flush()
		}
	}
	flush()
	return tokens
}
