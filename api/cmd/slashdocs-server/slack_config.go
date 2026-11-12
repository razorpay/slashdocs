package main

import (
	"errors"
	"strings"
)

// loadSlackLinkPreviews returns the signing secret when previews are on; both Slack secrets are then required.
func loadSlackLinkPreviews(enabled bool, botToken, signingSecret string) (string, error) {
	if !enabled {
		return "", nil
	}
	signingSecret = strings.TrimSpace(signingSecret)
	if signingSecret == "" {
		return "", errors.New("SLASHDOCS_SLACK_LINK_PREVIEWS is true but SLASHDOCS_SLACK_SIGNING_SECRET is empty")
	}
	if strings.TrimSpace(botToken) == "" {
		return "", errors.New("SLASHDOCS_SLACK_LINK_PREVIEWS is true but SLASHDOCS_SLACK_BOT_TOKEN is empty")
	}
	return signingSecret, nil
}
