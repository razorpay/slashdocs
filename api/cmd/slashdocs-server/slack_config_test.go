package main

import "testing"

func TestLoadSlackLinkPreviews(t *testing.T) {
	cases := []struct {
		name             string
		enabled          bool
		botToken, secret string
		wantSecret       string
		wantErr          bool
	}{
		{name: "off ignores secrets", enabled: false, botToken: "xoxb", secret: "s", wantSecret: ""},
		{name: "off with nothing set", enabled: false},
		{name: "on with both", enabled: true, botToken: "xoxb", secret: " s ", wantSecret: "s"},
		{name: "on without signing secret", enabled: true, botToken: "xoxb", wantErr: true},
		{name: "on without bot token", enabled: true, secret: "s", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := loadSlackLinkPreviews(tc.enabled, tc.botToken, tc.secret)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if got != tc.wantSecret {
				t.Fatalf("secret = %q, want %q", got, tc.wantSecret)
			}
		})
	}
}
