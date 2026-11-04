package render

import (
	"bytes"
	"strconv"
	"unicode/utf8"

	"golang.org/x/net/html"
)

// sourceAttr names the source position of an element in the rendered page.
// It must equal SOURCE_ATTR in frontend/bridge/source-pieces.ts.
const sourceAttr = "data-slashdocs-source"

// tagSource adds sourceAttr to every start tag of userHTML, right after the
// tag name. Its value is the offset of the tag's "<" in userHTML, counted in
// UTF-16 code units as JavaScript strings count: a character at or above
// U+10000 counts 2, and an invalid byte counts 1. All other bytes stay the
// same, so the bridge can map each element back to its source. Text in
// script, style, title, textarea and the other raw text elements has no tags.
func tagSource(userHTML []byte) []byte {
	var out bytes.Buffer
	out.Grow(len(userHTML) + len(userHTML)/8)
	z := html.NewTokenizer(bytes.NewReader(userHTML))
	// at is the byte offset of the current token, copied up to copied, and
	// units counts the UTF-16 code units of userHTML[:copied].
	at, copied, units := 0, 0, 0
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			break
		}
		// Raw changes when the tokenizer reads on, so take its length first.
		size := len(z.Raw())
		if tt == html.StartTagToken || tt == html.SelfClosingTagToken {
			units += utf16Len(userHTML[copied:at])
			nameEnd := at + 1 + bytes.IndexAny(userHTML[at+1:at+size], " \t\n\f\r/>")
			out.Write(userHTML[copied:nameEnd])
			out.WriteString(" " + sourceAttr + `="` + strconv.Itoa(units) + `"`)
			units += utf16Len(userHTML[at:nameEnd])
			copied = nameEnd
		}
		at += size
	}
	out.Write(userHTML[copied:])
	return out.Bytes()
}

// utf16Len counts the UTF-16 code units of b.
func utf16Len(b []byte) int {
	n := 0
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		n++
		if r >= 0x10000 {
			n++
		}
		b = b[size:]
	}
	return n
}
