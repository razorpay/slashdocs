package notifications

import (
	"regexp"
	"strings"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

// Mask recognizable sensitive fields before truncating, including in fallback
// text used by screen readers and push notifications. This is not a DLP scanner.
var sensitiveField = regexp.MustCompile(`(?i)\b(otp|one[ -]time (?:password|code)|verification code|password|api[ _-]?key|access[ _-]?token|cvv|cvc)\b(\s*[:=]\s*)([^\s,;]+)`)
var oneTimeCode = regexp.MustCompile(`(?i)\b(otp|one[ -]time (?:password|code)|verification code)(\s+(?:is\s+)?)([0-9]{4,10})\b`)
var cardNumber = regexp.MustCompile(`\b(?:[0-9][ -]?){12,18}[0-9]\b`)

func notificationPreview(text string, limit int) string {
	text = sensitiveField.ReplaceAllString(text, "$1$2[redacted]")
	text = oneTimeCode.ReplaceAllString(text, "$1$2[redacted]")
	text = cardNumber.ReplaceAllStringFunc(text, func(value string) string {
		digits := strings.NewReplacer(" ", "", "-", "").Replace(value)
		sum := 0
		for i := len(digits) - 1; i >= 0; i-- {
			n := int(digits[i] - '0')
			if (len(digits)-1-i)%2 == 1 {
				n *= 2
				if n > 9 {
					n -= 9
				}
			}
			sum += n
		}
		if sum > 0 && sum%10 == 0 {
			return "[redacted card number]"
		}
		return value
	})
	chars := []rune(strings.TrimSpace(text))
	if len(chars) > limit {
		return string(chars[:limit-1]) + "…"
	}
	return string(chars)
}

func slackMessage(channel string, message Message) map[string]any {
	title := notificationPreview(message.DocumentTitle, 150)
	if title == "" {
		title = "Untitled document"
	}
	if strings.HasPrefix(message.Reason, "access_") {
		return slackAccessMessage(channel, title, message)
	}
	highlight := notificationPreview(message.Highlight, 600)
	body := notificationPreview(message.Body, 2200)
	activity := commentActivity(message)
	text := func(value string) map[string]any {
		return map[string]any{"type": "text", "text": value}
	}
	bold := func(value string) map[string]any {
		return map[string]any{"type": "text", "text": value, "style": map[string]bool{"bold": true}}
	}
	// Structured rich text gives the highlight a real quote rail while keeping
	// user content literal: angle brackets and @tags cannot become Slack mentions.
	elements := []any{
		map[string]any{"type": "rich_text_section", "elements": []any{
			text("Document: "), map[string]any{"type": "link", "url": message.Link, "text": title, "style": map[string]bool{"bold": true}}, text("\n\n"),
		}},
	}
	fallback := []string{activity, "Document: " + title}
	if highlight != "" {
		elements = append(elements, map[string]any{"type": "rich_text_quote", "elements": []any{map[string]any{"type": "text", "text": highlight, "style": map[string]bool{"italic": true}}}})
		fallback = append(fallback, "> "+strings.ReplaceAll(highlight, "\n", "\n> "))
	}
	elements = append(elements, map[string]any{"type": "rich_text_section", "elements": []any{text("\n" + body)}})
	blocks := []any{
		map[string]any{"type": "rich_text", "elements": []any{
			map[string]any{"type": "rich_text_section", "elements": []any{bold(activity)}},
		}},
		map[string]any{"type": "rich_text", "elements": elements},
		map[string]any{"type": "actions", "elements": []any{
			map[string]any{"type": "button", "text": map[string]any{"type": "plain_text", "text": "View comment", "emoji": false}, "url": message.Link, "style": "primary"},
		}},
	}
	fallback = append(fallback, body, message.Link)
	return map[string]any{
		"channel": channel, "text": strings.Join(fallback, "\n\n"),
		"blocks": blocks,
		"mrkdwn": false, "parse": "none", "link_names": false,
		"unfurl_links": false, "unfurl_media": false,
	}
}

// commentActivity is the provider-neutral headline for comment activity. The
// actor is user-controlled text, so it is masked and bounded like the body.
func commentActivity(message Message) string {
	actor := notificationPreview(message.Actor, 150)
	if actor == "" {
		actor = "Someone"
	}
	if message.Reason == "mention" {
		return "🔔 " + actor + " mentioned you in a comment"
	}
	if message.Reply {
		return "💬 " + actor + " replied to a comment on your doc"
	}
	return "💬 " + actor + " commented on your doc"
}

// accessSummary is the provider-neutral wording for access notifications. An
// empty buttonLabel means the recipient has nothing left to open.
func accessSummary(message Message) (activity, detail, buttonLabel string) {
	activity = "🔐 Your document access changed"
	accessLabel := "Access"
	if message.DirectAccess {
		accessLabel = "Direct access"
	}
	detail = accessLabel + ": " + roleLabel(message.PreviousRole) + " → " + roleLabel(message.Role)
	buttonLabel = "Open document"
	switch message.Reason {
	case "access_requested":
		activity = "🔑 Someone requested access to your document"
		detail = "Requested by: " + notificationPreview(message.Requester, 300)
		buttonLabel = "Review access"
	case "access_shared":
		activity = "📄 A document was shared with you"
		if message.DirectAccess {
			activity = "📄 A document was shared directly with you"
		}
		detail = accessLabel + ": " + roleLabel(message.Role)
	case "access_removed":
		activity = "🔒 Your document access was removed"
		if message.DirectAccess {
			activity = "🔒 Your direct document access was removed"
		}
		detail = "Previous " + strings.ToLower(accessLabel) + ": " + roleLabel(message.PreviousRole)
		buttonLabel = ""
	}
	return activity, detail, buttonLabel
}

func slackAccessMessage(channel, title string, message Message) map[string]any {
	activity, detail, buttonLabel := accessSummary(message)
	text := func(value string) map[string]any {
		return map[string]any{"type": "text", "text": value}
	}
	bold := func(value string) map[string]any {
		return map[string]any{"type": "text", "text": value, "style": map[string]bool{"bold": true}}
	}
	blocks := []any{
		map[string]any{"type": "rich_text", "elements": []any{
			map[string]any{"type": "rich_text_section", "elements": []any{bold(activity)}},
		}},
		map[string]any{"type": "rich_text", "elements": []any{
			map[string]any{"type": "rich_text_section", "elements": []any{
				text("Document: "), map[string]any{"type": "link", "url": message.Link, "text": title, "style": map[string]bool{"bold": true}},
				text("\n\n" + detail),
			}},
		}},
	}
	if buttonLabel != "" {
		blocks = append(blocks, map[string]any{"type": "actions", "elements": []any{
			map[string]any{"type": "button", "text": map[string]any{"type": "plain_text", "text": buttonLabel, "emoji": false}, "url": message.Link, "style": "primary"},
		}})
	}
	return map[string]any{
		"channel": channel, "text": strings.Join([]string{activity, "Document: " + title, detail, message.Link}, "\n\n"),
		"blocks": blocks,
		"mrkdwn": false, "parse": "none", "link_names": false,
		"unfurl_links": false, "unfurl_media": false,
	}
}

func roleLabel(role repo.Role) string {
	switch string(role) {
	case "viewer":
		return "Viewer"
	case "commenter":
		return "Commenter"
	case "editor":
		return "Editor"
	case "owner":
		return "Owner"
	default:
		return "None"
	}
}
