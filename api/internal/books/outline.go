// Package books holds the pure outline domain for book mode: the outline
// format, validation, numbering and pruning. It has no database or HTTP code.
package books

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Entry is one outline slot: a real document, or a planned placeholder.
type Entry struct {
	Doc     string `json:"doc,omitempty"`
	Planned string `json:"planned,omitempty"`
}

// Part groups chapters under a title.
type Part struct {
	Title    string  `json:"title"`
	Chapters []Entry `json:"chapters"`
}

// Outline is the ordered structure of a book.
type Outline struct {
	Title    string  `json:"title"`
	Subtitle string  `json:"subtitle,omitempty"`
	Front    []Entry `json:"front"`
	Parts    []Part  `json:"parts"`
	Back     []Entry `json:"back"`
}

// Problem is one validation failure, addressed by its path in the outline.
type Problem struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// Kind classifies a numbered outline slot.
type Kind string

const (
	KindFront   Kind = "front"
	KindChapter Kind = "chapter"
	KindPlanned Kind = "planned"
	KindBack    Kind = "back"
)

// Numbered is an outline slot with its chapter number. Part is -1 for front
// and back matter, which are not numbered.
type Numbered struct {
	Kind    Kind
	Number  int
	Part    int
	Doc     string
	Planned string
}

// DocTitle is a document id with its title.
type DocTitle struct{ ID, Title string }

const (
	MaxEntries = 500
	MaxTitle   = 200
)

// titleNumberRe needs whitespace after an ASCII separator, so numbers that are
// part of the title ("1.5 Migration guide", "3-D Printing", "1:1 meetings",
// "24-hour support") are not read as chapter numbers.
var titleNumberRe = regexp.MustCompile(`^\s*(\d{1,3})\s*(?:·|–|—|[.:\-]\s)\s*(\S.*)$`)

// TitleNumber splits a leading chapter number such as "24 · Title".
func TitleNumber(title string) (int, string, bool) {
	m := titleNumberRe.FindStringSubmatch(title)
	if m == nil {
		return 0, strings.TrimSpace(title), false
	}
	n, _ := strconv.Atoi(m[1])
	return n, strings.TrimSpace(m[2]), true
}

// DisplayTitle strips the number prefix only when it equals number.
func DisplayTitle(title string, number int) string {
	if n, rest, ok := TitleNumber(title); ok && n == number {
		return rest
	}
	return title
}

// Validate reports every problem in the outline, each with its path.
func Validate(o Outline, folderDocs map[string]bool) []Problem {
	var ps []Problem
	seen := map[string]bool{}
	count := 0
	add := func(p, m string) { ps = append(ps, Problem{p, m}) }
	if strings.TrimSpace(o.Title) == "" {
		add("title", "Give the book a title.")
	}
	if utf8.RuneCountInString(o.Title) > MaxTitle {
		add("title", "Keep the title under 200 characters.")
	}
	entry := func(path string, e Entry) {
		count++
		switch {
		case e.Doc != "" && e.Planned != "":
			add(path, "Set either doc or planned, not both.")
		case e.Doc != "":
			if !folderDocs[e.Doc] {
				add(path+".doc", "This document is not in the book's folder.")
			} else if seen[e.Doc] {
				add(path+".doc", "This document is already in the outline.")
			}
			seen[e.Doc] = true
		case strings.TrimSpace(e.Planned) == "":
			add(path+".planned", "Give the planned chapter a title.")
		case utf8.RuneCountInString(e.Planned) > MaxTitle:
			add(path+".planned", "Keep the title under 200 characters.")
		}
	}
	for i, e := range o.Front {
		entry(fmt.Sprintf("front[%d]", i), e)
	}
	for pi, p := range o.Parts {
		if strings.TrimSpace(p.Title) == "" && len(o.Parts) > 1 {
			add(fmt.Sprintf("parts[%d].title", pi), "Give the part a title, or remove the part.")
		}
		for ci, e := range p.Chapters {
			entry(fmt.Sprintf("parts[%d].chapters[%d]", pi, ci), e)
		}
	}
	for i, e := range o.Back {
		entry(fmt.Sprintf("back[%d]", i), e)
	}
	if count > MaxEntries {
		add("parts", "An outline can hold at most 500 entries.")
	}
	return ps
}

