package cli

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/spf13/cobra"
)

// configCmd reports the connected server's deployment type and the label it
// uses for the "everyone" grant, so an agent knows the scope/wording of the
// context it is talking to.
func configCmd(g *globals, out io.Writer) *cobra.Command {
	return &cobra.Command{
		Use:   "config",
		Short: "Show the connected server's deployment configuration",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, args []string) error {
			return run(g, out, func(c *Client) ([]byte, error) {
				return c.do("GET", "/v1/config", nil, "")
			})
		},
	}
}

// everyoneLabelFor fetches /v1/config to resolve the human label for the
// "everyone" grant on the connected server. It falls back to a generic phrase
// if the server is unreachable or pre-dates the endpoint, so sharing still
// reports something sensible.
func everyoneLabelFor(g *globals) string {
	cfg := serverConfigFor(g)
	if cfg.EveryoneLabel == "" {
		return "everyone on this server"
	}
	return cfg.EveryoneLabel
}

type serverConfig struct {
	Deployment    string `json:"deployment"`
	OrgName       string `json:"org_name"`
	EveryoneLabel string `json:"everyone_label"`
}

func serverConfigFor(g *globals) serverConfig {
	cl, err := client(g)
	if err != nil {
		return serverConfig{}
	}
	b, err := cl.do("GET", "/v1/config", nil, "")
	if err != nil {
		return serverConfig{}
	}
	var cfg serverConfig
	_ = json.Unmarshal(b, &cfg)
	return cfg
}

// roleAccess phrases the level of access a default grant hands out, for the
// post-create confirm line ("Gave org-wide %s access by default.").
func roleAccess(role string) string {
	switch role {
	case "commenter":
		return "comment"
	case "editor":
		return "edit"
	default:
		return "read-only"
	}
}

// roleVerb phrases what a default grant lets its audience do with the
// document, for the post-create share notice.
func roleVerb(role string) string {
	switch role {
	case "commenter":
		return "read and comment on it"
	case "editor":
		return "read, comment and edit it"
	default:
		return "read it"
	}
}

// defaultShareNotice is printed after the server applies its default grant so
// neither an agent nor a human can miss how widely the new document is
// shared. Public deployments admit anyone with the link, so the org wording
// would understate the exposure there. An empty deployment means a server
// that predates /v1/config's deployment field; those were org installs.
func defaultShareNotice(cfg serverConfig, docID, role, grantID string) string {
	verb := roleVerb(role)
	revoke := fmt.Sprintf("To make it private, revoke the default grant: slashdocs docs grants revoke %s %s.", docID, grantID)
	if cfg.Deployment == "public" {
		return fmt.Sprintf("Anyone with the link can %s by default. Make sure your user knows it is publicly accessible. %s", verb, revoke)
	}
	org := cfg.OrgName
	if org == "" {
		org = "your org"
	}
	return fmt.Sprintf("This document is shared org-wide by default: anyone at %s can %s. Make sure your user knows this document is shared org-wide. %s", org, verb, revoke)
}

func orgWideViewerNudge(g *globals, docID string) string {
	if documentHasGrants(g, docID) {
		return ""
	}
	cfg := serverConfigFor(g)
	if cfg.Deployment == "public" {
		return fmt.Sprintf("Give read-only access to anyone with the link? You can do it with: slashdocs docs grants add %s --everyone --role viewer", docID)
	}
	org := cfg.OrgName
	if org == "" {
		org = "your org"
	}
	return fmt.Sprintf("Give org-wide read-only access? We are transparent here at %s. You can do it with: slashdocs docs grants add %s --everyone --role viewer", org, docID)
}

func printOrgWideViewerNudge(out io.Writer, g *globals, docID string) error {
	if g.quiet || g.json {
		return nil
	}
	if nudge := orgWideViewerNudge(g, docID); nudge != "" {
		_, err := fmt.Fprintln(out, nudge)
		return err
	}
	return nil
}

// documentHasGrants reports whether the document has any explicit grant. It
// reads the effective-access listing (the server exposes no GET /grants
// route) and counts only sources carrying a grant_id: ownership rows have
// none, so a freshly created private document correctly reads as grant-free.
// Errors fail closed (true) so the nudge never nags when state is unknown.
func documentHasGrants(g *globals, docID string) bool {
	cl, err := client(g)
	if err != nil {
		return true
	}
	b, err := cl.do("GET", apiPath("/v1/documents/%s/access", docID), nil, "")
	if err != nil {
		return true
	}
	var resp struct {
		Items []struct {
			Sources []struct {
				GrantID string `json:"grant_id"`
			} `json:"sources"`
		} `json:"items"`
	}
	if json.Unmarshal(b, &resp) != nil {
		return true
	}
	for _, item := range resp.Items {
		for _, source := range item.Sources {
			if source.GrantID != "" {
				return true
			}
		}
	}
	return false
}
