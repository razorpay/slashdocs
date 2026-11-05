package repo

import (
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/books"
)

// Book is a folder read in order, with its current outline.
type Book struct {
	ID, FolderID, OutlineVersionID string
	OutlineNumber                  int
	Outline                        books.Outline
	CreatedAt                      string
}

// OutlineVersion is one saved version of a book's outline.
type OutlineVersion struct {
	ID         string
	Number     int
	ChangeNote string
	CreatedBy  auth.Principal
	CreatedAt  string
}

// OutlineConflictError reports that an outline push was based on a version
// that is no longer current. It matches ErrConflict with errors.Is.
type OutlineConflictError struct{ CurrentVersionID string }

func (e *OutlineConflictError) Error() string   { return "outline version conflict" }
func (e *OutlineConflictError) Is(t error) bool { return t == ErrConflict }

// SectionInfo is one indexed section of a version.
type SectionInfo struct {
	ID, Title, Hash     string
	Level, Order, Words int
}

// VersionNote is a version's number and change summary.
type VersionNote struct {
	ID            string
	Number        int
	ChangeSummary string
	CreatedAt     string
}

// ChapterRead is one reader's state in one chapter. A row exists once the
// reader opens the chapter.
type ChapterRead struct {
	DocumentID, SeenVersionID, LastReadVersionID string
	FurthestProgression                          float64
	ReachedEnd, Done                             bool
	LastOpenedAt                                 string
}

// MaxReadingDevices is how many devices keep a reading position per reader
// and book. Device ids come from the client, so the oldest positions beyond
// this are dropped.
const MaxReadingDevices = 20

// ReadingPosition is one reader's place in a book on one device.
type ReadingPosition struct {
	DeviceID, DocumentID, VersionID, SectionID string
	Anchor                                     Anchor
	Progression                                float64
	ClientTS                                   time.Time
	UpdatedAt                                  string
}
