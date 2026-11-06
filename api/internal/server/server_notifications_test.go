package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

func TestNotificationPreferencesArePersonalAndRequireDocumentAccess(t *testing.T) {
	e := newTestEnv(t)
	path := "/v1/documents/" + e.doc.ID + "/notifications"
	for _, tc := range []struct {
		principal string
		status    int
	}{{"", http.StatusUnauthorized}, {"user:attacker", http.StatusForbidden}, {"user:" + fixtureViewer.ID, http.StatusOK}} {
		res := do(t, e.h, "PUT", path, `{"enabled":false}`, map[string]string{"X-Test-Principal": tc.principal})
		if res.Code != tc.status {
			t.Fatalf("status=%d body=%s", res.Code, res.Body)
		}
	}
	res := do(t, e.h, "GET", path, "", map[string]string{"X-Test-Principal": "user:" + fixtureOwner.ID})
	var p repo.NotificationPreferences
	if err := json.Unmarshal(res.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if !p.Enabled {
		t.Fatal("viewer mute affected owner")
	}
	res = do(t, e.h, "PUT", "/v1/me/notifications", `{}`, map[string]string{"X-Test-Principal": "user:" + fixtureViewer.ID})
	if res.Code != http.StatusBadRequest {
		t.Fatal("missing preference must fail")
	}
}

func TestDocumentLinksEnforceAccessAndDocumentMembership(t *testing.T) {
	e := newTestEnv(t)
	other, ver, err := e.store.CreateDocument(context.Background(), fixtureOwner, "other", []byte("<h1>Other</h1>"))
	if err != nil {
		t.Fatal(err)
	}
	cmt, err := e.store.CreateComment(context.Background(), other.ID, ver.ID, "Other comment", repo.Anchor{Quote: "Other"}, fixtureOwner, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path, principal string
		status          int
	}{
		{"/headings", "user:" + fixtureAttacker.ID, http.StatusForbidden},
		{"/link?comment=" + e.cmt.ID, "user:" + fixtureAttacker.ID, http.StatusForbidden},
		{"/link?comment=" + cmt.ID, "user:" + fixtureOwner.ID, http.StatusNotFound},
		{"/link?version=" + ver.ID, "user:" + fixtureOwner.ID, http.StatusNotFound},
		{"/headings?version=" + ver.ID, "user:" + fixtureOwner.ID, http.StatusNotFound},
		{"/link?comment=" + e.cmt.ID + "&heading=fixture", "user:" + fixtureViewer.ID, http.StatusBadRequest},
		{"/link?comment=" + e.cmt.ID, "user:" + fixtureViewer.ID, http.StatusOK},
		{"/link?heading=dynamic-heading", "user:" + fixtureViewer.ID, http.StatusOK},
	} {
		res := do(t, e.h, "GET", "/v1/documents/"+e.doc.ID+tc.path, "", map[string]string{"X-Test-Principal": tc.principal})
		if res.Code != tc.status {
			t.Fatalf("%s: status=%d body=%s", tc.path, res.Code, res.Body)
		}
	}
}
