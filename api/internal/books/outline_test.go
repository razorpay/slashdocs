package books

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestTitleNumber(t *testing.T) {
	for _, c := range []struct {
		in   string
		n    int
		rest string
		ok   bool
	}{
		{"24 · Document Processing", 24, "Document Processing", true}, {"00 · Roadmap", 0, "Roadmap", true},
		{"3. Python", 3, "Python", true}, {"7 - Evals", 7, "Evals", true}, {"12: Agents", 12, "Agents", true},
		{"Intro", 0, "Intro", false}, {"2026 roadmap", 0, "2026 roadmap", false},
		{"3.Python", 0, "3.Python", false}, {"4 — Serving", 4, "Serving", true}, {"5–Tools", 5, "Tools", true},
		// Numbers that are part of the title, not a chapter number.
		{"1.5 Migration guide", 0, "1.5 Migration guide", false}, {"2.0 Release notes", 0, "2.0 Release notes", false},
		{"3-D Printing", 0, "3-D Printing", false}, {"1:1 meetings", 0, "1:1 meetings", false},
		{"24-hour support", 0, "24-hour support", false}, {"3.5 Overview", 0, "3.5 Overview", false},
	} {
		n, r, ok := TitleNumber(c.in)
		if n != c.n || r != c.rest || ok != c.ok {
			t.Errorf("TitleNumber(%q) = (%d, %q, %v), want (%d, %q, %v)", c.in, n, r, ok, c.n, c.rest, c.ok)
		}
	}
}

func sortedProblems(ps []Problem) []Problem {
	out := append([]Problem(nil), ps...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return out[i].Message < out[j].Message
	})
	return out
}

func TestValidateReportsEveryProblemWithPath(t *testing.T) {
	o := Outline{Title: "", Parts: []Part{{Title: "", Chapters: []Entry{{Doc: "nope"}, {Planned: ""}, {Doc: "d1"}, {Doc: "d1"}, {Doc: "d1", Planned: "x"}}}, {Title: "II"}}}
	got := Validate(o, map[string]bool{"d1": true})
	want := []Problem{
		{"title", "Give the book a title."},
		{"parts[0].title", "Give the part a title, or remove the part."},
		{"parts[0].chapters[0].doc", "This document is not in the book's folder."},
		{"parts[0].chapters[1].planned", "Give the planned chapter a title."},
		{"parts[0].chapters[3].doc", "This document is already in the outline."},
		{"parts[0].chapters[4]", "Set either doc or planned, not both."},
	}
	if !reflect.DeepEqual(sortedProblems(want), sortedProblems(got)) {
		t.Fatalf("problems = %#v, want %#v", got, want)
	}
}

func TestValidateAllowsOneUntitledPartForSeededBooks(t *testing.T) {
	o := Outline{Title: "B", Parts: []Part{{Chapters: []Entry{{Doc: "d1"}}}}}
	if got := Validate(o, map[string]bool{"d1": true}); len(got) != 0 {
		t.Fatalf("problems = %#v, want none", got)
	}
}

func TestNumberSkipsFrontAndBack(t *testing.T) {
	o := Outline{Title: "B", Front: []Entry{{Doc: "f"}}, Parts: []Part{{Title: "I", Chapters: []Entry{{Doc: "a"}, {Planned: "P"}}}, {Title: "II", Chapters: []Entry{{Doc: "b"}}}}, Back: []Entry{{Doc: "z"}}}
	got := Number(o)
	want := []Numbered{{KindFront, 0, -1, "f", ""}, {KindChapter, 1, 0, "a", ""}, {KindPlanned, 2, 0, "", "P"}, {KindChapter, 3, 1, "b", ""}, {KindBack, 0, -1, "z", ""}}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("Number = %#v, want %#v", got, want)
	}
}

