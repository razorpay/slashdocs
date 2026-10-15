package server

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html/template"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

const (
	mcpScope          = "mcp"
	mcpClientIDPrefix = "slashdocs_mcp_client_"
	// legacyMCPClientIDPrefix marks registrations issued before the rename
	// from aidocs. They stay valid until they expire.
	legacyMCPClientIDPrefix     = "aidocs_mcp_client_"
	mcpClientRegistrationAud    = "mcp-client-registration"
	mcpClientRegistrationTTL    = 365 * 24 * time.Hour
	mcpAuthorizationCodeTTLHint = 5 * time.Minute
	mcpAccessTokenTTL           = time.Hour
	// mcpRefreshTokenTTL is the sliding inactivity window of a refresh-token
	// family: each rotation renews it, so an active client stays signed in
	// while an abandoned token dies within the TTL.
	mcpRefreshTokenTTL = 14 * 24 * time.Hour
	// mcpRefreshChainTTL is the absolute lifetime of a refresh-token family
	// measured from the original browser consent. Sliding renewals never
	// extend past it, so one consent cannot grant perpetual access and a
	// stolen chain dies within this bound even if actively renewed: the user
	// must re-authenticate in the browser at least once every 30 days.
	mcpRefreshChainTTL = 30 * 24 * time.Hour
	// mcpRefreshTokenPrefix is a public token type marker, not a credential.
	//nolint:gosec // The fixed prefix only routes the token to its verifier.
	mcpRefreshTokenPrefix = "slashdocs_mcp_refresh_"
	// mcpRefreshStateIDPrefix namespaces refresh-token family rows inside the
	// shared one-time login state store, mirroring how MCP authorization codes
	// reuse the CLI code store. The row stores only the SHA-256 hash of the
	// currently redeemable token, never the token itself.
	mcpRefreshStateIDPrefix = "mcp_refresh_family:"
	// mcpRefreshMode marks state rows that are redeemable refresh tokens, so
	// login states can never be replayed against the refresh grant.
	mcpRefreshMode         = "mcp_refresh"
	maxMCPAuthRequestBytes = 64 * 1024
	// Dynamic registration is embedded in the signed client ID. These byte
	// limits keep the resulting /oauth/authorize request comfortably below the
	// common 8 KiB proxy request-line/header limit while preserving ordinary
	// HTTPS and loopback callback URLs.
	maxMCPClientNameBytes  = 128
	maxMCPRedirectURIBytes = 1024
	maxMCPClientIDBytes    = 2048
)

type mcpOAuthClient struct {
	Name         string   `json:"name"`
	RedirectURIs []string `json:"redirect_uris"`
}

type mcpClientRegistrationRequest struct {
	ClientName              string   `json:"client_name"`
	RedirectURIs            []string `json:"redirect_uris"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	GrantTypes              []string `json:"grant_types"`
	ResponseTypes           []string `json:"response_types"`
}

type mcpProtectedResourceMetadataResponse struct {
	Resource               string   `json:"resource"`
	AuthorizationServers   []string `json:"authorization_servers"`
	BearerMethodsSupported []string `json:"bearer_methods_supported"`
	ScopesSupported        []string `json:"scopes_supported"`
}

type mcpAuthorizationServerMetadataResponse struct {
	Issuer                            string   `json:"issuer"`
	AuthorizationEndpoint             string   `json:"authorization_endpoint"`
	TokenEndpoint                     string   `json:"token_endpoint"`
	RegistrationEndpoint              string   `json:"registration_endpoint"`
	ResponseTypesSupported            []string `json:"response_types_supported"`
	ResponseModesSupported            []string `json:"response_modes_supported"`
	GrantTypesSupported               []string `json:"grant_types_supported"`
	TokenEndpointAuthMethodsSupported []string `json:"token_endpoint_auth_methods_supported"`
	CodeChallengeMethodsSupported     []string `json:"code_challenge_methods_supported"`
	ScopesSupported                   []string `json:"scopes_supported"`
}

type mcpClientRegistrationResponse struct {
	ClientID                string   `json:"client_id"`
	ClientIDIssuedAt        int64    `json:"client_id_issued_at"`
	ClientSecretExpiresAt   int64    `json:"client_secret_expires_at"`
	ClientName              string   `json:"client_name"`
	RedirectURIs            []string `json:"redirect_uris"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	GrantTypes              []string `json:"grant_types"`
	ResponseTypes           []string `json:"response_types"`
}

