package main

import (
	"errors"
	"strings"

	"github.com/razorpay/slashdocs/api/internal/notifications"
)

// loadNotificationSender picks the one configured delivery provider. Secrets
// come from the environment so deployment charts can inject them from a secret
// store. No provider means notifications are disabled.
func loadNotificationSender(getenv func(string) string) (notifications.Sender, error) {
	slackToken := strings.TrimSpace(getenv("SLASHDOCS_SLACK_BOT_TOKEN"))
	chatWebhook := strings.TrimSpace(getenv("SLASHDOCS_GOOGLE_CHAT_WEBHOOK_URL"))
	switch {
	case slackToken != "" && chatWebhook != "":
		return nil, errors.New("configure only one of SLASHDOCS_SLACK_BOT_TOKEN, SLASHDOCS_GOOGLE_CHAT_WEBHOOK_URL")
	case slackToken != "":
		return notifications.NewSlack(slackToken), nil
	case chatWebhook != "":
		sender, err := notifications.NewGoogleChatWebhook(chatWebhook)
		if err != nil {
			return nil, err
		}
		return sender, nil
	}
	return nil, nil
}
