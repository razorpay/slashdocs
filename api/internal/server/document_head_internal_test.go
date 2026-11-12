package server

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// The server serves the built page. The source page is checked too, because
// the built page exists only after a frontend build.
func TestShellTitleMatchesTheWebApp(t *testing.T) {
	check := func(name string, index []byte) {
		t.Helper()
		if !bytes.Contains(index, []byte(shellTitle)) {
			t.Errorf("%s lacks %s, which document pages replace", name, shellTitle)
		}
	}
	source, err := os.ReadFile("../../../frontend/index.html")
	if err != nil {
		t.Fatal(err)
	}
	check("frontend/index.html", source)
	built, err := os.ReadFile("frontend_dist/index.html")
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	check("the built index.html", built)
}

func TestDocumentDescriptionFallsBackToAByline(t *testing.T) {
	updated := time.Date(2026, 10, 28, 7, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name    string
		owner   string
		preview repo.VersionPreview
		want    string
	}{
		{"excerpt", "Owner", repo.VersionPreview{Text: "fixture Body text.", CreatedAt: updated}, "Body text."},
		{"byline", "Owner", repo.VersionPreview{Text: "fixture", CreatedAt: updated}, "By Owner · Updated 28 Oct 2026"},
		{"no owner name", "", repo.VersionPreview{CreatedAt: updated}, "Updated 28 Oct 2026"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := repo.Document{Title: "fixture", Owner: auth.Principal{Name: tc.owner}}
			if got := documentDescription(d, tc.preview); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}
