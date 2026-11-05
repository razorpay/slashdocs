package render

import "testing"

func TestSectionsSplitsAtHeadingsAndMatchesHeadingIDs(t *testing.T) {
	raw := []byte(`<p>Intro words here</p><h2>Parse PDFs</h2><p>one  two</p><script>var x=1</script><h2 id="cost">Cost</h2><p>three</p>`)
	got, err := Sections(raw)
	if err != nil {
		t.Fatalf("Sections: %v", err)
	}
	hs, _ := Headings(raw)
	if len(got) != 3 {
		t.Fatalf("got %d sections, want 3", len(got))
	}
	if got[0].ID != "" || got[0].Words != 3 {
		t.Errorf("intro = %+v", got[0])
	}
	if got[1].ID != hs[0].ID || got[1].Title != "Parse PDFs" || got[1].Words != 2 {
		t.Errorf("second = %+v", got[1])
	}
	if got[2].ID != "cost" || got[2].Words != 1 {
		t.Errorf("third = %+v", got[2])
	}
}

func TestSectionHashIgnoresWhitespaceAndMarkupButNotWords(t *testing.T) {
	a, _ := Sections([]byte(`<h2>A</h2><p>Costs ₹84 per dollar</p>`))
	b, _ := Sections([]byte(`<h2>A</h2><div>Costs   <b>₹84</b> per
dollar</div>`))
	c, _ := Sections([]byte(`<h2>A</h2><p>Costs ₹96 per dollar</p>`))
	if a[0].Hash != b[0].Hash {
		t.Errorf("hash changed for whitespace/markup only: %s vs %s", a[0].Hash, b[0].Hash)
	}
	if a[0].Hash == c[0].Hash {
		t.Errorf("hash did not change when words changed")
	}
}

func TestSectionsNoHeadings(t *testing.T) {
	got, _ := Sections([]byte(`<p>just text</p>`))
	if len(got) != 1 || got[0].Words != 2 {
		t.Fatalf("got %+v", got)
	}
}

func TestSectionHashChangesWhenOnlyAFigureChanges(t *testing.T) {
	cases := map[string][2]string{
		"svg":   {`<svg><rect width="10"/></svg>`, `<svg><rect width="20"/></svg>`},
		"img":   {`<img src="a.png" alt="x">`, `<img src="b.png" alt="x">`},
		"table": {`<table><tr><td>1</td></tr></table>`, `<table><tr><td>2</td></tr></table>`},
	}
	for name, c := range cases {
		a, _ := Sections([]byte(`<h2>A</h2><p>same words</p>` + c[0]))
		b, _ := Sections([]byte(`<h2>A</h2><p>same words</p>` + c[1]))
		if a[0].Hash == b[0].Hash {
			t.Errorf("%s: hash unchanged after figure change", name)
		}
	}
}

func TestSectionHashIgnoresIDsAndWhitespaceInFigures(t *testing.T) {
	a, _ := Sections([]byte(`<h2>A</h2><svg id="f1"><rect width="10"/></svg><pre id="p1">x = 1</pre>`))
	b, _ := Sections([]byte(`<h2>A</h2><svg   id="other">
  <rect   width="10"/>
</svg><pre id="p2">x   =   1</pre>`))
	if a[0].Hash != b[0].Hash {
		t.Errorf("hash changed for ids/whitespace in figures: %s vs %s", a[0].Hash, b[0].Hash)
	}
	if a[0].Words != 3 {
		t.Errorf("words = %d, want 3 (x, =, 1)", a[0].Words)
	}
}

func TestSectionsNestedHeadingKeepsIDsAlignedWithHeadings(t *testing.T) {
	raw := []byte(`<h2>One</h2><p>a</p><h2><span>Two<h3>Nested</h3></span></h2><p>b</p><h2>Three</h2><p>c</p>`)
	got, err := Sections(raw)
	if err != nil {
		t.Fatalf("Sections: %v", err)
	}
	hs, err := Headings(raw)
	if err != nil {
		t.Fatalf("Headings: %v", err)
	}
	if len(got) != len(hs) {
		t.Fatalf("got %d sections %+v, want one per heading %+v", len(got), got, hs)
	}
	for i, h := range hs {
		if got[i].ID != h.ID || got[i].Title != h.Text || got[i].Level != h.Level {
			t.Errorf("section %d = %+v, want heading %+v", i, got[i], h)
		}
	}
	last := got[len(got)-1]
	if last.ID != "three" || last.Words != 1 {
		t.Errorf("last section = %+v, want three with 1 word", last)
	}
}

func TestSectionsIgnoreDocumentHead(t *testing.T) {
	doc := func(title string) []byte {
		return []byte(`<!doctype html><html><head><title>` + title + `</title><meta charset="utf-8"></head><body><h2>A</h2><p>body words</p></body></html>`)
	}
	a, err := Sections(doc("My Title"))
	if err != nil {
		t.Fatalf("Sections: %v", err)
	}
	if len(a) != 1 || a[0].ID != "a" || a[0].Words != 2 {
		t.Fatalf("sections = %+v, want only section a with 2 words", a)
	}
	b, _ := Sections(doc("Another Title"))
	if len(b) != 1 || a[0].Hash != b[0].Hash {
		t.Errorf("changing only <title> changed sections: %+v vs %+v", a, b)
	}
}
