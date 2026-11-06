package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

// defaultDocPermissionEnv is the CLI-side per-user override for the sharing
// default applied when a document is created. The server does the granting;
// the CLI only forwards the preference.
const defaultDocPermissionEnv = "SLASHDOCS_DEFAULT_DOC_PERMISSION"

func docsCmd(g *globals, out io.Writer) *cobra.Command {
	c := &cobra.Command{Use: "docs", Short: "Manage documents"}
	del := mutate(g, out, "delete <doc_id>", "Delete a document", "DELETE", "/v1/documents/%s", 1, func(a []string) string { return "Deleted document " + a[0] + "." })
	c.AddCommand(
		documentListCmd(g, out),
		documentRequestAccessCmd(g, out),
		notificationsCmd(g, out, true),
		documentHeadingsCmd(g, out),
		documentLinkCmd(g, out),
		documentCreateCmd(g, out),
		simplePath(g, out, "show", "GET", "/v1/documents/%s"),
		documentUpdateCmd(g, out),
		del,
		documentMoveCmd(g, out),
		pullCmd(g, out),
		docsPushCmd(g, out),
		versionsCmd(g, out),
		commentsCmd(g, out),
		documentLabelsCmd(g, out),
		grantsCmd(g, out),
	)
	return c
}

func documentRequestAccessCmd(g *globals, out io.Writer) *cobra.Command {
	return &cobra.Command{
		Use:   "request-access <doc_id>",
		Short: "Ask the document owner for access",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return action(g, out, func(c *Client) ([]byte, error) {
				return c.doJSON("POST", apiPath("/v1/documents/%s/access-requests", args[0]), map[string]any{})
			}, func(map[string]any) string { return "Access request sent for " + args[0] + "." })
		},
	}
}

func documentListCmd(g *globals, out io.Writer) *cobra.Command {
	var query string
	cmd := &cobra.Command{
		Use:   "list [query]",
		Short: "List or search documents",
		Long: "List documents, or search with the same Slack-style language as the web application.\n\n" +
			"Every word must appear in the title or the text. The most relevant documents come first.\n" +
			"Modifiers narrow the results:\n" +
			"  \"exact phrase\"       Match the words together\n" +
			"  -word                Exclude documents that contain the word\n" +
			"  from:<person>        The owner: an email, the name before the @, or me\n" +
			"  in:<folder>          A folder, or any folder above the document\n" +
			"  label:<a,b>          Require every label\n" +
			"  before:<date>        Updated before the date\n" +
			"  after:<date>         Updated after the date\n" +
			"  on:<date>            Updated on the date (during: is the same)\n\n" +
			"A date is a day (25-09-26, 5 september, monday, today, 3 days ago), a week,\n" +
			"a month, or a year (last week, september, this year, 2026), or last 7 days.\n" +
			"Dates use UTC. Repeat from: or in: to match any value.\n" +
			"Quote the whole query when it contains spaces.\n\n" +
			"With --local, the query finds each word in the title or the path of a document, and modifiers are not available.",
		Example: "  slashdocs docs list 'incident from:alice@example.com label:api,review in:\"Product Specs\"'\n" +
			"  slashdocs docs list --query 'rollout -draft from:me after:last week'",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 1 && cmd.Flags().Changed("query") {
				return usageError{errors.New("pass the query either as an argument or with --query, not both")}
			}
			if len(args) == 1 {
				query = args[0]
			}
			path := "/v1/documents"
			if strings.TrimSpace(query) != "" {
				params := url.Values{"q": []string{query}}
				path += "?" + params.Encode()
			}
			return run(g, out, func(c *Client) ([]byte, error) {
				return c.do("GET", path, nil, "")
			})
		},
	}
	cmd.Flags().StringVar(&query, "query", "", "search query")
	return cmd
}

func documentLabelsCmd(g *globals, out io.Writer) *cobra.Command {
	root := &cobra.Command{Use: "labels", Short: "Manage document labels"}
	root.AddCommand(
		simplePath(g, out, "list", "GET", "/v1/documents/%s/labels"),
		documentLabelsSetCmd(g, out),
		documentLabelsClearCmd(g, out),
	)
	return root
}

