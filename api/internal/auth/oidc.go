package auth

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// GoogleIssuer is the OIDC issuer for Google accounts. Deployments configured
// with the legacy GOOGLE_OAUTH_* variables resolve to it.
const GoogleIssuer = "https://accounts.google.com"

// googleJWKSURL is the key endpoint used by Google's ID-token verifier. The
// remote key set fetches it lazily on the first verification and caches keys.
const googleJWKSURL = "https://www.googleapis.com/oauth2/v3/certs"

// googleOAuthEndpoint returns the stable values historically provided by
// oauth2/google.Endpoint without importing that package's unrelated metadata
// client dependencies.
func googleOAuthEndpoint() oauth2.Endpoint {
	//nolint:gosec // G101: these are public OAuth protocol endpoints, not credentials.
	return oauth2.Endpoint{
		AuthURL:       "https://accounts.google.com/o/oauth2/auth",
		TokenURL:      "https://oauth2.googleapis.com/token",
		DeviceAuthURL: "https://oauth2.googleapis.com/device/code",
		AuthStyle:     oauth2.AuthStyleInParams,
	}
}

// OIDCUser holds the identity claims extracted from a verified ID token.
type OIDCUser struct{ Sub, Email, Name, PictureURL string }

// OIDCConfig configures the connection to one OpenID Connect provider.
type OIDCConfig struct {
	// IssuerURL is the provider's public issuer; ID tokens are validated
	// against it and browsers are sent to its authorization endpoint.
	IssuerURL string
	// InternalIssuerURL optionally names a second base URL where the server
	// reaches the same provider (split horizon, e.g. a docker-compose network
	// where the browser sees http://localhost:5556 but the server must dial
	// http://dex:5556). Discovery, token exchange, and JWKS fetches use it;
	// token `iss` claims keep being validated against IssuerURL.
	InternalIssuerURL string
	ClientID          string
	ClientSecret      string
	RedirectURL       string
	// AcceptMissingEmailVerified accepts ID tokens that carry no
	// email_verified claim. See OIDC.AcceptMissingEmailVerified.
	AcceptMissingEmailVerified bool
}

// OIDC drives the OpenID Connect authorization-code flow for one provider.
// Tests may construct it directly with a fake Config; production code should
// go through NewOIDC, which discovers endpoints and wires JWKS verification.
type OIDC struct {
	Config   *oauth2.Config
	Verifier *oidc.IDTokenVerifier
	Issuer   string
	// AcceptMissingEmailVerified is an operator opt-in for identity providers
	// that never send email_verified. By default an ID token must prove the
	// email is verified, because the email gates org login and receives
	// email-addressed shares. An explicit false is rejected either way.
	AcceptMissingEmailVerified bool
}

// ErrEmailNotVerified reports an ID token that does not establish that its
// email address is verified. Errors carrying it are *EmailNotVerifiedError,
// which says why.
var ErrEmailNotVerified = errors.New("email is not verified by the identity provider")

// Reasons an ID token's email was not accepted as verified.
const (
	// EmailVerifiedFalse: the token says email_verified is false (or a
	// non-true value).
	EmailVerifiedFalse = "email_verified_false"
	// EntraDomainNotVerified: no email_verified, and Entra's xms_edov is
	// false (or a non-true value).
	EntraDomainNotVerified = "xms_edov_false"
	// EmailVerifiedMissing: neither claim is present and the operator has not
	// opted in with SLASHDOCS_OIDC_ACCEPT_MISSING_EMAIL_VERIFIED.
	EmailVerifiedMissing = "claim_missing"
)

// EmailNotVerifiedError is returned when the ID token does not establish a
// verified email. errors.Is(err, ErrEmailNotVerified) matches it.
type EmailNotVerifiedError struct{ Reason string }

func (e *EmailNotVerifiedError) Error() string {
	return ErrEmailNotVerified.Error() + " (" + e.Reason + ")"
}

func (e *EmailNotVerifiedError) Is(target error) bool { return target == ErrEmailNotVerified }

// errNonceMismatch reports an ID token that was not issued for this login.
var errNonceMismatch = errors.New("id token nonce does not match the login request")

