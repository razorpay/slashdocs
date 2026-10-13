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

func TestResolveOIDCSettingsAcceptMissingEmailVerified(t *testing.T) {
	generic := map[string]string{
		"SLASHDOCS_OIDC_ISSUER_URL":    "https://sso.example",
		"SLASHDOCS_OIDC_CLIENT_ID":     "id",
		"SLASHDOCS_OIDC_CLIENT_SECRET": "secret",
	}
	for _, tc := range []struct {
		name    string
		env     map[string]string
		want    bool
		wantErr bool
	}{
		{name: "default is fail-closed", env: generic},
		{name: "true", env: with(generic, "SLASHDOCS_OIDC_ACCEPT_MISSING_EMAIL_VERIFIED", "true"), want: true},
		{name: "false", env: with(generic, "SLASHDOCS_OIDC_ACCEPT_MISSING_EMAIL_VERIFIED", "false")},
		{name: "invalid value", env: with(generic, "SLASHDOCS_OIDC_ACCEPT_MISSING_EMAIL_VERIFIED", "maybe"), wantErr: true},
		{name: "not allowed with Google through the generic variables", env: with(map[string]string{
			"SLASHDOCS_OIDC_ISSUER_URL":    "https://accounts.google.com",
			"SLASHDOCS_OIDC_CLIENT_ID":     "id",
			"SLASHDOCS_OIDC_CLIENT_SECRET": "secret",
		}, "SLASHDOCS_OIDC_ACCEPT_MISSING_EMAIL_VERIFIED", "true"), wantErr: true},
		{name: "not allowed with Google", env: map[string]string{
			"GOOGLE_OAUTH_CLIENT_ID":                       "id",
			"GOOGLE_OAUTH_CLIENT_SECRET":                   "secret",
			"SLASHDOCS_OIDC_ACCEPT_MISSING_EMAIL_VERIFIED": "true",
		}, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := auth.ResolveOIDCSettings(func(k string) string { return tc.env[k] })
			if gotErr := err != nil; gotErr != tc.wantErr {
				t.Fatalf("error = %v, want error = %t", err, tc.wantErr)
			}
			if err == nil && got.AcceptMissingEmailVerified != tc.want {
				t.Fatalf("AcceptMissingEmailVerified = %t, want %t", got.AcceptMissingEmailVerified, tc.want)
			}
		})
	}
}

func with(base map[string]string, k, v string) map[string]string {
	out := make(map[string]string, len(base)+1)
	for bk, bv := range base {
		out[bk] = bv
	}
	out[k] = v
	return out
}
