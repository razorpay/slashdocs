package postgres

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"unicode"

	"golang.org/x/net/html"

	"github.com/razorpay/slashdocs/api/internal/blob"
	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// maxSearchTextBytes keeps a version's tsvector below the PostgreSQL limit of
// 1 MB. A text of short words that are all different, such as IDs, makes a
// tsvector 2.4 times its size, and a write fails above the limit. It is about
// 40,000 words, more than almost any document has. PostgreSQL also keeps word
// positions up to 16,383 only, so a phrase matches in the first 16,383 words.
const maxSearchTextBytes = 256 << 10

// searchText returns the words that a reader sees in an HTML document. Tags
// separate words. Markup inside a word is rare, and it only splits that word.
func searchText(doc []byte) string {
	z := html.NewTokenizer(bytes.NewReader(doc))
	var text strings.Builder
	hidden := 0 // The depth inside elements that are not shown.
	for text.Len() < maxSearchTextBytes {
		token := z.Next()
		if token == html.ErrorToken {
			break
		}
		switch token {
		case html.TextToken:
			if hidden > 0 {
				continue
			}
			// Control characters are removed, because snippets use two of them to mark matches.
			for _, word := range strings.FieldsFunc(string(z.Text()), isSeparator) {
				if text.Len() > 0 {
					text.WriteByte(' ')
				}
				text.WriteString(word)
			}
		case html.StartTagToken, html.EndTagToken:
			name, _ := z.TagName()
			switch {
			case !hiddenElements[string(name)]:
			case token == html.StartTagToken:
				hidden++
			case hidden > 0:
				hidden--
			}
		}
	}
	// The limit cuts after the last whole word, because a part of a word
	// matches searches for other words. Text with no space in the limit, such
	// as CJK prose, is cut at the limit.
	s := text.String()
	if len(s) > maxSearchTextBytes {
		if i := strings.LastIndexByte(s[:maxSearchTextBytes+1], ' '); i > 0 {
			s = s[:i]
		} else {
			s = s[:maxSearchTextBytes]
		}
	}
	// PostgreSQL text must be UTF-8, and a document can have bytes in another
	// encoding.
	return strings.ToValidUTF8(s, "")
}

var hiddenElements = map[string]bool{"script": true, "style": true, "template": true, "noscript": true}

func isSeparator(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }

// tsqueries are the PostgreSQL tsquery texts of a search.
type tsqueries struct {
	// match finds documents with every term, and a phrase matches its words
	// in order.
	match string
	// words finds the same documents and more, as it matches the words of
	// every term in any order: a phrase "error budget" becomes 'error':* &
	// 'budget':*. Search finds these documents in the index and checks the
	// order of the words, which reads a document's text vector, on the sorted
	// candidates only.
	words string
	// exclude finds documents with any excluded term.
	exclude string
	// rank orders matches by the terms in their titles.
	rank string
	// snippet marks the terms in the text, so it has no title terms.
	snippet string
}

// searchQueries returns the tsquery texts of a search. A title term matches
// title words only. The search vector gives title words weight A.
func searchQueries(search repo.DocumentSearch) tsqueries {
	terms := slices.Concat(tsqueryTerms(search.Terms, ""), tsqueryTerms(search.TitleTerms, "A"))
	words := slices.Concat(tsqueryTerms(splitWords(search.Terms), ""), tsqueryTerms(splitWords(search.TitleTerms), "A"))
	return tsqueries{
		match:   strings.Join(terms, " & "),
		words:   strings.Join(words, " & "),
		exclude: strings.Join(tsqueryTerms(search.ExcludedTerms, ""), " | "),
		rank:    strings.Join(tsqueryTerms(slices.Concat(search.Terms, search.TitleTerms), ""), " | "),
		snippet: strings.Join(tsqueryTerms(search.Terms, ""), " & "),
	}
}

// tsqueryTerms returns a tsquery operand for each term, which matches words
// that start with the term and have the weight ("" is any weight). Quoting
// makes every term a literal.
func tsqueryTerms(terms []string, weight string) []string {
	quoted := make([]string, len(terms))
	for i, term := range terms {
		quoted[i] = "'" + tsqueryEscaper.Replace(term) + "':*" + weight
	}
	return quoted
}

var tsqueryEscaper = strings.NewReplacer(`\`, `\\`, `'`, `''`)

func splitWords(terms []string) []string {
	var words []string
	for _, term := range terms {
		words = append(words, strings.Fields(term)...)
	}
	return words
}

// IndexVersions gives search text to current versions that were created
// before content search. Each batch locks its versions, so all servers can
// run it at the same time. A version that cannot be read is skipped until the
// next run. IndexVersions returns the number of versions that it indexed.
func (s *Store) IndexVersions(ctx context.Context) (indexed int, err error) {
	var skipped []string
	for {
		n, failed, err := s.indexVersionBatch(ctx, skipped)
		indexed += n
		skipped = append(skipped, failed...)
		if err != nil || n+len(failed) == 0 {
			return indexed, err
		}
	}
}

// IndexDocuments gives a search vector to documents that were created before
// documents had one. IndexDocuments returns the number of documents that it
// indexed.
func (s *Store) IndexDocuments(ctx context.Context) (indexed int, err error) {
	for {
		n, err := s.q.IndexDocuments(ctx, 100)
		indexed += int(n)
		if err != nil || n == 0 {
			return indexed, err
		}
	}
}

func (s *Store) indexVersionBatch(ctx context.Context, skipped []string) (indexed int, failed []string, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, nil, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	versions, err := q.ListUnindexedVersions(ctx, dbsqlc.ListUnindexedVersionsParams{Skipped: skipped, RowLimit: 20})
	if err != nil {
		return 0, nil, err
	}
	for _, v := range versions {
		doc, _, err := s.blobs.Get(ctx, v.HtmlBlobKey)
		// A missing blob gets empty text, so that it is not read again.
		if err != nil && !errors.Is(err, blob.ErrNotFound) {
			if ctx.Err() != nil {
				return 0, nil, ctx.Err()
			}
			slog.WarnContext(ctx, "version search text not indexed",
				slog.String("version_id", v.ID), slog.Any("error", err))
			failed = append(failed, v.ID)
			continue
		}
		if err := q.SetVersionSearchText(ctx, dbsqlc.SetVersionSearchTextParams{ID: v.ID, SearchText: searchText(doc)}); err != nil {
			return 0, nil, err
		}
		indexed++
	}
	return indexed, failed, tx.Commit(ctx)
}
