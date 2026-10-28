package server_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/notifications"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/server"
)

const testSlackSecret = "test-signing-secret"

type unfurlCall struct {
	target  notifications.UnfurlTarget
	unfurls map[string]any
}

// fakeUnfurler stands in for Slack: it records chat.unfurl calls and answers
// conversations.info with a fixed verdict.
type fakeUnfurler struct {
	calls     chan unfurlCall
	external  bool
	mu        sync.Mutex
	infoCalls int
}

func newFakeUnfurler(external bool) *fakeUnfurler {
	return &fakeUnfurler{calls: make(chan unfurlCall, 4), external: external}
}

func (f *fakeUnfurler) Unfurl(_ context.Context, target notifications.UnfurlTarget, unfurls map[string]any) error {
	f.calls <- unfurlCall{target, unfurls}
	return nil
}

func (f *fakeUnfurler) IsExternalChannel(context.Context, string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.infoCalls++
	return f.external, nil
}

func (f *fakeUnfurler) next(t *testing.T) unfurlCall {
	t.Helper()
	select {
	case c := <-f.calls:
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("no chat.unfurl call")
		return unfurlCall{}
	}
}

func (f *fakeUnfurler) none(t *testing.T) {
	t.Helper()
	select {
	case c := <-f.calls:
		t.Fatalf("unexpected chat.unfurl call: %+v", c)
	case <-time.After(300 * time.Millisecond):
	}
}

func slackEnv(t *testing.T, deployment string, u *fakeUnfurler) *testEnv {
	return newConfiguredTestEnv(t, server.Config{
		Environment:        "test",
		AppOrigin:          "https://docs.example",
		PreviousOrigins:    []string{"https://aidocs.example"},
		Deployment:         deployment,
		SlackSigningSecret: testSlackSecret,
	}, server.WithSlackUnfurler(u))
}

func postSlack(t *testing.T, h http.Handler, body string, sentAt time.Time, extra map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	ts := strconv.FormatInt(sentAt.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(testSlackSecret))
	mac.Write([]byte("v0:" + ts + ":" + body))
	headers := map[string]string{
		"Content-Type":              "application/json",
		"X-Slack-Request-Timestamp": ts,
		"X-Slack-Signature":         "v0=" + hex.EncodeToString(mac.Sum(nil)),
	}
	for k, v := range extra {
		headers[k] = v
	}
	return doRaw(t, h, http.MethodPost, "/v1/slack/events", strings.NewReader(body), headers)
}

func linkEvent(channel, source string, urls ...string) string {
	links := make([]map[string]string, len(urls))
	for i, u := range urls {
		links[i] = map[string]string{"url": u, "domain": "docs.example"}
	}
	b, _ := json.Marshal(map[string]any{
		"type": "event_callback",
		"event": map[string]any{
			"type": "link_shared", "channel": channel, "user": "U_PERSON", "message_ts": "1700000000.000100",
			"unfurl_id": "unf_1", "source": source, "links": links,
		},
		"authorizations": []map[string]any{{"user_id": "U_BOT", "is_bot": true}},
	})
	return string(b)
}

