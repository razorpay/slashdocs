package render

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"golang.org/x/net/html"
)

// Section is a heading-delimited slice of a document. Order 0 with an empty
// ID is the text before the first heading.
type Section struct {
	ID, Title           string
	Level, Order, Words int
	Hash                string
}

// skipText are the elements whose text is not body text. "head" keeps a full
// document's <title> out of the text before the first heading.
var skipText = map[string]bool{"head": true, "script": true, "style": true, "noscript": true, "template": true}

// figureTags are the elements whose markup, not just text, feeds the hash,
// so a changed diagram, image, code block or table marks the section changed.
var figureTags = map[string]bool{"svg": true, "img": true, "pre": true, "code": true, "table": true}

// Sections splits a document at its headings. Section IDs match Headings in
// order: both come from one parse and the same heading nodes. The hash covers
// the title, the normalised words and the markup of figures; Words counts
// text only.
func Sections(raw []byte) ([]Section, error) {
	d, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	nodes, hs := headingNodes(d)
	byNode := make(map[*html.Node]Heading, len(nodes))
	for i, n := range nodes {
		byNode[n] = hs[i]
	}
	type acc struct {
		s      Section
		text   strings.Builder
		markup strings.Builder
	}
	parts := []*acc{{}}
	// inHeading: heading text is the title, not body, but a heading nested
	// inside another one still starts its own section.
	var walk func(n *html.Node, inFigure, inHeading bool)
	walk = func(n *html.Node, inFigure, inHeading bool) {
		if n.Type == html.ElementNode {
			if skipText[n.Data] {
				return
			}
			if h, ok := byNode[n]; ok {
				parts = append(parts, &acc{s: Section{ID: h.ID, Title: h.Text, Level: h.Level}})
				inHeading = true
			}
			if !inHeading && !inFigure && figureTags[n.Data] {
				parts[len(parts)-1].markup.WriteString(figureMarkup(n))
				parts[len(parts)-1].markup.WriteByte('\n')
				inFigure = true
			}
		}
		if n.Type == html.TextNode && !inHeading {
			cur := parts[len(parts)-1]
			cur.text.WriteString(n.Data)
			cur.text.WriteByte(' ')
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, inFigure, inHeading)
		}
	}
	walk(d, false, false)
	out := make([]Section, 0, len(parts))
	for i, p := range parts {
		words := strings.Fields(p.text.String())
		if i == 0 && len(words) == 0 && p.markup.Len() == 0 {
			continue
		}
		sum := sha256.Sum256([]byte(p.s.Title + "\n" + strings.Join(words, " ") + "\n" + p.markup.String()))
		p.s.Words, p.s.Hash, p.s.Order = len(words), hex.EncodeToString(sum[:8]), len(out)
		out = append(out, p.s)
	}
	return out, nil
}

// figureMarkup serialises a figure subtree without id attributes (img keeps
// only src and alt) and collapses whitespace.
func figureMarkup(n *html.Node) string {
	var b bytes.Buffer
	if err := html.Render(&b, stripped(n)); err != nil {
		return ""
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

func stripped(n *html.Node) *html.Node {
	c := &html.Node{Type: n.Type, DataAtom: n.DataAtom, Data: n.Data, Namespace: n.Namespace}
	for _, a := range n.Attr {
		if a.Key == "id" || (n.Data == "img" && a.Key != "src" && a.Key != "alt") {
			continue
		}
		c.Attr = append(c.Attr, a)
	}
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		if ch.Type == html.TextNode {
			text := strings.Join(strings.Fields(ch.Data), " ")
			if text == "" {
				continue // whitespace between tags is layout, not content
			}
			c.AppendChild(&html.Node{Type: html.TextNode, Data: text})
			continue
		}
		c.AppendChild(stripped(ch))
	}
	return c
}
