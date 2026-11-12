package notifications

import (
	"context"
	"fmt"
	"strings"
)

// Slack unfurls do not accept rich_text blocks, so text goes in mrkdwn with
// &, < and > escaped: "<!channel>" in a title cannot become a mention.

// Unfurler sends link-preview cards and tells whether a conversation includes
// another organization.
type Unfurler interface {
	Unfurl(ctx context.Context, target UnfurlTarget, unfurls map[string]any) error
	IsExternalChannel(ctx context.Context, channel string) (bool, error)
}

// UnfurlTarget is the message a card belongs to.
type UnfurlTarget struct {
	Channel, TS, UnfurlID, Source string
}

func (t UnfurlTarget) IsComposer() bool {
	return t.Source == "composer" || t.Channel == "" || t.Channel == "COMPOSER"
}

type DocCard struct {
	Title       string
	URL         string
	Owner       string
	Version     int
	OpenThreads int
	// Text is the start of the text that a reader sees in the version.
	Text string
}

func LiveUnfurl(card DocCard) map[string]any {
	title := notificationPreview(card.Title, 150)
	if title == "" {
		title = "Untitled document"
	}
	blocks := []any{
		mrkdwnSection("*<" + card.URL + "|" + slackEscape(title) + ">*"),
	}
	if summary := DocumentSummary(card.Title, card.Text); summary != "" {
		blocks = append(blocks, mrkdwnSection(slackEscape(summary)))
	}
	var facts []string
	if card.Version > 0 {
		facts = append(facts, fmt.Sprintf("v%d", card.Version))
	}
	threads := "open threads"
	if card.OpenThreads == 1 {
		threads = "open thread"
	}
	facts = append(facts, fmt.Sprintf("%d %s", card.OpenThreads, threads))
	if owner := notificationPreview(card.Owner, 80); owner != "" {
		facts = append(facts, slackEscape(owner))
	}
	blocks = append(blocks,
		map[string]any{"type": "context", "elements": []any{
			map[string]any{"type": "mrkdwn", "text": strings.Join(facts, " · ")},
		}},
		map[string]any{"type": "actions", "elements": []any{
			map[string]any{
				"type": "button",
				"text": map[string]any{"type": "plain_text", "text": "Open doc"},
				"url":  card.URL,
			},
		}},
	)
	return map[string]any{"blocks": blocks}
}

// NeutralUnfurl names nothing, so private, missing and deleted docs look the same.
func NeutralUnfurl() map[string]any {
	return map[string]any{"blocks": []any{
		mrkdwnSection("slashdocs document · Sign in to see if you have access"),
	}}
}

func mrkdwnSection(text string) map[string]any {
	return map[string]any{"type": "section", "text": map[string]any{"type": "mrkdwn", "text": text}}
}

func slackEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}
