package auth

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

const (
	// MCPAccessTokenPrefix is a public token type marker, not a credential.
	//nolint:gosec // A fixed prefix lets the authenticator select the token verifier.
	MCPAccessTokenPrefix = "slashdocs_mcp_"
	ServiceAccountPrefix = "slashdocs_sa_"
	// legacyServiceAccountPrefix marks keys issued before the rename from
	// aidocs. They stay valid until their owners rotate them.
	legacyServiceAccountPrefix = "aidocs_sa_"
	mcpAccessTokenAudience     = "mcp:"
)

// MCPAuthenticator authenticates the remote MCP transport. Browser session
// cookies are deliberately not accepted: every MCP request must carry a bearer
// token so identity cannot leak between clients or transport sessions.
//
// Human access tokens are expiring, audience-bound tokens minted by the MCP
// OAuth flow. Existing service-account keys remain available for unattended
// agents and are resolved through the normal API authenticator.
type MCPAuthenticator struct {
	Users         UserResolver
	ServiceTokens Authenticator
	SessionSecret string
	Resource      string
}

func (a MCPAuthenticator) Authenticate(r *http.Request) (*Principal, error) {
	token := BearerFromHeader(r.Header.Get("Authorization"))
	if token == "" {
		return nil, ErrUnauthorized
	}

	switch {
	case strings.HasPrefix(token, MCPAccessTokenPrefix):
		if a.Users == nil || a.SessionSecret == "" || a.Resource == "" {
			return nil, ErrUnauthorized
		}
		userID, ok := (SessionCodec{Secret: []byte(a.SessionSecret)}).VerifyAudience(
			strings.TrimPrefix(token, MCPAccessTokenPrefix),
			mcpAccessTokenAudience+a.Resource,
		)
		if !ok {
			return nil, ErrUnauthorized
		}
		p, err := a.Users.ResolveUser(r.Context(), userID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				return nil, ErrUnauthorized
			}
			return nil, err
		}
		return &p, nil

	case strings.HasPrefix(token, ServiceAccountPrefix), strings.HasPrefix(token, legacyServiceAccountPrefix):
		if a.ServiceTokens == nil {
			return nil, ErrUnauthorized
		}
		return a.ServiceTokens.Authenticate(r)

	default:
		// CLI credentials are intentionally not accepted here. The CLI remains an
		// API client; it no longer doubles as, or provisions credentials for, the
		// remote MCP transport.
		return nil, ErrUnauthorized
	}
}

func NewMCPAccessToken(userID, resource, secret string, ttl time.Duration) string {
	signed := (SessionCodec{Secret: []byte(secret)}).SignForAudience(userID, mcpAccessTokenAudience+resource, ttl)
	return MCPAccessTokenPrefix + signed
}
