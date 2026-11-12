package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/spf13/cobra"
)

type mentionUser struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Email string `json:"email"`
}
type commentMention struct {
	Principal mentionUser `json:"principal"`
	Offset    int         `json:"offset"`
	Length    int         `json:"length"`
}

// Explicit --mention flags create real tags. Plain @text never guesses a user.
// Missing tags are appended, so callers do not need to calculate text offsets.
func (c *Client) commentJSON(method, path string, payload map[string]any, emails []string, clearMentions bool) ([]byte, error) {
	if len(emails) == 0 && !clearMentions {
		return c.doJSON(method, path, payload)
	}
	body, _ := payload["body"].(string)
	if len(emails) > 0 && body == "" {
		return nil, usageError{errors.New("--mention requires --body or --body-file")}
	}
	if len(emails) > 50 {
		return nil, usageError{errors.New("a comment can mention up to 50 people or agents")}
	}
	mentions := []commentMention{}
	seen := map[string]bool{}
	for _, email := range emails {
		email = strings.TrimSpace(email)
		if seen[strings.ToLower(email)] {
			continue
		}
		seen[strings.ToLower(email)] = true
		user, err := c.resolveMention(email)
		if err != nil {
			return nil, err
		}
		label := "@" + user.Email
		if user.Email == "" {
			label = "@" + user.ID
		}
		start := mentionOffset(body, label)
		if start < 0 {
			if body != "" {
				body += " "
			}
			start = len(body)
			body += label
		}
		mentions = append(mentions, commentMention{Principal: user, Offset: len(utf16.Encode([]rune(body[:start]))), Length: len(utf16.Encode([]rune(label)))})
	}
	if body != "" {
		payload["body"] = body
	}
	payload["mentions"] = mentions
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return c.do(method, path, bytes.NewReader(raw), "application/vnd.slashdocs.comment-mentions+json")
}

func commentBody(cmd *cobra.Command, body, filename string) (string, error) {
	if filename == "" {
		return body, nil
	}
	if cmd.Flags().Changed("body") {
		return "", usageError{errors.New("choose --body or --body-file")}
	}
	reader := cmd.InOrStdin()
	if filename != "-" {
		file, err := os.Open(filename) //nolint:gosec // G304: the user explicitly selects the local input file.
		if err != nil {
			return "", err
		}
		defer func() { _ = file.Close() }()
		reader = file
	}
	raw, err := io.ReadAll(io.LimitReader(reader, 1<<20))
	if err != nil {
		return "", err
	}
	if len(raw) == 1<<20 {
		return "", usageError{errors.New("comment body is too large")}
	}
	return string(raw), nil
}

func (c *Client) resolveMention(email string) (mentionUser, error) {
	var user mentionUser
	if strings.HasPrefix(email, "user:") || strings.HasPrefix(email, "sa:") {
		prefix, id, _ := strings.Cut(email, ":")
		if id == "" {
			return mentionUser{}, usageError{errors.New("mention principal ID must not be empty")}
		}
		user = mentionUser{Type: "user", ID: id}
		if prefix == "sa" {
			user.Type = "service_account"
		}
	} else {
		if email == "" || !strings.Contains(email, "@") {
			return mentionUser{}, usageError{fmt.Errorf("--mention expects an email, user:<id>, or sa:<id>: %q", email)}
		}
		raw, err := c.do("GET", "/v1/users?"+url.Values{"q": {email}}.Encode(), nil, "")
		if err != nil {
			return mentionUser{}, err
		}
		var result struct {
			Items []mentionUser `json:"items"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			return mentionUser{}, err
		}
		for _, u := range result.Items {
			if strings.EqualFold(u.Email, email) {
				user = u
				break
			}
		}
		if user.ID == "" {
			return mentionUser{}, fmt.Errorf("no platform user found for %s", email)
		}
	}
	return user, nil
}

func mentionOffset(body, label string) int {
	start := -1
	for offset := 0; offset < len(body); {
		index := strings.Index(body[offset:], label)
		if index < 0 {
			break
		}
		index += offset
		before, _ := utf8.DecodeLastRuneInString(body[:index])
		after, _ := utf8.DecodeRuneInString(body[index+len(label):])
		if (index == 0 || unicode.IsSpace(before) || strings.ContainsRune("([{", before)) && (index+len(label) == len(body) || unicode.IsSpace(after) || strings.ContainsRune(",.!?:;)]}", after)) {
			start = index
			break
		}
		offset = index + len(label)
	}
	return start
}