func cardText(t *testing.T, card any) string {
	t.Helper()
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(card); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

// orgDoc creates a doc the whole org can open, with a second version, one open
// thread with a reply, and one resolved thread.
func orgDoc(t *testing.T, e *testEnv) (doc repo.Document, v1, v2 repo.Version) {
	t.Helper()
	ctx := context.Background()
	doc, v1, err := e.store.CreateDocument(ctx, fixtureOwner, "Org plan <!channel>",
		[]byte(`<html><head><title>Org plan</title></head><body><h1>Org plan</h1><p>First version summary.</p></body></html>`))
	if err != nil {
		t.Fatal(err)
	}
	v2, err = e.store.CreateVersion(ctx, doc.ID, v1.ID, "", []byte(`<html><body><p>Second version summary.</p></body></html>`), fixtureOwner)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.CreateGrant(ctx, "document", doc.ID, auth.Principal{Type: auth.PrincipalAnyone}, repo.RoleViewer, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	open, err := e.store.CreateComment(ctx, doc.ID, v2.ID, "open thread", repo.Anchor{Quote: "Second"}, fixtureCommenter, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.CreateCommentReply(ctx, doc.ID, open.ID, "a reply", fixtureOwner, nil); err != nil {
		t.Fatal(err)
	}
	return doc, v1, v2
}

func TestSlackEventsRejectUnsignedAndStaleRequests(t *testing.T) {
	u := newFakeUnfurler(false)
	e := slackEnv(t, server.DeploymentOrg, u)
	body := linkEvent("C1", "conversations_history", "https://docs.example/app/d/"+e.doc.ID)

	bad := doRaw(t, e.h, http.MethodPost, "/v1/slack/events", strings.NewReader(body), map[string]string{
		"X-Slack-Request-Timestamp": strconv.FormatInt(time.Now().Unix(), 10),
		"X-Slack-Signature":         "v0=deadbeef",
	})
	assertStatus(t, bad, http.StatusUnauthorized)
	if !strings.Contains(bad.Body.String(), `"code":"unauthorized"`) {
		t.Fatalf("401 should use the shared error shape: %s", bad.Body.String())
	}
	stale := postSlack(t, e.h, body, time.Now().Add(-6*time.Minute), nil)
	assertStatus(t, stale, http.StatusUnauthorized)
	u.none(t)
}

func TestSlackEventsAnswerURLVerification(t *testing.T) {
	e := slackEnv(t, server.DeploymentOrg, newFakeUnfurler(false))
	rr := postSlack(t, e.h, `{"type":"url_verification","challenge":"abc123"}`, time.Now(), nil)
	assertStatus(t, rr, http.StatusOK)
	assertJSON(t, rr.Body.Bytes(), `{"challenge":"abc123"}`)
}

func TestSlackEventsGiveLiveCardsOnlyToOrgWideDocs(t *testing.T) {
	u := newFakeUnfurler(false)
	e := slackEnv(t, server.DeploymentOrg, u)
	ctx := context.Background()
	doc, v1, _ := orgDoc(t, e)
	_, otherV1, _ := orgDoc(t, e)
	// A doc that is org-wide only through its folder.
	folder, err := e.store.CreateFolder(ctx, fixtureOwner, "Shared folder", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.CreateGrant(ctx, "folder", folder.ID, auth.Principal{Type: auth.PrincipalAnyone}, repo.RoleViewer, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	inFolder, _, err := e.store.CreateDocument(ctx, fixtureOwner, "Folder doc", []byte(`<p>Folder body.</p>`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.MoveDocumentToFolder(ctx, fixtureOwner, folder.ID, inFolder.ID); err != nil {
		t.Fatal(err)
	}
	// A doc shared only with a Google group is not org-wide.
	group := repo.GoogleGroup{ID: "groups/design", CustomerID: "C0test", Email: "design@example.com", Name: "Design", LastVerifiedAt: time.Now()}
	if err := e.store.UpsertGoogleGroup(ctx, group); err != nil {
		t.Fatal(err)
	}
	groupDoc, _, err := e.store.CreateDocument(ctx, fixtureOwner, "Group only plan", []byte(`<p>Group body.</p>`))
	if err != nil {
		t.Fatal(err)
	}
	groupPrincipal := auth.Principal{Type: auth.PrincipalGoogleGroup, ID: group.ID, Email: group.Email, Name: group.Name}
	if _, err := e.store.CreateGrant(ctx, "document", groupDoc.ID, groupPrincipal, repo.RoleViewer, fixtureOwner); err != nil {
		t.Fatal(err)
	}

	links := map[string]string{
		"org":          "https://docs.example/app/d/" + doc.ID,
		"private":      "https://docs.example/app/d/" + e.doc.ID,
		"aidocs":       "https://aidocs.example/documents/" + doc.ID,
		"oldVersion":   "https://docs.example/app/d/" + doc.ID + "?version=" + v1.ID,
		"otherVersion": "https://docs.example/app/d/" + doc.ID + "/?version=" + otherV1.ID,
		"folderDoc":    "https://docs.example/app/d/" + inFolder.ID,
		"groupDoc":     "https://docs.example/app/d/" + groupDoc.ID,
		"folderLink":   "https://docs.example/app/folders/" + folder.ID,
		"foreign":      "https://example.org/app/d/" + doc.ID,
	}
	var urls []string
	for _, l := range links {
		urls = append(urls, l)
	}
	rr := postSlack(t, e.h, linkEvent("C1", "conversations_history", urls...), time.Now(), nil)
	assertStatus(t, rr, http.StatusOK)
	call := u.next(t)
	if call.target.Channel != "C1" || call.target.TS != "1700000000.000100" || call.target.IsComposer() {
		t.Fatalf("unfurl target = %+v", call.target)
	}
	card := func(name string) string {
		c, ok := call.unfurls[links[name]]
		if !ok {
			t.Fatalf("no card for %s link", name)
		}
		return cardText(t, c)
	}
	org := card("org")
	for _, want := range []string{"Org plan &lt;!channel&gt;", "Second version summary.", "v2 · 1 open thread · Owner", "https://docs.example/app/d/" + doc.ID} {
		if !strings.Contains(org, want) {
			t.Errorf("org card missing %q: %s", want, org)
		}
	}
	if p := card("private"); strings.Contains(p, "fixture") || !strings.Contains(p, "SlashDocs document") {
		t.Errorf("private card leaks or is not neutral: %s", p)
	}
	if a := card("aidocs"); !strings.Contains(a, "Org plan") || !strings.Contains(a, "https://docs.example/app/d/") || strings.Contains(a, "aidocs.example") {
		t.Errorf("aidocs card should be live with a current-origin button: %s", a)
	}
	if o := card("oldVersion"); !strings.Contains(o, "v1 · ") || !strings.Contains(o, "First version summary.") {
		t.Errorf("version link should show v1: %s", o)
	}
	if o := card("otherVersion"); !strings.Contains(o, "v2 · ") {
		t.Errorf("a version from another doc must fall back to current: %s", o)
	}
	if f := card("folderDoc"); !strings.Contains(f, "Folder doc") {
		t.Errorf("folder-inherited org-wide doc should be live: %s", f)
	}
	if g := card("groupDoc"); strings.Contains(g, "Group only plan") || !strings.Contains(g, "SlashDocs document") {
		t.Errorf("a Google-group-only doc must get the neutral card: %s", g)
	}
	for _, name := range []string{"folderLink", "foreign"} {
		if _, ok := call.unfurls[links[name]]; ok {
			t.Errorf("%s link must not be unfurled", name)
		}
	}
}

func TestSlackEventsUseNeutralCardsWhenOutsidersMightSee(t *testing.T) {
	cases := []struct {
		name, deployment, channel, source string
		external, wantInfo                bool
	}{
		{name: "shared with another org", deployment: server.DeploymentOrg, channel: "C1", source: "conversations_history", external: true, wantInfo: true},
		{name: "preview while typing", deployment: server.DeploymentOrg, channel: "COMPOSER", source: "composer"},
		{name: "public deployment", deployment: server.DeploymentPublic, channel: "C1", source: "conversations_history"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			u := newFakeUnfurler(tc.external)
			e := slackEnv(t, tc.deployment, u)
			doc, _, _ := orgDoc(t, e)
			link := "https://docs.example/app/d/" + doc.ID
			assertStatus(t, postSlack(t, e.h, linkEvent(tc.channel, tc.source, link), time.Now(), nil), http.StatusOK)
			text := cardText(t, u.next(t).unfurls[link])
			if strings.Contains(text, "Org plan") || !strings.Contains(text, "SlashDocs document") {
				t.Fatalf("card must be neutral: %s", text)
			}
			u.mu.Lock()
			defer u.mu.Unlock()
			if (u.infoCalls > 0) != tc.wantInfo {
				t.Fatalf("conversations.info calls = %d, want any = %v", u.infoCalls, tc.wantInfo)
			}
		})
	}
}

func TestSlackEventsSkipRetriesAndOwnMessages(t *testing.T) {
	u := newFakeUnfurler(false)
	e := slackEnv(t, server.DeploymentOrg, u)
	doc, _, _ := orgDoc(t, e)
	link := "https://docs.example/app/d/" + doc.ID

	assertStatus(t, postSlack(t, e.h, linkEvent("C1", "conversations_history", link), time.Now(), map[string]string{"X-Slack-Retry-Num": "1"}), http.StatusOK)
	u.none(t)

	own := strings.Replace(linkEvent("C1", "conversations_history", link), `"user":"U_PERSON"`, `"user":"U_BOT"`, 1)
	assertStatus(t, postSlack(t, e.h, own, time.Now(), nil), http.StatusOK)
	u.none(t)
}

func TestSlackEventsRouteOnlyExistsWhenConfigured(t *testing.T) {
	e := newTestEnv(t)
	rr := postSlack(t, e.h, `{"type":"url_verification","challenge":"x"}`, time.Now(), nil)
	assertStatus(t, rr, http.StatusNotFound)
}

// The web page served without sign-in must never carry doc content: cards
// only travel through Slack's API.
func TestDocPageDoesNotExposeOrgWideTitle(t *testing.T) {
	e := slackEnv(t, server.DeploymentOrg, newFakeUnfurler(false))
	doc, _, _ := orgDoc(t, e)
	for _, path := range []string{"/app/d/" + doc.ID, "/documents/" + doc.ID} {
		rr := do(t, e.h, http.MethodGet, path, "", nil)
		if body := rr.Body.String(); strings.Contains(body, "Org plan") || strings.Contains(body, "summary") {
			t.Fatalf("%s exposes doc content without sign-in", path)
		}
	}
}
