package main

import "testing"

func envFrom(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestLoadNotificationSender(t *testing.T) {
	webhook := "https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t"
	cases := []struct {
		name    string
		env     map[string]string
		enabled bool
		wantErr bool
	}{
		{"none", nil, false, false},
		{"slack", map[string]string{"SLASHDOCS_SLACK_BOT_TOKEN": "xoxb-test"}, true, false},
		{"chat webhook", map[string]string{"SLASHDOCS_GOOGLE_CHAT_WEBHOOK_URL": webhook}, true, false},
		{"bad webhook", map[string]string{"SLASHDOCS_GOOGLE_CHAT_WEBHOOK_URL": "https://example.com/hook"}, false, true},
		{"two providers", map[string]string{"SLASHDOCS_SLACK_BOT_TOKEN": "xoxb-test", "SLASHDOCS_GOOGLE_CHAT_WEBHOOK_URL": webhook}, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sender, err := loadNotificationSender(envFrom(tc.env))
			if (err != nil) != tc.wantErr || (sender != nil) != tc.enabled {
				t.Fatalf("sender=%v err=%v", sender, err)
			}
		})
	}
}
