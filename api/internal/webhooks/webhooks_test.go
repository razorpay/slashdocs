package webhooks_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/testdb"
	"github.com/razorpay/slashdocs/api/internal/webhooks"
)

var secret = []byte("0123456789abcdef0123456789abcdef")

type received struct {
	id, timestamp, signature string
	body                     []byte
}

// endpoint records each request and answers with the next status in line,
// then 204.
type endpoint struct {
	mu       sync.Mutex
	statuses []int
	requests []received
}

func (e *endpoint) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	e.mu.Lock()
	defer e.mu.Unlock()
	e.requests = append(e.requests, received{r.Header.Get("webhook-id"), r.Header.Get("webhook-timestamp"), r.Header.Get("webhook-signature"), body})
	status := http.StatusNoContent
	if len(e.statuses) > 0 {
		status, e.statuses = e.statuses[0], e.statuses[1:]
	}
	w.WriteHeader(status)
}

type event struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Sequence int64  `json:"sequence"`
	Document struct {
		ID, Title, URL string
	} `json:"document"`
	Version struct {
		Number int `json:"number"`
	} `json:"version"`
	Approver *struct {
		Email string `json:"email"`
	} `json:"approver"`
	Actor struct {
		Email string `json:"email"`
	} `json:"actor"`
	Note    string               `json:"note"`
	Status  string               `json:"status"`
	Summary repo.ApprovalSummary `json:"summary"`
}

func TestApprovalEventsReachTheWebhook(t *testing.T) {
	ctx := context.Background()
	store, err := pgrepo.Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_hook_owner", Email: "owner@example.com"}
	reviewer := auth.Principal{Type: auth.PrincipalUser, ID: "usr_hook_reviewer", Email: "reviewer@example.com"}
	for _, p := range []auth.Principal{owner, reviewer} {
		if _, err := store.UpsertGoogleUser(ctx, p.ID, p.Email, "", p.ID+"-sub", ""); err != nil {
			t.Fatal(err)
		}
	}
	doc, v1, err := store.CreateDocument(ctx, owner, "Launch plan", "", []byte("<p>one</p>"))
	if err != nil {
		t.Fatal(err)
	}
	queued := func() int {
		t.Helper()
		var n int
		if err := store.Pool().QueryRow(ctx, "SELECT count(*) FROM approval_event_outbox").Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	// Off by default: nothing is queued.
	request, err := store.CreateApprovalRequest(ctx, doc.ID, reviewer, owner)
	if err != nil {
		t.Fatal(err)
	}
	if queued() != 0 {
		t.Fatal("approval events were queued without a webhook")
	}
	if err := store.DeleteApprovalRequest(ctx, doc.ID, request.ID, owner); err != nil {
		t.Fatal(err)
	}

	store.EnableApprovalEvents("https://slashdocs.example.com/")
	if _, err := store.CreateApprovalRequest(ctx, doc.ID, reviewer, owner); err != nil {
		t.Fatal(err)
	}
	// Repeating the same decision changes nothing, so it sends no event.
	for range 2 {
		if _, _, err := store.CreateOrUpdateApproval(ctx, doc.ID, v1.ID, nil, repo.DecisionRejected, "needs a rollback plan", reviewer); err != nil {
			t.Fatal(err)
		}
	}
	if queued() != 2 {
		t.Fatalf("queued = %d, want one event for the request and one for the decision", queued())
	}
	if _, _, err := store.SaveVersion(ctx, doc.ID, v1.ID, nil, owner, repo.Upload([]byte("<p>two</p>"), "")); err != nil {
		t.Fatal(err)
	}

	hook := &endpoint{statuses: []int{http.StatusServiceUnavailable}}
	srv := httptest.NewServer(hook)
	defer srv.Close()
	w := webhooks.NewWorker(store, webhooks.Endpoint{URL: srv.URL, Secret: secret})

	// The first post fails, so that event waits for a retry.
	if delivered, err := w.DeliverNext(ctx); err != nil || delivered {
		t.Fatalf("first delivery = %v, %v; want a failure", delivered, err)
	}
	for {
		delivered, err := w.DeliverNext(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !delivered {
			break
		}
	}
	if queued() != 1 {
		t.Fatalf("queued = %d, want only the failed event", queued())
	}
	if _, err := store.Pool().Exec(ctx, "UPDATE approval_event_outbox SET available_at=now()"); err != nil {
		t.Fatal(err)
	}
	if delivered, err := w.DeliverNext(ctx); err != nil || !delivered {
		t.Fatalf("retry = %v, %v; want delivered", delivered, err)
	}
	if queued() != 0 {
		t.Fatalf("queued = %d after the retry, want 0", queued())
	}

	// Four posts: the failed one, two more, and the retry of the first.
	if len(hook.requests) != 4 || hook.requests[3].id != hook.requests[0].id {
		t.Fatalf("requests = %d, want 4 with the retry reusing the event id", len(hook.requests))
	}
	byType := map[string]event{}
	for _, r := range hook.requests {
		if r.signature != "v1,"+webhooks.Sign(secret, r.id, r.timestamp, r.body) {
			t.Fatalf("request %s has a bad signature", r.id)
		}
		var e event
		if err := json.Unmarshal(r.body, &e); err != nil {
			t.Fatal(err)
		}
		if e.ID != r.id {
			t.Fatalf("payload id %q, header id %q", e.ID, r.id)
		}
		byType[e.Type] = e
	}
	requested, rejected, created := byType[repo.ApprovalEventRequested], byType[repo.ApprovalEventRejected], byType[repo.ApprovalEventVersionCreated]
	if requested.Document.URL != "https://slashdocs.example.com/app/d/"+doc.ID || requested.Document.Title != "Launch plan" ||
		requested.Approver == nil || requested.Approver.Email != reviewer.Email || requested.Actor.Email != owner.Email ||
		requested.Status != repo.StatusPending || requested.Summary.Total != 1 {
		t.Fatalf("requested event = %+v", requested)
	}
	if rejected.Note != "needs a rollback plan" || rejected.Status != repo.DecisionRejected || rejected.Summary.Rejected != 1 || rejected.Actor.Email != reviewer.Email {
		t.Fatalf("rejected event = %+v", rejected)
	}
	if created.Approver != nil || created.Version.Number != 2 || created.Status != repo.StatusPending || created.Summary.Pending != 1 {
		t.Fatalf("version_created event = %+v", created)
	}
	if requested.Sequence >= rejected.Sequence || rejected.Sequence >= created.Sequence {
		t.Fatalf("sequences = %d, %d, %d; want them in the order of the changes", requested.Sequence, rejected.Sequence, created.Sequence)
	}
}
