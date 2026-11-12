package cli

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"slices"
	"strings"
	"time"

	docrender "github.com/razorpay/slashdocs/internal/render"
)

// Local documents are the HTML files of the documents folder. The ID of a
// document is its path. A document has one version, its current content,
// and git keeps the history. `slashdocs local` serves the document routes of
// the slashdocs API on these files, so `slashdocs docs` commands work with
// the local server as their context.

type localDocument struct {
	ID               string         `json:"id"`
	Title            string         `json:"title"`
	Owner            localPrincipal `json:"owner"`
	CurrentVersionID string         `json:"current_version_id"`
	ParentFolderID   string         `json:"parent_folder_id,omitzero"`
	UpdatedAt        time.Time      `json:"updated_at"`
}

// localMaxHTML is the limit of the server.
const localMaxHTML = 50 << 20

var errLocalOldVersion = localError{http.StatusNotFound, "slashdocs local keeps only the current version of a document: use git for older versions"}

func (s *localDocs) registerDocuments(mux *http.ServeMux) {
	const doc = "/v1/documents/{id}"
	mux.HandleFunc("GET /v1/documents", respond(s.listDocuments))
	mux.HandleFunc("POST /v1/documents", respond(s.createDocument))
	mux.HandleFunc("GET "+doc, s.handle(func(_ *http.Request, doc string) (any, error) { return s.document(doc) }))
	mux.HandleFunc("PATCH "+doc, s.handle(s.rename))
	mux.HandleFunc("DELETE "+doc, s.handle(s.deleteDocument))
	mux.HandleFunc("POST "+doc+"/versions", s.handle(s.push))
	mux.HandleFunc("GET "+doc+"/versions/{version}/html", s.html)
	mux.HandleFunc("GET "+doc+"/headings", s.handle(s.headings))
	mux.HandleFunc("GET "+doc+"/link", s.handle(s.link))
	// A folder ID is the path of the folder.
	mux.HandleFunc("POST /v1/folders/{folder}/documents", respond(s.moveToFolder))
	mux.HandleFunc("DELETE /v1/folders/{folder}/documents/{id}", s.handle(s.moveToRoot))
}

func (s *localDocs) document(doc string) (localDocument, error) {
	st, err := s.root.Stat(doc)
	if err != nil {
		return localDocument{}, err
	}
	b, err := s.root.ReadFile(doc)
	parent := path.Dir(doc)
	if parent == "." {
		parent = ""
	}
	return localDocument{ID: doc, Title: docTitle(s.root.FS(), doc), Owner: s.me, CurrentVersionID: localVersion(b), ParentFolderID: parent, UpdatedAt: st.ModTime().UTC()}, err
}

// listDocuments returns the documents with the most recent change first. A query
// keeps the documents that have each of its words in the title or the path.
func (s *localDocs) listDocuments(r *http.Request) (any, error) {
	words := strings.Fields(strings.ToLower(r.URL.Query().Get("q")))
	items := []localDocument{}
	err := fs.WalkDir(s.root.FS(), ".", func(p string, de fs.DirEntry, err error) error {
		switch {
		case err != nil:
			return err
		case p != "." && strings.HasPrefix(de.Name(), "."):
			if de.IsDir() {
				return fs.SkipDir
			}
			return nil
		case de.IsDir() || !isHTML(p):
			return nil
		}
		d, err := s.document(p)
		text := strings.ToLower(d.Title + " " + d.ID)
		// A file that cannot be read, such as a link out of the folder, is
		// not listed.
		if err == nil && !slices.ContainsFunc(words, func(w string) bool { return !strings.Contains(text, w) }) {
			items = append(items, d)
		}
		return nil
	})
	slices.SortFunc(items, func(a, b localDocument) int { return b.UpdatedAt.Compare(a.UpdatedAt) })
	return map[string][]localDocument{"items": items}, err
}

// createDocument writes the file in the documents folder with the name of the
// uploaded file. The CLI sends the file name as the title when the user gives
// none, so only another title overrides the <title> of the HTML.
func (s *localDocs) createDocument(r *http.Request) (any, error) {
	b, name, err := readLocalUpload(r)
	if err != nil {
		return nil, err
	}
	doc := path.Base(cleanLocal(name))
	if !isHTML(doc) || strings.HasPrefix(doc, ".") {
		return nil, localError{http.StatusBadRequest, "the file name must end in .html"}
	}
	if err := s.free(doc); err != nil {
		return nil, err
	}
	f, err := s.root.OpenFile(doc, os.O_WRONLY|os.O_CREATE|os.O_EXCL, pulledFilePerm)
	if err != nil {
		return nil, err
	}
	_, err = f.Write(b)
	if err = errors.Join(err, f.Close()); err == nil && r.FormValue("title") != name {
		err = s.setTitle(doc, r.FormValue("title"))
	}
	return map[string]string{"id": doc, "current_version_id": localVersion(b)}, err
}

// rename sets the title of a document. An empty title removes the override.
func (s *localDocs) rename(r *http.Request, doc string) (any, error) {
	var in struct {
		Title string `json:"title"`
	}
	if err := decodeLocal(r, &in); err != nil {
		return nil, err
	}
	if err := s.setTitle(doc, in.Title); err != nil {
		return nil, err
	}
	return s.document(doc)
}

func (s *localDocs) setTitle(doc, title string) error {
	return s.update(doc, func(t *localState) error {
		t.Title = strings.Join(strings.Fields(title), " ")
		return nil
	})
}

