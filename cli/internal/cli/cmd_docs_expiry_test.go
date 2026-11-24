package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// expiryServer is a slashdocs server for the expiry commands. It keeps the
// form of the last create and the body of the last PATCH, and answers with
// expiresAt when it is set.
type expiryServer struct {
	*httptest.Server
	form      map[string][]string
	patch     map[string]any
	expiresAt string
	// config is the answer of GET /v1/config. A server of an older release
	// has no document_expiry_enabled in it.
	config map[string]any
}

func newExpiryServer(t *testing.T, expiresAt string) *expiryServer {
	t.Helper()
	s := &expiryServer{expiresAt: expiresAt, config: map[string]any{"deployment": "public", "document_expiry_enabled": true}}
	document := func() map[string]any {
		d := map[string]any{"id": "doc_1", "title": "Scratch", "current_version_id": "ver_1"}
		if s.expiresAt != "" {
			d["expires_at"] = s.expiresAt
		}
		return d
	}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/documents":
			requireMultipart(t, r)
			s.form = r.MultipartForm.Value
			writeTestJSON(t, w, document())
		case r.Method == http.MethodPatch && r.URL.Path == "/v1/documents/doc_1":
			b, err := io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
			}
			s.patch = nil
			if err := json.Unmarshal(b, &s.patch); err != nil {
				t.Errorf("the PATCH body %q is not JSON: %v", b, err)
			}
			writeTestJSON(t, w, document())
		case r.Method == http.MethodGet && r.URL.Path == "/v1/documents/doc_1":
			writeTestJSON(t, w, document())
		case r.Method == http.MethodGet && r.URL.Path == "/v1/config":
			writeTestJSON(t, w, s.config)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/access"):
			writeTestJSON(t, w, map[string]any{"items": []any{}})
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusTeapot)
		}
	}))
	t.Cleanup(s.Close)
	jsonTestEnv(t, s.Server)
	return s
}

func scratchFile(t *testing.T) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "scratch.html")
	writeTestFile(t, file, []byte("<h1>scratch</h1>"))
	return file
}

// testExpiry is an expiry time that the server of the test gives: 7 days
// from now, as a create with --ttl 7d gets.
var testExpiry = time.Now().Add(7 * 24 * time.Hour).UTC().Truncate(time.Second).Format(time.RFC3339)

// expiryAsRead is the expiry time of the test as a person reads it: the
// time, and how long that is from now.
func expiryAsRead(t *testing.T) string {
	t.Helper()
	at, err := time.Parse(time.RFC3339, testExpiry)
	if err != nil {
		t.Fatal(err)
	}
	return at.Local().Format("2 Jan 2006 15:04 MST") + ", which is in 7 days"
}

func TestCreateSendsThePeriodAndTellsWhenTheDocumentGoes(t *testing.T) {
	s := newExpiryServer(t, testExpiry)
	got, err := Execute([]string{"docs", "create", scratchFile(t), "--ttl", "7d"})
	if err != nil {
		t.Fatal(err)
	}
	if period := s.form["expires_in"]; len(period) != 1 || period[0] != "7d" {
		t.Fatalf("the create sent the expires_in %q, want 7d", period)
	}
	if want := "The server deletes it after " + expiryAsRead(t) + ". This cannot be undone."; !strings.Contains(got, want) {
		t.Fatalf("the output is %q, want it to hold %q", got, want)
	}
}

func TestCreateWithoutATTLAsksForNoExpiry(t *testing.T) {
	for _, args := range [][]string{{}, {"--ttl", "never"}} {
		s := newExpiryServer(t, "")
		got, err := Execute(append([]string{"docs", "create", scratchFile(t)}, args...))
		if err != nil {
			t.Fatal(err)
		}
		if _, sent := s.form["expires_in"]; sent {
			t.Fatalf("a create with the flags %q sent expires_in", args)
		}
		if strings.Contains(got, "deletes") {
			t.Fatalf("the output of a document that is kept is %q", got)
		}
	}
}

func TestCreateJSONHoldsTheExpiry(t *testing.T) {
	newExpiryServer(t, testExpiry)
	got, err := Execute([]string{"--json", "docs", "create", scratchFile(t), "--ttl", "7d"})
	if err != nil {
		t.Fatal(err)
	}
	var created map[string]any
	if err := json.Unmarshal([]byte(got), &created); err != nil || created["expires_at"] != testExpiry {
		t.Fatalf("the JSON output is %q, %v, want expires_at %s", got, err, testExpiry)
	}
}

// A server of an older release does not know the field. The document then
// stays for ever, and the person thinks that it goes, so the command fails.
func TestCreateFailsWhenTheServerSetNoExpiry(t *testing.T) {
	newExpiryServer(t, "")
	got, err := Execute([]string{"docs", "create", scratchFile(t), "--ttl", "7d"})
	if err == nil || ExitCode(err) == 0 {
		t.Fatalf("the create gave %v and the output %q, want an error", err, got)
	}
	for _, want := range []string{"doc_1", "is kept", "older"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the error %q does not hold %q", err, want)
		}
	}
	// The document is there, so the person still learns its ID and address.
	if !strings.Contains(got, "doc_1") {
		t.Errorf("the output %q does not name the document", got)
	}
}