func documentLabelsSetCmd(g *globals, out io.Writer) *cobra.Command {
	return &cobra.Command{
		Use:     "set <doc_id> <label>...",
		Short:   "Replace a document's labels",
		Example: "  slashdocs docs labels set doc_… api review-ready\n  slashdocs docs labels set doc_… api,review-ready",
		Args:    cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			labels, err := normalizedLabelArgs(args[1:])
			if err != nil {
				return usageError{err}
			}
			return action(g, out, func(c *Client) ([]byte, error) {
				return c.doJSON("PUT", apiPath("/v1/documents/%s/labels", args[0]), map[string]any{"labels": labels})
			}, func(map[string]any) string {
				return fmt.Sprintf("Set labels on %s: %s.", args[0], strings.Join(labels, ", "))
			})
		},
	}
}

func documentLabelsClearCmd(g *globals, out io.Writer) *cobra.Command {
	return &cobra.Command{
		Use:   "clear <doc_id>",
		Short: "Remove every label from a document",
		Args:  exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return action(g, out, func(c *Client) ([]byte, error) {
				return c.doJSON("PUT", apiPath("/v1/documents/%s/labels", args[0]), map[string]any{"labels": []string{}})
			}, func(map[string]any) string { return "Cleared labels from " + args[0] + "." })
		},
	}
}

func normalizedLabelArgs(args []string) ([]string, error) {
	labels := make([]string, 0, len(args))
	seen := map[string]bool{}
	for _, raw := range args {
		for _, value := range strings.Split(raw, ",") {
			label := strings.ToLower(strings.TrimSpace(value))
			if label == "" {
				return nil, errors.New("labels cannot be empty")
			}
			if !seen[label] {
				seen[label] = true
				labels = append(labels, label)
			}
		}
	}
	return labels, nil
}

func documentCreateCmd(g *globals, out io.Writer) *cobra.Command {
	var title string
	cmd := &cobra.Command{Use: "create <file>", Short: "Create a document from an HTML file", Long: "Create a document from a single self-contained HTML file.\n\nThe sharing default for new documents is controlled by the server. Set SLASHDOCS_DEFAULT_DOC_PERMISSION to viewer, commenter, editor, or private to override it per-user; private keeps new documents private.\n\nRun 'slashdocs guidelines' for authoring rules (single-file, base64 images, reader theme).", Example: "  slashdocs docs create report.html --title 'Report'", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		perm, err := defaultDocPermission()
		if err != nil {
			return err
		}
		data, fn, err := readFileArg(args[0])
		if err != nil {
			return err
		}
		if title == "" {
			title = fn
		}
		cl, err := client(g)
		if err != nil {
			return err
		}
		fields := map[string]string{"title": title}
		if perm != "" {
			fields["default_permission"] = perm
		}
		b, err := cl.multipart("/v1/documents", fields, "file", fn, data)
		if err != nil {
			return err
		}
		var created struct {
			ID        string `json:"id"`
			VersionID string `json:"current_version_id"`
		}
		if err := json.Unmarshal(b, &created); err != nil {
			return err
		}
		if err := recordBaseVersion(g, created.ID, created.VersionID); err != nil {
			return err
		}
		return renderCreatedDocument(out, g, cl, title, perm, b)
	}}
	cmd.Flags().StringVar(&title, "title", "", "document title (defaults to the file name)")
	return cmd
}

// defaultDocPermission reads the per-user sharing override sent with document
// creation. Empty means the server-wide default applies.
func defaultDocPermission() (string, error) {
	perm := env(defaultDocPermissionEnv)
	switch perm {
	case "", "viewer", "commenter", "editor", "private":
		return perm, nil
	default:
		return "", fmt.Errorf("invalid %s value %q: must be viewer, commenter, editor, or private", defaultDocPermissionEnv, perm)
	}
}

// defaultGrantInfo extracts the server-applied default grant from a create
// response. An empty grant id means the document stayed private.
func defaultGrantInfo(payload map[string]any) (role, grantID string) {
	dg, ok := payload["default_grant"].(map[string]any)
	if !ok {
		return "", ""
	}
	role, _ = dg["role"].(string)
	grantID, _ = dg["grant_id"].(string)
	return role, grantID
}