// push replaces the document if base_version_id is its current version.
func (s *localDocs) push(r *http.Request, doc string) (any, error) {
	b, _, err := readLocalUpload(r)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.root.ReadFile(doc)
	if err != nil {
		return nil, err
	}
	if v := localVersion(current); r.FormValue("base_version_id") != v {
		return nil, localError{http.StatusConflict, "base_version_id is stale: the current version is " + v}
	}
	sum := sha256.Sum256(b)
	return map[string]string{"id": localVersion(b), "sha256": hex.EncodeToString(sum[:])}, s.write(doc, b)
}

// html sends the document as a download, as the server does, because it is
// not safe to run on the origin of the app.
func (s *localDocs) html(w http.ResponseWriter, r *http.Request) {
	b, err := s.readVersion(cleanLocal(r.PathValue("id")), r.PathValue("version"))
	if err != nil {
		writeLocalError(w, err)
		return
	}
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "attachment")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	//nolint:gosec // G705: the CSP sandbox and the attachment stop the document from running here.
	_, _ = w.Write(b)
}

// deleteDocument removes the document and its comments.
func (s *localDocs) deleteDocument(_ *http.Request, doc string) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.root.Remove(sidecarPath(doc)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return nil, s.root.Remove(doc)
}

func (s *localDocs) headings(r *http.Request, doc string) (any, error) {
	b, err := s.readVersion(doc, r.URL.Query().Get("version"))
	if err != nil {
		return nil, err
	}
	headings, err := docrender.Headings(b)
	type heading struct {
		docrender.Heading
		URL string `json:"url"`
	}
	items := make([]heading, len(headings))
	for i, h := range headings {
		items[i] = heading{h, s.docURL(doc, nil, h.ID)}
	}
	return map[string][]heading{"items": items}, err
}

func (s *localDocs) link(r *http.Request, doc string) (any, error) {
	q := r.URL.Query()
	comment, heading, version := q.Get("comment"), q.Get("heading"), q.Get("version")
	if comment != "" && (heading != "" || version != "") {
		return nil, localError{http.StatusBadRequest, "choose a comment, or a heading and optional version"}
	}
	if _, err := s.readVersion(doc, version); err != nil {
		return nil, err
	}
	link := url.Values{}
	if comment != "" {
		t, err := readLocalState(s.root.FS(), doc)
		if err != nil {
			return nil, err
		}
		if c, _ := t.find(comment); c == nil {
			return nil, errLocalCommentNotFound
		}
		link.Set("comment", comment)
	}
	return map[string]string{"url": s.docURL(doc, link, heading)}, nil
}

func (s *localDocs) moveToFolder(r *http.Request) (any, error) {
	var in struct {
		DocumentID string `json:"document_id"`
	}
	if err := decodeLocal(r, &in); err != nil {
		return nil, err
	}
	doc := cleanLocal(in.DocumentID)
	if !isLocalDoc(s.root.FS(), doc) {
		return nil, errLocalDocNotFound
	}
	to := path.Join(cleanLocal(r.PathValue("folder")), path.Base(doc))
	if isHidden(to) {
		return nil, localError{http.StatusBadRequest, "a folder that starts with a dot is hidden, so it cannot keep documents"}
	}
	return s.move(doc, to)
}

func (s *localDocs) moveToRoot(r *http.Request, doc string) (any, error) {
	if path.Dir(doc) != cleanLocal(r.PathValue("folder")) {
		return nil, localError{http.StatusNotFound, "the document is not in this folder"}
	}
	return s.move(doc, path.Base(doc))
}

// move moves a document and its comments. The path is the ID, so the ID
// changes.
func (s *localDocs) move(doc, to string) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.free(to); err != nil {
		return nil, err
	}
	if err := s.root.MkdirAll(path.Dir(to), configDirPerm); err != nil {
		return nil, err
	}
	if err := s.root.Rename(doc, to); err != nil {
		return nil, err
	}
	if err := s.root.Rename(sidecarPath(doc), sidecarPath(to)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	return s.document(to)
}

// free makes sure that a new document at doc does not replace a document,
// or take the comments of a document that was there before.
func (s *localDocs) free(doc string) error {
	for _, p := range []string{doc, sidecarPath(doc)} {
		if _, err := s.root.Lstat(p); err == nil {
			return localError{http.StatusConflict, p + " already exists"}
		}
	}
	return nil
}

// readVersion returns the document if version is empty or the current
// version.
func (s *localDocs) readVersion(doc, version string) ([]byte, error) {
	if !isLocalDoc(s.root.FS(), doc) {
		return nil, errLocalDocNotFound
	}
	b, err := s.root.ReadFile(doc)
	if err == nil && version != "" && version != localVersion(b) {
		return nil, errLocalOldVersion
	}
	return b, err
}

// docURL is the address of a document in the app.
func (s *localDocs) docURL(doc string, query url.Values, fragment string) string {
	return s.url + (&url.URL{Path: "/" + doc, RawQuery: query.Encode(), Fragment: fragment}).String()
}

// localVersion names the content of a document, so the app shows each change.
func localVersion(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}

// readLocalUpload reads the HTML file of a multipart request.
func readLocalUpload(r *http.Request) ([]byte, string, error) {
	r.Body = http.MaxBytesReader(nil, r.Body, localMaxHTML)
	f, h, err := r.FormFile("file")
	if tooLarge := new(http.MaxBytesError); errors.As(err, &tooLarge) {
		return nil, "", localError{http.StatusRequestEntityTooLarge, "the HTML file is larger than 50 MiB"}
	}
	if err != nil {
		return nil, "", localError{http.StatusBadRequest, "file is required"}
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(f)
	return b, h.Filename, err
}