func TestFillPlaceholderByNumberThenTitle(t *testing.T) {
	o := Outline{Title: "B", Parts: []Part{{Title: "I", Chapters: []Entry{{Doc: "a"}, {Planned: "Inference Internals"}, {Planned: "Serving"}}}}}
	o2, n, ok := FillPlaceholder(o, DocTitle{"d2", "02 · Something else"})
	if !ok || n != 2 || o2.Parts[0].Chapters[1].Doc != "d2" {
		t.Fatalf("by number: ok=%v n=%d chapters=%#v", ok, n, o2.Parts[0].Chapters)
	}
	if o.Parts[0].Chapters[1].Doc != "" {
		t.Fatalf("FillPlaceholder mutated its input: %#v", o.Parts[0].Chapters)
	}
	o3, n, ok := FillPlaceholder(o, DocTitle{"d3", "serving"})
	if !ok || n != 3 || o3.Parts[0].Chapters[2].Doc != "d3" {
		t.Fatalf("by title: ok=%v n=%d chapters=%#v", ok, n, o3.Parts[0].Chapters)
	}
	if _, _, ok = FillPlaceholder(o, DocTitle{"d4", "Unrelated"}); ok {
		t.Errorf("unrelated title filled a placeholder")
	}
	if _, _, ok = FillPlaceholder(o, DocTitle{"d5", "01 · Taken"}); ok { // number 1 is a real chapter
		t.Errorf("number 1 is a real chapter, want ok=false")
	}
	// A9: a doc already in the outline cannot fill a placeholder.
	if _, _, ok = FillPlaceholder(o2, DocTitle{"d2", "03 · Serving"}); ok {
		t.Errorf("doc already in the outline filled a placeholder, want ok=false")
	}
	if _, _, ok = FillPlaceholder(o3, DocTitle{"d3", "serving"}); ok {
		t.Errorf("filling the same doc twice, want ok=false")
	}
}

func TestDisplayTitle(t *testing.T) {
	for _, c := range []struct {
		title string
		n     int
		want  string
	}{{"25 · Agents", 25, "Agents"}, {"25 · Agents", 26, "25 · Agents"}, {"Agents", 3, "Agents"}} {
		if got := DisplayTitle(c.title, c.n); got != c.want {
			t.Errorf("DisplayTitle(%q, %d) = %q, want %q", c.title, c.n, got, c.want)
		}
	}
}

func TestPrune(t *testing.T) {
	o := Outline{Title: "B", Front: []Entry{{Doc: "gone"}}, Parts: []Part{{Title: "I", Chapters: []Entry{{Doc: "a"}, {Planned: "p"}, {Doc: "gone2"}}}}}
	got, removed := Prune(o, map[string]bool{"a": true})
	if len(got.Front) != 0 {
		t.Errorf("front = %#v, want empty", got.Front)
	}
	if want := []Entry{{Doc: "a"}, {Planned: "p"}}; !reflect.DeepEqual(want, got.Parts[0].Chapters) {
		t.Errorf("chapters = %#v, want %#v", got.Parts[0].Chapters, want)
	}
	if want := []string{"gone", "gone2"}; !reflect.DeepEqual(want, removed) {
		t.Errorf("removed = %#v, want %#v", removed, want)
	}
	if len(o.Front) != 1 {
		t.Errorf("Prune mutated its input")
	}
}

func TestDocIDs(t *testing.T) {
	o := Outline{Front: []Entry{{Doc: "f"}}, Parts: []Part{{Chapters: []Entry{{Doc: "a"}, {Planned: "p"}, {Doc: "b"}}}}, Back: []Entry{{Doc: "z"}}}
	if got, want := DocIDs(o), []string{"f", "a", "b", "z"}; !reflect.DeepEqual(want, got) {
		t.Fatalf("DocIDs = %#v, want %#v", got, want)
	}
}

func TestFillPlaceholderKeepsEmptySlicesNonNull(t *testing.T) {
	o, _ := Seed("Book", []DocTitle{{"d1", "01 · A"}})
	o.Parts[0].Chapters = append(o.Parts[0].Chapters, Entry{Planned: "Serving"})
	o.Parts = append(o.Parts, Part{Title: "II", Chapters: []Entry{}})
	o2, _, ok := FillPlaceholder(o, DocTitle{"d2", "Serving"})
	if !ok {
		t.Fatalf("expected placeholder to be filled")
	}
	b, err := json.Marshal(o2)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "null") {
		t.Fatalf("serialized outline contains null: %s", b)
	}
}

func TestFillPlaceholderRejectsDocAlreadyPlacedWhilePlaceholderRemains(t *testing.T) {
	o := Outline{Title: "B", Parts: []Part{{Title: "I", Chapters: []Entry{{Doc: "d2"}, {Planned: "Serving"}}}}}
	if _, _, ok := FillPlaceholder(o, DocTitle{"d2", "Serving"}); ok {
		t.Fatalf("doc already in outline filled a matching placeholder, want ok=false")
	}
}

func TestFillPlaceholderNumbersAcrossParts(t *testing.T) {
	o := Outline{Title: "B", Parts: []Part{{Title: "I", Chapters: []Entry{{Doc: "a"}, {Planned: "X"}}}, {Title: "II", Chapters: []Entry{{Planned: "Y"}}}}}
	o2, n, ok := FillPlaceholder(o, DocTitle{"d3", "03 · Whatever"})
	if !ok || n != 3 || o2.Parts[1].Chapters[0].Doc != "d3" || o2.Parts[0].Chapters[1].Planned != "X" {
		t.Fatalf("ok=%v n=%d parts=%#v", ok, n, o2.Parts)
	}
}
