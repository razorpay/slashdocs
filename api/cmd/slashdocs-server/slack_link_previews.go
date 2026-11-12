package main

import (
	"errors"
	"os"
	"strings"

	"github.com/razorpay/slashdocs/api/internal/notifications"
	"github.com/razorpay/slashdocs/api/internal/server"
)

// loadSlackLinkPreviews returns the option that serves Slack link previews, or
// nil when SLASHDOCS_SLACK_LINK_PREVIEWS is off. Previews need the bot token
// and the Slack app's signing secret.
func loadSlackLinkPreviews() (server.Option, error) {
	enabled, err := boolEnv("SLASHDOCS_SLACK_LINK_PREVIEWS", false)
	if err != nil || !enabled {
		return nil, err
	}
	botToken := strings.TrimSpace(os.Getenv("SLASHDOCS_SLACK_BOT_TOKEN"))
	signingSecret := strings.TrimSpace(os.Getenv("SLASHDOCS_SLACK_SIGNING_SECRET"))
	if botToken == "" || signingSecret == "" {
		return nil, errors.New("SLASHDOCS_SLACK_LINK_PREVIEWS needs SLASHDOCS_SLACK_BOT_TOKEN and SLASHDOCS_SLACK_SIGNING_SECRET")
	}
	return server.WithSlackLinkPreviews(signingSecret, notifications.NewSlack(botToken)), nil
}
