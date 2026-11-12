package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"unicode/utf16"
)

func TestCLIMentionsResolveEmailsAndCalculateUTF16Offsets(t *testing.T) {
	var received struct {
		Body     string           `json:"body"`
		Mentions []commentMention `json:"mentions"`
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/users" {
			writeTestJSON(t, w, map[string]any{"items": []mentionUser{{Type: "user", ID: "usr_alice", Email: "alice@example.com"}}})
			return
		}
		if r.Header.Get("Content-Type") != "application/vnd.slashdocs.comment-mentions+json" {
			t.Error("missing structured mention media type")
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		writeTestJSON(t, w, map[string]string{"id": "cmt_1"})
	}))
	defer server.Close()
	client := Client{Base: server.URL, HTTP: server.Client()}
	body := "🙂 Please review @alice@example.com"
	_, err := client.commentJSON("POST", "/comments", map[string]any{"body": body}, []string{"alice@example.com", "alice@example.com", "sa:sa_review"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if received.Body != body+" @sa_review" || len(received.Mentions) != 2 {
		t.Fatalf("payload=%#v", received)
	}
	if received.Mentions[0].Offset != len(utf16.Encode([]rune("🙂 Please review "))) || received.Mentions[1].Principal.Type != "service_account" {
		t.Fatalf("mentions=%#v", received.Mentions)
	}
	_, err = client.commentJSON("PATCH", "/comments", map[string]any{}, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(received.Mentions) != 0 {
		t.Fatal("clear mentions must send an empty array")
	}
}
