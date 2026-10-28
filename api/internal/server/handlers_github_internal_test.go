package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

func TestGitHubTokenEncryptionRoundTripAndTamperDetection(t *testing.T) {
	sealed, err := sealGitHubToken("session-secret", "github-token")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("github-token")) {
		t.Fatal("ciphertext contains plaintext token")
	}
	got, err := openGitHubToken("session-secret", sealed)
	if err != nil || got != "github-token" {
		t.Fatalf("open token = %q, %v", got, err)
	}
	sealed[len(sealed)-1] ^= 1
	if _, err := openGitHubToken("session-secret", sealed); err == nil {
		t.Fatal("tampered ciphertext was accepted")
	}
}

func TestGitHubTokenKeyKeepsPreRenameSeparator(t *testing.T) {
	// Tokens stored before the rename from aidocs must still decrypt.
	want := sha256.Sum256([]byte("aidocs/github-token/v1\x00session-secret"))
	if !bytes.Equal(tokenKey("session-secret"), want[:]) {
		t.Fatal("tokenKey changed its domain separator; stored GitHub tokens would not decrypt")
	}
}

func TestPrintableHTMLInjectsTopLevelPrintBootstrap(t *testing.T) {
	got := printableHTML([]byte("<!doctype html><html><body><h1>Report</h1></body></html>"))
	if !bytes.Contains(got, []byte(`window.print()`)) || !bytes.Contains(got, []byte(`<h1>Report</h1>`)) {
		t.Fatalf("printable HTML missing content or bootstrap: %s", got)
	}
}

type headerAuth map[string]auth.Principal

func (a headerAuth) Authenticate(r *http.Request) (*auth.Principal, error) {
	if p, ok := a[r.Header.Get("X-User")]; ok {
		return &p, nil
	}
	return nil, auth.ErrUnauthorized
}

// fakeGitHub answers repository and file reads for the repositories that each
// token can read, and counts the repository access checks for each token.
type fakeGitHub struct {
	readable map[string]string
	checks   map[string]int
}

func (f *fakeGitHub) RoundTrip(r *http.Request) (*http.Response, error) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	path := strings.ToLower(r.URL.Path)
	if strings.Count(path, "/") == 3 {
		f.checks[token]++
	}
	status, body := http.StatusNotFound, ""
	if path == "/repos/"+f.readable[token] {
		status = http.StatusOK
	} else if strings.HasPrefix(path, "/repos/"+f.readable[token]+"/contents/") {
		status, body = http.StatusOK, "file body"
	}
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
}

func TestGitHubRawContentNeedsEveryVersionCreatorToReadTheRepository(t *testing.T) {
	ctx := context.Background()
	store, err := pgrepo.Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	const secret = "session-secret"
	users := headerAuth{}
	github := &fakeGitHub{readable: map[string]string{"owner-token": "acme/app", "viewer-token": "acme/app", "editor-token": "acme/other"}, checks: map[string]int{}}
	for _, name := range []string{"owner", "viewer", "editor"} {
		p, err := store.UpsertGoogleUser(ctx, name, name+"@example.com", name, "sub-"+name, "")
		if err != nil {
			t.Fatal(err)
		}
		users[name] = p
		sealed, err := sealGitHubToken(secret, name+"-token")
		if err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertGitHubConnection(ctx, repo.GitHubConnection{UserID: name, Login: name, AccessTokenCiphertext: sealed}); err != nil {
			t.Fatal(err)
		}
	}
	doc, ver, err := store.CreateDocument(ctx, users["owner"], "doc", []byte("<html></html>"))
	if err != nil {
		t.Fatal(err)
	}
	for name, role := range map[string]repo.Role{"viewer": repo.RoleViewer, "editor": repo.RoleEditor} {
		if _, err := store.CreateGrant(ctx, "document", doc.ID, users[name], role, users["owner"]); err != nil {
			t.Fatal(err)
		}
	}
	h := New(Config{Environment: "test", SessionSecret: secret}, WithRepository(store), WithAuthenticator(users), func(d *dependencies) {
		d.githubHTTPClient = &http.Client{Transport: github}
	}).Handler()
	readDoc := func(docID, user, owner, name string) *httptest.ResponseRecorder {
		body := `{"owner":"` + owner + `","repo":"` + name + `","path":"README.md","ref":"main"}`
		req := httptest.NewRequest(http.MethodPost, "/v1/documents/"+docID+"/github/raw", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-User", user)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}
	read := func(user, owner, name string) *httptest.ResponseRecorder {
		return readDoc(doc.ID, user, owner, name)
	}
	expect := func(rr *httptest.ResponseRecorder, status int, ownerChecks, editorChecks int) {
		t.Helper()
		if rr.Code != status || github.checks["owner-token"] != ownerChecks || github.checks["editor-token"] != editorChecks {
			t.Fatalf("status %d (want %d), checks %v (want owner %d, editor %d): %s", rr.Code, status, github.checks, ownerChecks, editorChecks, rr.Body)
		}
	}

	// The author can read the repository, so the viewer gets the file.
	expect(read("viewer", "acme", "app"), http.StatusOK, 1, 0)
	// The answer is cached, also for other letter case.
	expect(read("viewer", "ACME", "App"), http.StatusOK, 1, 0)
	// The author is the viewer, so only the viewer's own fetch is necessary.
	expect(read("owner", "acme", "app"), http.StatusOK, 1, 0)

	// A service account counts as its owner, so its document uses the
	// owner's cached answer.
	sa, err := store.CreateServiceAccount(ctx, users["owner"], "agent")
	if err != nil {
		t.Fatal(err)
	}
	saDoc, _, err := store.CreateDocument(ctx, auth.Principal{Type: auth.PrincipalServiceAccount, ID: sa.ID}, "agent doc", []byte("<html></html>"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateGrant(ctx, "document", saDoc.ID, users["viewer"], repo.RoleViewer, users["owner"]); err != nil {
		t.Fatal(err)
	}
	expect(readDoc(saDoc.ID, "viewer", "acme", "app"), http.StatusOK, 1, 0)

	// An editor who cannot read the repository adds a version. The old
	// author still passes from the cache, and the new author is stopped.
	if _, err := store.CreateVersion(ctx, doc.ID, ver.ID, "edit", []byte("<html>2</html>"), users["editor"], false); err != nil {
		t.Fatal(err)
	}
	rr := read("viewer", "acme", "app")
	expect(rr, http.StatusForbidden, 1, 1)
	if !strings.Contains(rr.Body.String(), `"github_author_access"`) || !strings.Contains(rr.Body.String(), `"id":"editor"`) {
		t.Fatalf("missing author access error: %s", rr.Body)
	}
	// The denial is cached too.
	expect(read("viewer", "acme", "app"), http.StatusForbidden, 1, 1)
}
