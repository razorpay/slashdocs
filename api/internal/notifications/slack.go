// Package notifications delivers comment activity to authorized recipients.
package notifications

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type DeliveryError struct {
	Code       string
	Permanent  bool
	RetryAfter time.Duration
}

func (e *DeliveryError) Error() string { return "Slack delivery: " + e.Code }

type Slack struct {
	token  string
	client *http.Client
}

func NewSlack(token string) *Slack {
	return &Slack{token: token, client: &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (s *Slack) call(ctx context.Context, method string, payload any, result any) error {
	var body io.Reader
	contentType := "application/json; charset=utf-8"
	if form, ok := payload.(url.Values); ok {
		body = strings.NewReader(form.Encode())
		contentType = "application/x-www-form-urlencoded"
	} else {
		b, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://slack.com/api/"+method, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Content-Type", contentType)
	res, err := s.client.Do(req)
	if err != nil {
		return &DeliveryError{Code: "transport"}
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode == http.StatusTooManyRequests {
		seconds, _ := strconv.Atoi(res.Header.Get("Retry-After"))
		return &DeliveryError{Code: "rate_limited", RetryAfter: time.Duration(max(1, seconds)) * time.Second}
	}
	if res.StatusCode != http.StatusOK {
		return &DeliveryError{Code: fmt.Sprintf("http_%d", res.StatusCode), Permanent: res.StatusCode >= 400 && res.StatusCode < 500}
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return &DeliveryError{Code: "response_read"}
	}
	var status struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &status) != nil {
		return &DeliveryError{Code: "invalid_response"}
	}
	if !status.OK {
		switch status.Error {
		case "users_not_found", "user_not_found", "account_inactive", "cannot_dm_bot", "channel_not_found", "invalid_auth", "token_revoked", "missing_scope", "not_allowed_token_type",
			"cannot_unfurl_url", "cannot_find_message", "cannot_unfurl_message", "invalid_unfurls_format", "invalid_blocks":
			return &DeliveryError{Code: status.Error, Permanent: true}
		default:
			// Avoid logging arbitrary provider response text.
			return &DeliveryError{Code: "api_error"}
		}
	}
	return json.Unmarshal(raw, result)
}

func (s *Slack) Send(ctx context.Context, email string, message Message) error {
	var user struct {
		User struct {
			ID      string `json:"id"`
			Deleted bool   `json:"deleted"`
			Bot     bool   `json:"is_bot"`
		} `json:"user"`
	}
	if err := s.call(ctx, "users.lookupByEmail", url.Values{"email": {email}}, &user); err != nil {
		return err
	}
	if user.User.ID == "" || user.User.Deleted || user.User.Bot {
		return &DeliveryError{Code: "ineligible_user", Permanent: true}
	}
	var channel struct {
		Channel struct {
			ID string `json:"id"`
		} `json:"channel"`
	}
	if err := s.call(ctx, "conversations.open", map[string]string{"users": user.User.ID}, &channel); err != nil {
		return err
	}
	if channel.Channel.ID == "" {
		return errors.New("Slack returned no direct message channel")
	}
	var response map[string]any
	return s.call(ctx, "chat.postMessage", slackMessage(channel.Channel.ID, message), &response)
}

// Unfurl addresses posted messages by channel and ts, and composer previews by unfurl id.
func (s *Slack) Unfurl(ctx context.Context, target UnfurlTarget, unfurls map[string]any) error {
	payload := map[string]any{"unfurls": unfurls}
	if target.IsComposer() {
		payload["unfurl_id"], payload["source"] = target.UnfurlID, "composer"
	} else {
		payload["channel"], payload["ts"] = target.Channel, target.TS
	}
	var response map[string]any
	return s.call(ctx, "chat.unfurl", payload, &response)
}

// IsExternalChannel reports Slack Connect conversations. On error it reports true.
func (s *Slack) IsExternalChannel(ctx context.Context, channel string) (bool, error) {
	var response struct {
		Channel struct {
			IsExtShared        bool `json:"is_ext_shared"`
			IsPendingExtShared bool `json:"is_pending_ext_shared"`
		} `json:"channel"`
	}
	if err := s.call(ctx, "conversations.info", url.Values{"channel": {channel}}, &response); err != nil {
		return true, err
	}
	return response.Channel.IsExtShared || response.Channel.IsPendingExtShared, nil
}

func CommentURL(origin, documentID, commentID string) string {
	return strings.TrimRight(origin, "/") + "/app/d/" + url.PathEscape(documentID) + "?" + url.Values{"comment": {commentID}}.Encode()
}

func DocumentURL(origin, documentID string) string {
	return strings.TrimRight(origin, "/") + "/app/d/" + url.PathEscape(documentID)
}
