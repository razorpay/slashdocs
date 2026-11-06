package server

import "testing"

func TestMCPRedirectTarget(t *testing.T) {
	for _, tc := range []struct{ uri, want string }{
		{"https://client.example:8443/callback", "client.example:8443"},
		{"http://[::1]:5678/callback", "http://[::1]:5678"},
		{"cursor://client.example/callback", "cursor://client.example"},
		{"app:callback", "app:callback"},
		{"https://%/callback", "https://%/callback"},
	} {
		if got := mcpRedirectTarget(tc.uri); got != tc.want {
			t.Errorf("mcpRedirectTarget(%q) = %q, want %q", tc.uri, got, tc.want)
		}
	}
}

func TestMCPRequestLimitPreservesHTMLEscapingHeadroom(t *testing.T) {
	// A JSON encoder may represent one input byte as a six-byte escape. Leave
	// another MiB for the JSON-RPC request and tool argument envelope.
	const minimum = int64(maxHTMLBytes*6 + (1 << 20))
	if maxMCPRequestBytes < minimum {
		t.Fatalf("MCP request limit = %d, want at least %d for a maximally escaped HTML payload", maxMCPRequestBytes, minimum)
	}
}
