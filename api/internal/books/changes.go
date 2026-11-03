package books

// SectionHash is a content fingerprint of one section of a chapter.
type SectionHash struct {
	ID    string
	Title string
	Hash  string
	Words int
}

// ChangedSection is one entry of the "what changed" panel.
type ChangedSection struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Removed bool   `json:"removed"`
}

// ChangedSections lists sections that are new or changed in cur, in cur
// order, followed by sections removed from old, in old order. It never
// returns nil, so it serializes as [] rather than null.
func ChangedSections(old, cur []SectionHash) []ChangedSection {
	out := []ChangedSection{}
	oldByID := make(map[string]string, len(old))
	for _, s := range old {
		oldByID[s.ID] = s.Hash
	}
	curIDs := make(map[string]struct{}, len(cur))
	for _, s := range cur {
		curIDs[s.ID] = struct{}{}
		if h, ok := oldByID[s.ID]; !ok || h != s.Hash {
			out = append(out, ChangedSection{ID: s.ID, Title: s.Title})
		}
	}
	for _, s := range old {
		if _, ok := curIDs[s.ID]; !ok {
			out = append(out, ChangedSection{ID: s.ID, Title: s.Title, Removed: true})
		}
	}
	return out
}

// ChapterProgress is one chapter's size and reading state. Read is true for
// the Read and Done states.
type ChapterProgress struct {
	Words       int
	Read        bool
	Progression float64
}

// Progress returns the word-weighted share of the book read, in [0,1].
func Progress(chapters []ChapterProgress) float64 {
	var total, done float64
	for _, c := range chapters {
		w := float64(c.Words)
		total += w
		if c.Read {
			done += w
		} else {
			done += c.Progression * w
		}
	}
	if total == 0 {
		return 0
	}
	return done / total
}