// renderCreatedDocument reports a document create from the server response
// alone: the server owns default sharing, so a default_grant in the payload
// is the only signal that the document was shared. requestedPermission is the
// CLI env override that was sent with the request; "private" is an explicit
// user preference, so it also suppresses the share nudge.
func renderCreatedDocument(out io.Writer, g *globals, cl *Client, title, requestedPermission string, body []byte) error {
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return render(out, g, body)
	}
	id := fmt.Sprint(value(payload, "id"))
	if id == "" || id == "<nil>" {
		if g.json {
			return render(out, g, body)
		}
		return confirm(out, g, fmt.Sprintf("Created document %q. Document URL unavailable: response did not include id.", title))
	}
	if g.quiet {
		return nil
	}
	role, grantID := defaultGrantInfo(payload)
	documentURL := browserURL(cl.Base, "/app/d/%s", id)
	if g.json {
		return renderCreatedDocumentJSON(out, g, id, requestedPermission, documentURL, role, grantID, payload)
	}
	if err := confirm(out, g, fmt.Sprintf("Created document %q (%s). Review it at %s", title, id, documentURL)); err != nil {
		return err
	}
	if grantID != "" {
		// The confirm line must not claim "org-wide" on a public deployment,
		// where the anyone grant admits anyone with the link.
		cfg := serverConfigFor(g)
		audience := "org-wide"
		if cfg.Deployment == "public" {
			audience = "anyone with the link"
		}
		if err := confirm(out, g, fmt.Sprintf("Gave %s %s access by default.", audience, roleAccess(role))); err != nil {
			return err
		}
		_, err := fmt.Fprintln(out, defaultShareNotice(cfg, id, role, grantID))
		return err
	}
	if requestedPermission == "private" {
		return nil
	}
	return printOrgWideViewerNudge(out, g, id)
}

// renderCreatedDocumentJSON augments the create payload with the URL and the
// share warning (grant applied) or nudge (org server, not explicitly private).
func renderCreatedDocumentJSON(out io.Writer, g *globals, id, requestedPermission, documentURL, role, grantID string, payload map[string]any) error {
	payload["url"] = documentURL
	if grantID != "" {
		payload["warning"] = defaultShareNotice(serverConfigFor(g), id, role, grantID)
	} else if requestedPermission != "private" {
		if nudge := orgWideViewerNudge(g, id); nudge != "" {
			payload["message"] = nudge
		}
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return render(out, g, encoded)
}

func documentUpdateCmd(g *globals, out io.Writer) *cobra.Command {
	var ut string
	cmd := &cobra.Command{Use: "update <doc_id>", Short: "Update document metadata", Long: "Rename a document. Sharing is managed separately with 'slashdocs docs grants'.", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		if !cmd.Flags().Changed("title") {
			return errors.New("nothing to update; pass --title")
		}
		return action(g, out, func(c *Client) ([]byte, error) {
			return c.doJSON("PATCH", apiPath("/v1/documents/%s", args[0]), map[string]any{"title": ut})
		}, func(map[string]any) string { return "Renamed document " + args[0] + "." }, actionOptions{
			after: func() error { return printOrgWideViewerNudge(out, g, args[0]) },
			jsonFields: func() map[string]any {
				return map[string]any{"message": orgWideViewerNudge(g, args[0])}
			},
		})
	}}
	cmd.Flags().StringVar(&ut, "title", "", "new document title")
	return cmd
}

func documentMoveCmd(g *globals, out io.Writer) *cobra.Command {
	var moveFolderID string
	var moveRoot bool
	cmd := &cobra.Command{Use: "move <doc_id>", Short: "Move a document to a folder or back to root", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		if moveRoot && moveFolderID != "" {
			return errors.New("--folder-id and --root are mutually exclusive")
		}
		if !moveRoot && moveFolderID == "" {
			return errors.New("pass --folder-id <fld_…> or --root")
		}
		if moveRoot {
			cl, err := client(g)
			if err != nil {
				return err
			}
			b, err := cl.do("GET", apiPath("/v1/documents/%s", args[0]), nil, "")
			if err != nil {
				return err
			}
			var doc struct {
				ParentFolderID string `json:"parent_folder_id"`
			}
			if json.Unmarshal(b, &doc) != nil || doc.ParentFolderID == "" {
				return errors.New("document is already at root")
			}
			_, err = cl.do("DELETE", apiPath("/v1/folders/%s/documents/%s", doc.ParentFolderID, args[0]), nil, "")
			if err != nil {
				return err
			}
			return confirm(out, g, "Moved "+args[0]+" to workspace root.")
		}
		return action(g, out, func(c *Client) ([]byte, error) {
			return c.doJSON("POST", apiPath("/v1/folders/%s/documents", moveFolderID), map[string]any{"document_id": args[0]})
		}, func(m map[string]any) string {
			msg := "Moved " + args[0] + " to folder " + moveFolderID + "."
			if w, ok := m["permission_warning"].(map[string]any); ok {
				msg += " Warning: " + fmt.Sprint(value(w, "message"))
			}
			return msg
		})
	}}
	cmd.Flags().StringVar(&moveFolderID, "folder-id", "", "destination folder ID")
	cmd.Flags().BoolVar(&moveRoot, "root", false, "move document to workspace root")
	return cmd
}

