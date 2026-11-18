package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"strings"
	"time"
)

// A local document can have an expiry time in its state file. After that
// time the server moves the document and its state file to the trash, a
// hidden folder of the documents folder. It deletes no document: the folder
// belongs to the person, and other tools write to it. The person empties
// the trash.

// localTrash is the folder of the documents folder that takes the expired
// documents. Its name starts with a dot, so its files are not documents.
const localTrash = ".slashdocs-trash"

// localTrashStamp names the folder of the trash that one sweep fills, so
// that two documents with the same path do not meet in the trash.
const localTrashStamp = "20060102T150405.000Z"

// localSweepInterval is how often the server looks for expired documents.
const localSweepInterval = time.Minute

const sidecarSuffix = ".slashdocs.json"

// sweepExpired moves the expired documents to the trash at once, and then
// each minute, until ctx ends.
func (s *localDocs) sweepExpired(ctx context.Context) {
	sweep := func() {
		moved, err := s.removeExpired(time.Now())
		for _, doc := range moved {
			// %q, so that a file name cannot write a line of its own.
			fmt.Fprintf(os.Stderr, "slashdocs local: %q expired, and is now in %s\n", doc, localTrash)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "slashdocs local: the sweep of expired documents failed: %q\n", err.Error())
		}
	}
	sweep()
	ticker := time.NewTicker(localSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweep()
		}
	}
}

// removeExpired moves each document whose expiry time is not after now to
// the trash, with its state, and returns the documents that it moved. It
// also removes the expiry of a state file whose document is gone. A document
// that fails is in the error, and the others still go.
func (s *localDocs) removeExpired(now time.Time) ([]string, error) {
	expired, orphans, err := s.findExpired(now)
	failures := []error{err}
	// A person deleted the document by hand, and its state file stayed. A
	// new file with the same name must not take the expiry of the old one.
	for _, doc := range orphans {
		if err := s.forgetExpiry(doc); err != nil {
			failures = append(failures, fmt.Errorf("%s: %w", doc, err))
		}
	}
	var moved []string
	trash := path.Join(localTrash, now.UTC().Format(localTrashStamp))
	for _, doc := range expired {
		gone, err := s.trashExpired(doc, now, trash)
		if err != nil {
			failures = append(failures, fmt.Errorf("%s: %w", doc, err))
		}
		if gone {
			moved = append(moved, doc)
		}
	}
	return moved, errors.Join(failures...)
}

// findExpired returns the documents whose expiry time is not after now, and
// the documents that are gone but whose state file still has an expiry.
func (s *localDocs) findExpired(now time.Time) (expired, orphans []string, err error) {
	docs := s.root.FS()
	err = fs.WalkDir(docs, ".", func(p string, de fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if de.IsDir() {
			// Hidden folders, such as the trash and .git, hold no documents.
			if p != "." && strings.HasPrefix(de.Name(), ".") {
				return fs.SkipDir
			}
			return nil
		}
		doc, isState := sidecarDoc(p)
		if !isState && (strings.HasPrefix(de.Name(), ".") || !isHTML(p)) {
			return nil
		}
		if !isState {
			doc = p
		}
		// A state file that is wrong gives no expiry, so its document stays.
		t, err := readLocalState(docs, doc)
		if err != nil || t.ExpiresAt.IsZero() {
			return nil
		}
		if !isState && !t.ExpiresAt.After(now) {
			expired = append(expired, doc)
		}
		if _, err := fs.Stat(docs, doc); isState && errors.Is(err, fs.ErrNotExist) {
			orphans = append(orphans, doc)
		}
		return nil
	})
	return expired, orphans, err
}

// sidecarDoc returns the document of a state file, if p is one.
func sidecarDoc(p string) (string, bool) {
	name := path.Base(p)
	if !strings.HasPrefix(name, ".") || !strings.HasSuffix(name, sidecarSuffix) {
		return "", false
	}
	return path.Join(path.Dir(p), strings.TrimSuffix(name[1:], sidecarSuffix)), true
}

// forgetExpiry removes the expiry from the state of a document that is
// gone.
func (s *localDocs) forgetExpiry(doc string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.root.Lstat(doc); !errors.Is(err, fs.ErrNotExist) {
		return err // A request made the document since the walk.
	}
	t, err := readLocalState(s.root.FS(), doc)
	if err != nil || t.ExpiresAt.IsZero() {
		return nil
	}
	t.ExpiresAt = time.Time{}
	return s.saveState(doc, t)
}

// trashExpired moves one document to the trash folder, if it is still
// expired. It reports whether the document went.
func (s *localDocs) trashExpired(doc string, now time.Time, trash string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// A request can have changed the expiry since the walk read it.
	t, err := readLocalState(s.root.FS(), doc)
	if err != nil || t.ExpiresAt.IsZero() || t.ExpiresAt.After(now) {
		return false, nil
	}
	// A link is not a file of the folder, so it stays.
	st, err := s.root.Lstat(doc)
	if err != nil || !st.Mode().IsRegular() {
		return false, nil
	}
	expiresAt := t.ExpiresAt
	t.ExpiresAt = time.Time{}
	// The expiry belongs to the path. A file that changed after the expiry
	// time is a new file with the name of an old one, or a document that a
	// person worked on while the server was off. It stays, and its expiry
	// goes, so that the person sees a document that is kept.
	if st.ModTime().After(expiresAt) {
		return false, s.saveState(doc, t)
	}
	return s.moveToTrash(doc, path.Join(trash, doc), t)
}

// moveToTrash moves a document to its place in the trash, with the state t,
// which has no expiry: a document that a person takes back from the trash
// then stays. It reports whether the document went. The caller holds s.mu.
func (s *localDocs) moveToTrash(doc, to string, t localState) (bool, error) {
	if err := s.makeTrash(path.Dir(to)); err != nil {
		return false, err
	}
	// A state that holds nothing needs no file.
	state, trashedState := sidecarPath(doc), sidecarPath(to)
	if !t.empty() {
		b, err := json.MarshalIndent(t, "", "  ")
		if err == nil {
			err = s.write(trashedState, append(b, '\n'))
		}
		if err != nil {
			s.removeEmptyTrash(path.Dir(to))
			return false, err
		}
	}
	// The document goes before its old state file. If the move fails, the
	// document still has its expiry, and the next sweep tries again.
	if err := s.root.Rename(doc, to); err != nil {
		_ = s.root.Remove(trashedState)
		s.removeEmptyTrash(path.Dir(to))
		return false, err
	}
	if err := s.root.Remove(state); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return true, err
	}
	return true, nil
}

// makeTrash makes a folder of the trash. The trash must be a folder of the
// documents folder: a link in its place could send the documents to a
// folder that is listed.
func (s *localDocs) makeTrash(dir string) error {
	if st, err := s.root.Lstat(localTrash); err == nil && !st.IsDir() {
		return fmt.Errorf("%s is not a folder, so the expired documents stay", localTrash)
	}
	return s.root.MkdirAll(dir, configDirPerm)
}

// removeEmptyTrash removes dir and the folders above it in the trash that
// are empty, after a move that failed.
func (s *localDocs) removeEmptyTrash(dir string) {
	for ; dir != localTrash && strings.HasPrefix(dir, localTrash+"/"); dir = path.Dir(dir) {
		if s.root.Remove(dir) != nil {
			return
		}
	}
}
