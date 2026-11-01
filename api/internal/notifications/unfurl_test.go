package notifications

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestLiveUnfurlEscapesRedactsAndListsFacts(t *testing.T) {
	card := LiveUnfurl(DocCard{
		Title:       "Plan <!channel> & more",
		URL:         "https://docs.example/app/d/doc_abc",
		Owner:       "Sudarshan Srinivas",
		Version:     27,
		OpenThreads: 1,
		Text:        "The OTP is 482913, use it.",
	})
	text := marshalPlain(t, card)
	for _, want := range []string{
		`*<https://docs.example/app/d/doc_abc|Plan &lt;!channel&gt; &amp; more>*`,
		`[redacted]`,
		`v27 · 1 open thread · Sudarshan Srinivas`,
		`"text":"Open doc"`,
		`"url":"https://docs.example/app/d/doc_abc"`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("card missing %s\n%s", want, text)
		}
	}
	if strings.Contains(text, "482913") {
		t.Fatalf("one-time code leaked into the card: %s", text)
	}
}

func TestLiveUnfurlLeavesOutMissingFacts(t *testing.T) {
	text := marshalPlain(t, LiveUnfurl(DocCard{URL: "https://d/app/d/doc_x", OpenThreads: 3}))
	if !strings.Contains(text, `"text":"3 open threads"`) || !strings.Contains(text, "Untitled document") {
		t.Fatalf("unexpected card: %s", text)
	}
}

func TestNeutralUnfurlNamesNothing(t *testing.T) {
	text := marshalPlain(t, NeutralUnfurl())
	if !strings.Contains(text, `"text":"SlashDocs document · Sign in to see if you have access"`) || strings.Contains(text, "button") {
		t.Fatalf("unexpected neutral card: %s", text)
	}
}

// marshalPlain encodes like the Slack client does on the wire, without Go's
// HTML escaping, so tests can look for the literal mrkdwn.
func marshalPlain(t *testing.T, v any) string {
	t.Helper()
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

func newFakeSlack(t *testing.T, handle func(method string, body []byte) string) *Slack {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(handle(strings.TrimPrefix(r.URL.Path, "/api/"), body)))
	}))
	t.Cleanup(server.Close)
	target, _ := url.Parse(server.URL)
	slack := NewSlack("xoxb-test")
	slack.client = &http.Client{Transport: testTransport{base: server.Client().Transport, target: target}}
	return slack
}

func TestSlackUnfurlUsesChannelOrComposerArguments(t *testing.T) {
	var got []map[string]any
	slack := newFakeSlack(t, func(method string, body []byte) string {
		if method != "chat.unfurl" {
			t.Errorf("method = %s", method)
		}
		var payload map[string]any
		_ = json.Unmarshal(body, &payload)
		got = append(got, payload)
		return `{"ok":true}`
	})
	unfurls := map[string]any{"https://d/app/d/doc_x": NeutralUnfurl()}
	if err := slack.Unfurl(context.Background(), UnfurlTarget{Channel: "C1", TS: "123.4", UnfurlID: "U8", Source: "conversations_history"}, unfurls); err != nil {
		t.Fatal(err)
	}
	if err := slack.Unfurl(context.Background(), UnfurlTarget{Channel: "COMPOSER", TS: "U9", UnfurlID: "U9", Source: "composer"}, unfurls); err != nil {
		t.Fatal(err)
	}
	if got[0]["channel"] != "C1" || got[0]["ts"] != "123.4" || got[0]["unfurl_id"] != nil {
		t.Errorf("message unfurl payload = %v", got[0])
	}
	if got[1]["unfurl_id"] != "U9" || got[1]["source"] != "composer" || got[1]["channel"] != nil {
		t.Errorf("composer unfurl payload = %v", got[1])
	}
}

func TestSlackUnfurlKeepsSlackErrorCodes(t *testing.T) {
	slack := newFakeSlack(t, func(string, []byte) string { return `{"ok":false,"error":"cannot_unfurl_url"}` })
	err := slack.Unfurl(context.Background(), UnfurlTarget{Channel: "C1", TS: "1.2"}, map[string]any{})
	var de *DeliveryError
	if !errors.As(err, &de) || de.Code != "cannot_unfurl_url" {
		t.Fatalf("err = %v, want cannot_unfurl_url", err)
	}
}

func TestSlackIsExternalChannelDetectsOtherOrganisations(t *testing.T) {
	cases := map[string]bool{
		`{"ok":true,"channel":{"is_ext_shared":true}}`:         true,
		`{"ok":true,"channel":{"is_pending_ext_shared":true}}`: true,
		`{"ok":true,"channel":{"is_org_shared":true}}`:         false,
		`{"ok":true,"channel":{}}`:                             false,
	}
	for response, want := range cases {
		slack := newFakeSlack(t, func(method string, _ []byte) string { return response })
		got, err := slack.IsExternalChannel(context.Background(), "C1")
		if err != nil || got != want {
			t.Errorf("%s: external = %v, err = %v, want %v", response, got, err, want)
		}
	}
	slack := newFakeSlack(t, func(string, []byte) string { return `{"ok":false,"error":"channel_not_found"}` })
	if got, err := slack.IsExternalChannel(context.Background(), "G1"); err == nil || !got {
		t.Fatalf("lookup failure must report external: got %v, err %v", got, err)
	}
}
