package auth_test

import (
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

func envmap(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestResolveOIDCSettingsGoogleVarsAlias(t *testing.T) {
	s, err := auth.ResolveOIDCSettings(envmap(map[string]string{
		"GOOGLE_OAUTH_CLIENT_ID":     "gid",
		"GOOGLE_OAUTH_CLIENT_SECRET": "gsecret",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if s.IssuerURL != auth.GoogleIssuer || s.ClientID != "gid" || s.ClientSecret != "gsecret" {
		t.Fatalf("settings = %+v, want Google issuer with the GOOGLE_OAUTH_* credentials", s)
	}
	if s.ProviderName != "Google" {
		t.Fatalf("ProviderName = %q, want Google", s.ProviderName)
	}
}

func TestResolveOIDCSettingsGeneric(t *testing.T) {
	s, err := auth.ResolveOIDCSettings(envmap(map[string]string{
		"SLASHDOCS_OIDC_ISSUER_URL":    "https://sso.example",
		"SLASHDOCS_OIDC_CLIENT_ID":     "cid",
		"SLASHDOCS_OIDC_CLIENT_SECRET": "csecret",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if s.IssuerURL != "https://sso.example" || s.ClientID != "cid" || s.ClientSecret != "csecret" {
		t.Fatalf("settings = %+v", s)
	}
	if s.ProviderName != "SSO" {
		t.Fatalf("ProviderName = %q, want the SSO default", s.ProviderName)
	}
	if s.InternalIssuerURL != "" {
		t.Fatalf("InternalIssuerURL = %q, want empty", s.InternalIssuerURL)
	}
}

func TestResolveOIDCSettingsProviderNameAndInternalIssuer(t *testing.T) {
	s, err := auth.ResolveOIDCSettings(envmap(map[string]string{
		"SLASHDOCS_OIDC_ISSUER_URL":          "http://localhost:5556",
		"SLASHDOCS_OIDC_INTERNAL_ISSUER_URL": "http://dex:5556",
		"SLASHDOCS_OIDC_CLIENT_ID":           "cid",
		"SLASHDOCS_OIDC_CLIENT_SECRET":       "csecret",
		"SLASHDOCS_OIDC_PROVIDER_NAME":       "Dex",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if s.InternalIssuerURL != "http://dex:5556" || s.ProviderName != "Dex" {
		t.Fatalf("settings = %+v", s)
	}
}

func TestResolveOIDCSettingsRejectsMixedFamilies(t *testing.T) {
	for name, env := range map[string]map[string]string{
		"google id with oidc issuer": {
			"GOOGLE_OAUTH_CLIENT_ID":    "gid",
			"SLASHDOCS_OIDC_ISSUER_URL": "https://sso.example",
		},
		"google pair with internal issuer": {
			"GOOGLE_OAUTH_CLIENT_ID":             "gid",
			"GOOGLE_OAUTH_CLIENT_SECRET":         "gsecret",
			"SLASHDOCS_OIDC_INTERNAL_ISSUER_URL": "http://dex:5556",
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := auth.ResolveOIDCSettings(envmap(env)); err == nil {
				t.Fatal("want a configuration conflict error, got nil")
			}
		})
	}
}

func TestResolveOIDCSettingsRejectsPartialConfig(t *testing.T) {
	for name, env := range map[string]map[string]string{
		"nothing set":            {},
		"google id only":         {"GOOGLE_OAUTH_CLIENT_ID": "gid"},
		"oidc issuer only":       {"SLASHDOCS_OIDC_ISSUER_URL": "https://sso.example"},
		"oidc missing client id": {"SLASHDOCS_OIDC_ISSUER_URL": "https://sso.example", "SLASHDOCS_OIDC_CLIENT_SECRET": "csecret"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := auth.ResolveOIDCSettings(envmap(env)); err == nil {
				t.Fatal("want an error for incomplete configuration, got nil")
			}
		})
	}
}
