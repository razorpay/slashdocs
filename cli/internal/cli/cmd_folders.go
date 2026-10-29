package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"

	"github.com/spf13/cobra"
)

func foldersCmd(g *globals, out io.Writer) *cobra.Command {
	c := &cobra.Command{Use: "folders", Short: "Manage folders"}

	var createTitle, createParent string
	create := &cobra.Command{Use: "create", Short: "Create a folder", Args: exactArgs(0), RunE: func(cmd *cobra.Command, args []string) error {
		if createTitle == "" {
			return errors.New("--title is required")
		}
		body := map[string]any{"title": createTitle}
		if createParent != "" {
			body["parent_folder_id"] = createParent
		}
		return action(g, out, func(c *Client) ([]byte, error) {
			return c.doJSON("POST", "/v1/folders", body)
		}, func(m map[string]any) string {
			return fmt.Sprintf("Created folder %q (%s).", createTitle, fmt.Sprint(value(m, "id")))
		})
	}}
	create.Flags().StringVar(&createTitle, "title", "", "folder title (required)")
	create.Flags().StringVar(&createParent, "parent", "", "parent folder ID")

	var listPath, listFolderID string
	list := &cobra.Command{Use: "list", Short: "List folders and documents", Long: "Browse folders. With no arguments, lists root folders (first 50).\nWith --path /A/B or --folder-id, lists that folder's contents.", RunE: func(cmd *cobra.Command, args []string) error {
		q := url.Values{}
		if listPath != "" {
			q.Set("path", listPath)
		}
		if listFolderID != "" {
			q.Set("folder_id", listFolderID)
		}
		path := "/v1/folders"
		if len(q) > 0 {
			path += "?" + q.Encode()
		}
		cl, err := client(g)
		if err != nil {
			return err
		}
		b, err := cl.do("GET", path, nil, "")
		if err != nil {
			var ae *APIError
			if errors.As(err, &ae) && ae.Code == "ambiguous_path" {
				if g.json {
					_, writeErr := fmt.Fprintln(out, ae.Body)
					return writeErr
				}
				return renderAmbiguousPath(out, ae.Body)
			}
			return err
		}
		if g.quiet {
			return nil
		}
		if g.json {
			return render(out, g, b)
		}
		return renderFolderList(out, b)
	}}
	list.Flags().StringVar(&listPath, "path", "", "folder path (e.g. /A/B)")
	list.Flags().StringVar(&listFolderID, "folder-id", "", "folder ID to list")

	search := &cobra.Command{Use: "search <name>", Short: "Search folders by title", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		params := url.Values{}
		params.Set("q", args[0])
		return run(g, out, func(c *Client) ([]byte, error) {
			return c.do("GET", "/v1/folders?"+params.Encode(), nil, "")
		})
	}}

	show := simplePath(g, out, "show", "GET", "/v1/folders/%s")

	var updateTitle string
	update := &cobra.Command{Use: "update <folder_id>", Short: "Rename a folder", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		if !cmd.Flags().Changed("title") {
			return errors.New("nothing to update; pass --title")
		}
		return action(g, out, func(c *Client) ([]byte, error) {
			return c.doJSON("PATCH", apiPath("/v1/folders/%s", args[0]), map[string]any{"title": updateTitle})
		}, func(map[string]any) string { return "Renamed folder " + args[0] + "." })
	}}
	update.Flags().StringVar(&updateTitle, "title", "", "new folder title")

	var moveParent string
	move := &cobra.Command{Use: "move <folder_id>", Short: "Move a folder to a new parent", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		parent := moveParent
		return action(g, out, func(c *Client) ([]byte, error) {
			return c.doJSON("PATCH", apiPath("/v1/folders/%s", args[0]), map[string]any{"parent_folder_id": &parent})
		}, func(map[string]any) string { return "Moved folder " + args[0] + "." })
	}}
	move.Flags().StringVar(&moveParent, "parent", "", "new parent folder ID (empty = root)")

	del := mutate(g, out, "delete <folder_id>", "Delete a folder and its subfolders", "DELETE", "/v1/folders/%s", 1, func(a []string) string { return "Deleted folder " + a[0] + "." })

	access := simplePath(g, out, "access", "GET", "/v1/folders/%s/access")
	access.Short = "Show effective access for a folder"

	c.AddCommand(list, search, create, show, update, move, del, access, folderGrantsCmd(g, out), folderDocsCmd(g, out))
	return c
}

