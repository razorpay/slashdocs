package main

import (
	"strings"

	"github.com/razorpay/slashdocs/api/internal/notifications"
)

// Deployment charts inject the bot token from a Kubernetes Secret.
func loadSlackSender(token string) notifications.Sender {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil
	}
	return notifications.NewSlack(token)
}
