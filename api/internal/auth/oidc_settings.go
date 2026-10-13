package auth

import (
	"errors"
	"fmt"
	"strconv"
)

// OIDCSettings is the login provider configuration resolved from environment
// variables.
type OIDCSettings struct {
	IssuerURL         string
	InternalIssuerURL string
	ClientID          string
	ClientSecret      string
	// ProviderName labels the login button ("Continue with <ProviderName>").
	ProviderName string
	// AcceptMissingEmailVerified is SLASHDOCS_OIDC_ACCEPT_MISSING_EMAIL_VERIFIED:
	// accept ID tokens without an email_verified claim. Generic OIDC only.
	AcceptMissingEmailVerified bool
}

const acceptMissingEmailVerifiedEnv = "SLASHDOCS_OIDC_ACCEPT_MISSING_EMAIL_VERIFIED"

// ResolveOIDCSettings resolves the generic SLASHDOCS_OIDC_* variables and the
// legacy GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET pair into one
// provider configuration. The Google pair keeps working as an alias for
// issuer https://accounts.google.com so existing deployments need no changes;
// mixing the two families is a configuration error. getenv is os.Getenv in
// production.
func ResolveOIDCSettings(getenv func(string) string) (OIDCSettings, error) {
	google := OIDCSettings{
		IssuerURL:    GoogleIssuer,
		ClientID:     getenv("GOOGLE_OAUTH_CLIENT_ID"),
		ClientSecret: getenv("GOOGLE_OAUTH_CLIENT_SECRET"),
	}
	generic := OIDCSettings{
		IssuerURL:         getenv("SLASHDOCS_OIDC_ISSUER_URL"),
		InternalIssuerURL: getenv("SLASHDOCS_OIDC_INTERNAL_ISSUER_URL"),
		ClientID:          getenv("SLASHDOCS_OIDC_CLIENT_ID"),
		ClientSecret:      getenv("SLASHDOCS_OIDC_CLIENT_SECRET"),
	}
	providerName := getenv("SLASHDOCS_OIDC_PROVIDER_NAME")
	acceptMissing, err := parseAcceptMissingEmailVerified(getenv)
	if err != nil {
		return OIDCSettings{}, err
	}

	googleSet := google.ClientID != "" || google.ClientSecret != ""
	genericSet := generic.IssuerURL != "" || generic.InternalIssuerURL != "" || generic.ClientID != "" || generic.ClientSecret != ""
	switch {
	case googleSet && genericSet:
		return OIDCSettings{}, errors.New("configure either GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET or the SLASHDOCS_OIDC_* variables, not both")
	case googleSet:
		return googleSettings(google, providerName, acceptMissing)
	case genericSet:
		if generic.IssuerURL == "" || generic.ClientID == "" || generic.ClientSecret == "" {
			return OIDCSettings{}, errors.New("SLASHDOCS_OIDC_ISSUER_URL, SLASHDOCS_OIDC_CLIENT_ID, and SLASHDOCS_OIDC_CLIENT_SECRET are all required")
		}
		if acceptMissing && generic.IssuerURL == GoogleIssuer {
			return OIDCSettings{}, fmt.Errorf("%s does not apply to Google, which always sends email_verified", acceptMissingEmailVerifiedEnv)
		}
		generic.ProviderName = defaultString(providerName, "SSO")
		generic.AcceptMissingEmailVerified = acceptMissing
		return generic, nil
	default:
		return OIDCSettings{}, errors.New("login is not configured: set SLASHDOCS_OIDC_ISSUER_URL, SLASHDOCS_OIDC_CLIENT_ID, and SLASHDOCS_OIDC_CLIENT_SECRET (or GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET for Google)")
	}
}

func googleSettings(google OIDCSettings, providerName string, acceptMissing bool) (OIDCSettings, error) {
	if google.ClientID == "" || google.ClientSecret == "" {
		return OIDCSettings{}, errors.New("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are both required")
	}
	if acceptMissing {
		// Google always sends email_verified; the opt-in could only weaken it.
		return OIDCSettings{}, fmt.Errorf("%s applies only to SLASHDOCS_OIDC_* providers; Google always sends email_verified", acceptMissingEmailVerifiedEnv)
	}
	google.ProviderName = defaultString(providerName, "Google")
	return google, nil
}

// parseAcceptMissingEmailVerified reads the opt-in. Unset means false.
func parseAcceptMissingEmailVerified(getenv func(string) string) (bool, error) {
	raw := getenv(acceptMissingEmailVerifiedEnv)
	if raw == "" {
		return false, nil
	}
	v, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false (got %q)", acceptMissingEmailVerifiedEnv, raw)
	}
	return v, nil
}

func defaultString(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}
