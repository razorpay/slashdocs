package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/server"
)

func TestLoadGoogleGroupsConfigDisabledByDefault(t *testing.T) {
	t.Setenv("SLASHDOCS_GOOGLE_GROUPS_ENABLED", "")
	cfg, err := loadGoogleGroupsConfig(context.Background(), server.DeploymentPublic)
	if err != nil || cfg.enabled || cfg.directory != nil {
		t.Fatalf("cfg=%+v err=%v", cfg, err)
	}
}

func TestLoadGoogleGroupsConfigRejectsMalformedOrIncompleteConfiguration(t *testing.T) {
	t.Setenv("SLASHDOCS_GOOGLE_GROUPS_ENABLED", "yes")
	if _, err := loadGoogleGroupsConfig(context.Background(), server.DeploymentOrg); err == nil {
		t.Fatal("malformed enabled value accepted")
	}
	t.Setenv("SLASHDOCS_GOOGLE_GROUPS_ENABLED", "true")
	if _, err := loadGoogleGroupsConfig(context.Background(), server.DeploymentPublic); err == nil {
		t.Fatal("public deployment accepted")
	}
	if _, err := loadGoogleGroupsConfig(context.Background(), server.DeploymentOrg); err == nil {
		t.Fatal("incomplete org configuration accepted")
	}
}

func TestLoadGoogleGroupsConfigBuildsDelegatedDirectoryWithoutLiveCall(t *testing.T) {
	credentials := serviceAccountCredentials(t)
	t.Setenv("SLASHDOCS_GOOGLE_GROUPS_ENABLED", "true")
	t.Setenv("GOOGLE_GROUPS_CUSTOMER_ID", "C123")
	t.Setenv("GOOGLE_GROUPS_ADMIN_EMAIL", "admin@example.com")
	t.Setenv("GOOGLE_GROUPS_CREDENTIALS_FILE", credentials)
	t.Setenv("GOOGLE_GROUPS_MEMBERSHIP_TTL", "45s")
	t.Setenv("GOOGLE_GROUPS_REQUEST_TIMEOUT", "2s")
	cfg, err := loadGoogleGroupsConfig(context.Background(), server.DeploymentOrg)
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.enabled || cfg.directory == nil || cfg.membershipTTL != 45*time.Second {
		t.Fatalf("cfg=%+v", cfg)
	}

	t.Setenv("GOOGLE_GROUPS_MEMBERSHIP_TTL", "not-a-duration")
	_, err = loadGoogleGroupsConfig(context.Background(), server.DeploymentOrg)
	if err == nil || strings.Contains(err.Error(), credentials) {
		t.Fatalf("duration error=%v", err)
	}
}

func serviceAccountCredentials(t *testing.T) string {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	privateKey, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	//nolint:gosec // G101 matches the "private_key" keys; this is a throwaway key generated in-test, not a real credential.
	payload, err := json.Marshal(map[string]string{
		"type": "service_account", "client_email": "reader@example.iam.gserviceaccount.com",
		"private_key_id": "test", "private_key": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateKey})),
		"token_uri": "https://oauth2.googleapis.com/token",
	})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