type mcpTokenResponse struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
	RefreshToken string `json:"refresh_token,omitempty"`
}

type mcpTokenRequest struct {
	GrantType    string
	Code         string
	CodeVerifier string
	ClientID     string
	RedirectURI  string
	Resource     string
	RefreshToken string
}

type oauthRequestError struct {
	Status      int
	Code        string
	Description string
}

type oauthErrorResponse struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

type mcpAuthorizeRequest struct {
	ClientID            string
	RedirectURI         string
	ResponseType        string
	CodeChallenge       string
	CodeChallengeMethod string
	Resource            string
	Scope               string
	State               string
}

func (h handlers) mcpResource() string { return strings.TrimRight(h.deps.appOrigin, "/") + "/mcp" }

func (h handlers) mcpProtectedResourceMetadata(c *gin.Context) {
	c.JSON(http.StatusOK, mcpProtectedResourceMetadataResponse{
		Resource:               h.mcpResource(),
		AuthorizationServers:   []string{strings.TrimRight(h.deps.appOrigin, "/")},
		BearerMethodsSupported: []string{"header"},
		ScopesSupported:        []string{mcpScope},
	})
}

func (h handlers) mcpAuthorizationServerMetadata(c *gin.Context) {
	origin := strings.TrimRight(h.deps.appOrigin, "/")
	c.JSON(http.StatusOK, mcpAuthorizationServerMetadataResponse{
		Issuer:                            origin,
		AuthorizationEndpoint:             origin + "/oauth/authorize",
		TokenEndpoint:                     origin + "/oauth/token",
		RegistrationEndpoint:              origin + "/oauth/register",
		ResponseTypesSupported:            []string{"code"},
		ResponseModesSupported:            []string{"query"},
		GrantTypesSupported:               []string{"authorization_code", "refresh_token"},
		TokenEndpointAuthMethodsSupported: []string{"none"},
		CodeChallengeMethodsSupported:     []string{"S256"},
		ScopesSupported:                   []string{mcpScope},
	})
}

func (h handlers) mcpRegisterClient(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxMCPAuthRequestBytes)
	if !requireJSON(c) {
		return
	}
	var in mcpClientRegistrationRequest
	if err := c.ShouldBindJSON(&in); err != nil {
		oauthError(c, http.StatusBadRequest, "invalid_client_metadata", "invalid client registration")
		return
	}
	if message := validateMCPClientRegistration(in); message != "" {
		oauthError(c, http.StatusBadRequest, "invalid_client_metadata", message)
		return
	}
	client := mcpOAuthClient{Name: strings.TrimSpace(in.ClientName), RedirectURIs: slices.Clone(in.RedirectURIs)}
	if client.Name == "" {
		client.Name = "MCP client"
	}
	b, err := json.Marshal(client)
	if err != nil {
		internalErr(c, err)
		return
	}
	subject := base64.RawURLEncoding.EncodeToString(b)
	clientID := mcpClientIDPrefix + (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).SignForAudience(subject, mcpClientRegistrationAud, mcpClientRegistrationTTL)
	if len(clientID) > maxMCPClientIDBytes {
		oauthError(c, http.StatusBadRequest, "invalid_client_metadata", "client metadata produces an oversized client_id")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, mcpClientRegistrationResponse{
		ClientID:                clientID,
		ClientIDIssuedAt:        time.Now().Unix(),
		ClientSecretExpiresAt:   0,
		ClientName:              client.Name,
		RedirectURIs:            client.RedirectURIs,
		TokenEndpointAuthMethod: "none",
		GrantTypes:              []string{"authorization_code", "refresh_token"},
		ResponseTypes:           []string{"code"},
	})
}

