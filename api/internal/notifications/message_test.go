package notifications

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

func TestSlackMessageContent(t *testing.T) {
	message := Message{DocumentTitle: "Launch <review>", Highlight: "Ship on Friday", Body: "Please review <!here> & <@U123>", Actor: "Reviewer <!here> & <@U123>", Link: "https://slashdocs.example.com/app/d/doc_1?comment=cmt_1", Reply: true}
	payload := slackMessage("D1", message)
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	type block struct {
		Type     string
		Elements []struct {
			Type     string
			Elements []struct{ Type, Text, URL string }
		}
	}
	var decoded struct {
		Text        string
		Blocks      []block
		Attachments []json.RawMessage
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	fallback := decoded.Text
	for _, want := range []string{message.DocumentTitle, message.Highlight, message.Body, message.Actor + " replied", message.Link} {
		if !strings.Contains(fallback, want) {
			t.Errorf("fallback missing %q", want)
		}
	}
	if payload["parse"] != "none" || payload["mrkdwn"] != false || payload["link_names"] != false {
		t.Fatal("comment text must not trigger Slack parsing or mentions")
	}
	if len(decoded.Blocks) != 3 || len(decoded.Attachments) != 0 {
		t.Fatal("message must use native rich text followed by the action button")
	}
	if got := decoded.Blocks[0].Elements[0].Elements[0].Text; got != "💬 "+message.Actor+" replied to a comment on your doc" {
		t.Fatalf("activity heading = %q", got)
	}
	parts := decoded.Blocks[1].Elements
	if len(parts) != 3 || parts[1].Type != "rich_text_quote" || parts[1].Elements[0].Text != message.Highlight {
		t.Fatal("highlight must render as a native quote")
	}
	if parts[0].Elements[1].Text != message.DocumentTitle || strings.TrimSpace(parts[2].Elements[0].Text) != message.Body {
		t.Fatal("title and comment content must be preserved")
	}
	for _, part := range parts {
		for _, element := range part.Elements {
			trustedTitleLink := element.Type == "link" && element.URL == message.Link && element.Text == message.DocumentTitle
			if element.Type != "text" && !trustedTitleLink {
				t.Fatal("content must stay literal text, never Slack mention elements")
			}
		}
	}
	message.Highlight = ""
	encoded, err = json.Marshal(slackMessage("D1", message))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Blocks[1].Elements) != 2 {
		t.Fatal("missing highlight must not create an empty block")
	}
}

func TestSlackCommentActivityHeadings(t *testing.T) {
	tests := []struct {
		name    string
		message Message
		want    string
	}{
		{name: "comment", message: Message{Actor: "Asha"}, want: "💬 Asha commented on your doc"},
		{name: "reply", message: Message{Actor: "Asha", Reply: true}, want: "💬 Asha replied to a comment on your doc"},
		{name: "mention", message: Message{Actor: "Asha", Reason: "mention"}, want: "🔔 Asha mentioned you in a comment"},
		{name: "missing actor", message: Message{}, want: "💬 Someone commented on your doc"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			payload := slackMessage("D1", tt.message)
			fallback, ok := payload["text"].(string)
			if !ok || !strings.HasPrefix(fallback, tt.want) {
				t.Fatalf("fallback = %q, want prefix %q", fallback, tt.want)
			}
		})
	}
}

func TestSlackAccessMessageContent(t *testing.T) {
	message := Message{
		Reason: "access_shared", DocumentTitle: "Roadmap <draft>", Link: "https://slashdocs.example.com/app/d/doc_1",
		Role: repo.RoleCommenter, DirectAccess: true,
	}
	payload := slackMessage("D1", message)
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	content := string(encoded)
	for _, want := range []string{"shared directly with you", "Direct access: Commenter", message.Link, "Open document"} {
		if !strings.Contains(content, want) {
			t.Errorf("access notification missing %q", want)
		}
	}
	if fallback, ok := payload["text"].(string); !ok || !strings.Contains(fallback, message.DocumentTitle) {
		t.Fatal("access notification must preserve the literal document title")
	}
	if payload["parse"] != "none" || payload["mrkdwn"] != false || payload["link_names"] != false {
		t.Fatal("access notification content must remain literal")
	}

	message.Reason = "access_removed"
	message.PreviousRole = repo.RoleCommenter
	message.Role = repo.RoleNone
	encoded, err = json.Marshal(slackMessage("D1", message))
	if err != nil {
		t.Fatal(err)
	}
	content = string(encoded)
	if !strings.Contains(content, "direct document access was removed") || !strings.Contains(content, "Previous direct access: Commenter") {
		t.Fatal("direct removal notification has the wrong content")
	}
	if strings.Contains(content, "Open document") {
		t.Fatal("removed access must not offer a document button")
	}
}

func TestSlackAccessRequestMessageContent(t *testing.T) {
	message := Message{
		Reason: "access_requested", DocumentTitle: "Private roadmap", Requester: "Reader (reader@example.com)",
		Link: "https://slashdocs.example.com/app/d/doc_1",
	}
	payload := slackMessage("D1", message)
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	content := string(encoded)
	for _, want := range []string{"requested access", message.DocumentTitle, message.Requester, "Review access", message.Link} {
		if !strings.Contains(content, want) {
			t.Errorf("access request notification missing %q", want)
		}
	}
}

func TestCommentActivityNamesActor(t *testing.T) {
	for _, tc := range []struct {
		message Message
		want    string
	}{
		{Message{Actor: "Ravi (ravi@example.com)"}, "💬 Ravi (ravi@example.com) commented on your doc"},
		{Message{Actor: "ravi@example.com", Reply: true}, "💬 ravi@example.com replied to a comment on your doc"},
		{Message{Actor: "Ravi", Reason: "mention", Reply: true}, "🔔 Ravi mentioned you in a comment"},
		{Message{Actor: "  "}, "💬 Someone commented on your doc"},
		{Message{Actor: "password: hunter2"}, "💬 password: [redacted] commented on your doc"},
	} {
		if got := commentActivity(tc.message); got != tc.want {
			t.Errorf("commentActivity(%+v) = %q, want %q", tc.message, got, tc.want)
		}
	}
}

func TestNotificationPreviewBoundsAndSensitiveFields(t *testing.T) {
	long := notificationPreview(strings.Repeat("界", 3000), 150)
	if utf8.RuneCountInString(long) != 150 || !utf8.ValidString(long) || !strings.HasSuffix(long, "…") {
		t.Fatal("preview must truncate within Slack limits without splitting Unicode")
	}
	got := notificationPreview("OTP is 123456; password: example-secret; card 4111 1111 1111 1111", 2200)
	for _, secret := range []string{"123456", "example-secret", "4111"} {
		if strings.Contains(got, secret) {
			t.Fatal("recognized sensitive fields must be masked")
		}
	}
	ordinary := "Discuss password reset and API key rotation. Launch on 2026-09-08."
	if notificationPreview(ordinary, 2200) != ordinary {
		t.Fatal("ordinary discussion must remain intact")
	}
}
