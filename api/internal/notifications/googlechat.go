package notifications

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// GoogleChat posts every notification to a single space's incoming webhook as
// a card naming its recipient. It needs no Cloud project, but the space sees
// all notifications, so it is not private.
type GoogleChat struct {
	webhookURL string
	client     *http.Client
}

// NewGoogleChatWebhook builds a webhook sender. Only Google Chat webhook URLs
// are accepted so a misconfiguration cannot post comment text elsewhere.
func NewGoogleChatWebhook(webhookURL string) (*GoogleChat, error) {
	u, err := url.Parse(webhookURL)
	if err != nil || u.Scheme != "https" || u.Host != "chat.googleapis.com" || !strings.HasPrefix(u.Path, "/v1/spaces/") || !strings.HasSuffix(u.Path, "/messages") {
		return nil, errors.New("Google Chat webhook URL must look like https://chat.googleapis.com/v1/spaces/<space>/messages?key=…&token=…")
	}
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return &GoogleChat{webhookURL: webhookURL, client: client}, nil
}

func (g *GoogleChat) Send(ctx context.Context, email string, message Message) error {
	body, err := json.Marshal(googleChatMessage(message, email))
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.webhookURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	res, err := g.client.Do(req)
	if err != nil {
		return &DeliveryError{Code: "transport"}
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode == http.StatusTooManyRequests {
		seconds, _ := strconv.Atoi(res.Header.Get("Retry-After"))
		return &DeliveryError{Code: "rate_limited", RetryAfter: time.Duration(max(1, seconds)) * time.Second}
	}
	if res.StatusCode != http.StatusOK {
		// Avoid logging arbitrary provider response text.
		return &DeliveryError{Code: fmt.Sprintf("http_%d", res.StatusCode), Permanent: res.StatusCode >= 400 && res.StatusCode < 500}
	}
	return nil
}

// googleChatMessage renders a card. User content only appears inside card
// widgets, HTML-escaped: Chat's top-level text would turn <users/all> into a
// real @-mention and <url|label> into a disguised link. recipient is named
// because the shared space needs to know who the message is for.
func googleChatMessage(message Message, recipient string) map[string]any {
	title := notificationPreview(message.DocumentTitle, 150)
	if title == "" {
		title = "Untitled document"
	}
	esc := func(value string) string {
		return strings.ReplaceAll(html.EscapeString(value), "\n", "<br>")
	}
	paragraph := func(value string) map[string]any {
		return map[string]any{"textParagraph": map[string]any{"text": value}}
	}
	var activity, buttonLabel string
	var widgets []any
	if recipient != "" {
		widgets = append(widgets, paragraph("<b>For:</b> "+esc(recipient)))
	}
	if strings.HasPrefix(message.Reason, "access_") {
		var detail string
		activity, detail, buttonLabel = accessSummary(message)
		widgets = append(widgets, paragraph(esc(detail)))
	} else {
		activity, buttonLabel = commentActivity(message), "View comment"
		if highlight := notificationPreview(message.Highlight, 600); highlight != "" {
			widgets = append(widgets, paragraph("<i>“"+esc(highlight)+"”</i>"))
		}
		widgets = append(widgets, paragraph(esc(notificationPreview(message.Body, 2200))))
	}
	if buttonLabel != "" {
		widgets = append(widgets, map[string]any{"buttonList": map[string]any{"buttons": []any{
			map[string]any{"text": buttonLabel, "onClick": map[string]any{"openLink": map[string]any{"url": message.Link}}},
		}}})
	}
	return map[string]any{
		"fallbackText": activity,
		"cardsV2": []any{map[string]any{
			"cardId": "slashdocs-notification",
			"card": map[string]any{
				"header":   map[string]any{"title": activity, "subtitle": title},
				"sections": []any{map[string]any{"widgets": widgets}},
			},
		}},
	}
}
