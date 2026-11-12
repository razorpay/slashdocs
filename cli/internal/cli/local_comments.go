package cli

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/user"
	"path"
	"slices"
	"strings"
	"sync"
	"time"
)

// The state of a local document is in a hidden sidecar file next to it: the
// state of specs/api.html is in specs/.api.html.slashdocs.json. It keeps the
// title that overrides the <title> of the HTML, and the comments. All state
// stays in the documents folder, so git and other tools see a document and
// its state together. An agent can read and write the file without the
// server. The file uses the fields of the slashdocs API, and `slashdocs local`
// serves the comment routes of that API, so the app uses one client for both.

type localPrincipal struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name,omitzero"`
}

func (p localPrincipal) is(q localPrincipal) bool { return p.Type == q.Type && p.ID == q.ID }

// currentLocalPrincipal is the author of the comments that the app writes.
func currentLocalPrincipal() localPrincipal {
	u, err := user.Current()
	if err != nil {
		return localPrincipal{Type: "user", ID: "local"}
	}
	return localPrincipal{Type: "user", ID: u.Username, Name: first(u.Name, u.Username)}
}

type localAnchor struct {
	Quote       string `json:"quote"`
	Prefix      string `json:"prefix,omitzero"`
	Suffix      string `json:"suffix,omitzero"`
	DOMPath     string `json:"dom_path,omitzero"`
	StartOffset int    `json:"start_offset,omitzero"`
	EndOffset   int    `json:"end_offset,omitzero"`
}

// localReaction keeps who reacted. Count and Reacted change with the viewer,
// so the sidecar file does not keep them.
type localReaction struct {
	Emoji    string           `json:"emoji"`
	Count    int              `json:"count,omitzero"`
	Reacted  bool             `json:"reacted,omitzero"`
	Reactors []localPrincipal `json:"reactors"`
}

// localComment is a thread, or a reply when it is in Replies. Only threads
// have an anchor and a status.
type localComment struct {
	ID         string          `json:"id"`
	Author     localPrincipal  `json:"author"`
	Body       string          `json:"body"`
	Anchor     *localAnchor    `json:"anchor,omitzero"`
	Status     string          `json:"status,omitzero"`
	Version    string          `json:"created_on_version_id,omitzero"`
	CreatedAt  time.Time       `json:"created_at"`
	ResolvedAt time.Time       `json:"resolved_at,omitzero"`
	Edited     bool            `json:"edited,omitzero"`
	Reactions  []localReaction `json:"reactions,omitzero"`
	Replies    []*localComment `json:"replies,omitzero"`
}

type localState struct {
	Title    string          `json:"title,omitzero"`
	Comments []*localComment `json:"comments"`
}

// find returns the comment with the ID, and the list that holds it.
func (t *localState) find(id string) (*localComment, *[]*localComment) {
	for _, c := range t.Comments {
		if c.ID == id {
			return c, &t.Comments
		}
		for _, r := range c.Replies {
			if r.ID == id {
				return r, &c.Replies
			}
		}
	}
	return nil, nil
}

// localReactions is the closed set of the server.
var localReactions = []string{"+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes", "plus"}

type localError struct {
	status  int
	message string
}

func (e localError) Error() string { return e.message }

var (
	errLocalDocNotFound     = localError{http.StatusNotFound, "document not found"}
	errLocalCommentNotFound = localError{http.StatusNotFound, "comment not found"}
	errLocalEmptyBody       = localError{http.StatusBadRequest, "comment body cannot be empty"}
)

// writeLocalError writes the error shape of the slashdocs API.
func writeLocalError(w http.ResponseWriter, err error) {
	le := localError{http.StatusInternalServerError, err.Error()}
	errors.As(err, &le)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(le.status)
	_ = json.NewEncoder(w).Encode(map[string]map[string]string{"error": {"message": le.message}})
}

func isLocalDoc(docs fs.FS, p string) bool {
	st, err := fs.Stat(docs, first(p, "."))
	return err == nil && st.Mode().IsRegular() && isHTML(p) && !isHidden(p)
}

// isHidden reports whether a name in the path starts with a dot. Hidden
// files, such as state files and .git, are not documents.
func isHidden(p string) bool {
	return slices.ContainsFunc(strings.Split(p, "/"), func(name string) bool { return strings.HasPrefix(name, ".") })
}

// localDocs serves the document and comment routes of the slashdocs API on
// the documents folder.
type localDocs struct {
	root *os.Root
	me   localPrincipal
	url  string     // the origin of the app, for links
	mu   sync.Mutex // serializes the changes of documents and sidecar files
}

