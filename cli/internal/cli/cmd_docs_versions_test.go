package cli

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sumOf returns the sha256 of b, as the server gives it.
func sumOf(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// pushedFile returns the file of a push that a test server got.
func pushedFile(t *testing.T, r *http.Request) []byte {
	t.Helper()
	requireMultipart(t, r)
	f, _, err := r.FormFile("file")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// baseOfFile returns the recorded base of file, as version@seq.
func baseOfFile(t *testing.T, file string) string {
	t.Helper()
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	base := cfg.Contexts[cfg.ActiveContext].Bases[file]
	return base.VersionID + "@" + base.Seq
}

func TestCreateAndPushRecordBaseVersion(t *testing.T) {
	for _, output := range []string{"--quiet", "--json", ""} {
		t.Run(output, func(t *testing.T) {
			version := 1
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/documents":
					requireMultipart(t, r)
					writeTestJSON(t, w, map[string]any{"id": "doc_new", "current_version_id": "ver_1"})
				case "/v1/documents/doc_new/versions":
					requireMultipart(t, r)
					if got := r.FormValue("base_version_id"); got != fmt.Sprintf("ver_%d", version) {
						w.WriteHeader(http.StatusConflict)
						writeTestJSON(t, w, map[string]any{"error": map[string]string{"code": "version_conflict"}})
						return
					}
					version++
					writeTestJSON(t, w, map[string]any{"id": fmt.Sprintf("ver_%d", version), "number": version, "sha256": sumOf(pushedFile(t, r))})
				case "/v1/config":
					writeTestJSON(t, w, map[string]string{"deployment": "personal"})
				case "/version.json":
					writeTestJSON(t, w, map[string]string{"version": "dev"})
				default:
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()
			t.Setenv("SLASHDOCS_SERVER", srv.URL)
			t.Setenv("SLASHDOCS_TOKEN", "tok")
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			file := filepath.Join(t.TempDir(), "doc.html")
			writeTestFile(t, file, []byte("<p>test</p>"))
			for _, args := range [][]string{{"docs", "create", file}, {"docs", "push", "doc_new", file}, {"docs", "push", "doc_new", file}} {
				if output != "" {
					args = append([]string{output}, args...)
				}
				if _, err := Execute(args); err != nil {
					t.Fatalf("%v: %v", args, err)
				}
			}
			version++ // Another writer creates a version.
			if _, err := Execute([]string{"docs", "push", "doc_new", file}); err == nil || !strings.Contains(err.Error(), "version_conflict") {
				t.Fatalf("concurrent edit did not return a version conflict: %v", err)
			}
			cfg, err := loadConfig()
			if err != nil {
				t.Fatal(err)
			}
			if got := cfg.Contexts[cfg.ActiveContext].Pulled["doc_new"]; got != "ver_3" {
				t.Fatalf("base version = %q, want ver_3", got)
			}
		})
	}
}

// A pull records the version and the seq of its HTML, and a push sends both.
// After a push that the server merged with the edits of other people, the
// file gets the saved version, so that the next push does not take their
// edits out.
func TestPushSendsTheSeqOfThePullAndTakesTheMergedVersion(t *testing.T) {
	const pulled, merged = "<p>pulled</p>", "<p>mine and theirs</p>"
	var bases []string
	rebased := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/documents/doc_1":
			writeTestJSON(t, w, map[string]any{"id": "doc_1", "current_version_id": "ver_open"})
		case "/v1/documents/doc_1/versions/ver_open/html":
			w.Header().Set("X-Slashdocs-Seq", "41")
			_, _ = w.Write([]byte(pulled))
		case "/v1/documents/doc_1/versions/ver_merged/html":
			w.Header().Set("X-Slashdocs-Seq", "44")
			_, _ = w.Write([]byte(merged))
		case "/v1/documents/doc_1/versions":
			requireMultipart(t, r)
			bases = append(bases, r.FormValue("base_version_id")+"@"+r.FormValue("base_seq"))
			refuse := func(status int, code string, details map[string]any) {
				w.WriteHeader(status)
				writeTestJSON(t, w, map[string]any{"error": map[string]any{"code": code, "message": "server text", "details": details}})
			}
			switch r.FormValue("base_version_id") {
			case "ver_conflict":
				refuse(http.StatusConflict, "version_conflict", map[string]any{"current_version_id": "ver_merged", "seq": 44, "text": "TTL of 10 minutes"})
				return
			case "ver_point":
				refuse(http.StatusConflict, "version_conflict", map[string]any{"current_version_id": "ver_merged", "seq": 44})
				return
			case "ver_wrong":
				refuse(http.StatusUnprocessableEntity, "base_version_not_found", nil)
				return
			case "ver_typing":
				refuse(http.StatusConflict, "stale", nil)
				return
			case "ver_same":
				writeTestJSON(t, w, map[string]any{"id": "ver_same", "number": 3, "seq": 50, "unchanged": true, "sha256": sumOf(pushedFile(t, r))})
				return
			}
			saved := []byte(merged)
			if !rebased {
				saved = pushedFile(t, r)
			}
			writeTestJSON(t, w, map[string]any{"id": "ver_merged", "number": 3, "rebased": rebased, "seq": 44, "sha256": sumOf(saved)})
		case "/v1/config":
			writeTestJSON(t, w, map[string]string{"deployment": "personal"})
		case "/version.json":
			writeTestJSON(t, w, map[string]string{"version": "dev"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	file := filepath.Join(t.TempDir(), "doc.html")
	base := func() string { return baseOfFile(t, file) }

	if _, err := Execute([]string{"docs", "pull", "doc_1", "--out", file}); err != nil {
		t.Fatal(err)
	}
	if got := base(); got != "ver_open@41" {
		t.Fatalf("base after the pull = %q, want ver_open@41", got)
	}
	writeTestFile(t, file, []byte("<p>mine</p>"))
	out, err := Execute([]string{"docs", "push", "doc_1", file})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Other people edited this document while you worked. Your file now has their edits too.") {
		t.Fatalf("output = %q, want the line about the edits of other people", out)
	}
	if got := string(readTestFile(t, file)); got != merged || bases[0] != "ver_open@41" || base() != "ver_merged@44" {
		t.Fatalf("file = %q, push base %q, new base %q; want the merged version, ver_open@41, ver_merged@44", got, bases[0], base())
	}

	// With --json the file is written too, and the payload says so.
	writeTestFile(t, file, []byte("<p>mine again</p>"))
	if out, err = Execute([]string{"--json", "docs", "push", "doc_1", file}); err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(out), &payload); err != nil || payload["rebased"] != true || payload["file_updated"] != true || string(readTestFile(t, file)) != merged {
		t.Fatalf("payload = %s, %v; want rebased and file_updated", out, err)
	}

	// A push with nothing after its base leaves the file as it is.
	rebased = false
	writeTestFile(t, file, []byte("<p>exact</p>"))
	if out, err = Execute([]string{"docs", "push", "doc_1", file}); err != nil || strings.Contains(out, "Other people") || string(readTestFile(t, file)) != "<p>exact</p>" {
		t.Fatalf("output = %q, %v, file = %q; want the file as pushed", out, err, string(readTestFile(t, file)))
	}

	// A base version from a flag has no seq of a pull. Each refused push
	// tells the person what is true and what to do: the line ends with the
	// command that writes the file, not with the code or the ids of the
	// server.
	again := " Run slashdocs docs pull doc_1 --out " + file + " to get the document as it is now, then make your change again."
	const want = `Other people changed the same text, in "TTL of 10 minutes", and their text stays.`
	for base, want := range map[string]string{
		"ver_conflict": want + again,
		"ver_point":    "Other people changed the same text, and their text stays." + again,
		"ver_wrong":    "ver_wrong is not a version of this document." + again,
		"ver_typing":   "People are editing this document, and slashdocs does not know which state of it this file holds. Run slashdocs docs pull doc_1 --out " + latestFile(file) + ", make your change in that file, and push that file without --base-version.",
	} {
		_, err = Execute([]string{"docs", "push", "doc_1", file, "--base-version", base})
		if err == nil || err.Error() != want {
			t.Errorf("push on %s = %v, want %q", base, err, want)
		}
	}
	_, err = Execute([]string{"docs", "push", "doc_1", file, "--base-version", "ver_conflict"})
	if got := bases[len(bases)-1]; err == nil || got != "ver_conflict@" || base() != "ver_merged@44" {
		t.Fatalf("push base %q, base after the conflict %q; want ver_conflict@ and the base before", got, base())
	}
	// The pulled version by name is the pulled version: its seq goes too.
	if _, err = Execute([]string{"docs", "push", "doc_1", file, "--base-version", "ver_merged"}); err != nil || bases[len(bases)-1] != "ver_merged@44" {
		t.Fatalf("push base %q, %v; want ver_merged@44", bases[len(bases)-1], err)
	}
	// With --json the payload has the same message, and keeps the code.
	var buf bytes.Buffer
	if err := Run(&buf, []string{"--json", "docs", "push", "doc_1", file, "--base-version", "ver_conflict"}); err == nil || !strings.HasSuffix(err.Error(), want+again) {
		t.Fatalf("--json conflict = %v, want %q", err, want+again)
	}
	var refused struct {
		Error struct{ Code, Message string }
	}
	if err := json.Unmarshal(buf.Bytes(), &refused); err != nil || refused.Error.Code != "version_conflict" || refused.Error.Message != want+again {
		t.Fatalf("--json output = %s, %v; want version_conflict with %q", buf.String(), err, want+again)
	}

	// A file that is the document makes no version. The answer has the hash
	// of the file, so the file is the document at the seq of the answer.
	out, err = Execute([]string{"docs", "push", "doc_1", file, "--base-version", "ver_same"})
	if err != nil || out != "Nothing changed.\n" || base() != "ver_same@50" {
		t.Fatalf("output = %q, %v, base %q; want only that nothing changed, and ver_same@50", out, err, base())
	}
	if out, err = Execute([]string{"--json", "docs", "push", "doc_1", file, "--base-version", "ver_same"}); err != nil || !strings.Contains(out, `"unchanged": true`) {
		t.Fatalf("--json output = %q, %v; want the unchanged field", out, err)
	}
}

// The server merged and saved the push, and then the read of the saved
// version fails. The push is done, so the command does not fail: it tells
// the author to pull.
func TestMergedPushSucceedsWhenTheSavedVersionCannotBeRead(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/documents/doc_1/versions/ver_merged/html":
			w.WriteHeader(http.StatusBadGateway)
		case "/v1/documents/doc_1/versions":
			writeTestJSON(t, w, map[string]any{"id": "ver_merged", "number": 3, "rebased": true, "seq": 44})
		case "/v1/config":
			writeTestJSON(t, w, map[string]string{"deployment": "personal"})
		case "/version.json":
			writeTestJSON(t, w, map[string]string{"version": "dev"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	file := filepath.Join(t.TempDir(), "doc.html")
	writeTestFile(t, file, []byte("<p>mine</p>"))
	out, err := Execute([]string{"docs", "push", "doc_1", file, "--base-version", "ver_1"})
	if err != nil {
		t.Fatalf("push = %v, want no error: the push is saved", err)
	}
	if !strings.Contains(out, "Your change is in the document: ") || !strings.Contains(out, "Run slashdocs docs pull doc_1 --out "+latestFile(file)+", and make your next changes in that file.") || string(readTestFile(t, file)) != "<p>mine</p>" {
		t.Fatalf("output = %q, file = %q; want the pull line and the file of the person", out, string(readTestFile(t, file)))
	}
	// The file is not the saved version, so it is not the base of a push.
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cx := cfg.Contexts[cfg.ActiveContext]; cx != nil && cx.Pulled["doc_1"] != "" {
		t.Fatalf("base = %q, want none", cx.Pulled["doc_1"])
	}
}

// The file changed on disk while the push was on its way, so the CLI does
// not write over it, and keeps the base of the file.
func TestMergedPushDoesNotWriteOverAFileThatChanged(t *testing.T) {
	file := filepath.Join(t.TempDir(), "doc.html")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/documents/doc_1/versions/ver_merged/html":
			_, _ = w.Write([]byte("<p>merged</p>"))
		case "/v1/documents/doc_1/versions":
			// The person saves the file again during the push.
			writeTestFile(t, file, []byte("<p>newer</p>"))
			writeTestJSON(t, w, map[string]any{"id": "ver_merged", "number": 3, "rebased": true, "seq": 44})
		case "/v1/config":
			writeTestJSON(t, w, map[string]string{"deployment": "personal"})
		case "/version.json":
			writeTestJSON(t, w, map[string]string{"version": "dev"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	writeTestFile(t, file, []byte("<p>mine</p>"))
	out, err := Execute([]string{"docs", "push", "doc_1", file, "--base-version", "ver_1"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Other people edited this document while you worked, and your file does not have their edits. Run slashdocs docs pull doc_1 --out "+latestFile(file)+", and make your next changes in that file.") || string(readTestFile(t, file)) != "<p>newer</p>" {
		t.Fatalf("output = %q, file = %q; want the pull line and the file of the person", out, string(readTestFile(t, file)))
	}
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cx := cfg.Contexts[cfg.ActiveContext]; cx != nil && cx.Pulled["doc_1"] != "" {
		t.Fatalf("base = %q, want none recorded", cx.Pulled["doc_1"])
	}
}

// The server merged and saved the push, and the CLI cannot write the saved
// version to the file. The push is done, so the command does not fail: it
// says that the push is saved, and tells the author to pull. The file is not
// the saved version, so that version is not recorded as its base.
func TestMergedPushSucceedsWhenTheFileCannotBeWritten(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/documents/doc_1/versions/ver_merged/html":
			_, _ = w.Write([]byte("<p>merged</p>"))
		case "/v1/documents/doc_1/versions":
			writeTestJSON(t, w, map[string]any{"id": "ver_merged", "number": 3, "rebased": true, "seq": 44})
		case "/v1/config":
			writeTestJSON(t, w, map[string]string{"deployment": "personal"})
		case "/version.json":
			writeTestJSON(t, w, map[string]string{"version": "dev"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	file := filepath.Join(t.TempDir(), "doc.html")
	writeTestFile(t, file, []byte("<p>mine</p>"))
	if err := os.Chmod(file, 0o400); err != nil {
		t.Fatal(err)
	}
	out, err := Execute([]string{"docs", "push", "doc_1", file, "--base-version", "ver_1"})
	if err != nil {
		t.Fatalf("push = %v, want no error: the push is saved", err)
	}
	if !strings.Contains(out, "Your change is in the document: ") || !strings.Contains(out, "Run slashdocs docs pull doc_1 --out "+latestFile(file)+", and make your next changes in that file.") || string(readTestFile(t, file)) != "<p>mine</p>" {
		t.Fatalf("output = %q, file = %q; want the pushed line, the pull line and the file of the person", out, string(readTestFile(t, file)))
	}
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cx := cfg.Contexts[cfg.ActiveContext]; cx != nil && cx.Pulled["doc_1"] != "" {
		t.Fatalf("base = %q, want none recorded", cx.Pulled["doc_1"])
	}
}

func TestDocsEditSendsOnlyTheEdits(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/documents/doc_1/edits":
			if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
				t.Errorf("decode edits: %v", err)
			}
			w.WriteHeader(http.StatusCreated)
			writeTestJSON(t, w, map[string]any{"id": "ver_2", "number": 2, "base_version_id": "ver_1", "edits_applied": 2})
		case "/v1/config":
			writeTestJSON(t, w, map[string]string{"deployment": "personal"})
		case "/version.json":
			writeTestJSON(t, w, map[string]string{"version": "dev"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	editsFile := filepath.Join(t.TempDir(), "edits.json")
	writeTestFile(t, editsFile, []byte(`[{"old_string": "twice", "new_string": "three times", "replace_all": true}]`))

	out, err := Execute([]string{"docs", "edit", "doc_1", "--old", "10 minutes", "--new", "5 minutes", "--edits", editsFile, "--summary", "Tune retries"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Your change is in the document: ") {
		t.Errorf("output = %q", out)
	}
	want := `{"change_summary":"Tune retries","edits":[{"new_string":"5 minutes","old_string":"10 minutes"},{"new_string":"three times","old_string":"twice","replace_all":true}]}`
	if b, _ := json.Marshal(got); string(b) != want {
		t.Errorf("request = %s, want %s", b, want)
	}

	got = nil
	if _, err := Execute([]string{"docs", "edit", "doc_1", "--all", "--old", "Cache design", "--new", "Cache plan"}); err != nil {
		t.Fatal(err)
	}
	want = `{"edits":[{"new_string":"Cache plan","old_string":"Cache design","replace_all":true}]}`
	if b, _ := json.Marshal(got); string(b) != want {
		t.Errorf("--all request = %s, want %s", b, want)
	}

	for _, args := range [][]string{
		{"docs", "edit", "doc_1"},
		{"docs", "edit", "doc_1", "--old", "a"},
		{"docs", "edit", "doc_1", "--edits", filepath.Join(t.TempDir(), "missing.json")},
	} {
		if _, err := Execute(args); err == nil {
			t.Errorf("%v succeeded, want an error", args)
		}
	}
}

// The base of a push is the base of its file. A pull to stdout, to look at
// the document, is the base of no file: with it as the base, a push of an
// older file takes out what people typed between the two pulls.
func TestTheBaseOfAPushIsTheBaseOfItsFile(t *testing.T) {
	seq := 1
	var bases []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/documents/doc_1":
			writeTestJSON(t, w, map[string]any{"id": "doc_1", "current_version_id": fmt.Sprintf("ver_%d", seq)})
		case fmt.Sprintf("/v1/documents/doc_1/versions/ver_%d/html", seq):
			w.Header().Set("X-Slashdocs-Seq", fmt.Sprint(seq))
			_, _ = fmt.Fprintf(w, "<p>at %d</p>", seq)
		case "/v1/documents/doc_1/versions":
			file := pushedFile(t, r)
			bases = append(bases, r.FormValue("base_version_id")+"@"+r.FormValue("base_seq"))
			writeTestJSON(t, w, map[string]any{"id": "ver_pushed", "number": 9, "seq": 9, "sha256": sumOf(file)})
		case "/v1/config":
			writeTestJSON(t, w, map[string]string{"deployment": "personal"})
		case "/version.json":
			writeTestJSON(t, w, map[string]string{"version": "dev"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	dir := t.TempDir()
	work, other := filepath.Join(dir, "work.html"), filepath.Join(dir, "other file.html")

	if _, err := Execute([]string{"docs", "pull", "doc_1", "--out", work}); err != nil {
		t.Fatal(err)
	}
	// A person types, and the agent looks at the document.
	seq = 2
	if out, err := Execute([]string{"docs", "pull", "doc_1"}); err != nil || out != "<p>at 2</p>" {
		t.Fatalf("pull to stdout = %q, %v", out, err)
	}
	if got := baseOfFile(t, work); got != "ver_1@1" {
		t.Fatalf("base of the file after a pull to stdout = %q, want ver_1@1", got)
	}
	// Each file of one document has its own base.
	seq = 3
	if _, err := Execute([]string{"docs", "pull", "doc_1", "--out", other}); err != nil {
		t.Fatal(err)
	}
	if _, err := Execute([]string{"docs", "push", "doc_1", work}); err != nil || bases[0] != "ver_1@1" {
		t.Fatalf("push base = %v, %v; want the base of the file, ver_1@1", bases, err)
	}
	if got := baseOfFile(t, work) + " " + baseOfFile(t, other); got != "ver_pushed@9 ver_3@3" {
		t.Fatalf("bases = %q, want ver_pushed@9 ver_3@3", got)
	}
	// A file with no base, a file of another document and stdin have no
	// base, and the push says so. The pull that it names writes to another
	// file, so the changes in this one stay. The command quotes a path with
	// a space.
	none := filepath.Join(dir, "new.html")
	writeTestFile(t, none, []byte("<p>new</p>"))
	for args, pull := range map[*[]string]string{
		{"docs", "push", "doc_1", none}:  "doc_1 this file holds, and a push on a guessed version can remove the text of other people. Run slashdocs docs pull doc_1 --out " + filepath.Join(dir, "new.latest.html"),
		{"docs", "push", "doc_2", other}: "doc_2 this file holds, and a push on a guessed version can remove the text of other people. Run slashdocs docs pull doc_2 --out '" + latestFile(other) + "'",
		{"docs", "push", "doc_1", "-"}:   "doc_1 this file holds, and a push on a guessed version can remove the text of other people. Run slashdocs docs pull doc_1 --out <file>",
	} {
		want := "slashdocs does not know which version of " + pull + ", make your change in that file, and push that file"
		if _, err := Execute(*args); err == nil || err.Error() != want {
			t.Errorf("%v = %v, want %q", *args, err, want)
		}
	}
	if len(bases) != 1 {
		t.Fatalf("pushes = %v, want only the first", bases)
	}
}

// A push of a file with no change of its own, after a person typed, changes
// nothing. The file is not the document as it is now, so its base stays:
// with the live seq as its base, the next push takes out what the person
// typed. The server answers with the base of the file. A server that
// answers with the live seq gives the hash of the live document, and the
// CLI keeps the base all the same.
func TestAnUnchangedPushKeepsTheBaseOfTheFile(t *testing.T) {
	const pulled, live = "<p>one</p>", "<p>one typed</p>"
	for name, unchanged := range map[string]map[string]any{
		"the base of the file":             {"id": "ver_1", "number": 1, "seq": 1, "unchanged": true, "sha256": sumOf([]byte(pulled))},
		"the live seq, as a server before": {"id": "ver_open", "number": 2, "seq": 2, "unchanged": true, "sha256": sumOf([]byte(live))},
	} {
		t.Run(name, func(t *testing.T) {
			var bases []string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v1/documents/doc_1":
					writeTestJSON(t, w, map[string]any{"id": "doc_1", "current_version_id": "ver_1"})
				case "/v1/documents/doc_1/versions/ver_1/html":
					w.Header().Set("X-Slashdocs-Seq", "1")
					_, _ = w.Write([]byte(pulled))
				case "/v1/documents/doc_1/versions":
					file := pushedFile(t, r)
					bases = append(bases, r.FormValue("base_version_id")+"@"+r.FormValue("base_seq"))
					if string(file) == pulled {
						writeTestJSON(t, w, unchanged)
						return
					}
					writeTestJSON(t, w, map[string]any{"id": "ver_3", "number": 3, "seq": 3, "rebased": true, "sha256": sumOf([]byte(live))})
				case "/v1/documents/doc_1/versions/ver_3/html":
					_, _ = w.Write([]byte(live))
				case "/v1/config":
					writeTestJSON(t, w, map[string]string{"deployment": "personal"})
				case "/version.json":
					writeTestJSON(t, w, map[string]string{"version": "dev"})
				default:
					http.NotFound(w, r)
				}
			}))
			defer srv.Close()
			t.Setenv("SLASHDOCS_SERVER", srv.URL)
			t.Setenv("SLASHDOCS_TOKEN", "tok")
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			file := filepath.Join(t.TempDir(), "doc.html")
			if _, err := Execute([]string{"docs", "pull", "doc_1", "--out", file}); err != nil {
				t.Fatal(err)
			}
			// A person types " typed" (seq 2), and the agent pushes its file.
			if out, err := Execute([]string{"docs", "push", "doc_1", file}); err != nil || out != "Nothing changed.\n" || baseOfFile(t, file) != "ver_1@1" {
				t.Fatalf("output = %q, %v, base %q; want that nothing changed, and the base ver_1@1", out, err, baseOfFile(t, file))
			}
			writeTestFile(t, file, []byte("<p>one</p><p>mine</p>"))
			if _, err := Execute([]string{"docs", "push", "doc_1", file}); err != nil || bases[1] != "ver_1@1" {
				t.Fatalf("second push base = %v, %v; want ver_1@1, so that the server keeps the typed text", bases, err)
			}
			if got := string(readTestFile(t, file)); got != live || baseOfFile(t, file) != "ver_3@3" {
				t.Fatalf("file = %q, base %q; want the saved version and ver_3@3", got, baseOfFile(t, file))
			}
		})
	}
}

// The text of a conflict comes from a document: its control characters do
// not go to the terminal.
func TestTheConflictTextHasNoControlCharacters(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		writeTestJSON(t, w, map[string]any{"error": map[string]any{"code": "version_conflict", "message": "server text", "details": map[string]any{"text": "TTL \x1b[2Jof\r 10\x07"}}})
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	file := filepath.Join(t.TempDir(), "doc.html")
	writeTestFile(t, file, []byte("<p>mine</p>"))
	_, err := Execute([]string{"docs", "push", "doc_1", file, "--base-version", "ver_1"})
	if err == nil || !strings.Contains(err.Error(), `in "TTL [2Jof 10",`) {
		t.Fatalf("err = %v, want the text with no control characters", err)
	}
}

// Edits that leave the document as it is save no version, and the command
// says so.
func TestDocsEditSaysWhenNothingChanged(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/documents/doc_1/edits":
			writeTestJSON(t, w, map[string]any{"id": "ver_2", "number": 2, "base_version_id": "ver_2", "edits_applied": 1, "unchanged": true})
		case "/v1/config":
			writeTestJSON(t, w, map[string]string{"deployment": "personal"})
		case "/version.json":
			writeTestJSON(t, w, map[string]string{"version": "dev"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	t.Setenv("SLASHDOCS_SERVER", srv.URL)
	t.Setenv("SLASHDOCS_TOKEN", "tok")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if out, err := Execute([]string{"docs", "edit", "doc_1", "--old", "a", "--new", "a"}); err != nil || out != "Nothing changed.\n" {
		t.Fatalf("output = %q, %v; want only that nothing changed", out, err)
	}
	if out, err := Execute([]string{"--json", "docs", "edit", "doc_1", "--old", "a", "--new", "a"}); err != nil || !strings.Contains(out, `"unchanged": true`) {
		t.Fatalf("--json output = %q, %v; want the unchanged field", out, err)
	}
}
