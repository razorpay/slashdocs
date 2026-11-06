package render

import (
	"bytes"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/net/html"
)

// Heading is a heading of a document, with the ID that the viewer gives it.
type Heading struct {
	ID    string `json:"id"`
	Text  string `json:"text"`
	Level int    `json:"level"`
}

var headingSlug = regexp.MustCompile(`[^a-z0-9]+`)

// Headings mirrors bridge prepareHeadings: reserve every author ID first,
// then suffix generated IDs until unique. The source HTML is never changed.
func Headings(raw []byte) ([]Heading, error) {
	d, err := html.Parse(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	used := map[string]bool{}
	var nodes []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if id := htmlID(n); id != "" {
				used[id] = true
			}
			if isHeading(n.Data) {
				nodes = append(nodes, n)
			}
			if n.Data == "template" {
				return
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(d)
	var content func(*html.Node) string
	content = func(n *html.Node) string {
		if n.Type == html.TextNode {
			return n.Data
		}
		var b strings.Builder
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			b.WriteString(content(c))
		}
		return b.String()
	}
	result := make([]Heading, 0, len(nodes))
	for _, n := range nodes {
		text := strings.TrimSpace(content(n))
		id := htmlID(n)
		if id == "" {
			base := strings.Trim(headingSlug.ReplaceAllString(strings.ToLower(text), "-"), "-")
			if base == "" {
				base = "section"
			}
			id = base
			for suffix := 2; used[id]; suffix++ {
				id = base + "-" + strconv.Itoa(suffix)
			}
			used[id] = true
		}
		result = append(result, Heading{ID: id, Text: text, Level: int(n.Data[1] - '0')})
	}
	return result, nil
}

func htmlID(n *html.Node) string {
	for _, a := range n.Attr {
		if a.Key == "id" {
			return a.Val
		}
	}
	return ""
}

func isHeading(tag string) bool {
	return len(tag) == 2 && tag[0] == 'h' && tag[1] >= '1' && tag[1] <= '6'
}