func (s *localDocs) registerComments(mux *http.ServeMux) {
	const comment = "/v1/documents/{id}/comments/{comment}"
	mux.HandleFunc("GET /v1/documents/{id}/comments", s.handle(s.list))
	mux.HandleFunc("POST /v1/documents/{id}/comments", s.handle(s.create))
	mux.HandleFunc("POST "+comment+"/replies", s.handle(s.reply))
	mux.HandleFunc("PATCH "+comment, s.handle(s.patch))
	mux.HandleFunc("DELETE "+comment, s.handle(s.delete))
	mux.HandleFunc("PUT "+comment+"/reactions/{emoji}", s.handle(s.react))
	mux.HandleFunc("DELETE "+comment+"/reactions/{emoji}", s.handle(s.react))
}

// respond writes the result of fn. A nil result has no content.
func respond(fn func(r *http.Request) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch v, err := fn(r); {
		case err != nil:
			writeLocalError(w, err)
		case v == nil:
			w.WriteHeader(http.StatusNoContent)
		default:
			writeLocalJSON(w, v)
		}
	}
}

// handle gives fn the document of the request.
func (s *localDocs) handle(fn func(r *http.Request, doc string) (any, error)) http.HandlerFunc {
	return respond(func(r *http.Request) (any, error) {
		doc := cleanLocal(r.PathValue("id"))
		if !isLocalDoc(s.root.FS(), doc) {
			return nil, errLocalDocNotFound
		}
		return fn(r, doc)
	})
}

func (s *localDocs) list(r *http.Request, doc string) (any, error) {
	t, err := readLocalState(s.root.FS(), doc)
	if err != nil {
		return nil, err
	}
	if status := r.URL.Query().Get("status"); status != "" {
		t.Comments = slices.DeleteFunc(t.Comments, func(c *localComment) bool { return c.Status != status })
	}
	return map[string][]*localComment{"items": s.view(t.Comments...)}, nil
}

func (s *localDocs) create(r *http.Request, doc string) (any, error) {
	var in struct {
		VersionID string       `json:"version_id"`
		Body      string       `json:"body"`
		Anchor    *localAnchor `json:"anchor"`
	}
	if err := decodeLocal(r, &in); err != nil {
		return nil, err
	}
	if in.Anchor == nil || in.Anchor.Quote == "" {
		return nil, localError{http.StatusBadRequest, "comment anchor needs a quote"}
	}
	c, err := s.newComment(in.Body)
	if err != nil {
		return nil, err
	}
	c.Anchor, c.Status, c.Version = in.Anchor, "open", in.VersionID
	return c, s.update(doc, func(t *localState) error {
		t.Comments = append(t.Comments, c)
		return nil
	})
}

func (s *localDocs) reply(r *http.Request, doc string) (any, error) {
	var in struct {
		Body string `json:"body"`
	}
	if err := decodeLocal(r, &in); err != nil {
		return nil, err
	}
	c, err := s.newComment(in.Body)
	if err != nil {
		return nil, err
	}
	return c, s.update(doc, func(t *localState) error {
		// Replies go to threads, not to other replies.
		thread, list := t.find(r.PathValue("comment"))
		if thread == nil || list != &t.Comments {
			return errLocalCommentNotFound
		}
		thread.Replies = append(thread.Replies, c)
		return nil
	})
}

