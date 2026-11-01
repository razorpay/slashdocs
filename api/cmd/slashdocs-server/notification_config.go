package main

import (
	"strings"

	"github.com/razorpay/slashdocs/api/internal/notifications"
)

// loadNotificationSenders returns every configured delivery provider by name.
// Secrets come from the environment so deployment charts can inject them from
// a secret store. No provider means notifications are disabled.
func loadNotificationSenders(getenv func(string) string) (map[string]notifications.Sender, error) {
	senders := map[string]notifications.Sender{}
	if token := strings.TrimSpace(getenv("SLASHDOCS_SLACK_BOT_TOKEN")); token != "" {
		senders["slack"] = notifications.NewSlack(token)
	}
	if webhook := strings.TrimSpace(getenv("SLASHDOCS_GOOGLE_CHAT_WEBHOOK_URL")); webhook != "" {
		chat, err := notifications.NewGoogleChatWebhook(webhook)
		if err != nil {
			return nil, err
		}
		senders["google_chat"] = chat
	}
	return senders, nil
}
