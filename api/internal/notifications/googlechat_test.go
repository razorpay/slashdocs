package notifications

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestGoogleChatWebhookPostsEscapedCardNamingRecipient(t *testing.T) {
	var got map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/spaces/AAA/messages" || r.URL.Query().Get("key") != "k" || r.Header.Get("Authorization") != "" {
			t.Errorf("unexpected webhook request %s %q auth=%q", r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Error(err)
		}
		_, _ = w.Write([]byte(`{"name":"spaces/AAA/messages/1"}`))
	}))
	defer server.Close()
	chat, err := NewGoogleChatWebhook("https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t")
	if err != nil {
		t.Fatal(err)
	}
	target, _ := url.Parse(server.URL)
	chat.client = &http.Client{Transport: testTransport{base: server.Client().Transport, target: target}}
	err = chat.Send(context.Background(), "alice@example.com", Message{Reason: "owner", Link: "https://slashdocs.example.com/app/d/doc_1?comment=cmt_1", DocumentTitle: "Plan", Highlight: "Ship <b>now</b>", Body: "ping <users/all> and <https://evil.example|docs>"})
	if err != nil {
		t.Fatal(err)
	}
	var buf strings.Builder
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // compare the text Chat will actually receive
	_ = enc.Encode(got)
	s := buf.String()
	for _, want := range []string{"For:", "alice@example.com", "View comment", "&lt;users/all&gt;", "Ship &lt;b&gt;now&lt;/b&gt;"} {
		if !strings.Contains(s, want) {
			t.Errorf("payload missing %q: %s", want, s)
		}
	}
	if strings.Contains(s, "<users/all>") || got["text"] != nil {
		t.Errorf("unescaped user content: %s", s)
	}
}

func TestGoogleChatWebhookRetriesRateLimitsAndServerErrors(t *testing.T) {
	cases := []struct {
		status     int
		retryAfter time.Duration
		permanent  bool
	}{
		{http.StatusTooManyRequests, 42 * time.Second, false},
		{http.StatusServiceUnavailable, 0, false},
		{http.StatusForbidden, 0, true},
	}
	for _, tc := range cases {
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Retry-After", "42")
			w.WriteHeader(tc.status)
		}))
		chat, err := NewGoogleChatWebhook("https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t")
		if err != nil {
			t.Fatal(err)
		}
		target, _ := url.Parse(server.URL)
		chat.client = &http.Client{Transport: testTransport{base: server.Client().Transport, target: target}}
		err = chat.Send(context.Background(), "bob@example.com", Message{Reason: "owner", Body: "hi"})
		server.Close()
		var delivery *DeliveryError
		if !errors.As(err, &delivery) || delivery.RetryAfter != tc.retryAfter || delivery.Permanent != tc.permanent {
			t.Errorf("status %d: delivery error=%v", tc.status, err)
		}
	}
}

func TestGoogleChatWebhookRejectsForeignURLs(t *testing.T) {
	for _, raw := range []string{
		"http://chat.googleapis.com/v1/spaces/AAA/messages?key=k",
		"https://example.com/v1/spaces/AAA/messages?key=k",
		"https://chat.googleapis.com/v1/users/AAA",
		"not a url",
	} {
		if _, err := NewGoogleChatWebhook(raw); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
}

func TestGoogleChatHeaderNamesActorAsPlainText(t *testing.T) {
	payload := googleChatMessage(Message{Reason: "owner", Actor: "Mallory <users/all>", DocumentTitle: "Plan", Body: "hi"}, "")
	card := payload["cardsV2"].([]any)[0].(map[string]any)["card"].(map[string]any)
	header := card["header"].(map[string]any)
	// Card headers are plain text in Chat, so markup stays literal rather than
	// becoming a mention; the top-level text that would parse it is unset.
	if header["title"] != "💬 Mallory <users/all> commented on your doc" || payload["text"] != nil {
		t.Errorf("header=%v text=%v", header, payload["text"])
	}
}

func TestGoogleChatAccessRemovalHasNoButton(t *testing.T) {
	encoded, _ := json.Marshal(googleChatMessage(Message{Reason: "access_removed", DocumentTitle: "Plan", PreviousRole: "editor"}, ""))
	s := string(encoded)
	if strings.Contains(s, "buttonList") || !strings.Contains(s, "Previous access: Editor") {
		t.Errorf("payload: %s", s)
	}
}