func (s *localDocs) patch(r *http.Request, doc string) (any, error) {
	var in struct {
		Body   *string `json:"body"`
		Status string  `json:"status"`
	}
	if err := decodeLocal(r, &in); err != nil {
		return nil, err
	}
	if in.Body != nil && strings.TrimSpace(*in.Body) == "" {
		return nil, errLocalEmptyBody
	}
	var c *localComment
	err := s.update(doc, func(t *localState) error {
		if c, _ = t.find(r.PathValue("comment")); c == nil {
			return errLocalCommentNotFound
		}
		if in.Body != nil && c.Body != *in.Body {
			c.Body, c.Edited = *in.Body, true
		}
		switch {
		case in.Status == "":
		case c.Status == "":
			return localError{http.StatusBadRequest, "a reply has no status"}
		case in.Status == "open":
			c.Status, c.ResolvedAt = in.Status, time.Time{}
		case in.Status == "resolved":
			c.Status, c.ResolvedAt = in.Status, time.Now().UTC()
		default:
			return localError{http.StatusBadRequest, "invalid comment status"}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.view(c)[0], nil
}

func (s *localDocs) delete(r *http.Request, doc string) (any, error) {
	return nil, s.update(doc, func(t *localState) error {
		c, list := t.find(r.PathValue("comment"))
		if c == nil {
			return errLocalCommentNotFound
		}
		*list = slices.DeleteFunc(*list, func(x *localComment) bool { return x == c })
		return nil
	})
}

func (s *localDocs) react(r *http.Request, doc string) (any, error) {
	emoji := r.PathValue("emoji")
	if !slices.Contains(localReactions, emoji) {
		return nil, localError{http.StatusBadRequest, "unsupported reaction"}
	}
	return nil, s.update(doc, func(t *localState) error {
		c, _ := t.find(r.PathValue("comment"))
		if c == nil {
			return errLocalCommentNotFound
		}
		i := slices.IndexFunc(c.Reactions, func(x localReaction) bool { return x.Emoji == emoji })
		if i < 0 {
			c.Reactions, i = append(c.Reactions, localReaction{Emoji: emoji}), len(c.Reactions)
		}
		reactors := slices.DeleteFunc(c.Reactions[i].Reactors, s.me.is)
		if r.Method == http.MethodPut {
			reactors = append(reactors, s.me)
		}
		c.Reactions[i].Reactors = reactors
		c.Reactions = slices.DeleteFunc(c.Reactions, func(x localReaction) bool { return len(x.Reactors) == 0 })
		return nil
	})
}

func (s *localDocs) newComment(body string) (*localComment, error) {
	if strings.TrimSpace(body) == "" {
		return nil, errLocalEmptyBody
	}
	return &localComment{ID: rand.Text(), Author: s.me, Body: body, CreatedAt: time.Now().UTC()}, nil
}

// view fills the reaction fields that depend on the viewer.
func (s *localDocs) view(comments ...*localComment) []*localComment {
	for _, c := range comments {
		for i, r := range c.Reactions {
			c.Reactions[i].Count, c.Reactions[i].Reacted = len(r.Reactors), slices.ContainsFunc(r.Reactors, s.me.is)
		}
		s.view(c.Replies...)
	}
	return comments
}

func sidecarPath(doc string) string {
	return path.Join(path.Dir(doc), "."+path.Base(doc)+".slashdocs.json")
}

func readLocalState(docs fs.FS, doc string) (localState, error) {
	t := localState{Comments: []*localComment{}}
	b, err := fs.ReadFile(docs, sidecarPath(doc))
	if errors.Is(err, fs.ErrNotExist) {
		return t, nil
	}
	if err != nil {
		return t, err
	}
	// A person or an agent can edit the file, so it can be wrong.
	if err := json.Unmarshal(b, &t); err != nil {
		return t, fmt.Errorf("%s is not valid JSON: %w", sidecarPath(doc), err)
	}
	if !validComments(t.Comments) {
		return t, fmt.Errorf("%s has an empty comment", sidecarPath(doc))
	}
	if t.Comments == nil {
		t.Comments = []*localComment{}
	}
	return t, nil
}

func validComments(comments []*localComment) bool {
	return !slices.ContainsFunc(comments, func(c *localComment) bool { return c == nil || !validComments(c.Replies) })
}

// update changes the state of a document and saves it. A document without
// state has no sidecar file.
func (s *localDocs) update(doc string, change func(*localState) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, err := readLocalState(s.root.FS(), doc)
	if err != nil {
		return err
	}
	if err := change(&t); err != nil {
		return err
	}
	if t.Title == "" && len(t.Comments) == 0 {
		if err := s.root.Remove(sidecarPath(doc)); !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	b, err := json.MarshalIndent(t, "", "  ")
	if err != nil {
		return err
	}
	return s.write(sidecarPath(doc), append(b, '\n'))
}

// write replaces a file with a new temporary file, so a crash cannot leave
// half a file. The temporary file has a new random name, so it cannot be a
// link to another file. The file keeps its mode.
func (s *localDocs) write(name string, b []byte) error {
	mode := pulledFilePerm
	if st, err := s.root.Stat(name); err == nil {
		mode = st.Mode().Perm()
	}
	tmp := name + "." + rand.Text() + ".tmp"
	f, err := s.root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	if err = errors.Join(err, f.Chmod(mode), f.Close()); err == nil {
		err = s.root.Rename(tmp, name)
	}
	if err != nil {
		_ = s.root.Remove(tmp)
	}
	return err
}

func decodeLocal(r *http.Request, v any) error {
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v); err != nil {
		return localError{http.StatusBadRequest, "invalid JSON: " + err.Error()}
	}
	return nil
}