func grantsCmd(g *globals, out io.Writer) *cobra.Command {
	c := &cobra.Command{Use: "grants", Short: "Manage document grants"}
	var principal, address, group, role string
	var everyone bool
	add := &cobra.Command{
		Use:   "add <doc_id>",
		Short: "Share a doc with a person, bot, Google Group, or everyone",
		Long: "Share a doc by passing an email, bot address, or verified Google Group, or use --everyone to grant\n" +
			"access to everyone who can reach this server (anyone with the link on a\n" +
			"public deployment, or everyone in the org on an org deployment).\n\n" +
			"Examples:\n" +
			"  slashdocs docs grants add doc_… --to user@org.example --role commenter\n" +
			"  slashdocs docs grants add doc_… --to report-creator@brave.otter.bot --role editor\n" +
			"  slashdocs docs grants add doc_… --group tech-infra@org.example --role commenter\n" +
			"  slashdocs docs grants add doc_… --everyone --role viewer",
		Args: exactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			body := map[string]any{"role": role}
			var target string
			selected := 0
			for _, set := range []bool{address != "", group != "", everyone, principal != ""} {
				if set {
					selected++
				}
			}
			if selected > 1 {
				return usageError{errors.New("--group, --to, --everyone, and --principal are mutually exclusive")}
			}
			switch {
			case everyone:
				body["principal"] = map[string]any{"type": "anyone"}
				target = everyoneLabelFor(g)
			case address != "":
				body["address"] = address
				target = address
			case group != "":
				body["principal"] = map[string]any{"type": "google_group", "email": group}
				target = group
			case principal != "":
				body["principal"] = parsePrincipal(principal)
				target = principal
			default:
				return usageError{errors.New("pass --to <email-or-bot-address>, --group <email>, or --everyone")}
			}
			return action(g, out, func(c *Client) ([]byte, error) {
				return c.doJSON("POST", apiPath("/v1/documents/%s/grants", args[0]), body)
			}, func(m map[string]any) string {
				return fmt.Sprintf("Shared %s with %s as %s.", args[0], target, role)
			})
		},
	}
	add.Flags().StringVar(&address, "to", "", "email or bot address (e.g. user@org.example or report-creator@brave.otter.bot)")
	add.Flags().StringVar(&group, "group", "", "verified organization Google Group email")
	add.Flags().BoolVar(&everyone, "everyone", false, "share with everyone who can reach this server")
	add.Flags().StringVar(&principal, "principal", "", "legacy: sa:<id> or user:<email>")
	add.Flags().StringVar(&role, "role", "viewer", "viewer, commenter, or editor")
	var r string
	upd := &cobra.Command{Use: "update <doc_id> <grant_id>", Short: "Update a grant role", Args: exactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		return action(g, out, func(c *Client) ([]byte, error) {
			return c.doJSON("PATCH", apiPath("/v1/documents/%s/grants/%s", args[0], args[1]), map[string]any{"role": r})
		}, func(map[string]any) string { return "Changed grant " + args[1] + " on " + args[0] + " to " + r + "." })
	}}
	upd.Flags().StringVar(&r, "role", "viewer", "new grant role: viewer, commenter, or editor")
	revoke := mutate(g, out, "revoke <doc_id> <grant_id>", "Revoke a document grant", "DELETE", "/v1/documents/%s/grants/%s", 2, func(a []string) string { return "Revoked grant " + a[1] + " on " + a[0] + "." })
	list := simplePath(g, out, "list", "GET", "/v1/documents/%s/access")
	list.Short = "List effective document access"
	c.AddCommand(list, add, upd, revoke)
	return c
}

