// Package webhooks delivers approval events to an external HTTP endpoint, such
// as a task tracker. Events wait in a database outbox until the endpoint
// accepts them: delivery is at least once, and each event carries its ID as an
// idempotency key.
package webhooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

// maxAge is how long an event waits for delivery before it is dropped.
const maxAge = 7 * 24 * time.Hour

type Store interface {
	ClaimApprovalEvent(context.Context) (*repo.ApprovalEvent, error)
	FinishApprovalEvent(context.Context, repo.ApprovalEvent, time.Duration) error
	ExpireApprovalEvents(context.Context, time.Duration) (int64, error)
}

// Endpoint is where events go. Secret signs each request.
type Endpoint struct {
	URL    string
	Secret []byte
}

type Worker struct {
	store    Store
	endpoint Endpoint
	client   *http.Client
}

func NewWorker(store Store, endpoint Endpoint) *Worker {
	return &Worker{store: store, endpoint: endpoint, client: &http.Client{
		Timeout:       10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

// Run delivers due events once a second until ctx ends. After a failed
// delivery it waits for the next tick, because the endpoint is likely down.
func (w *Worker) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		expired, err := w.store.ExpireApprovalEvents(ctx, maxAge)
		if err != nil {
			slog.Error("approval webhook expiry failed", "error", err)
		} else if expired > 0 {
			slog.Error("approval webhook events expired undelivered", "count", expired)
		}
		for {
			delivered, err := w.DeliverNext(ctx)
			if err != nil {
				slog.Error("approval webhook processing failed", "error", err)
			}
			if !delivered {
				break
			}
		}
	}
}

// DeliverNext posts the next due event and reports whether the endpoint
// accepted it. A failed post is retried with exponential backoff.
func (w *Worker) DeliverNext(ctx context.Context) (bool, error) {
	e, err := w.store.ClaimApprovalEvent(ctx)
	if err != nil || e == nil {
		return false, err
	}
	var retryAfter time.Duration
	if err := w.post(ctx, *e); err != nil {
		retryAfter = backoff(e.Attempts)
		slog.Warn("approval webhook delivery failed", "event_id", e.ID, "attempts", e.Attempts, "retry_after", retryAfter, "error", err)
	}
	return retryAfter == 0, w.store.FinishApprovalEvent(ctx, *e, retryAfter)
}

func backoff(attempts int) time.Duration {
	return min(time.Duration(1<<min(attempts, 12))*time.Second, time.Hour)
}

// post sends one event. The headers follow the Standard Webhooks layout: the
// signature is HMAC-SHA256 over "<id>.<timestamp>.<body>", base64 encoded.
func (w *Worker) post(ctx context.Context, e repo.ApprovalEvent) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, w.endpoint.URL, bytes.NewReader(e.Payload))
	if err != nil {
		return err
	}
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "slashdocs-webhooks")
	req.Header.Set("webhook-id", e.ID)
	req.Header.Set("webhook-timestamp", timestamp)
	req.Header.Set("webhook-signature", "v1,"+Sign(w.endpoint.Secret, e.ID, timestamp, e.Payload))
	res, err := w.client.Do(req)
	// Report the cause without the URL, which can hold a credential.
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err
	}
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("status %d", res.StatusCode)
	}
	return nil
}

// Sign returns the base64 HMAC-SHA256 of "<id>.<timestamp>.<body>" with
// secret, which a receiver computes to check a request.
func Sign(secret []byte, id, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	_, _ = fmt.Fprintf(mac, "%s.%s.", id, timestamp)
	_, _ = mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}
