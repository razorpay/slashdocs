package cli

import (
	"io"

	"github.com/spf13/cobra"
)

// The same verbs work globally and for one document. These are always the
// authenticated principal's preferences, including when called by an agent.
func notificationsCmd(g *globals, out io.Writer, document bool) *cobra.Command {
	root := &cobra.Command{Use: "notifications", Short: "Control your chat notifications (Slack or Google Chat)"}
	suffix := ""
	count := 0
	if document {
		suffix = " <doc_id>"
		count = 1
		root.Long = "Control notifications for this document, only for you. Global disable overrides document enable. Muting includes @mentions."
	}
	for _, verb := range []string{"status", "enable", "disable"} {
		cmd := &cobra.Command{Use: verb + suffix, Short: verb + " notifications", Args: exactArgs(count), RunE: func(_ *cobra.Command, args []string) error {
			path := "/v1/me/notifications"
			if document {
				path = apiPath("/v1/documents/%s/notifications", args[0])
			}
			return run(g, out, func(c *Client) ([]byte, error) {
				if verb == "status" {
					return c.do("GET", path, nil, "")
				}
				return c.doJSON("PUT", path, map[string]bool{"enabled": verb == "enable"})
			})
		}}
		root.AddCommand(cmd)
	}
	return root
}