func TestUpdateSetsThePeriod(t *testing.T) {
	s := newExpiryServer(t, testExpiry)
	got, err := Execute([]string{"docs", "update", "doc_1", "--ttl", "3mo"})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.patch) != 1 || s.patch["expires_in"] != "3mo" {
		t.Fatalf("the update sent %v, want only expires_in 3mo", s.patch)
	}
	if want := "The server deletes document doc_1 after " + expiryAsRead(t) + ". This cannot be undone."; !strings.Contains(got, want) {
		t.Fatalf("the output is %q, want it to hold %q", got, want)
	}
	if strings.Contains(got, "Renamed") {
		t.Fatalf("the output of an update with no title is %q", got)
	}
}

func TestUpdateWithNeverRemovesTheExpiry(t *testing.T) {
	s := newExpiryServer(t, "")
	got, err := Execute([]string{"docs", "update", "doc_1", "--ttl", "never"})
	if err != nil {
		t.Fatal(err)
	}
	value, sent := s.patch["expires_at"]
	if len(s.patch) != 1 || !sent || value != nil {
		t.Fatalf("the update sent %v, want only expires_at null", s.patch)
	}
	if want := "Document doc_1 has no expiry: the server keeps it."; !strings.Contains(got, want) {
		t.Fatalf("the output is %q, want it to hold %q", got, want)
	}
}

func TestUpdateSetsTheTitleAndThePeriodInOneRequest(t *testing.T) {
	s := newExpiryServer(t, testExpiry)
	got, err := Execute([]string{"docs", "update", "doc_1", "--title", "New title", "--ttl", "1d"})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.patch) != 2 || s.patch["title"] != "New title" || s.patch["expires_in"] != "1d" {
		t.Fatalf("the update sent %v, want the title and expires_in", s.patch)
	}
	if !strings.Contains(got, "Renamed document doc_1.") || !strings.Contains(got, "The server deletes document doc_1 after") {
		t.Fatalf("the output is %q, want the rename and the expiry", got)
	}
}

// A rename is as it was before the flag.
func TestUpdateWithOnlyATitleSendsOnlyTheTitle(t *testing.T) {
	s := newExpiryServer(t, "")
	got, err := Execute([]string{"docs", "update", "doc_1", "--title", "New title"})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.patch) != 1 || s.patch["title"] != "New title" {
		t.Fatalf("the update sent %v, want only the title", s.patch)
	}
	if !strings.Contains(got, "Renamed document doc_1.") || strings.Contains(got, "expiry") {
		t.Fatalf("the output is %q", got)
	}
}

func TestUpdateFailsWhenTheServerSetNoExpiry(t *testing.T) {
	newExpiryServer(t, "")
	_, err := Execute([]string{"docs", "update", "doc_1", "--title", "New title", "--ttl", "7d"})
	if err == nil || !strings.Contains(err.Error(), "is kept") || !strings.Contains(err.Error(), "older") {
		t.Fatalf("the update gave %v, want an error that tells that the document is kept", err)
	}
}

// A server of an older release does not know the expiry, and an operator can
// turn it off. The CLI asks the server first, so that the command makes no
// document that then stays for ever.
func TestATTLDoesNothingWhenTheServerHasNoExpiry(t *testing.T) {
	for name, config := range map[string]map[string]any{
		"an older server":    {"deployment": "public"},
		"the feature is off": {"deployment": "public", "document_expiry_enabled": false},
	} {
		t.Run(name, func(t *testing.T) {
			s := newExpiryServer(t, testExpiry)
			s.config = config
			for _, args := range [][]string{
				{"docs", "create", scratchFile(t), "--ttl", "7d"},
				{"docs", "update", "doc_1", "--title", "New title", "--ttl", "7d"},
			} {
				got, err := Execute(args)
				if err == nil || !strings.Contains(err.Error(), "does not set an expiry") {
					t.Fatalf("%s gave %q, %v, want an error that tells that the server sets no expiry", args[1], got, err)
				}
			}
			if s.form != nil || s.patch != nil {
				t.Fatalf("the commands reached the server: create %v, update %v", s.form, s.patch)
			}
			// A command with no period works as before.
			if _, err := Execute([]string{"docs", "update", "doc_1", "--title", "New title"}); err != nil || s.patch["title"] != "New title" {
				t.Fatalf("a rename gave %v and sent %v", err, s.patch)
			}
		})
	}
}

// A wrong period must not reach the server: 3m could delete a document in
// three minutes.
func TestAWrongTTLFailsBeforeTheRequest(t *testing.T) {
	jsonTestEnv(t, failOnRequest(t))
	file := scratchFile(t)
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"docs", "create", file, "--ttl", "3m"}, "use min for minutes and mo for months"},
		{[]string{"docs", "create", file, "--ttl", "soon"}, "a period is a whole number and a unit"},
		{[]string{"docs", "update", "doc_1", "--ttl", "3m"}, "use min for minutes and mo for months"},
		{[]string{"docs", "update", "doc_1", "--ttl", "30s"}, "a period is a whole number and a unit"},
		{[]string{"docs", "update", "doc_1", "--ttl", ""}, "a period is a whole number and a unit"},
		{[]string{"docs", "update", "doc_1"}, "nothing to update; pass --title or --ttl"},
	} {
		t.Run(strings.Join(tc.args[1:], " "), func(t *testing.T) {
			_, err := Execute(tc.args)
			if code := ExitCode(err); code != 2 || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("exit code %d, err %v, want 2 and %q", code, err, tc.want)
			}
		})
	}
}

func TestShowPrintsTheExpiry(t *testing.T) {
	newExpiryServer(t, testExpiry)
	got, err := Execute([]string{"docs", "show", "doc_1"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "expires_at="+testExpiry) {
		t.Fatalf("the output is %q, want it to hold the expiry", got)
	}
}
