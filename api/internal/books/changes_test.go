package books

import (
	"math"
	"reflect"
	"testing"
)

func TestChangedSections(t *testing.T) {
	old := []SectionHash{{"a", "A", "1", 0}, {"b", "B", "2", 0}, {"c", "C", "3", 0}}
	cur := []SectionHash{{"a", "A", "1", 0}, {"b", "B", "9", 0}, {"d", "D", "4", 0}}
	want := []ChangedSection{{"b", "B", false}, {"d", "D", false}, {"c", "C", true}}
	if got := ChangedSections(old, cur); !reflect.DeepEqual(got, want) {
		t.Fatalf("ChangedSections = %+v, want %+v", got, want)
	}
	same := ChangedSections(cur, cur)
	if same == nil || len(same) != 0 {
		t.Fatalf("unchanged must be a non-nil empty slice, got %#v", same)
	}
}

func TestProgressWeightsByWords(t *testing.T) {
	// (300 + 0.5*200) / 600 = 2/3
	got := Progress([]ChapterProgress{{Words: 300, Read: true}, {Words: 200, Progression: 0.5}, {Words: 100}})
	if math.Abs(got-2.0/3.0) > 1e-9 {
		t.Errorf("Progress = %v, want 2/3", got)
	}
	if got := Progress(nil); got != 0 {
		t.Errorf("Progress(nil) = %v, want 0", got)
	}
}