func versionsCmd(g *globals, out io.Writer) *cobra.Command {
	c := &cobra.Command{Use: "versions", Short: "Inspect document versions"}
	list := simplePath(g, out, "list", "GET", "/v1/documents/%s/versions")
	list.Use = "list <doc_id>"
	c.AddCommand(
		list,
		docVersionCmd(g, out, "show", "GET", "/v1/documents/%s/versions/%s"),
		docVersionCmd(g, out, "html", "GET", "/v1/documents/%s/versions/%s/html"),
	)
	return c
}

// docVersionCmd builds a versions subcommand scoped to a document, taking
// <doc_id> <version_id> and filling a path template with two %s segments.
func docVersionCmd(g *globals, out io.Writer, use, method, tmpl string) *cobra.Command {
	return &cobra.Command{Use: use + " <doc_id> <version_id>", Short: shortFor(use), Args: exactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		return run(g, out, func(c *Client) ([]byte, error) {
			return c.do(method, apiPath(tmpl, args[0], args[1]), nil, "")
		})
	}}
}

func pullCmd(g *globals, out io.Writer) *cobra.Command {
	var ver, outp string
	cmd := &cobra.Command{Use: "pull <doc_id>", Short: "Download a document HTML version", Example: "  slashdocs docs pull doc_123 --out report.html\n  slashdocs docs pull doc_123 --version ver_123", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		cl, err := client(g)
		if err != nil {
			return err
		}
		v := ver
		if v == "" {
			b, err := cl.do("GET", apiPath("/v1/documents/%s", args[0]), nil, "")
			if err != nil {
				return err
			}
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				return fmt.Errorf("could not parse document response: %w", err)
			}
			v = fmt.Sprint(value(m, "current_version_id"))
			if v == "" || v == "<nil>" {
				return errors.New("document response did not include current_version_id")
			}
		}
		b, err := cl.do("GET", apiPath("/v1/documents/%s/versions/%s/html", args[0], v), nil, "")
		if err != nil {
			return err
		}
		if err := recordBaseVersion(g, args[0], v); err != nil {
			return err
		}
		if outp != "" {
			if err := os.WriteFile(outp, b, pulledFilePerm); err != nil {
				return err
			}
			return confirm(out, g, "Pulled version "+v+" of "+args[0]+" to "+outp+".")
		}
		_, err = out.Write(b)
		return err
	}}
	cmd.Flags().StringVar(&ver, "version", "", "specific version ID to pull (defaults to the current version)")
	cmd.Flags().StringVar(&outp, "out", "", "write HTML to this file instead of stdout")
	return cmd
}

func recordBaseVersion(g *globals, docID, versionID string) error {
	if docID == "" || versionID == "" {
		return nil
	}
	name, cx, cfg := currentContext(g)
	cx.Pulled[docID] = versionID
	cfg.Contexts[name] = cx
	if cfg.ActiveContext == "" && !g.local {
		cfg.ActiveContext = name
	}
	return saveConfig(cfg)
}

func docsPushCmd(g *globals, out io.Writer) *cobra.Command {
	var base, summary string
	cmd := &cobra.Command{Use: "push <doc_id> <file>", Short: "Upload a new document version", Example: "  slashdocs docs push doc_123 report.html --base-version ver_123\n  slashdocs docs push doc_123 report.html --summary 'Address comments'", Args: exactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		doc, file := args[0], args[1]
		data, fn, err := readFileArg(file)
		if err != nil {
			return err
		}
		if base == "" {
			_, cx, _ := currentContext(g)
			base = cx.Pulled[doc]
		}
		if base == "" {
			return errors.New("no base version known; run slashdocs docs pull <doc_id> first or pass --base-version")
		}
		cl, err := client(g)
		if err != nil {
			return err
		}
		b, err := cl.multipart(apiPath("/v1/documents/%s/versions", doc), map[string]string{"base_version_id": base, "change_summary": summary}, "file", fn, data)
		if err != nil {
			return err
		}
		var pushed struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(b, &pushed); err != nil {
			return err
		}
		if err := recordBaseVersion(g, doc, pushed.ID); err != nil {
			return err
		}
		return printPushedVersion(out, g, doc, cl.Base, b)
	}}
	cmd.Flags().StringVar(&base, "base-version", "", "base version ID")
	cmd.Flags().StringVar(&summary, "summary", "", "change summary, one change per line")
	return cmd
}

