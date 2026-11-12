package auth_test

import (
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

func TestNewBearerToken(t *testing.T) {
	raw, hash, err := auth.NewBearerToken("slashdocs_cli_")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(raw, "slashdocs_cli_") {
		t.Fatalf("token %q missing prefix", raw)
	}
	if got := auth.HashToken(raw); got != hash {
		t.Fatalf("HashToken(raw) = %q, want %q", got, hash)
	}
	raw2, _, err := auth.NewBearerToken("slashdocs_cli_")
	if err != nil {
		t.Fatal(err)
	}
	if raw == raw2 {
		t.Fatal("two generated tokens are identical")
	}
}

func TestHashTokenIsDeterministicHex(t *testing.T) {
	a, b := auth.HashToken("tok"), auth.HashToken("tok")
	if a != b {
		t.Fatalf("HashToken not deterministic: %q vs %q", a, b)
	}
	if len(a) != 64 { // sha256 hex
		t.Fatalf("hash length = %d, want 64", len(a))
	}
	if auth.HashToken("other") == a {
		t.Fatal("distinct tokens hashed identically")
	}
}

func TestBearerFromHeader(t *testing.T) {
	tests := []struct {
		header string
		want   string
	}{
		{"Bearer abc", "abc"},
		{"bearer abc", "abc"},
		{"BEARER  abc ", "abc"},
		{"Basic abc", ""},
		{"", ""},
		{"Bearer", ""},
	}
	for _, tt := range tests {
		if got := auth.BearerFromHeader(tt.header); got != tt.want {
			t.Fatalf("BearerFromHeader(%q) = %q, want %q", tt.header, got, tt.want)
		}
	}
}