func validateMCPClientRegistration(in mcpClientRegistrationRequest) string {
	if len(strings.TrimSpace(in.ClientName)) > maxMCPClientNameBytes {
		return "client_name must not exceed 128 bytes"
	}
	if len(in.RedirectURIs) == 0 || len(in.RedirectURIs) > 10 {
		return "redirect_uris must contain between 1 and 10 entries"
	}
	for _, raw := range in.RedirectURIs {
		if len(raw) > maxMCPRedirectURIBytes {
			return "each redirect_uri must not exceed 1024 bytes"
		}
		if !validMCPRedirectURI(raw) {
			return "redirect_uris must use HTTPS, loopback HTTP, or a private-use app scheme, without fragments or credentials"
		}
	}
	if in.TokenEndpointAuthMethod != "" && in.TokenEndpointAuthMethod != "none" {
		return "only public clients with token_endpoint_auth_method=none are supported"
	}
	if message := validateMCPGrantTypes(in.GrantTypes); message != "" {
		return message
	}
	if len(in.ResponseTypes) > 0 && !slices.Equal(in.ResponseTypes, []string{"code"}) {
		return "only the code response type is supported"
	}
	return ""
}

// validateMCPGrantTypes requires the authorization_code grant and accepts a
// co-registered refresh_token grant, which conformant MCP clients (mcp2cli,
// VS Code, Claude) request by default during dynamic registration. The token
// endpoint issues a rotating refresh token with every exchange, so clients
// renew the short-lived access token silently instead of re-running the
// browser authorization flow every hour.
func validateMCPGrantTypes(grantTypes []string) string {
	if len(grantTypes) == 0 {
		return ""
	}
	if !slices.Contains(grantTypes, "authorization_code") {
		return "the authorization_code grant is required"
	}
	for _, grant := range grantTypes {
		if grant != "authorization_code" && grant != "refresh_token" {
			return "only the authorization_code and refresh_token grants are supported"
		}
	}
	return ""
}

// redirectURIMatchesRegistration checks a request's redirect_uri against the
// URIs frozen into the signed client_id. RFC 8252 §7.3 requires the
// authorization server to allow any port on a loopback IP redirect URI, since
// native apps bind an ephemeral port at request time and a client_id cached
// across runs carries a stale port. Loopback IP literals therefore match on
// scheme, host, path, and query while ignoring the port; everything else
// (including https and localhost) still requires an exact match, because only
// loopback delivery to the user's own machine makes a free port safe.
func redirectURIMatchesRegistration(registered []string, requested string) bool {
	if slices.Contains(registered, requested) {
		return true
	}
	req, err := url.Parse(requested)
	if err != nil || !isLoopbackIPHost(req.Hostname()) {
		return false
	}
	for _, raw := range registered {
		reg, err := url.Parse(raw)
		if err != nil || !isLoopbackIPHost(reg.Hostname()) {
			continue
		}
		if strings.EqualFold(reg.Scheme, req.Scheme) &&
			strings.EqualFold(reg.Hostname(), req.Hostname()) &&
			reg.Path == req.Path && reg.RawQuery == req.RawQuery {
			return true
		}
	}
	return false
}

func isLoopbackIPHost(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func validMCPRedirectURI(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return false
	}
	switch scheme := strings.ToLower(u.Scheme); scheme {
	case "https":
		return u.Host != ""
	case "http":
		// Loopback only (RFC 8252 §7.3): native apps listening on localhost.
		host := u.Hostname()
		if strings.EqualFold(host, "localhost") {
			return true
		}
		ip := net.ParseIP(host)
		return ip != nil && ip.IsLoopback()
	default:
		// Private-use app schemes (RFC 8252 §7.1): cursor://, vscode://, and
		// friends. The OS resolves the scheme to the installed client, and an
		// intercepted code is useless without the PKCE verifier. Refuse
		// schemes a browser could interpret as active or local content.
		switch scheme {
		case "javascript", "data", "file", "blob", "about", "vbscript", "filesystem", "chrome", "chrome-extension":
			return false
		}
		return true
	}
}

