package cli

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGoogleGroupGrantFlagsPayloadAndOutput(t *testing.T) {
	var requests []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		requests = append(requests, body)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "gr_1", "role": body["role"],
			"principal": map[string]any{"type": "google_group", "id": "groups/1", "email": "platform@example.com", "name": "Platform"},
		})
	}))
	defer server.Close()
	t.Setenv("SLASHDOCS_SERVER", server.URL)
	t.Setenv("SLASHDOCS_TOKEN", "token")
	t.Setenv("SLASHDOCS_DISABLE_AUTO_UPDATE", "1")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	out, err := Execute([]string{"docs", "grants", "add", "doc_1", "--group", "platform@example.com", "--role", "editor"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "platform@example.com") || !strings.Contains(out, "editor") {
		t.Fatalf("human output = %q", out)
	}
	out, err = Execute([]string{"--json", "folders", "grants", "add", "fld_1", "--group", "platform@example.com", "--role", "viewer"})
	if err != nil {
		t.Fatal(err)
	}
	var jsonOutput map[string]any
	if err := json.Unmarshal([]byte(out), &jsonOutput); err != nil {
		t.Fatalf("JSON output=%q err=%v", out, err)
	}
	principal, _ := jsonOutput["principal"].(map[string]any)
	if principal["id"] != "groups/1" || principal["email"] != "platform@example.com" {
		t.Fatalf("JSON principal = %#v", principal)
	}
	if len(requests) != 2 {
		t.Fatalf("requests = %d", len(requests))
	}
	for _, body := range requests {
		principal, _ := body["principal"].(map[string]any)
		if principal["type"] != "google_group" || principal["email"] != "platform@example.com" || principal["id"] != nil {
			t.Fatalf("group payload = %#v", body)
		}
	}
}

func TestGoogleGroupGrantFlagsAreMutuallyExclusiveUsageErrors(t *testing.T) {
	for _, args := range [][]string{
		{"docs", "grants", "add", "doc_1", "--group", "g@example.com", "--to", "u@example.com"},
		{"docs", "grants", "add", "doc_1", "--group", "g@example.com", "--everyone"},
		{"docs", "grants", "add", "doc_1", "--group", "g@example.com", "--principal", "user:u@example.com"},
		{"folders", "grants", "add", "fld_1", "--group", "g@example.com", "--to", "u@example.com"},
	} {
		_, err := Execute(args)
		if err == nil {
			t.Fatalf("%v succeeded", args)
		}
		var usage usageError
		if !errors.As(err, &usage) || ExitCode(err) != 2 || !strings.Contains(err.Error(), "mutually exclusive") {
			t.Fatalf("%v error=%T %v exit=%d", args, err, err, ExitCode(err))
		}
	}
}

func TestGoogleGroupGrantHelpDocumentsGroupSyntax(t *testing.T) {
	for _, args := range [][]string{{"docs", "grants", "add", "--help"}, {"folders", "grants", "add", "--help"}} {
		out, err := Execute(args)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out, "--group") || !strings.Contains(out, "Google Group") {
			t.Fatalf("help missing group syntax: %s", out)
		}
	}
}
