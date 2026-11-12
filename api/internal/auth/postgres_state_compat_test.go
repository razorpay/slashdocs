package auth_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

func TestPostgresStateStoreLoginStateRollingCompatibility(t *testing.T) {
	ctx := context.Background()
	db, err := pgxpool.New(ctx, testdb.New(t))
	if err != nil {
		t.Fatalf("connect postgres: %v", err)
	}
	t.Cleanup(db.Close)
	store := auth.NewPostgresStateStore(db)

	wantCurrent := auth.OIDCUser{Sub: "current-sub", Email: "current@example.com"}
	if err := store.PutCode(ctx, "current-code", auth.LoginState{Mode: "cli", User: wantCurrent, UserID: "usr_current"}); err != nil {
		t.Fatalf("write current state: %v", err)
	}
	var raw []byte
	if err := db.QueryRow(ctx, `SELECT state_json FROM oauth_states WHERE kind='cli_code' AND id='current-code'`).Scan(&raw); err != nil {
		t.Fatalf("read current state JSON: %v", err)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keys); err != nil {
		t.Fatalf("decode current state keys: %v", err)
	}
	if _, ok := keys["GoogleUser"]; !ok {
		t.Fatalf("current state JSON does not contain canonical GoogleUser key: %s", raw)
	}
	if _, ok := keys["User"]; ok {
		t.Fatalf("current state JSON unexpectedly contains interim User key: %s", raw)
	}
	var legacy struct {
		GoogleUser auth.OIDCUser
	}
	if err := json.Unmarshal(raw, &legacy); err != nil {
		t.Fatalf("decode current state with legacy shape: %v", err)
	}
	if legacy.GoogleUser != wantCurrent {
		t.Fatalf("legacy decoder user = %+v, want %+v", legacy.GoogleUser, wantCurrent)
	}

	states := []struct {
		name string
		code string
		raw  string
		want auth.OIDCUser
	}{
		{
			name: "historical GoogleUser",
			code: "legacy-code",
			raw:  `{"Mode":"cli","GoogleUser":{"Sub":"legacy-sub","Email":"legacy@example.com"}}`,
			want: auth.OIDCUser{Sub: "legacy-sub", Email: "legacy@example.com"},
		},
		{
			name: "interim User",
			code: "interim-code",
			raw:  `{"Mode":"cli","User":{"Sub":"interim-sub","Email":"interim@example.com"}}`,
			want: auth.OIDCUser{Sub: "interim-sub", Email: "interim@example.com"},
		},
	}
	for _, tt := range states {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := db.Exec(ctx, `
				INSERT INTO oauth_states(id, kind, state_json, expires_at)
				VALUES ($1, 'cli_code', $2::jsonb, $3)
			`, tt.code, tt.raw, time.Now().Add(time.Minute)); err != nil {
				t.Fatalf("insert rolling state: %v", err)
			}
			got, ok, err := store.TakeCode(ctx, tt.code)
			if err != nil {
				t.Fatalf("take rolling state: %v", err)
			}
			if !ok {
				t.Fatal("rolling state was not found")
			}
			if got.User != tt.want {
				t.Fatalf("user = %+v, want %+v", got.User, tt.want)
			}
		})
	}
}
