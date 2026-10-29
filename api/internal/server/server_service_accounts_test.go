package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
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

func TestPatchServiceAccountName_BareLabelKeepsDomain(t *testing.T) {
	e := newTestEnv(t)
	create := do(t, e.h, http.MethodPost, "/v1/service-accounts", `{"label":"my-bot","domain":"custom.test.bot"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureUser),
	})
	assertStatus(t, create, http.StatusCreated)
	saID := jsonField(t, create.Body.Bytes(), "id")

	rr := do(t, e.h, http.MethodPatch, "/v1/service-accounts/"+saID, `{"name":"renamed-bot"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureUser),
	})
	assertStatus(t, rr, http.StatusOK)
	if got := jsonField(t, rr.Body.Bytes(), "name"); got != "renamed-bot@custom.test.bot" {
		t.Fatalf("name = %q, want %q", got, "renamed-bot@custom.test.bot")
	}
}

func TestPatchServiceAccountName_FullBotAddress(t *testing.T) {
	e := newTestEnv(t)
	create := do(t, e.h, http.MethodPost, "/v1/service-accounts", `{"label":"my-bot","domain":"custom.test.bot"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureUser),
	})
	assertStatus(t, create, http.StatusCreated)
	saID := jsonField(t, create.Body.Bytes(), "id")

	rr := do(t, e.h, http.MethodPatch, "/v1/service-accounts/"+saID, `{"name":"new-bot@other.domain.bot"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureUser),
	})
	assertStatus(t, rr, http.StatusOK)
	if got := jsonField(t, rr.Body.Bytes(), "name"); got != "new-bot@other.domain.bot" {
		t.Fatalf("name = %q, want %q", got, "new-bot@other.domain.bot")
	}
}

func TestPatchServiceAccountName_RejectsInvalidLabel(t *testing.T) {
	e := newTestEnv(t)
	create := do(t, e.h, http.MethodPost, "/v1/service-accounts", `{"label":"my-bot","domain":"custom.test.bot"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureUser),
	})
	assertStatus(t, create, http.StatusCreated)
	saID := jsonField(t, create.Body.Bytes(), "id")

	for _, invalid := range []string{"Not A Valid Label", "-start-hyphen", "end-hyphen-", "has space", "has_underscore", ""} {
		rr := do(t, e.h, http.MethodPatch, "/v1/service-accounts/"+saID, fmt.Sprintf(`{"name":%q}`, invalid), map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureUser),
		})
		assertStatus(t, rr, http.StatusBadRequest)
		assertJSON(t, rr.Body.Bytes(), `{
		  "error": { "code": "bad_request", "message": "Use letters, numbers, and hyphens for the bot's name." }
		}`)
	}
}

func TestPatchServiceAccountName_RejectsNonBotAddress(t *testing.T) {
	e := newTestEnv(t)
	create := do(t, e.h, http.MethodPost, "/v1/service-accounts", `{"label":"my-bot","domain":"custom.test.bot"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureUser),
	})
	assertStatus(t, create, http.StatusCreated)
	saID := jsonField(t, create.Body.Bytes(), "id")

	for _, invalid := range []string{"admin@example.com", "user@gmail.com", "bot@notbot", "bot@domain.com"} {
		rr := do(t, e.h, http.MethodPatch, "/v1/service-accounts/"+saID, fmt.Sprintf(`{"name":%q}`, invalid), map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(fixtureUser),
		})
		assertStatus(t, rr, http.StatusBadRequest)
		assertJSON(t, rr.Body.Bytes(), `{
		  "error": { "code": "bad_request", "message": "Addresses must end in .bot." }
		}`)
	}
}

func TestPatchServiceAccountName_ConflictReturns409(t *testing.T) {
	e := newTestEnv(t)
	sa1 := do(t, e.h, http.MethodPost, "/v1/service-accounts", `{"label":"bot-one","domain":"shared.test.bot"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureUser),
	})
	assertStatus(t, sa1, http.StatusCreated)

	sa2 := do(t, e.h, http.MethodPost, "/v1/service-accounts", `{"label":"bot-two","domain":"shared.test.bot"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureUser),
	})
	assertStatus(t, sa2, http.StatusCreated)
	sa2ID := jsonField(t, sa2.Body.Bytes(), "id")

	// Renaming sa2 to sa1's bare label (within same domain)
	rr := do(t, e.h, http.MethodPatch, "/v1/service-accounts/"+sa2ID, `{"name":"bot-one"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureUser),
	})
	assertStatus(t, rr, http.StatusConflict)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "address_taken", "message": "Someone already uses bot-one@shared.test.bot. Try a different address." }
	}`)

	// Renaming sa2 to sa1's full address
	rr2 := do(t, e.h, http.MethodPatch, "/v1/service-accounts/"+sa2ID, `{"name":"bot-one@shared.test.bot"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureUser),
	})
	assertStatus(t, rr2, http.StatusConflict)
	assertJSON(t, rr2.Body.Bytes(), `{
	  "error": { "code": "address_taken", "message": "Someone already uses bot-one@shared.test.bot. Try a different address." }
	}`)
}
