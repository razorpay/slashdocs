package auth

import (
	"context"
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
}

// OIDC drives the OpenID Connect authorization-code flow for one provider.
// Tests may construct it directly with a fake Config; production code should
// go through NewOIDC, which discovers endpoints and wires JWKS verification.
type OIDC struct {
	Config   *oauth2.Config
	Verifier *oidc.IDTokenVerifier
	Issuer   string
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
		Issuer:   cfg.IssuerURL,
		Verifier: verifier,
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

func (o OIDC) AuthCodeURL(state string, opts ...oauth2.AuthCodeOption) string {
	return o.Config.AuthCodeURL(state, opts...)
}

// ExchangeAndVerify redeems an authorization code and verifies the returned
// ID token's signature, issuer, audience, and expiry.
func (o OIDC) ExchangeAndVerify(ctx context.Context, code string, opts ...oauth2.AuthCodeOption) (OIDCUser, error) {
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
	if strings.TrimSpace(idToken.Subject) == "" {
		return OIDCUser{}, errors.New("missing subject claim")
	}
	var claims struct {
		Email         string     `json:"email"`
		EmailVerified *boolClaim `json:"email_verified"`
		// Entra ID never sends email_verified. Its optional xms_edov claim
		// says whether the owner of the email's domain is verified.
		EntraEmailVerified *boolClaim `json:"xms_edov"`
		Name               string     `json:"name"`
		Picture            string     `json:"picture"`
	}
	if err := idToken.Claims(&claims); err != nil {
		return OIDCUser{}, err
	}
	if strings.TrimSpace(claims.Email) == "" {
		return OIDCUser{}, errors.New("missing email claim")
	}
	// Fail closed: a provider that omits the claim may let users choose any
	// email, and the email gates org login and receives email-addressed shares.
	verified := claims.EmailVerified
	if verified == nil {
		verified = claims.EntraEmailVerified
	}
	if verified == nil || !*verified {
		return OIDCUser{}, errors.New("email is not verified by the identity provider: the id token needs email_verified or xms_edov set to true")
	}
	return OIDCUser{Sub: idToken.Subject, Email: claims.Email, Name: claims.Name, PictureURL: claims.Picture}, nil
}

// boolClaim reads a boolean claim that some providers send as a string, such
// as Entra's xms_edov "1". Any value other than true, "true", or "1" is false.
type boolClaim bool

func (c *boolClaim) UnmarshalJSON(raw []byte) error {
	v := strings.Trim(string(raw), `"`)
	*c = v == "true" || v == "1"
	return nil
}

func LoopbackRedirectAllowed(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost")
}
