package server

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

func TestGoogleHostedDomain(t *testing.T) {
	tests := []struct {
		name       string
		deployment string
		domains    []string
		want       string
	}{
		{"org with one domain", DeploymentOrg, []string{"acme.com"}, "acme.com"},
		{"org with multiple domains", DeploymentOrg, []string{"acme.com", "acme-labs.io"}, ""},
		{"org with no domains", DeploymentOrg, nil, ""},
		{"public with one domain", DeploymentPublic, []string{"acme.com"}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := googleHostedDomain(tt.deployment, tt.domains); got != tt.want {
				t.Fatalf("googleHostedDomain(%q, %v) = %q, want %q", tt.deployment, tt.domains, got, tt.want)
			}
		})
	}
}

func TestEmailDomainAllowed(t *testing.T) {
	tests := []struct {
		name    string
		email   string
		allowed []string
		want    bool
	}{
		{"no allowlist admits anyone", "user@example.com", nil, true},
		{"exact match", "user@acme.com", []string{"acme.com"}, true},
		{"case-insensitive match", "user@ACME.com", []string{"Acme.COM"}, true},
		{"allowlist entries are trimmed", "user@acme.com", []string{" acme.com "}, true},
		{"second entry matches", "user@acme-labs.io", []string{"acme.com", "acme-labs.io"}, true},
		{"other domain rejected", "user@evil.com", []string{"acme.com"}, false},
		{"subdomain is not a match", "user@sub.acme.com", []string{"acme.com"}, false},
		{"no at sign", "acme.com", []string{"acme.com"}, false},
		{"trailing at sign", "user@", []string{"acme.com"}, false},
		{"domain of last at sign wins", "user@evil.com@acme.com", []string{"evil.com"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := emailDomainAllowed(tt.email, tt.allowed); got != tt.want {
				t.Fatalf("emailDomainAllowed(%q, %v) = %v, want %v", tt.email, tt.allowed, got, tt.want)
			}
		})
	}
}

func TestDefaultProviderName(t *testing.T) {
	if got := defaultProviderName(""); got != "SSO" {
		t.Fatalf("defaultProviderName(\"\") = %q, want \"SSO\"", got)
	}
	if got := defaultProviderName("Okta"); got != "Okta" {
		t.Fatalf("defaultProviderName(\"Okta\") = %q, want \"Okta\"", got)
	}
}

func TestOIDCAuthMetricKindPreservesGoogleSeries(t *testing.T) {
	t.Parallel()

	tests := []struct {
		issuer string
		want   string
	}{
		{issuer: auth.GoogleIssuer, want: "google"},
		{issuer: "https://sso.example.com", want: "oidc"},
		{issuer: "", want: "oidc"},
	}
	for _, tt := range tests {
		if got := oidcAuthMetricKind(tt.issuer); got != tt.want {
			t.Errorf("oidcAuthMetricKind(%q) = %q, want %q", tt.issuer, got, tt.want)
		}
	}
}

func TestOIDCIdentityKeysNamespaceGenericSubjectsByExactIssuer(t *testing.T) {
	t.Parallel()
	const subject = "shared-subject"

	firstID, firstExternalSubject := oidcIdentityKeys("https://issuer-one.example", subject)
	repeatID, repeatExternalSubject := oidcIdentityKeys("https://issuer-one.example", subject)
	secondID, secondExternalSubject := oidcIdentityKeys("https://issuer-two.example", subject)
	otherSubjectID, otherExternalSubject := oidcIdentityKeys("https://issuer-one.example", "other-subject")
	if repeatID != firstID || repeatExternalSubject != firstExternalSubject {
		t.Fatal("generic OIDC identity namespace was not deterministic")
	}
	if otherSubjectID == firstID || otherExternalSubject == firstExternalSubject {
		t.Fatal("distinct subjects from the same issuer shared an account namespace")
	}
	if firstID == secondID {
		t.Fatalf("generic OIDC user IDs collided: %q", firstID)
	}
	if firstExternalSubject == secondExternalSubject {
		t.Fatalf("generic OIDC external identity keys collided: %q", firstExternalSubject)
	}
	for _, item := range []struct {
		name, value, prefix string
	}{
		{"first user ID", firstID, oidcUserIDPrefix},
		{"second user ID", secondID, oidcUserIDPrefix},
		{"first external subject", firstExternalSubject, "oidc_sha256_"},
		{"second external subject", secondExternalSubject, "oidc_sha256_"},
	} {
		if !strings.HasPrefix(item.value, item.prefix) || len(item.value) != len(item.prefix)+sha256.Size*2 {
			t.Fatalf("%s is not a bounded SHA-256 namespace: %q", item.name, item.value)
		}
	}
	wantDigest := sha256.Sum256([]byte("aidocs-oidc-subject-v1\x00https://issuer-one.example\x00" + subject))
	wantNamespace := hex.EncodeToString(wantDigest[:])
	if firstID != oidcUserIDPrefix+wantNamespace || firstExternalSubject != "oidc_sha256_"+wantNamespace {
		t.Fatalf("generic OIDC namespace does not use the documented exact issuer and subject: id=%q external=%q", firstID, firstExternalSubject)
	}

	// OIDC issuer identifiers are exact identifiers. A trailing slash is not
	// normalized into the same account namespace.
	withoutSlashID, withoutSlashSubject := oidcIdentityKeys("https://issuer.example", subject)
	withSlashID, withSlashSubject := oidcIdentityKeys("https://issuer.example/", subject)
	if withoutSlashID == withSlashID || withoutSlashSubject == withSlashSubject {
		t.Fatal("distinct exact issuer identifiers shared an account namespace")
	}
}

func TestOIDCIdentityKeysPreserveGoogleCompatibility(t *testing.T) {
	t.Parallel()
	const subject = "google-subject-123"

	userID, externalSubject := oidcIdentityKeys(auth.GoogleIssuer, subject)
	if userID != googleUserIDPrefix+subject {
		t.Fatalf("Google user ID = %q, want historical %q", userID, googleUserIDPrefix+subject)
	}
	if externalSubject != subject {
		t.Fatalf("Google external subject = %q, want raw subject %q", externalSubject, subject)
	}
}
