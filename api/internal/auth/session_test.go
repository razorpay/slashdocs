package auth_test

import (
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

func TestSessionCodecRoundTrip(t *testing.T) {
	codec := auth.SessionCodec{Secret: []byte("test-secret")}
	tok := codec.Sign("usr_1")
	uid, ok := codec.VerifySession(tok)
	if !ok || uid != "usr_1" {
		t.Fatalf("VerifySession = (%q, %v), want (\"usr_1\", true)", uid, ok)
	}
}

func TestSessionCodecRejectsWrongSecret(t *testing.T) {
	tok := (auth.SessionCodec{Secret: []byte("secret-a")}).Sign("usr_1")
	if _, ok := (auth.SessionCodec{Secret: []byte("secret-b")}).VerifySession(tok); ok {
		t.Fatal("session signed with a different secret verified")
	}
}

func TestSessionCodecRejectsTamperedToken(t *testing.T) {
	codec := auth.SessionCodec{Secret: []byte("test-secret")}
	tok := codec.Sign("usr_1")
	tampered := []byte(tok)
	// Flip a character inside the payload segment (after the "v1." prefix).
	if tampered[4] == 'A' {
		tampered[4] = 'B'
	} else {
		tampered[4] = 'A'
	}
	if _, ok := codec.VerifySession(string(tampered)); ok {
		t.Fatal("tampered session token verified")
	}
}

func TestSessionCodecRejectsMalformedTokens(t *testing.T) {
	codec := auth.SessionCodec{Secret: []byte("test-secret")}
	for _, tok := range []string{"", "v1", "v1.only-two", "v2.a.b", "v1.!!!.!!!"} {
		if _, ok := codec.VerifySession(tok); ok {
			t.Fatalf("malformed token %q verified", tok)
		}
	}
}

func TestSessionCodecRejectsExpiredToken(t *testing.T) {
	codec := auth.SessionCodec{Secret: []byte("test-secret")}
	tok := codec.SignForAudience("usr_1", "session", -time.Minute)
	if _, ok := codec.VerifySession(tok); ok {
		t.Fatal("expired session token verified")
	}
}

func TestSessionCodecRejectsWrongAudience(t *testing.T) {
	codec := auth.SessionCodec{Secret: []byte("test-secret")}
	tok := codec.SignForAudience("ver_1", "render", time.Hour)
	if _, ok := codec.VerifySession(tok); ok {
		t.Fatal("render-audience token accepted as a session")
	}
	uid, ok := codec.VerifyAudience(tok, "render")
	if !ok || uid != "ver_1" {
		t.Fatalf("VerifyAudience(render) = (%q, %v), want (\"ver_1\", true)", uid, ok)
	}
}
