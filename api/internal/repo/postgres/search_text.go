package postgres

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"unicode"

	"golang.org/x/net/html"

	"github.com/razorpay/slashdocs/api/internal/blob"
	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
)

// maxSearchTextBytes keeps a version's tsvector below the PostgreSQL limit of
// 1 MB. It is about 40,000 words, more than almost any document has.
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
	// PostgreSQL text must be UTF-8. A document can have bytes in another
	// encoding, and the size limit can cut a character in two.
	return strings.ToValidUTF8(text.String()[:min(text.Len(), maxSearchTextBytes)], "")
}

var hiddenElements = map[string]bool{"script": true, "style": true, "template": true, "noscript": true}

func isSeparator(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }

// tsquery returns PostgreSQL tsquery text that matches words that start with
// each term, joined with op. Quoting makes every term a literal, and a quoted
// phrase matches its words in order.
func tsquery(terms []string, op string) string {
	quoted := make([]string, len(terms))
	for i, term := range terms {
		quoted[i] = "'" + tsqueryEscaper.Replace(term) + "':*"
	}
	return strings.Join(quoted, op)
}

var tsqueryEscaper = strings.NewReplacer(`\`, `\\`, `'`, `''`)

// tsqueryWords returns tsquery text that matches the words of every term in
// any order: a phrase "error budget" becomes 'error':* & 'budget':*. Every
// document that tsquery(terms, " & ") matches, this matches too. Search
// finds these documents in the index and checks the order of the words, which
// reads a document's text vector, on the sorted candidates only.
func tsqueryWords(terms []string) string {
	var words []string
	for _, term := range terms {
		words = append(words, strings.Fields(term)...)
	}
	return tsquery(words, " & ")
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
