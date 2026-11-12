package server

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/internal/textedit"
)

// anchorContext is the length of the prefix and the suffix of a text anchor,
// as CONTEXT_LENGTH in frontend/bridge/anchoring/index.ts.
const anchorContext = 32

// follow moves the text comments of the document to the live document
// before a read of them. The change is saved, so a failure is only logged:
// the next change or read moves them.
func (h handlers) follow(c *gin.Context, docID string) {
	h.followNow(context.WithoutCancel(c.Request.Context()), docID)
}

// followLater moves the text comments of the document after a change, off
// the request, so that typing does not wait for it. When the text of a
// comment changed, the pages read the comments again: a page that loaded
// them before the change has an anchor that its frame no longer finds.
func (h handlers) followLater(c *gin.Context, docID string) {
	ctx, by := context.WithoutCancel(c.Request.Context()), current(c)
	h.deps.anchorFollows.start(docID, func() {
		if !h.followNow(ctx, docID) {
			return
		}
		event := repo.DocumentKVEvent{DocumentID: docID, Kind: repo.DocumentEventComments, UpdatedBy: by}
		if err := h.deps.documentKVEvents.Relay(ctx, event); err != nil {
			slog.WarnContext(ctx, "comment anchor relay failed", slog.String("document_id", docID), slog.Any("error", err))
		}
	})
}

// followNow moves the anchors, and reports whether the text of one changed.
func (h handlers) followNow(ctx context.Context, docID string) bool {
	moved, err := h.followAnchors(ctx, docID)
	if err != nil {
		slog.WarnContext(ctx, "comment anchors did not follow the document", slog.String("document_id", docID), slog.Any("error", err))
	}
	return moved && err == nil
}

// followers runs one follow of the anchors of a document at a time. A
// change that comes during a follow runs one more after it, so a burst of
// changes gives at most two follows.
type followers struct {
	mu sync.Mutex
	// pending holds the documents that a follow runs for, and true when
	// one more waits.
	pending map[string]bool
}

func (f *followers) start(docID string, follow func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, running := f.pending[docID]; running {
		f.pending[docID] = true
		return
	}
	f.pending[docID] = false
	go func() {
		for again := true; again; {
			follow()
			f.mu.Lock()
			if again = f.pending[docID]; again {
				f.pending[docID] = false
			} else {
				delete(f.pending, docID)
			}
			f.mu.Unlock()
		}
	}()
}

// followAnchors moves the text comments of the document to the live
// document, as Google Docs does: the text of each anchor shrinks and grows
// with the changes after the seq that the anchor is on, and text put in at
// its ends stays out of it. An anchor whose text is all gone, or whose seq
// the log no longer holds, keeps its quote. Two calls at one time cannot
// move an anchor twice: a move applies only while the anchor is on the seq
// that the move started from.
func (h handlers) followAnchors(ctx context.Context, docID string) (moved bool, err error) {
	r := h.deps.repository
	behind, err := r.AnchorsBehind(ctx, docID)
	if err != nil || len(behind) == 0 {
		return false, err
	}
	d, err := r.GetDocument(ctx, docID)
	if err != nil {
		return false, err
	}
	live, seq, err := r.GetVersionHTMLAt(ctx, d.CurrentVersionID, repo.LiveSeq)
	if err != nil {
		return false, err
	}
	now := renderedBodyText(string(live))
	texts := map[int64]*renderedText{}
	for i, f := range behind {
		text, ok := texts[f.Seq]
		if !ok {
			before, _, err := r.GetVersionHTMLAt(ctx, d.CurrentVersionID, f.Seq)
			if err != nil && !errors.Is(err, repo.ErrStale) {
				return false, err
			}
			if before != nil {
				t := renderedBodyText(string(before))
				text = &t
			}
			texts[f.Seq] = text
		}
		if text != nil {
			behind[i].Anchor = followText(f.Anchor, *text, now)
			moved = moved || behind[i].Anchor.Quote != f.Anchor.Quote
		}
	}
	// A write that made another version the current one during the reads
	// can make a seq of the anchors look gone. The next follow moves them.
	if again, err := r.GetDocument(ctx, docID); err != nil || again.CurrentVersionID != d.CurrentVersionID {
		return false, err
	}
	return moved, r.MoveAnchors(ctx, behind, seq)
}