func (h handlers) parseMCPClient(clientID string) (mcpOAuthClient, bool) {
	signed, ok := strings.CutPrefix(clientID, mcpClientIDPrefix)
	if !ok {
		signed, ok = strings.CutPrefix(clientID, legacyMCPClientIDPrefix)
	}
	if len(clientID) > maxMCPClientIDBytes || !ok {
		return mcpOAuthClient{}, false
	}
	subject, ok := (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).VerifyAudience(signed, mcpClientRegistrationAud)
	if !ok {
		return mcpOAuthClient{}, false
	}
	b, err := base64.RawURLEncoding.DecodeString(subject)
	if err != nil {
		return mcpOAuthClient{}, false
	}
	var client mcpOAuthClient
	if json.Unmarshal(b, &client) != nil || validateMCPClientRegistration(mcpClientRegistrationRequest{RedirectURIs: client.RedirectURIs}) != "" {
		return mcpOAuthClient{}, false
	}
	return client, true
}

func mcpAuthorizeRequestFrom(c *gin.Context) mcpAuthorizeRequest {
	value := c.Query
	if c.Request.Method == http.MethodPost {
		value = c.PostForm
	}
	return mcpAuthorizeRequest{
		ClientID:            value("client_id"),
		RedirectURI:         value("redirect_uri"),
		ResponseType:        value("response_type"),
		CodeChallenge:       value("code_challenge"),
		CodeChallengeMethod: value("code_challenge_method"),
		Resource:            value("resource"),
		Scope:               value("scope"),
		State:               value("state"),
	}
}

func (h handlers) validateMCPAuthorizeRequest(in mcpAuthorizeRequest) (mcpOAuthClient, string) {
	client, ok := h.parseMCPClient(in.ClientID)
	if !ok {
		return mcpOAuthClient{}, "unknown or expired client_id"
	}
	if !redirectURIMatchesRegistration(client.RedirectURIs, in.RedirectURI) {
		return mcpOAuthClient{}, "redirect_uri is not registered for this client"
	}
	if in.ResponseType != "code" {
		return mcpOAuthClient{}, "response_type must be code"
	}
	if in.CodeChallengeMethod != "S256" || !validPKCEChallenge(in.CodeChallenge) {
		return mcpOAuthClient{}, "S256 PKCE is required"
	}
	if in.Resource != h.mcpResource() {
		return mcpOAuthClient{}, "resource must identify this MCP server"
	}
	if in.Scope != "" && in.Scope != mcpScope {
		return mcpOAuthClient{}, "unsupported scope"
	}
	return client, ""
}

func validPKCEChallenge(challenge string) bool {
	if len(challenge) < 43 || len(challenge) > 128 {
		return false
	}
	for _, r := range challenge {
		if !strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~", r) {
			return false
		}
	}
	return true
}

func mcpRedirectTarget(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if u.Scheme == "https" {
		return u.Host
	}
	if u.Host != "" {
		return u.Scheme + "://" + u.Host
	}
	return raw
}

