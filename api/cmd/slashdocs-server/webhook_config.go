package main

import (
	"errors"
	"net/url"
	"os"
	"strings"

	"github.com/razorpay/slashdocs/api/internal/webhooks"
)

// loadApprovalWebhook reads the endpoint that receives approval events. An
// unset URL turns approval events off. The errors do not repeat the URL,
// which can hold a credential.
func loadApprovalWebhook() (*webhooks.Endpoint, error) {
	rawURL := strings.TrimSpace(os.Getenv("SLASHDOCS_APPROVAL_WEBHOOK_URL"))
	if rawURL == "" {
		return nil, nil
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return nil, errors.New("SLASHDOCS_APPROVAL_WEBHOOK_URL must be an absolute http or https URL")
	}
	secret := os.Getenv("SLASHDOCS_APPROVAL_WEBHOOK_SECRET")
	if len(secret) < 32 {
		return nil, errors.New("SLASHDOCS_APPROVAL_WEBHOOK_SECRET must be at least 32 bytes when SLASHDOCS_APPROVAL_WEBHOOK_URL is set")
	}
	return &webhooks.Endpoint{URL: rawURL, Secret: []byte(secret)}, nil
}
