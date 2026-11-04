package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
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

// The server records an access request also when no notification channel is
// set, and the people who manage access can read it until they grant access.
func TestAccessRequestsAreRecordedWithoutNotifications(t *testing.T) {
	e := newTestEnv(t)
	path := "/v1/documents/" + e.doc.ID + "/access-requests"
	as := func(p auth.Principal) map[string]string {
		return map[string]string{"X-Test-Principal": principalHeader(p), "Content-Type": "application/json"}
	}
	rr := do(t, e.h, http.MethodPost, path, `{}`, as(fixtureStranger))
	assertStatus(t, rr, http.StatusAccepted)
	assertJSON(t, rr.Body.Bytes(), `{"status":"sent"}`)
	var queued int
	if err := e.store.Pool().QueryRow(context.Background(), "SELECT count(*) FROM document_access_request_notification_outbox").Scan(&queued); err != nil || queued != 0 {
		t.Fatalf("queued=%d err=%v, want no notification without a channel", queued, err)
	}

	for _, p := range []auth.Principal{fixtureOwner, fixtureEditor} {
		rr = do(t, e.h, http.MethodGet, path, "", as(p))
		assertStatus(t, rr, http.StatusOK)
		var got struct{ Items []repo.AccessRequest }
		if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if len(got.Items) != 1 || got.Items[0].Requester.ID != fixtureStranger.ID ||
			got.Items[0].Requester.Email != fixtureStranger.Email || got.Items[0].RequestedAt == "" {
			t.Fatalf("%s: access requests = %+v, want the stranger's request", p.ID, got.Items)
		}
	}
	// Others see only their own request.
	rr = do(t, e.h, http.MethodGet, path, "", as(fixtureViewer))
	assertStatus(t, rr, http.StatusOK)
	assertJSON(t, rr.Body.Bytes(), `{"items":[]}`)
	rr = do(t, e.h, http.MethodGet, path, "", as(fixtureStranger))
	assertStatus(t, rr, http.StatusOK)
	var own struct{ Items []repo.AccessRequest }
	if err := json.Unmarshal(rr.Body.Bytes(), &own); err != nil {
		t.Fatal(err)
	}
	if len(own.Items) != 1 || own.Items[0].Requester.ID != fixtureStranger.ID {
		t.Fatalf("own access requests = %+v, want the stranger's request", own.Items)
	}

	rr = do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", `{"address":"`+fixtureStranger.Email+`","role":"viewer"}`, as(fixtureOwner))
	assertStatus(t, rr, http.StatusCreated)
	rr = do(t, e.h, http.MethodGet, path, "", as(fixtureOwner))
	assertStatus(t, rr, http.StatusOK)
	assertJSON(t, rr.Body.Bytes(), `{"items":[]}`)
}

// A person who manages access can decline a request. The request goes away
// with its notification, and the requester can ask again.
func TestAccessRequestDecline(t *testing.T) {
	e := newTestEnv(t)
	e.store.SetNotificationsEnabled(true)
	path := "/v1/documents/" + e.doc.ID + "/access-requests"
	declinePath := path + "/user/" + fixtureStranger.ID
	as := func(p auth.Principal) map[string]string {
		return map[string]string{"X-Test-Principal": principalHeader(p), "Content-Type": "application/json"}
	}
	queued := func() (n int) {
		if err := e.store.Pool().QueryRow(context.Background(), "SELECT count(*) FROM document_access_request_notification_outbox").Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	assertStatus(t, do(t, e.h, http.MethodPost, path, `{}`, as(fixtureStranger)), http.StatusAccepted)
	if n := queued(); n != 1 {
		t.Fatalf("queued=%d, want the owner's notification", n)
	}

	assertStatus(t, do(t, e.h, http.MethodDelete, declinePath, "", as(fixtureViewer)), http.StatusForbidden)
	assertStatus(t, do(t, e.h, http.MethodDelete, path+"/anyone/x", "", as(fixtureOwner)), http.StatusBadRequest)
	assertStatus(t, do(t, e.h, http.MethodDelete, declinePath, "", as(fixtureEditor)), http.StatusNoContent)
	if n := queued(); n != 0 {
		t.Fatalf("queued=%d after decline, want none", n)
	}
	for _, p := range []auth.Principal{fixtureOwner, fixtureStranger} {
		rr := do(t, e.h, http.MethodGet, path, "", as(p))
		assertStatus(t, rr, http.StatusOK)
		assertJSON(t, rr.Body.Bytes(), `{"items":[]}`)
	}

	assertStatus(t, do(t, e.h, http.MethodPost, path, `{}`, as(fixtureStranger)), http.StatusAccepted)
	rr := do(t, e.h, http.MethodGet, path, "", as(fixtureStranger))
	var got struct{ Items []repo.AccessRequest }
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Items) != 1 {
		t.Fatalf("access requests after a new request = %+v, want one", got.Items)
	}
}

func TestDocumentLinksEnforceAccessAndDocumentMembership(t *testing.T) {
	e := newTestEnv(t)
	other, ver, err := e.store.CreateDocument(context.Background(), fixtureOwner, "other", "", []byte("<h1>Other</h1>"))
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