func commentsCmd(g *globals, out io.Writer) *cobra.Command {
	c := &cobra.Command{Use: "comments", Short: "Manage document review comments"}

	var listStatus, listVersion string
	list := &cobra.Command{Use: "list <doc_id>", Short: "List document comments", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		q := url.Values{}
		if listStatus != "" {
			q.Set("status", listStatus)
		}
		if listVersion != "" {
			q.Set("version_id", listVersion)
		}
		path := apiPath("/v1/documents/%s/comments", args[0])
		if len(q) > 0 {
			path += "?" + q.Encode()
		}
		return run(g, out, func(c *Client) ([]byte, error) {
			return c.do("GET", path, nil, "")
		})
	}}
	list.Flags().StringVar(&listStatus, "status", "", "filter by status: open or resolved")
	list.Flags().StringVar(&listVersion, "version", "", "filter by version ID")

	var createBody, createQuote, createPrefix, createSuffix, createVersion string
	var createMentions []string
	var createBodyFile string
	create := &cobra.Command{Use: "create <doc_id>", Short: "Create a document comment", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		var err error
		createBody, err = commentBody(cmd, createBody, createBodyFile)
		if err != nil {
			return err
		}
		if createBody == "" || createVersion == "" || createQuote == "" {
			return errors.New("--body (or --body-file), --version, and --quote are required")
		}
		return action(g, out, func(c *Client) ([]byte, error) {
			return c.commentJSON("POST", apiPath("/v1/documents/%s/comments", args[0]), map[string]any{"body": createBody, "version_id": createVersion, "anchor": map[string]any{"quote": createQuote, "prefix": createPrefix, "suffix": createSuffix}}, createMentions, false)
		}, func(m map[string]any) string {
			return "Added comment " + fmt.Sprint(value(m, "id")) + " on " + args[0] + "."
		})
	}}
	create.Flags().StringVar(&createBodyFile, "body-file", "", "read comment text from a file, or - for stdin")
	create.Flags().StringArrayVar(&createMentions, "mention", nil, "tag email, user:<id>, or sa:<id> (repeatable; appends tag if absent)")
	create.Flags().StringVar(&createBody, "body", "", "comment body text")
	create.Flags().StringVar(&createQuote, "quote", "", "anchor: the exact quoted text")
	create.Flags().StringVar(&createPrefix, "prefix", "", "anchor: text immediately before the quote")
	create.Flags().StringVar(&createSuffix, "suffix", "", "anchor: text immediately after the quote")
	create.Flags().StringVar(&createVersion, "version", "", "version ID the comment anchors to")

	var replyBody string
	var replyMentions []string
	var replyBodyFile string
	reply := &cobra.Command{Use: "reply <doc_id> <comment_id>", Short: "Create a reply in a comment thread", Args: exactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		var err error
		replyBody, err = commentBody(cmd, replyBody, replyBodyFile)
		if err != nil {
			return err
		}
		if replyBody == "" {
			return errors.New("--body is required")
		}
		return action(g, out, func(c *Client) ([]byte, error) {
			return c.commentJSON("POST", apiPath("/v1/documents/%s/comments/%s/replies", args[0], args[1]), map[string]any{"body": replyBody}, replyMentions, false)
		}, func(m map[string]any) string {
			return "Created reply " + fmt.Sprint(value(m, "id")) + " on comment " + args[1] + "."
		})
	}}
	reply.Flags().StringVar(&replyBodyFile, "body-file", "", "read reply text from a file, or - for stdin")
	reply.Flags().StringArrayVar(&replyMentions, "mention", nil, "tag email, user:<id>, or sa:<id> (repeatable; appends tag if absent)")
	reply.Flags().StringVar(&replyBody, "body", "", "reply body text")

	c.AddCommand(list, create, reply, updateCommentCmd(g, out), deleteCommentCmd(g, out),
		resolveCmd(g, out, "resolve", "resolved"), resolveCmd(g, out, "reopen", "open"),
		reactionCmd(g, out, "react", "Add a reaction to a document comment", "PUT",
			func(a []string) string { return "Reacted " + a[2] + " on comment " + a[1] + "." }),
		reactionCmd(g, out, "unreact", "Remove your reaction from a document comment", "DELETE",
			func(a []string) string { return "Removed " + a[2] + " from comment " + a[1] + "." }))
	return c
}