// Number lists every slot in reading order; chapters and placeholders are
// numbered 1..N across parts, front and back matter are not numbered.
func Number(o Outline) []Numbered {
	var out []Numbered
	n := 0
	for _, e := range o.Front {
		out = append(out, Numbered{Kind: KindFront, Part: -1, Doc: e.Doc, Planned: e.Planned})
	}
	for pi, p := range o.Parts {
		for _, e := range p.Chapters {
			n++
			k := KindChapter
			if e.Doc == "" {
				k = KindPlanned
			}
			out = append(out, Numbered{k, n, pi, e.Doc, e.Planned})
		}
	}
	for _, e := range o.Back {
		out = append(out, Numbered{Kind: KindBack, Part: -1, Doc: e.Doc, Planned: e.Planned})
	}
	return out
}

// FillPlaceholder puts d into a planned slot, matching by number first and
// then by title (case-insensitive, number prefix stripped). It returns
// ok=false when nothing matches or d is already in the outline.
func FillPlaceholder(o Outline, d DocTitle) (Outline, int, bool) {
	for _, id := range DocIDs(o) {
		if id == d.ID {
			return o, 0, false
		}
	}
	n, rest, hasNum := TitleNumber(d.Title)
	nums := Number(o)
	target := -1
	if hasNum {
		for _, x := range nums {
			if x.Number == n && x.Kind == KindPlanned {
				target = n
			}
		}
	}
	if target < 0 {
		for _, x := range nums {
			if x.Kind == KindPlanned && strings.EqualFold(strings.TrimSpace(x.Planned), rest) {
				target = x.Number
				break
			}
		}
	}
	if target < 0 {
		return o, 0, false
	}
	out := clone(o)
	k := 0
	for pi := range out.Parts {
		for ci := range out.Parts[pi].Chapters {
			k++
			if k == target {
				out.Parts[pi].Chapters[ci] = Entry{Doc: d.ID}
			}
		}
	}
	return out, target, true
}

// Prune drops entries whose doc is not in present, keeping planned entries.
// It returns the removed doc ids in order (front, parts, back).
func Prune(o Outline, present map[string]bool) (Outline, []string) {
	var removed []string
	keep := func(es []Entry) []Entry {
		out := make([]Entry, 0, len(es))
		for _, e := range es {
			if e.Doc != "" && !present[e.Doc] {
				removed = append(removed, e.Doc)
				continue
			}
			out = append(out, e)
		}
		return out
	}
	out := Outline{Title: o.Title, Subtitle: o.Subtitle, Front: keep(o.Front), Parts: make([]Part, len(o.Parts))}
	for i, p := range o.Parts {
		out.Parts[i] = Part{Title: p.Title, Chapters: keep(p.Chapters)}
	}
	out.Back = keep(o.Back)
	return out, removed
}

// DocIDs returns every doc id in order (front, parts, back).
func DocIDs(o Outline) []string {
	var ids []string
	add := func(es []Entry) {
		for _, e := range es {
			if e.Doc != "" {
				ids = append(ids, e.Doc)
			}
		}
	}
	add(o.Front)
	for _, p := range o.Parts {
		add(p.Chapters)
	}
	add(o.Back)
	return ids
}

// clone deep-copies the outline's slices.
func clone(o Outline) Outline {
	out := o
	out.Front = copyEntries(o.Front)
	out.Back = copyEntries(o.Back)
	out.Parts = make([]Part, len(o.Parts))
	for i, p := range o.Parts {
		out.Parts[i] = Part{Title: p.Title, Chapters: copyEntries(p.Chapters)}
	}
	return out
}

// copyEntries copies es, keeping nil as nil and empty as empty so JSON output
// does not change between null and [].
func copyEntries(es []Entry) []Entry {
	if es == nil {
		return nil
	}
	out := make([]Entry, len(es))
	copy(out, es)
	return out
}
