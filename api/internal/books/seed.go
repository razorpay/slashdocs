package books

import "sort"

// Seed builds a first outline from a folder's documents. Titles numbered 0
// go to the front matter, other numbered titles become chapters in one
// untitled part ordered by number, and the rest are returned as unplaced.
func Seed(title string, docs []DocTitle) (Outline, []string) {
	type num struct {
		n  int
		id string
	}
	var chapters []num
	o := Outline{Title: title, Front: []Entry{}, Back: []Entry{}}
	var unplaced []string
	for _, d := range docs {
		n, _, ok := TitleNumber(d.Title)
		switch {
		case !ok:
			unplaced = append(unplaced, d.ID)
		case n == 0:
			o.Front = append(o.Front, Entry{Doc: d.ID})
		default:
			chapters = append(chapters, num{n, d.ID})
		}
	}
	sort.SliceStable(chapters, func(i, j int) bool { return chapters[i].n < chapters[j].n })
	p := Part{Chapters: []Entry{}}
	for _, c := range chapters {
		p.Chapters = append(p.Chapters, Entry{Doc: c.id})
	}
	o.Parts = []Part{p}
	sort.Strings(unplaced)
	return o, unplaced
}
