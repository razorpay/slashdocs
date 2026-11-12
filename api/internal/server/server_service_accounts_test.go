package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

func TestCreateServiceAccountStartsWithoutDocumentGrants(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/service-accounts", `{"label":"report-bot","domain":"explicit.test.bot"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureUser),
	})

	assertStatus(t, rr, http.StatusCreated)
	var got map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	key, _ := got["key"].(map[string]any)
	if tok, _ := key["token"].(string); !strings.HasPrefix(tok, auth.ServiceAccountPrefix) {
		t.Fatalf("expected %s token, got %v", auth.ServiceAccountPrefix, key)
	}
	saID, _ := got["id"].(string)
	if !strings.HasPrefix(saID, "sa_") {
		t.Fatalf("expected sa_ id, got %v", got["id"])
	}
	delete(got, "key")
	normalised, _ := json.Marshal(got)
	assertJSON(t, normalised, fmt.Sprintf(`{
	  "id": %q,
	  "label": "report-bot",
	  "name": "report-bot@explicit.test.bot",
	  "owner": { "id": "usr_1", "email": "anurag@example.com" },
	  "disabled": false,
	  "grants": []
	}`, saID))
}

func TestNonOwnerCannotCreateServiceAccountKey(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/service-accounts/"+e.sa.ID+"/keys", `{"name":"stolen"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureAttacker),
	})

	assertStatus(t, rr, http.StatusForbidden)
}

func TestNonOwnerCannotListServiceAccountKeys(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodGet, "/v1/service-accounts/"+e.sa.ID+"/keys", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureAttacker),
	})

	assertStatus(t, rr, http.StatusForbidden)
}

func TestNonOwnerCannotRevokeServiceAccountKey(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodDelete, "/v1/service-accounts/"+e.sa.ID+"/keys/sak_1", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureAttacker),
	})

	assertStatus(t, rr, http.StatusForbidden)
}

func TestNonOwnerCannotPatchServiceAccount(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPatch, "/v1/service-accounts/"+e.sa.ID, `{"disabled":true}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureAttacker),
	})

	assertStatus(t, rr, http.StatusForbidden)
}

func TestNonOwnerCannotTransferServiceAccount(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/service-accounts/"+e.sa.ID+"/transfer", `{"to_user_email":"attacker@example.com"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureAttacker),
	})

	assertStatus(t, rr, http.StatusForbidden)
}

func TestAcceptDeclinedOwnershipTransferIsRejected(t *testing.T) {
	e := newTestEnv(t)
	newOwner := auth.Principal{Type: auth.PrincipalUser, ID: "new_owner_1", Email: "new_owner@example.com", Name: "New Owner"}
	e.seedUser(newOwner)

	create := do(t, e.h, http.MethodPost, "/v1/service-accounts/"+e.sa.ID+"/transfer", `{"to_user_email":"new_owner@example.com"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, create, http.StatusCreated)
	transferID := jsonField(t, create.Body.Bytes(), "id")

	decline := do(t, e.h, http.MethodPost, "/v1/service-accounts/transfers/"+transferID+"/decline", "", map[string]string{
		"X-Test-Principal": principalHeader(newOwner),
	})
	assertStatus(t, decline, http.StatusNoContent)

	rr := do(t, e.h, http.MethodPost, "/v1/service-accounts/transfers/"+transferID+"/accept", "", map[string]string{
		"X-Test-Principal": principalHeader(newOwner),
	})

	assertStatus(t, rr, http.StatusConflict)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "invalid_transfer_state", "message": "transfer is not pending" }
	}`)
}

func TestPatchServiceAccountName(t *testing.T) {
	e := newTestEnv(t)
	create := func(label string) string {
		rr := do(t, e.h, http.MethodPost, "/v1/service-accounts", `{"label":"`+label+`","domain":"custom.test.bot"}`, map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureUser),
		})
		assertStatus(t, rr, http.StatusCreated)
		return jsonField(t, rr.Body.Bytes(), "id")
	}
	create("taken-bot")
	saID := create("my-bot")
	patch := func(name string) *httptest.ResponseRecorder {
		return do(t, e.h, http.MethodPatch, "/v1/service-accounts/"+saID, fmt.Sprintf(`{"name":%q}`, name), map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureUser),
		})
	}

	for _, name := range []string{"taken-bot", "taken-bot@custom.test.bot"} {
		rr := patch(name)
		assertStatus(t, rr, http.StatusConflict)
		assertJSON(t, rr.Body.Bytes(), `{
		  "error": { "code": "address_taken", "message": "Someone already uses taken-bot@custom.test.bot. Try a different address." }
		}`)
	}
	for _, tc := range []struct{ name, want string }{
		{"renamed-bot", "renamed-bot@custom.test.bot"},
		{"new-bot@other.domain.bot", "new-bot@other.domain.bot"},
	} {
		rr := patch(tc.name)
		assertStatus(t, rr, http.StatusOK)
		if got := jsonField(t, rr.Body.Bytes(), "name"); got != tc.want {
			t.Fatalf("rename to %q: name = %q, want %q", tc.name, got, tc.want)
		}
	}
	for _, tc := range []struct{ name, message string }{
		{"Not A Valid Label", "Use letters, numbers, and hyphens for the bot's name."},
		{"has_underscore", "Use letters, numbers, and hyphens for the bot's name."},
		{"-start@custom.test.bot", "Use letters, numbers, and hyphens for the bot's name."},
		{"admin@example.com", "Addresses must end in .bot."},
		{"bot@notbot", "Addresses must end in .bot."},
	} {
		rr := patch(tc.name)
		assertStatus(t, rr, http.StatusBadRequest)
		assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{"error": {"code": "bad_request", "message": %q}}`, tc.message))
	}
}

// The web app sends the current name with every enable or disable, also a
// name from before names were .bot addresses.
func TestPatchServiceAccountKeepsCurrentName(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPatch, "/v1/service-accounts/"+e.sa.ID, `{"name":"fixture","disabled":true}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusOK)
	if got := jsonField(t, rr.Body.Bytes(), "name"); got != "fixture" {
		t.Fatalf("name = %q, want fixture", got)
	}
}
