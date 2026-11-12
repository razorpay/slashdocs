package notifications

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

type testTransport struct {
	base   http.RoundTripper
	target *url.URL
}

func (t testTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.URL.Scheme = t.target.Scheme
	r.URL.Host = t.target.Host
	return t.base.RoundTrip(r)
}

func TestSlackDeliveryUsesPrivateMessagesAndHonorsRateLimits(t *testing.T) {
	var paths []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.Method != "POST" || r.URL.RawQuery != "" {
			t.Error("identity must travel in POST body")
		}
		var body map[string]any
		if r.URL.Path == "/api/users.lookupByEmail" {
			if r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
				t.Error("Slack email lookup requires a form-encoded body")
			}
			if err := r.ParseForm(); err != nil {
				t.Error(err)
				return
			}
			if r.PostForm.Get("email") != "alice@example.com" {
				t.Error("lookup email missing")
			}
		} else if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		var result any
		switch r.URL.Path {
		case "/api/users.lookupByEmail":
			result = map[string]any{"ok": true, "user": map[string]any{"id": "U1"}}
		case "/api/conversations.open":
			result = map[string]any{"ok": true, "channel": map[string]any{"id": "D1"}}
		case "/api/chat.postMessage":
			if body["channel"] != "D1" || body["unfurl_links"] != false || body["mrkdwn"] != false {
				t.Errorf("unsafe message: %#v", body)
			}
			w.Header().Set("Retry-After", "42")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		default:
			t.Error("unexpected Slack method")
		}
		if err := json.NewEncoder(w).Encode(result); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	target, _ := url.Parse(server.URL)
	slack := NewSlack("test-only-token")
	slack.client = &http.Client{Transport: testTransport{base: server.Client().Transport, target: target}}
	err := slack.Send(context.Background(), "alice@example.com", Message{Reason: "mention", Link: "https://slashdocs.example.com/app/d/doc_1?comment=cmt_1", DocumentTitle: "Launch review", Highlight: "Ship on Friday", Body: "Please review"})
	var delivery *DeliveryError
	if !errors.As(err, &delivery) || delivery.RetryAfter != 42*time.Second || len(paths) != 3 {
		t.Fatalf("delivery error=%v paths=%v", err, paths)
	}
}