// LoginBinding ties one authorization request to the token that answers it.
// The nonce is sent to the provider and must come back unchanged in the ID
// token; the PKCE verifier stays on the server and is sent only to the token
// endpoint, so an intercepted authorization code cannot be redeemed alone.
//
// The zero value is a login state written by an older server during a rolling
// deployment, before bindings existed: it adds nothing to the request and
// skips both checks. Login states are created and stored only by the server;
// a client can reach the zero value only by starting a login on an older
// instance during a rollout, which is the exposure that existed before.
// Once a release with bindings has fully rolled out, the zero value can be
// rejected instead.
type LoginBinding struct {
	Nonce        string
	PKCEVerifier string
}

// NewLoginBinding returns a fresh nonce and PKCE verifier from crypto/rand.
func NewLoginBinding() (LoginBinding, error) {
	nonce, err := RandomURLToken()
	if err != nil {
		return LoginBinding{}, err
	}
	verifier, err := RandomURLToken()
	if err != nil {
		return LoginBinding{}, err
	}
	return LoginBinding{Nonce: nonce, PKCEVerifier: verifier}, nil
}

// NewOIDC prepares an OIDC client. Google uses its stable OAuth endpoints and
// a lazy remote JWKS so existing deployments do not require network access at
// startup. Other providers are discovered from
// <issuer>/.well-known/openid-configuration.
func NewOIDC(ctx context.Context, cfg OIDCConfig) (OIDC, error) {
	split := cfg.InternalIssuerURL != "" && cfg.InternalIssuerURL != cfg.IssuerURL
	if cfg.IssuerURL == GoogleIssuer && !split {
		return OIDC{
			Issuer:   GoogleIssuer,
			Verifier: oidc.NewVerifier(GoogleIssuer, oidc.NewRemoteKeySet(ctx, googleJWKSURL), &oidc.Config{ClientID: cfg.ClientID}),
			Config: &oauth2.Config{
				ClientID:     cfg.ClientID,
				ClientSecret: cfg.ClientSecret,
				RedirectURL:  cfg.RedirectURL,
				Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
				Endpoint:     googleOAuthEndpoint(),
			},
		}, nil
	}

	discoveryBase := cfg.IssuerURL
	if split {
		discoveryBase = cfg.InternalIssuerURL
		// The discovery document served over the internal URL still names the
		// public issuer; accept that mismatch here and keep verifying token
		// `iss` claims against the public issuer below.
		ctx = oidc.InsecureIssuerURLContext(ctx, cfg.IssuerURL)
	}
	provider, err := oidc.NewProvider(ctx, discoveryBase)
	if err != nil {
		return OIDC{}, fmt.Errorf("oidc discovery for %s: %w", discoveryBase, err)
	}
	endpoint := provider.Endpoint()
	verifier := provider.Verifier(&oidc.Config{ClientID: cfg.ClientID})
	if split {
		var extra struct {
			JWKSURL string `json:"jwks_uri"`
		}
		if err := provider.Claims(&extra); err != nil {
			return OIDC{}, fmt.Errorf("oidc discovery for %s: %w", discoveryBase, err)
		}
		// Browsers hit the authorization endpoint; the server hits the token
		// endpoint and JWKS. Rebase each onto the side that must reach it.
		endpoint.AuthURL = rebaseURL(endpoint.AuthURL, cfg.InternalIssuerURL, cfg.IssuerURL)
		endpoint.TokenURL = rebaseURL(endpoint.TokenURL, cfg.IssuerURL, cfg.InternalIssuerURL)
		jwks := rebaseURL(extra.JWKSURL, cfg.IssuerURL, cfg.InternalIssuerURL)
		verifier = oidc.NewVerifier(cfg.IssuerURL, oidc.NewRemoteKeySet(ctx, jwks), &oidc.Config{ClientID: cfg.ClientID})
	}
	return OIDC{
		Issuer:                     cfg.IssuerURL,
		AcceptMissingEmailVerified: cfg.AcceptMissingEmailVerified,
		Verifier:                   verifier,
		Config: &oauth2.Config{
			ClientID:     cfg.ClientID,
			ClientSecret: cfg.ClientSecret,
			RedirectURL:  cfg.RedirectURL,
			Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
			Endpoint:     endpoint,
		},
	}, nil
}

// rebaseURL swaps the `from` base URL prefix of u for `to`. URLs outside
// `from` are returned unchanged.
func rebaseURL(u, from, to string) string {
	from = strings.TrimSuffix(from, "/")
	to = strings.TrimSuffix(to, "/")
	if u == from || strings.HasPrefix(u, from+"/") {
		return to + strings.TrimPrefix(u, from)
	}
	return u
}

