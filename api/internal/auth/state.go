package auth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"sync"
	"time"
)

// defaultStateTTL is applied by PutState when the caller leaves ExpiresAt unset
// (zero), so a forgotten expiry does not make every state instantly expired.
const defaultStateTTL = 10 * time.Minute

// codeTTL is the lifetime of a CLI exchange code.
const codeTTL = 5 * time.Minute

type LoginState struct {
	Mode, Redirect, CLIRedirect, CodeChallenge string
	ExpiresAt                                  time.Time
	User                                       OIDCUser
	UserID                                     string
	// MCP OAuth authorization codes reuse the same one-time, persisted code
	// store as CLI login while carrying the audience and public-client binding
	// required by OAuth 2.1.
	OAuthClientID    string
	OAuthRedirectURI string
	OAuthResource    string
	OAuthScope       string
	// OAuthRefreshTokenHash holds the SHA-256 hash of the refresh token that
	// is currently redeemable for this MCP token family. Rotation overwrites
	// it; presenting any other token value revokes the family.
	OAuthRefreshTokenHash string
	// OAuthChainExpiresAt is the absolute deadline of an MCP refresh-token
	// family: sliding renewals never extend past it, so one consent cannot
	// grant perpetual access.
	OAuthChainExpiresAt time.Time
	// WebBindingRequired marks web login states created after browser binding
	// was introduced. Its zero value preserves callbacks for states created by
	// older instances during a rolling deployment.
	WebBindingRequired bool
}

// loginStateJSON preserves the historical GoogleUser wire key while allowing
// the provider-neutral User name used by LoginState in Go. User is decode-only
// compatibility for states briefly written under that key.
type loginStateJSON struct {
	Mode                  string
	Redirect              string
	CLIRedirect           string
	CodeChallenge         string
	ExpiresAt             time.Time
	GoogleUser            *OIDCUser
	User                  *OIDCUser `json:",omitempty"`
	UserID                string
	WebBindingRequired    bool
	OAuthClientID         string
	OAuthRedirectURI      string
	OAuthResource         string
	OAuthScope            string
	OAuthRefreshTokenHash string    `json:",omitempty"`
	OAuthChainExpiresAt   time.Time `json:",omitzero"`
}

func (s LoginState) MarshalJSON() ([]byte, error) {
	return json.Marshal(loginStateJSON{
		Mode:                  s.Mode,
		Redirect:              s.Redirect,
		CLIRedirect:           s.CLIRedirect,
		CodeChallenge:         s.CodeChallenge,
		ExpiresAt:             s.ExpiresAt,
		GoogleUser:            &s.User,
		UserID:                s.UserID,
		WebBindingRequired:    s.WebBindingRequired,
		OAuthClientID:         s.OAuthClientID,
		OAuthRedirectURI:      s.OAuthRedirectURI,
		OAuthResource:         s.OAuthResource,
		OAuthScope:            s.OAuthScope,
		OAuthRefreshTokenHash: s.OAuthRefreshTokenHash,
		OAuthChainExpiresAt:   s.OAuthChainExpiresAt,
	})
}

func (s *LoginState) UnmarshalJSON(data []byte) error {
	var wire loginStateJSON
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	var user OIDCUser
	if wire.GoogleUser != nil {
		user = *wire.GoogleUser
	} else if wire.User != nil {
		user = *wire.User
	}
	*s = LoginState{
		Mode:                  wire.Mode,
		Redirect:              wire.Redirect,
		CLIRedirect:           wire.CLIRedirect,
		CodeChallenge:         wire.CodeChallenge,
		ExpiresAt:             wire.ExpiresAt,
		User:                  user,
		UserID:                wire.UserID,
		WebBindingRequired:    wire.WebBindingRequired,
		OAuthClientID:         wire.OAuthClientID,
		OAuthRedirectURI:      wire.OAuthRedirectURI,
		OAuthResource:         wire.OAuthResource,
		OAuthScope:            wire.OAuthScope,
		OAuthRefreshTokenHash: wire.OAuthRefreshTokenHash,
		OAuthChainExpiresAt:   wire.OAuthChainExpiresAt,
	}
	return nil
}

type LoginStateStore interface {
	PutState(ctx context.Context, id string, st LoginState) error
	TakeState(ctx context.Context, id string) (LoginState, bool, error)
	PutCode(ctx context.Context, code string, st LoginState) error
	TakeCode(ctx context.Context, code string) (LoginState, bool, error)
}

type StateStore struct {
	mu       sync.Mutex
	states   map[string]LoginState
	cliCodes map[string]LoginState
}

func NewStateStore() *StateStore {
	return &StateStore{states: map[string]LoginState{}, cliCodes: map[string]LoginState{}}
}
func (s *StateStore) PutState(ctx context.Context, id string, st LoginState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st.ExpiresAt.IsZero() {
		st.ExpiresAt = time.Now().Add(defaultStateTTL)
	}
	s.states[id] = st
	return nil
}
func (s *StateStore) TakeState(ctx context.Context, id string) (LoginState, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.states[id]
	delete(s.states, id)
	if !ok || time.Now().After(st.ExpiresAt) {
		return LoginState{}, false, nil
	}
	return st, true, nil
}
func (s *StateStore) PutCode(ctx context.Context, code string, st LoginState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st.ExpiresAt = time.Now().Add(codeTTL)
	s.cliCodes[code] = st
	return nil
}
func (s *StateStore) TakeCode(ctx context.Context, code string) (LoginState, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.cliCodes[code]
	delete(s.cliCodes, code)
	if !ok || time.Now().After(st.ExpiresAt) {
		return LoginState{}, false, nil
	}
	return st, true, nil
}
func RandomURLToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
