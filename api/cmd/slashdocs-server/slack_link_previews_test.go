package main

import "testing"

func TestLoadSlackLinkPreviews(t *testing.T) {
	for _, tc := range []struct {
		name, enabled, botToken, signingSecret string
		wantOption, wantErr                    bool
	}{
		{name: "off by default", botToken: "xoxb", signingSecret: "s"},
		{name: "off", enabled: "false", botToken: "xoxb", signingSecret: "s"},
		{name: "on", enabled: "true", botToken: "xoxb", signingSecret: " s ", wantOption: true},
		{name: "malformed switch", enabled: "yes", wantErr: true},
		{name: "on without signing secret", enabled: "true", botToken: "xoxb", wantErr: true},
		{name: "on without bot token", enabled: "true", signingSecret: "s", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SLASHDOCS_SLACK_LINK_PREVIEWS", tc.enabled)
			t.Setenv("SLASHDOCS_SLACK_BOT_TOKEN", tc.botToken)
			t.Setenv("SLASHDOCS_SLACK_SIGNING_SECRET", tc.signingSecret)
			option, err := loadSlackLinkPreviews()
			if (err != nil) != tc.wantErr || (option != nil) != tc.wantOption {
				t.Fatalf("option = %v, err = %v", option != nil, err)
			}
		})
	}
}
