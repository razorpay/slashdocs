package books

import (
	"reflect"
	"testing"
)

func TestSeedOrdersByNumberAndSendsZeroToFront(t *testing.T) {
	o, unplaced := Seed("Book", []DocTitle{{"d2", "02 · B"}, {"d0", "00 · Roadmap"}, {"d1", "01 · A"}, {"dx", "Notes"}})
	if want := []Entry{{Doc: "d0"}}; !reflect.DeepEqual(want, o.Front) {
		t.Errorf("front = %#v, want %#v", o.Front, want)
	}
	if len(o.Parts) != 1 || o.Parts[0].Title != "" {
		t.Fatalf("parts = %#v, want one untitled part", o.Parts)
	}
	if want := []Entry{{Doc: "d1"}, {Doc: "d2"}}; !reflect.DeepEqual(want, o.Parts[0].Chapters) {
		t.Errorf("chapters = %#v, want %#v", o.Parts[0].Chapters, want)
	}
	if want := []string{"dx"}; !reflect.DeepEqual(want, unplaced) {
		t.Errorf("unplaced = %#v, want %#v", unplaced, want)
	}
}