func folderGrantsCmd(g *globals, out io.Writer) *cobra.Command {
	c := &cobra.Command{Use: "grants", Short: "Manage folder grants"}
	list := simplePath(g, out, "list", "GET", "/v1/folders/%s/access")
	list.Short = "List effective folder access"

	var address, group, principal, role string
	var everyone bool
	add := &cobra.Command{Use: "add <folder_id>", Short: "Share a folder", Long: "Share a folder with a person, bot, verified Google Group, or everyone.\n\nExamples:\n  slashdocs folders grants add fld_… --to user@org.example --role editor\n  slashdocs folders grants add fld_… --group tech-infra@org.example --role viewer\n  slashdocs folders grants add fld_… --everyone --role viewer", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
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
			target = "everyone"
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
			return c.doJSON("POST", apiPath("/v1/folders/%s/grants", args[0]), body)
		}, func(m map[string]any) string {
			return fmt.Sprintf("Shared %s with %s as %s.", args[0], target, role)
		})
	}}
	add.Flags().StringVar(&address, "to", "", "email or bot address")
	add.Flags().StringVar(&group, "group", "", "verified organization Google Group email")
	add.Flags().BoolVar(&everyone, "everyone", false, "share with everyone")
	add.Flags().StringVar(&principal, "principal", "", "legacy: sa:<id> or user:<email>")
	add.Flags().StringVar(&role, "role", "viewer", "viewer, commenter, or editor")

	var updRole string
	upd := &cobra.Command{Use: "update <folder_id> <grant_id>", Short: "Update a folder grant role", Args: exactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		return action(g, out, func(c *Client) ([]byte, error) {
			return c.doJSON("PATCH", apiPath("/v1/folders/%s/grants/%s", args[0], args[1]), map[string]any{"role": updRole})
		}, func(map[string]any) string {
			return "Changed grant " + args[1] + " on folder " + args[0] + " to " + updRole + "."
		})
	}}
	upd.Flags().StringVar(&updRole, "role", "viewer", "new role")

	revoke := mutate(g, out, "revoke <folder_id> <grant_id>", "Revoke a folder grant", "DELETE", "/v1/folders/%s/grants/%s", 2, func(a []string) string { return "Revoked grant " + a[1] + " on folder " + a[0] + "." })

	c.AddCommand(list, add, upd, revoke)
	return c
}

func folderDocsCmd(g *globals, out io.Writer) *cobra.Command {
	c := &cobra.Command{Use: "docs", Short: "Manage documents in a folder"}
	list := simplePath(g, out, "list", "GET", "/v1/folders/%s/documents")

	move := &cobra.Command{Use: "move <folder_id> <doc_id>", Short: "Move a document into this folder", Args: exactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		return action(g, out, func(c *Client) ([]byte, error) {
			return c.doJSON("POST", apiPath("/v1/folders/%s/documents", args[0]), map[string]any{"document_id": args[1]})
		}, func(m map[string]any) string {
			msg := "Moved " + args[1] + " to folder " + args[0] + "."
			if w, ok := m["permission_warning"].(map[string]any); ok {
				msg += " Warning: " + fmt.Sprint(value(w, "message"))
			}
			return msg
		})
	}}

	remove := mutate(g, out, "remove <folder_id> <doc_id>", "Move a document out of this folder to root", "DELETE", "/v1/folders/%s/documents/%s", 2, func(a []string) string { return "Moved " + a[1] + " out of folder " + a[0] + " to root." })

	c.AddCommand(list, move, remove)
	return c
}

func renderFolderList(out io.Writer, b []byte) error {
	var resp struct {
		Folder  *json.RawMessage  `json:"folder"`
		Items   []json.RawMessage `json:"items"`
		HasMore bool              `json:"has_more"`
	}
	if err := json.Unmarshal(b, &resp); err != nil {
		_, e := out.Write(b)
		return e
	}
	// Extract the current folder's ID so inaccessible-document hints can name it.
	var currentFolderID string
	if resp.Folder != nil {
		var f struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(*resp.Folder, &f)
		currentFolderID = f.ID
	}
	for _, item := range resp.Items {
		var entry struct {
			Type     string          `json:"type"`
			Folder   json.RawMessage `json:"folder"`
			Document json.RawMessage `json:"document"`
		}
		if json.Unmarshal(item, &entry) != nil {
			continue
		}
		var row map[string]any
		switch entry.Type {
		case "folder":
			_ = json.Unmarshal(entry.Folder, &row)
			if row != nil {
				row["type"] = "folder"
			}
		case "document":
			_ = json.Unmarshal(entry.Document, &row)
			if row != nil {
				row["type"] = "document"
				// caller_role is present but empty when the folder owner has no
				// direct role on the document. Surface this so the owner knows
				// they can eject the document without opening it.
				if cr, ok := row["caller_role"].(string); ok && cr == "" {
					docIDVal, _ := row["id"].(string)
					hint := " [no document access"
					if currentFolderID != "" && docIDVal != "" {
						hint += " — eject: slashdocs folders docs remove " + currentFolderID + " " + docIDVal
					}
					hint += "]"
					if _, err := fmt.Fprintln(out, compactRow(row)+hint); err != nil {
						return err
					}
					continue
				}
			}
		}
		if row != nil {
			if _, err := fmt.Fprintln(out, compactRow(row)); err != nil {
				return err
			}
		}
	}
	if resp.HasMore {
		if _, err := fmt.Fprintln(out, "Showing the first 50 folders. There are more. Use `slashdocs folders search <name>` to find a folder."); err != nil {
			return err
		}
	}
	if len(resp.Items) == 0 {
		if _, err := fmt.Fprintln(out, "No items."); err != nil {
			return err
		}
	}
	return nil
}

func renderAmbiguousPath(out io.Writer, body string) error {
	var resp struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Candidates []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
			Owner struct {
				Name  string `json:"name"`
				Email string `json:"email"`
			} `json:"owner"`
		} `json:"candidates"`
	}
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		_, writeErr := fmt.Fprintln(out, body)
		return writeErr
	}
	if _, err := fmt.Fprintln(out, "Ambiguous path: multiple folders match."); err != nil {
		return err
	}
	if _, err := fmt.Fprintln(out); err != nil {
		return err
	}
	for i, c := range resp.Candidates {
		owner := c.Owner.Name
		if owner == "" {
			owner = c.Owner.Email
		}
		if owner == "" {
			owner = "unknown"
		}
		if _, err := fmt.Fprintf(out, "  %d. %s (owner: %s)\n     --folder-id %s\n\n", i+1, c.Title, owner, c.ID); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintln(out, "Re-run with --folder-id to specify which one.")
	return err
}
