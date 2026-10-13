package auth

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestLoginStateJSONPreservesWebBindingRollingCompatibility(t *testing.T) {
	t.Parallel()

	var legacy LoginState
	if err := json.Unmarshal([]byte(`{"Mode":"web","Redirect":"/documents/doc_1"}`), &legacy); err != nil {
		t.Fatalf("unmarshal legacy login state: %v", err)
	}
	if legacy.WebBindingRequired {
		t.Fatal("legacy login state unexpectedly requires a browser binding")
	}

	raw, err := json.Marshal(LoginState{Mode: "web", WebBindingRequired: true})
	if err != nil {
		t.Fatalf("marshal bound login state: %v", err)
	}
	var current LoginState
	if err := json.Unmarshal(raw, &current); err != nil {
		t.Fatalf("unmarshal bound login state: %v", err)
	}
	if !current.WebBindingRequired {
		t.Fatal("current login state lost its browser-binding requirement")
	}
}

func TestLoginStateJSONWritesHistoricalGoogleUserKey(t *testing.T) {
	t.Parallel()

	wantUser := OIDCUser{Sub: "sub-1", Email: "user@example.com", Name: "User", PictureURL: "https://example.com/user.png"}
	want := LoginState{
		Mode:               "cli",
		Redirect:           "/documents/doc_1",
		CLIRedirect:        "http://127.0.0.1:32123/callback",
		CodeChallenge:      "challenge",
		ExpiresAt:          time.Unix(1_700_000_000, 0).UTC(),
		User:               wantUser,
		UserID:             "usr_1",
		WebBindingRequired: true,
	}
	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal login state: %v", err)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keys); err != nil {
		t.Fatalf("unmarshal login state keys: %v", err)
	}
	if _, ok := keys["GoogleUser"]; !ok {
		t.Fatalf("login state JSON does not contain canonical GoogleUser key: %s", raw)
	}
	if _, ok := keys["User"]; ok {
		t.Fatalf("login state JSON unexpectedly contains interim User key: %s", raw)
	}

	// Model an older binary decoding a state written by the current binary.
	var legacy struct {
		GoogleUser OIDCUser
	}
	if err := json.Unmarshal(raw, &legacy); err != nil {
		t.Fatalf("legacy unmarshal: %v", err)
	}
	if !reflect.DeepEqual(legacy.GoogleUser, wantUser) {
		t.Fatalf("legacy user = %+v, want %+v", legacy.GoogleUser, wantUser)
	}

	var roundTrip LoginState
	if err := json.Unmarshal(raw, &roundTrip); err != nil {
		t.Fatalf("current unmarshal: %v", err)
	}
	if !reflect.DeepEqual(roundTrip, want) {
		t.Fatalf("round-trip state = %+v, want %+v", roundTrip, want)
	}
}

func TestLoginStateJSONReadsRollingUserKeys(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		raw  string
		want OIDCUser
	}{
		{
			name: "historical GoogleUser",
			raw:  `{"Mode":"cli","GoogleUser":{"Sub":"legacy-sub","Email":"legacy@example.com"}}`,
			want: OIDCUser{Sub: "legacy-sub", Email: "legacy@example.com"},
		},
		{
			name: "interim User",
			raw:  `{"Mode":"cli","User":{"Sub":"interim-sub","Email":"interim@example.com"}}`,
			want: OIDCUser{Sub: "interim-sub", Email: "interim@example.com"},
		},
		{
			name: "canonical key wins when both exist",
			raw:  `{"GoogleUser":{"Sub":"canonical"},"User":{"Sub":"interim"}}`,
			want: OIDCUser{Sub: "canonical"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got LoginState
			if err := json.Unmarshal([]byte(tt.raw), &got); err != nil {
				t.Fatalf("unmarshal login state: %v", err)
			}
			if !reflect.DeepEqual(got.User, tt.want) {
				t.Fatalf("user = %+v, want %+v", got.User, tt.want)
			}
		})
	}
}

func TestLoginStateJSONKeepsOIDCBinding(t *testing.T) {
	in := LoginState{Mode: "web", Redirect: "/", Nonce: "nonce-1", PKCEVerifier: "verifier-1", WebBindingRequired: true}
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out LoginState
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if out.Nonce != in.Nonce || out.PKCEVerifier != in.PKCEVerifier {
		t.Fatalf("round trip lost the OIDC binding: %s -> %+v", raw, out)
	}
}