func deleteCommentCmd(g *globals, out io.Writer) *cobra.Command {
	return mutate(g, out, "delete <doc_id> <comment_id>", "Delete a document comment", "DELETE", "/v1/documents/%s/comments/%s", 2, func(a []string) string { return "Deleted comment " + a[1] + "." })
}

// reactionSlugs is the server's accepted set, repeated here only so help text
// and errors are useful offline. The server remains the authority.
const reactionSlugs = "+1, -1, laugh, hooray, confused, heart, rocket, eyes, plus"

func reactionCmd(g *globals, out io.Writer, name, short, method string, msg func(args []string) string) *cobra.Command {
	cmd := mutate(g, out, name+" <doc_id> <comment_id> <emoji>", short, method, "/v1/documents/%s/comments/%s/reactions/%s", 3, msg)
	cmd.Long = short + ".\n\nReactions work on both root comments and replies.\nValid values: " + reactionSlugs + "."
	cmd.Example = "  slashdocs docs comments " + name + " doc_123 cmt_456 +1"
	return cmd
}

func resolveCmd(g *globals, out io.Writer, name, status string) *cobra.Command {
	short := "Resolve document comments"
	verb := "Resolved"
	if status == "open" {
		short = "Reopen document comments"
		verb = "Reopened"
	}
	return &cobra.Command{Use: name + " <doc_id> <comment_id>...", Short: short, Args: minArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		cl, err := client(g)
		if err != nil {
			return err
		}
		docID := args[0]
		for _, id := range args[1:] {
			b, err := cl.doJSON("PATCH", apiPath("/v1/documents/%s/comments/%s", docID, id), map[string]any{"status": status})
			if err != nil {
				return err
			}
			if g.json {
				if err := render(out, g, b); err != nil {
					return err
				}
				continue
			}
			if err := confirm(out, g, verb+" comment "+id+"."); err != nil {
				return err
			}
		}
		return nil
	}}
}

func openCmd(g *globals, out io.Writer) *cobra.Command {
	return &cobra.Command{Use: "open <doc_id>", Short: "Open a document in the browser", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		c, err := client(g)
		if err != nil {
			return err
		}
		u := browserURL(c.Base, "/app/d/%s", args[0])
		if err := openBrowserErr(u); err != nil {
			return err
		}
		if env("SLASHDOCS_NO_BROWSER") != "" {
			return message(out, g, "Browser launch is disabled (SLASHDOCS_NO_BROWSER). Open this URL manually:\n"+u)
		}
		return confirm(out, g, "Opened "+args[0]+" in your browser: "+u)
	}}
}

func updateCommentCmd(g *globals, out io.Writer) *cobra.Command {
	var updateBody, updateStatus string
	var updateMentions []string
	var updateBodyFile string
	var clearMentions bool
	update := &cobra.Command{Use: "update <doc_id> <comment_id>", Short: "Update a document comment", Args: exactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		var err error
		updateBody, err = commentBody(cmd, updateBody, updateBodyFile)
		if err != nil {
			return err
		}
		body := map[string]any{}
		if cmd.Flags().Changed("body") || cmd.Flags().Changed("body-file") {
			if updateBody == "" {
				return errors.New("--body cannot be empty")
			}
			body["body"] = updateBody
		}
		if cmd.Flags().Changed("status") {
			body["status"] = updateStatus
		}
		if len(body) == 0 && !clearMentions {
			return errors.New("nothing to update; pass --body, --status, or --clear-mentions")
		}
		return action(g, out, func(c *Client) ([]byte, error) {
			return c.commentJSON("PATCH", apiPath("/v1/documents/%s/comments/%s", args[0], args[1]), body, updateMentions, clearMentions)
		}, func(map[string]any) string { return "Updated comment " + args[1] + "." })
	}}
	update.Flags().StringVar(&updateBodyFile, "body-file", "", "read updated text from a file, or - for stdin")
	update.Flags().StringArrayVar(&updateMentions, "mention", nil, "tag email, user:<id>, or sa:<id> (requires body; replaces mention metadata)")
	update.Flags().BoolVar(&clearMentions, "clear-mentions", false, "remove all structured mentions")
	update.MarkFlagsMutuallyExclusive("mention", "clear-mentions")
	update.Flags().StringVar(&updateBody, "body", "", "new comment body text")
	update.Flags().StringVar(&updateStatus, "status", "", "new status: open or resolved")

	return update
}
