package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"
)

func approversCmd(g *globals, out io.Writer) *cobra.Command {
	c := &cobra.Command{Use: "approvers", Short: "Manage who can approve a document"}
	var address, principal string
	add := &cobra.Command{
		Use:   "add <doc_id>",
		Short: "Assign an approver",
		Long: "Assign a person or bot as an approver. Approvers must already have at\n" +
			"least viewer access on the document (share it first with 'slashdocs docs\n" +
			"grants add').\n\n" +
			"Examples:\n" +
			"  slashdocs docs approvers add doc_… --to reviewer@org.example\n" +
			"  slashdocs docs approvers add doc_… --to qa-bot@brave.otter.bot",
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{}
			var target string
			switch {
			case address != "":
				body["address"] = address
				target = address
			case principal != "":
				body["principal"] = parsePrincipal(principal)
				target = principal
			default:
				return errors.New("pass --to <email-or-bot-address>")
			}
			return action(g, out, func(c *Client) ([]byte, error) {
				return c.doJSON("POST", apiPath("/v1/documents/%s/approvers", args[0]), body)
			}, func(m map[string]any) string {
				return fmt.Sprintf("Assigned %s as an approver on %s.", target, args[0])
			})
		},
	}
	add.Flags().StringVar(&address, "to", "", "email or bot address (e.g. reviewer@org.example)")
	add.Flags().StringVar(&principal, "principal", "", "legacy: sa:<id> or user:<email>")
	list := simplePath(g, out, "list", "GET", "/v1/documents/%s/approvers")
	list.Use = "list <doc_id>"
	list.Short = "List assigned approvers"
	remove := mutate(g, out, "remove <doc_id> <approver_id>", "Remove an approver (their decisions stop counting)", "DELETE", "/v1/documents/%s/approvers/%s", 2, func(a []string) string {
		return "Removed approver " + a[1] + " from " + a[0] + "."
	})
	c.AddCommand(list, add, remove)
	return c
}

func approvalsCmd(g *globals, out io.Writer) *cobra.Command {
	c := &cobra.Command{Use: "approvals", Short: "Inspect document approval decisions"}
	var ver string
	list := &cobra.Command{
		Use:   "list <doc_id>",
		Short: "Show decisions and the aggregate approval status",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := apiPath("/v1/documents/%s/approvals", args[0])
			if ver != "" {
				path += "?version=" + ver
			}
			return run(g, out, func(c *Client) ([]byte, error) {
				return c.do("GET", path, nil, "")
			})
		},
	}
	list.Flags().StringVar(&ver, "version", "", "version ID (defaults to the current version)")
	c.AddCommand(list)
	return c
}

// resolveApprovalVersion picks the version a decision applies to: an explicit
// --version wins, then the version remembered from 'docs pull', then the
// document's current version.
func resolveApprovalVersion(g *globals, cl *Client, docID, explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	_, cx, _ := currentContext(g)
	if v := cx.Pulled[docID]; v != "" {
		return v, nil
	}
	b, err := cl.do("GET", apiPath("/v1/documents/%s", docID), nil, "")
	if err != nil {
		return "", err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return "", fmt.Errorf("could not parse document response: %w", err)
	}
	v, _ := m["current_version_id"].(string)
	if v == "" {
		return "", errors.New("document response did not include current_version_id")
	}
	return v, nil
}

// decisionCmd builds the approve / request-changes verbs, which submit a
// decision on the current (or given) version.
func decisionCmd(g *globals, out io.Writer, use, short, decision, did string) *cobra.Command {
	var ver string
	var note string
	cmd := &cobra.Command{
		Use:   use + " <doc_id>",
		Short: short,
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			// Requesting changes without saying what to change leaves the
			// author guessing, so the note is mandatory for that verb.
			if decision == "changes_requested" && strings.TrimSpace(note) == "" {
				return errors.New("--note is required: say what needs to change")
			}
			cl, err := client(g)
			if err != nil {
				return err
			}
			v, err := resolveApprovalVersion(g, cl, args[0], ver)
			if err != nil {
				return err
			}
			body := map[string]any{"version_id": v, "decision": decision}
			if n := strings.TrimSpace(note); n != "" {
				body["note"] = n
			}
			b, err := cl.doJSON("POST", apiPath("/v1/documents/%s/approvals", args[0]), body)
			if err != nil {
				return err
			}
			if g.json {
				return render(out, g, b)
			}
			return confirm(out, g, fmt.Sprintf("%s %s of %s.", did, v, args[0]))
		},
	}
	cmd.Flags().StringVar(&ver, "version", "", "version ID (defaults to the current version)")
	noteHelp := "note explaining the decision"
	if decision == "changes_requested" {
		noteHelp = "note explaining what needs to change (required)"
	}
	cmd.Flags().StringVar(&note, "note", "", noteHelp)
	return cmd
}

func revokeApprovalCmd(g *globals, out io.Writer) *cobra.Command {
	var ver string
	cmd := &cobra.Command{
		Use:   "revoke-approval <doc_id>",
		Short: "Revoke your decision on a version (back to pending)",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cl, err := client(g)
			if err != nil {
				return err
			}
			v, err := resolveApprovalVersion(g, cl, args[0], ver)
			if err != nil {
				return err
			}
			approvalID, err := ownDecisionID(cl, args[0], v)
			if err != nil {
				return err
			}
			if _, err := cl.do("DELETE", apiPath("/v1/documents/%s/approvals/%s", args[0], approvalID), nil, ""); err != nil {
				return err
			}
			return confirm(out, g, fmt.Sprintf("Revoked your decision on %s of %s.", v, args[0]))
		},
	}
	cmd.Flags().StringVar(&ver, "version", "", "version ID (defaults to the current version)")
	return cmd
}

// ownDecisionID finds the caller's decision on a version by matching the
// approvals list against /v1/me.
func ownDecisionID(cl *Client, docID, versionID string) (string, error) {
	meBody, err := cl.do("GET", "/v1/me", nil, "")
	if err != nil {
		return "", err
	}
	var me struct {
		Principal struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		} `json:"principal"`
	}
	if err := json.Unmarshal(meBody, &me); err != nil {
		return "", fmt.Errorf("could not parse /v1/me response: %w", err)
	}
	b, err := cl.do("GET", apiPath("/v1/documents/%s/approvals", docID)+"?version="+versionID, nil, "")
	if err != nil {
		return "", err
	}
	var list struct {
		Items []struct {
			ID       string  `json:"id"`
			Decision *string `json:"decision"`
			Approver struct {
				Type string `json:"type"`
				ID   string `json:"id"`
			} `json:"approver"`
		} `json:"items"`
	}
	if err := json.Unmarshal(b, &list); err != nil {
		return "", fmt.Errorf("could not parse approvals response: %w", err)
	}
	for _, item := range list.Items {
		if item.Approver.Type == me.Principal.Type && item.Approver.ID == me.Principal.ID && item.Decision != nil {
			return item.ID, nil
		}
	}
	return "", errors.New("you have no decision on version " + versionID)
}
