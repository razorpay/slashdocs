package cli

import (
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"strings"
	"unicode/utf16"

	"github.com/spf13/cobra"
)

func documentHeadingsCmd(g *globals, out io.Writer) *cobra.Command {
	var version string
	cmd := &cobra.Command{Use: "headings <doc_id>", Short: "List headings, their IDs, and shareable URLs", Args: exactArgs(1), RunE: func(_ *cobra.Command, args []string) error {
		path := apiPath("/v1/documents/%s/headings", args[0])
		if version != "" {
			path += "?" + url.Values{"version": {version}}.Encode()
		}
		return run(g, out, func(c *Client) ([]byte, error) { return c.do("GET", path, nil, "") })
	}}
	cmd.Flags().StringVar(&version, "version", "", "list and link to a specific version")
	return cmd
}

func documentLinkCmd(g *globals, out io.Writer) *cobra.Command { //nolint:gocyclo // flag validation for the link kinds is intentionally exhaustive and flat.
	var heading, comment, version, text, prefix, suffix string
	cmd := &cobra.Command{Use: "link <doc_id>", Short: "Get a URL to a document, heading, text, or comment", Args: exactArgs(1), RunE: func(_ *cobra.Command, args []string) error {
		if text != "" && (heading != "" || comment != "") {
			return usageError{errors.New("--text cannot be combined with --heading or --comment")}
		}
		if (prefix != "" || suffix != "") && text == "" {
			return usageError{errors.New("--prefix and --suffix require --text")}
		}
		if text != "" && (strings.TrimSpace(text) == "" || len(utf16.Encode([]rune(text))) > 4096) {
			return usageError{errors.New("--text must contain 1 to 4096 characters")}
		}
		if len(utf16.Encode([]rune(prefix))) > 64 || len(utf16.Encode([]rune(suffix))) > 64 {
			return usageError{errors.New("--prefix and --suffix must be at most 64 characters")}
		}
		if comment != "" && (heading != "" || version != "") {
			return usageError{errors.New("--comment cannot be combined with --heading or --version")}
		}
		q := url.Values{}
		if heading != "" {
			q.Set("heading", heading)
		}
		if comment != "" {
			q.Set("comment", comment)
		}
		if version != "" {
			q.Set("version", version)
		}
		return run(g, out, func(c *Client) ([]byte, error) {
			body, err := c.do("GET", apiPath("/v1/documents/%s/link", args[0])+"?"+q.Encode(), nil, "")
			if err != nil || text == "" {
				return body, err
			}
			var result struct {
				URL string `json:"url"`
			}
			if err := json.Unmarshal(body, &result); err != nil {
				return nil, err
			}
			u, err := url.Parse(result.URL)
			if err != nil {
				return nil, err
			}
			fragment := "text=" + url.QueryEscape(text)
			if prefix != "" {
				fragment += "&prefix=" + url.QueryEscape(prefix)
			}
			if suffix != "" {
				fragment += "&suffix=" + url.QueryEscape(suffix)
			}
			u.Fragment = ""
			u.RawFragment = ""
			result.URL = u.String() + "#" + fragment
			return json.Marshal(result)
		})
	}}
	cmd.Flags().StringVar(&text, "text", "", "selected passage to scroll to and highlight (up to 4096 characters)")
	cmd.Flags().StringVar(&prefix, "prefix", "", "text immediately before the passage, to distinguish repeated text")
	cmd.Flags().StringVar(&suffix, "suffix", "", "text immediately after the passage, to distinguish repeated text")
	cmd.Flags().StringVar(&heading, "heading", "", "HTML heading ID (discover with docs headings)")
	cmd.Flags().StringVar(&comment, "comment", "", "comment or reply ID")
	cmd.Flags().StringVar(&version, "version", "", "pin document, heading, or text link to a version")
	cmd.Example = "  slashdocs docs headings doc_123 --json\n  slashdocs docs link doc_123 --heading rollout\n  slashdocs docs link doc_123 --comment cmt_456\n  slashdocs docs link doc_123 --text \"The selected passage\" --version ver_123"
	return cmd
}