// followText gives the text anchor a, on the text before, its place in the
// text after. It gives a as it is when a is not placed on before, or when
// all of its text is gone.
func followText(a repo.Anchor, before, after renderedText) repo.Anchor {
	start, end, ok := textPlace(before, a, a.Quote)
	if !ok {
		return a
	}
	old, now := string(utf16.Decode(before.units)), string(utf16.Decode(after.units))
	changes := words(old, now, textedit.Between([]byte(old), []byte(now)))
	from, to := len(string(utf16.Decode(before.units[:start]))), len(string(utf16.Decode(before.units[:end])))
	if !keeps(old, from, to, changes) {
		return a
	}
	start, end = unitsIn(now, moved(from, changes, true)), unitsIn(now, moved(to, changes, false))
	// The viewer trims the white space at the ends of a selection.
	for start < end && unicode.IsSpace(rune(after.units[start])) {
		start++
	}
	for end > start && unicode.IsSpace(rune(after.units[end-1])) {
		end--
	}
	if start == end {
		return a
	}
	return anchorAt(after, start, end)
}

// moved gives the place in the new text of the byte p of the old text, for
// the changes from the old text to the new one. A place in text that a
// change takes out goes to the start of its new text, or to its end when
// late. Text put in at p comes before the place when late.
func moved(p int, changes []textedit.Replacement, late bool) int {
	shift := 0
	for _, r := range changes {
		switch {
		case r.Start > p || r.Start == p && (r.End > p || !late):
			return p + shift
		case r.End > p && late:
			return r.Start + shift + len(r.NewHTML)
		case r.End > p:
			return r.Start + shift
		}
		shift += len(r.NewHTML) - len(r.OldHTML)
	}
	return p + shift
}

// keeps reports whether a word of the old text from byte from to byte to
// stays out of the changes.
func keeps(old string, from, to int, changes []textedit.Replacement) bool {
	for _, r := range changes {
		if from >= to {
			return false
		}
		if r.Start > from && strings.IndexFunc(old[from:min(r.Start, to)], isWord) >= 0 {
			return true
		}
		from = max(from, r.End)
	}
	return from < to && strings.IndexFunc(old[from:to], isWord) >= 0
}

// words widens each change that takes out a part of a word to whole words
// of the old text. A diff of two different sentences keeps the letters that they have
// in common by chance, and an anchor must not stay on those letters. Text
// that is only put in stays as it is.
func words(old, now string, changes []textedit.Replacement) []textedit.Replacement {
	var out []textedit.Replacement
	for _, r := range changes {
		// Only a change that takes out a part of a word cuts into it: a
		// change of punctuation next to a word leaves the word as it is.
		start, end := r.Start, r.End
		if start < end && wordRune(utf8.DecodeRuneInString(r.OldHTML)) {
			for start > 0 && wordRune(utf8.DecodeLastRuneInString(old[:start])) {
				_, n := utf8.DecodeLastRuneInString(old[:start])
				start -= n
			}
		}
		if start < end && wordRune(utf8.DecodeLastRuneInString(r.OldHTML)) {
			for end < len(old) && wordRune(utf8.DecodeRuneInString(old[end:])) {
				_, n := utf8.DecodeRuneInString(old[end:])
				end += n
			}
		}
		for n := len(out); n > 0 && start <= out[n-1].End; n-- {
			start, end = min(start, out[n-1].Start), max(end, out[n-1].End)
			out = out[:n-1]
		}
		out = append(out, textedit.Replacement{Start: start, End: end})
	}
	for i, r := range out {
		out[i].OldHTML = old[r.Start:r.End]
		out[i].NewHTML = now[moved(r.Start, changes, false):moved(r.End, changes, true)]
	}
	return out
}

func isWord(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }

func wordRune(r rune, _ int) bool { return isWord(r) }

// unitsIn gives the number of UTF-16 units in the first b bytes of s.
func unitsIn(s string, b int) int { return utf16Len(s[:b]) }

// anchorAt describes the units from start to end of text as the viewer
// does (describeAnchor in frontend/bridge/anchoring/index.ts): the offsets
// count raw textContent, which has no character for a <br>.
func anchorAt(text renderedText, start, end int) repo.Anchor {
	raw := func(rendered int) int {
		n := rendered
		for _, br := range text.brs {
			if br < rendered {
				n--
			}
		}
		return n
	}
	rawStart, rawEnd := raw(start), raw(end)
	from := rawOffsetToRendered(text.brs, max(0, rawStart-anchorContext))
	to := rawOffsetToRendered(text.brs, min(raw(len(text.units)), rawEnd+anchorContext))
	units := func(i, j int) string { return string(utf16.Decode(text.units[i:j])) }
	return repo.Anchor{
		Quote: units(start, end), Prefix: units(from, start), Suffix: units(end, to),
		DOMPath: "body", StartOffset: rawStart, EndOffset: rawEnd,
	}
}
