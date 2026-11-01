package main

import (
	"maps"
	"slices"
	"testing"
)

func envFrom(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestLoadNotificationSenders(t *testing.T) {
	webhook := "https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t"
	cases := []struct {
		name      string
		env       map[string]string
		providers []string
		wantErr   bool
	}{
		{"none", nil, nil, false},
		{"slack", map[string]string{"SLASHDOCS_SLACK_BOT_TOKEN": "xoxb-test"}, []string{"slack"}, false},
		{"chat webhook", map[string]string{"SLASHDOCS_GOOGLE_CHAT_WEBHOOK_URL": webhook}, []string{"google_chat"}, false},
		{"bad webhook", map[string]string{"SLASHDOCS_GOOGLE_CHAT_WEBHOOK_URL": "https://example.com/hook"}, nil, true},
		{"both providers", map[string]string{"SLASHDOCS_SLACK_BOT_TOKEN": "xoxb-test", "SLASHDOCS_GOOGLE_CHAT_WEBHOOK_URL": webhook}, []string{"google_chat", "slack"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			senders, err := loadNotificationSenders(envFrom(tc.env))
			if (err != nil) != tc.wantErr || !slices.Equal(slices.Sorted(maps.Keys(senders)), tc.providers) {
				t.Fatalf("senders=%v err=%v", senders, err)
			}
		})
	}
}