// AuthCodeURL returns the provider's authorization URL for state, carrying the
// binding's nonce and S256 PKCE challenge. The verifier itself never leaves
// the server.
func (o OIDC) AuthCodeURL(state string, b LoginBinding, opts ...oauth2.AuthCodeOption) string {
	if b.Nonce != "" {
		opts = append(opts, oidc.Nonce(b.Nonce))
	}
	if b.PKCEVerifier != "" {
		opts = append(opts, oauth2.S256ChallengeOption(b.PKCEVerifier))
	}
	return o.Config.AuthCodeURL(state, opts...)
}

// ExchangeAndVerify redeems an authorization code with the binding's PKCE
// verifier, verifies the returned ID token's signature, issuer, audience, and
// expiry, checks that it carries the binding's nonce, and requires a verified
// email address.
func (o OIDC) ExchangeAndVerify(ctx context.Context, code string, b LoginBinding) (OIDCUser, error) {
	var opts []oauth2.AuthCodeOption
	if b.PKCEVerifier != "" {
		opts = append(opts, oauth2.VerifierOption(b.PKCEVerifier))
	}
	tok, err := o.Config.Exchange(ctx, code, opts...)
	if err != nil {
		return OIDCUser{}, err
	}
	raw, ok := tok.Extra("id_token").(string)
	if !ok || raw == "" {
		return OIDCUser{}, errors.New("missing id_token")
	}
	idToken, err := o.Verifier.Verify(ctx, raw)
	if err != nil {
		return OIDCUser{}, err
	}
	if b.Nonce != "" && subtle.ConstantTimeCompare([]byte(idToken.Nonce), []byte(b.Nonce)) != 1 {
		return OIDCUser{}, errNonceMismatch
	}
	if strings.TrimSpace(idToken.Subject) == "" {
		return OIDCUser{}, errors.New("missing subject claim")
	}
	// Decode into a map and read exact claim names. Decoding into a struct
	// would match names case-insensitively, so "Email_Verified" or "EMAIL"
	// (for example from a custom attribute mapping) could stand in for the
	// standard claims.
	var claims map[string]json.RawMessage
	if err := idToken.Claims(&claims); err != nil {
		return OIDCUser{}, err
	}
	email := stringClaim(claims["email"])
	if strings.TrimSpace(email) == "" {
		return OIDCUser{}, errors.New("missing email claim")
	}
	// xms_edov is Microsoft Entra's optional claim stating that the owner of
	// the email's domain is verified. Entra never sends email_verified.
	if reason := o.emailNotVerifiedReason(claims["email_verified"], claims["xms_edov"]); reason != "" {
		return OIDCUser{}, &EmailNotVerifiedError{Reason: reason}
	}
	return OIDCUser{Sub: idToken.Subject, Email: email, Name: stringClaim(claims["name"]), PictureURL: stringClaim(claims["picture"])}, nil
}

// emailNotVerifiedReason decides whether the ID token establishes a verified
// email, returning "" when it does. email_verified, when present, is
// authoritative. Without it, Entra's xms_edov decides when present. With
// neither, the email is accepted only when the operator opted in.
func (o OIDC) emailNotVerifiedReason(emailVerified, entraDomainOwnerVerified json.RawMessage) string {
	switch {
	case claimPresent(emailVerified):
		if claimTrue(emailVerified) {
			return ""
		}
		return EmailVerifiedFalse
	case claimPresent(entraDomainOwnerVerified):
		if claimTrue(entraDomainOwnerVerified) {
			return ""
		}
		return EntraDomainNotVerified
	case o.AcceptMissingEmailVerified:
		return ""
	default:
		return EmailVerifiedMissing
	}
}

// stringClaim returns a string claim, or "" when it is absent or not a string.
func stringClaim(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

func claimPresent(raw json.RawMessage) bool {
	return len(raw) > 0 && string(raw) != "null"
}

// claimTrue reads a boolean claim. The spec type is a JSON boolean, but some
// providers emit the string "true" (AWS Cognito) or "1" (Entra optional
// claims). Anything else, including other strings and numbers, is false.
func claimTrue(raw json.RawMessage) bool {
	var b bool
	if json.Unmarshal(raw, &b) == nil {
		return b
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s == "1" || strings.EqualFold(s, "true")
	}
	return false
}

func LoopbackRedirectAllowed(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost")
}