var mcpConsentTemplate = template.Must(template.New("mcp-consent").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect {{.ClientName}} to slashdocs</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:10vh auto;padding:0 1.5rem;color:#171717}section{border:1px solid #ddd;border-radius:12px;padding:1.5rem}h1{font-size:1.4rem}p{color:#525252}.actions{display:flex;gap:.75rem;margin-top:1.5rem}button{padding:.65rem 1rem;border-radius:8px;border:1px solid #bbb;background:#fff;font:inherit}button[value=approve]{background:#171717;color:#fff;border-color:#171717}</style></head>
<body><section><h1>Connect {{.ClientName}}?</h1><p>Access goes to <strong>{{.RedirectTarget}}</strong>.</p><p>The client name is self-reported and is not verified.</p><p>This gives the client access to slashdocs as <strong>{{.User}}</strong>. It can read and change the same documents, comments, folders, sharing settings, and service accounts that you can.</p>
<form method="post" action="/oauth/authorize">{{range $k,$v := .Fields}}<input type="hidden" name="{{$k}}" value="{{$v}}">{{end}}<div class="actions"><button type="submit" name="decision" value="deny">Cancel</button><button type="submit" name="decision" value="approve">Connect</button></div></form></section></body></html>`))

func (h handlers) mcpAuthorize(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxMCPAuthRequestBytes)
	if current(c) == nil || current(c).Type != auth.PrincipalUser {
		oauthError(c, http.StatusForbidden, "access_denied", "MCP browser authorization requires a user account")
		return
	}
	in := mcpAuthorizeRequestFrom(c)
	client, message := h.validateMCPAuthorizeRequest(in)
	if message != "" {
		oauthError(c, http.StatusBadRequest, "invalid_request", message)
		return
	}
	if c.Request.Method == http.MethodGet {
		p := current(c)
		user := p.Name
		if user == "" {
			user = p.Email
		}
		fields := map[string]string{
			"client_id": in.ClientID, "redirect_uri": in.RedirectURI, "response_type": in.ResponseType,
			"code_challenge": in.CodeChallenge, "code_challenge_method": in.CodeChallengeMethod,
			"resource": in.Resource, "scope": firstNonEmpty(in.Scope, mcpScope), "state": in.State,
		}
		c.Header("Content-Type", "text/html; charset=utf-8")
		c.Header("Cache-Control", "no-store")
		// No form-action: browsers check it on every redirect after the consent
		// POST, and client callbacks redirect again to hosts that this server
		// cannot know (www.cursor.com to cursor.com, vscode.dev to loopback).
		c.Header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
		c.Header("X-Frame-Options", "DENY")
		// Keep same-origin form submissions compatible with the application's
		// cookie CSRF check without leaking authorization parameters off-origin.
		c.Header("Referrer-Policy", "same-origin")
		if err := mcpConsentTemplate.Execute(c.Writer, map[string]any{"ClientName": client.Name, "RedirectTarget": mcpRedirectTarget(in.RedirectURI), "User": user, "Fields": fields}); err != nil {
			internalErr(c, err)
		}
		return
	}

	if c.PostForm("decision") != "approve" {
		redirectOAuthResult(c, in.RedirectURI, in.State, "", "access_denied")
		return
	}
	code, err := auth.RandomURLToken()
	if err != nil {
		internalErr(c, err)
		return
	}
	if err := h.deps.stateStore.PutCode(c.Request.Context(), code, auth.LoginState{
		Mode: "mcp", CodeChallenge: in.CodeChallenge, UserID: current(c).ID,
		OAuthClientID: in.ClientID, OAuthRedirectURI: in.RedirectURI,
		OAuthResource: in.Resource, OAuthScope: firstNonEmpty(in.Scope, mcpScope),
		ExpiresAt: time.Now().Add(mcpAuthorizationCodeTTLHint),
	}); err != nil {
		internalErr(c, err)
		return
	}
	redirectOAuthResult(c, in.RedirectURI, in.State, code, "")
}

func redirectOAuthResult(c *gin.Context, redirectURI, state, code, oauthErr string) {
	u, _ := url.Parse(redirectURI) // validated against the signed client registration
	q := u.Query()
	if code != "" {
		q.Set("code", code)
	}
	if oauthErr != "" {
		q.Set("error", oauthErr)
	}
	if state != "" {
		q.Set("state", state)
	}
	u.RawQuery = q.Encode()
	c.Redirect(http.StatusFound, u.String())
}

func (h handlers) mcpToken(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxMCPAuthRequestBytes)
	in, requestErr := parseMCPTokenRequest(c)
	if requestErr != nil {
		oauthError(c, requestErr.Status, requestErr.Code, requestErr.Description)
		return
	}
	if _, ok := h.parseMCPClient(in.ClientID); !ok {
		oauthError(c, http.StatusBadRequest, "invalid_client", "unknown or expired client_id")
		return
	}
	if in.GrantType == "refresh_token" {
		h.mcpRefreshGrant(c, in)
		return
	}
	st, ok, err := h.deps.stateStore.TakeCode(c.Request.Context(), in.Code)
	if err != nil {
		internalErr(c, err)
		return
	}
	if !h.validMCPCodeGrant(st, ok, in) {
		incAuth("mcp_exchange", "failure")
		oauthError(c, http.StatusBadRequest, "invalid_grant", "authorization code is invalid, expired, or does not match the PKCE request")
		return
	}
	incAuth("mcp_exchange", "success")
	familyID, err := auth.RandomURLToken()
	if err != nil {
		internalErr(c, err)
		return
	}
	h.issueMCPTokens(c, st.UserID, in.ClientID, in.Resource, firstNonEmpty(st.OAuthScope, mcpScope),
		familyID, time.Now().Add(mcpRefreshChainTTL))
}

// mcpRefreshGrant redeems a rotating refresh token. Each family keeps exactly
// one live row that stores the hash of its currently redeemable token. The
// one-time Take of that row retrieves and invalidates it, and the row is only
// re-created after every check passes, so any failed redemption — a replayed
// rotated-out token, a wrong client, a wrong resource — revokes the whole
// family (OAuth 2.1 §4.14.2). A thief and the legitimate client racing the
// same token therefore cannot both end up with a live chain: the loser's
// attempt kills the family and forces a fresh browser consent.
func (h handlers) mcpRefreshGrant(c *gin.Context, in mcpTokenRequest) {
	reject := func() {
		incAuth("mcp_refresh", "failure")
		oauthError(c, http.StatusBadRequest, "invalid_grant", "refresh token is invalid, expired, revoked, or bound to a different client")
	}
	familyID, ok := parseMCPRefreshToken(in.RefreshToken)
	if !ok {
		reject()
		return
	}
	st, ok, err := h.deps.stateStore.TakeState(c.Request.Context(), mcpRefreshStateIDPrefix+familyID)
	if err != nil {
		internalErr(c, err)
		return
	}
	if !ok || st.Mode != mcpRefreshMode ||
		subtle.ConstantTimeCompare([]byte(st.OAuthRefreshTokenHash), []byte(auth.HashToken(in.RefreshToken))) != 1 ||
		st.OAuthClientID != in.ClientID || st.OAuthResource != in.Resource || in.Resource != h.mcpResource() ||
		st.OAuthChainExpiresAt.IsZero() || time.Now().After(st.OAuthChainExpiresAt) {
		reject()
		return
	}
	// Offboarded accounts must not keep renewable credentials: the chain ends
	// here unless the user still resolves.
	if _, err := h.deps.repository.ResolveUser(c.Request.Context(), st.UserID); err != nil {
		if errors.Is(err, auth.ErrNotFound) {
			reject()
			return
		}
		internalErr(c, err)
		return
	}
	incAuth("mcp_refresh", "success")
	h.issueMCPTokens(c, st.UserID, in.ClientID, in.Resource, firstNonEmpty(st.OAuthScope, mcpScope),
		familyID, st.OAuthChainExpiresAt)
}

// parseMCPRefreshToken splits a refresh token into its family id, which keys
// the stored row, and reports whether the token is well formed. The secret
// half is never inspected directly; redemption compares the full token's hash
// against the stored hash.
func parseMCPRefreshToken(token string) (familyID string, ok bool) {
	rest, found := strings.CutPrefix(token, mcpRefreshTokenPrefix)
	if !found {
		return "", false
	}
	familyID, secret, found := strings.Cut(rest, ".")
	if !found || familyID == "" || secret == "" {
		return "", false
	}
	return familyID, true
}

// issueMCPTokens mints the short-lived access token plus the family's next
// refresh token, persists the rotated hash in the one-time state store, and
// writes the OAuth token response. The row's expiry is the sliding renewal
// window capped by the family's absolute chain deadline.
func (h handlers) issueMCPTokens(c *gin.Context, userID, clientID, resource, scope, familyID string, chainExpiresAt time.Time) {
	accessToken := auth.NewMCPAccessToken(userID, resource, h.deps.sessionSecret, mcpAccessTokenTTL)
	refreshSecret, err := auth.RandomURLToken()
	if err != nil {
		internalErr(c, err)
		return
	}
	refreshToken := mcpRefreshTokenPrefix + familyID + "." + refreshSecret
	expiresAt := time.Now().Add(mcpRefreshTokenTTL)
	if expiresAt.After(chainExpiresAt) {
		expiresAt = chainExpiresAt
	}
	if err := h.deps.stateStore.PutState(c.Request.Context(), mcpRefreshStateIDPrefix+familyID, auth.LoginState{
		Mode: mcpRefreshMode, UserID: userID,
		OAuthClientID: clientID, OAuthResource: resource, OAuthScope: scope,
		OAuthRefreshTokenHash: auth.HashToken(refreshToken),
		OAuthChainExpiresAt:   chainExpiresAt,
		ExpiresAt:             expiresAt,
	}); err != nil {
		internalErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Header("Pragma", "no-cache")
	c.JSON(http.StatusOK, mcpTokenResponse{
		AccessToken:  accessToken,
		TokenType:    "Bearer",
		ExpiresIn:    int(mcpAccessTokenTTL / time.Second),
		Scope:        scope,
		RefreshToken: refreshToken,
	})
}

func parseMCPTokenRequest(c *gin.Context) (mcpTokenRequest, *oauthRequestError) {
	if !strings.HasPrefix(strings.ToLower(c.GetHeader("Content-Type")), "application/x-www-form-urlencoded") {
		return mcpTokenRequest{}, &oauthRequestError{http.StatusUnsupportedMediaType, "invalid_request", "token requests must be form encoded"}
	}
	grantType := c.PostForm("grant_type")
	if grantType != "authorization_code" && grantType != "refresh_token" {
		return mcpTokenRequest{}, &oauthRequestError{http.StatusBadRequest, "unsupported_grant_type", "only the authorization_code and refresh_token grants are supported"}
	}
	in := mcpTokenRequest{
		GrantType: grantType,
		Code:      c.PostForm("code"), CodeVerifier: c.PostForm("code_verifier"),
		ClientID: c.PostForm("client_id"), RedirectURI: c.PostForm("redirect_uri"), Resource: c.PostForm("resource"),
		RefreshToken: c.PostForm("refresh_token"),
	}
	if grantType == "refresh_token" {
		if in.RefreshToken == "" || in.ClientID == "" || in.Resource == "" {
			return mcpTokenRequest{}, &oauthRequestError{http.StatusBadRequest, "invalid_request", "refresh_token, client_id, and resource are required"}
		}
		return in, nil
	}
	if in.Code == "" || in.CodeVerifier == "" || in.ClientID == "" || in.RedirectURI == "" || in.Resource == "" {
		return mcpTokenRequest{}, &oauthRequestError{http.StatusBadRequest, "invalid_request", "code, code_verifier, client_id, redirect_uri, and resource are required"}
	}
	return in, nil
}

func (h handlers) validMCPCodeGrant(st auth.LoginState, found bool, in mcpTokenRequest) bool {
	return found && st.Mode == "mcp" && st.OAuthClientID == in.ClientID &&
		st.OAuthRedirectURI == in.RedirectURI && st.OAuthResource == in.Resource &&
		in.Resource == h.mcpResource() && auth.VerifyPKCES256(in.CodeVerifier, st.CodeChallenge)
}

func oauthError(c *gin.Context, status int, code, description string) {
	c.Header("Cache-Control", "no-store")
	c.JSON(status, oauthErrorResponse{Error: code, ErrorDescription: description})
}

func firstNonEmpty(value, fallback string) string {
	if value != "" {
		return value
	}
	return fallback
}

func mcpResourceMetadataURL(appOrigin string) string {
	return strings.TrimRight(appOrigin, "/") + "/.well-known/oauth-protected-resource/mcp"
}

func mcpWWWAuthenticate(appOrigin string) string {
	return `Bearer resource_metadata="` + mcpResourceMetadataURL(appOrigin) + `"`
}
