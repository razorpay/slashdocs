package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

func booksCmd(g *globals, out io.Writer) *cobra.Command {
	c := &cobra.Command{Use: "books", Short: "Manage books (folders of chapters)"}

	create := &cobra.Command{Use: "create <folder_id>", Short: "Make a folder a book", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		var created struct {
			BookID       string    `json:"book_id"`
			Placed       []string  `json:"placed"`
			NotInOutline []bookDoc `json:"not_in_outline"`
		}
		return action(g, out, func(cl *Client) ([]byte, error) {
			b, err := cl.do("POST", apiPath("/v1/folders/%s/book", args[0]), nil, "")
			if err != nil {
				return nil, explainBookExists(err)
			}
			return b, json.Unmarshal(b, &created)
		}, func(map[string]any) string {
			return fmt.Sprintf("Created book %s from folder %s: %d documents placed, %d not in the outline.", created.BookID, args[0], len(created.Placed), len(created.NotInOutline))
		}, actionOptions{after: func() error {
			var sb strings.Builder
			if len(created.NotInOutline) > 0 {
				sb.WriteString("Not in outline:\n")
				for _, d := range created.NotInOutline {
					fmt.Fprintf(&sb, "  %s  %s\n", d.ID, d.Title)
				}
			}
			fmt.Fprintf(&sb, "See the outline with `slashdocs books status %s`.\n", created.BookID)
			_, err := io.WriteString(out, sb.String())
			return err
		}})
	}}

	var folder string
	show := &cobra.Command{Use: "show <book_id> | --folder <folder_id>", Short: "Show a book's chapters", Long: "Show the book's ID, title and the chapters you can open.\nWith --folder, find the book made from that folder.", Args: wrapArgs(cobra.MaximumNArgs(1)), RunE: func(cmd *cobra.Command, args []string) error {
		if (len(args) == 1) == (folder != "") {
			return usageError{errors.New("give either a book ID or --folder <folder_id>")}
		}
		cl, err := client(g)
		if err != nil {
			return err
		}
		book := ""
		if len(args) == 1 {
			book = args[0]
		} else {
			b, err := cl.do("GET", apiPath("/v1/folders/%s/book", folder), nil, "")
			if err != nil {
				return err
			}
			var found struct {
				BookID string `json:"book_id"`
			}
			if err := json.Unmarshal(b, &found); err != nil {
				return err
			}
			book = found.BookID
		}
		b, err := cl.do("GET", apiPath("/v1/books/%s", book), nil, "")
		if err != nil {
			return err
		}
		return renderBook(out, g, b, renderBookSummary)
	}}
	show.Flags().StringVar(&folder, "folder", "", "show the book made from this folder")

	status := &cobra.Command{Use: "status <book_id>", Short: "Show each outline entry, placeholders and documents not in the outline", Long: "Show each outline entry with its number, title, document ID and current version,\nthen the placeholders, the folder documents the outline does not place,\nand any chapters removed from the outline.\nNeeds editor access to the book's folder.", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		return getBook(g, out, apiPath("/v1/books/%s/status", args[0]), renderBookStatus)
	}}

	del := mutate(g, out, "delete <book_id>", "Permanently delete a book, all its outline versions and readers' saved places (the folder, documents and chapter progress stay)", "DELETE", "/v1/books/%s", 1, func(a []string) string { return "Deleted book " + a[0] + "." })

	c.AddCommand(create, show, status, del, booksOutlineCmd(g, out))
	return c
}

// getBook GETs path and prints it with render, or raw with --json.
func getBook(g *globals, out io.Writer, path string, render func(io.Writer, []byte) error) error {
	cl, err := client(g)
	if err != nil {
		return err
	}
	b, err := cl.do("GET", path, nil, "")
	if err != nil {
		return err
	}
	return renderBook(out, g, b, render)
}

func renderBook(out io.Writer, g *globals, b []byte, renderText func(io.Writer, []byte) error) error {
	if g.json {
		return render(out, g, b)
	}
	if g.quiet {
		return nil
	}
	return renderText(out, b)
}

// renderBookStatus prints GET /v1/books/{id}/status: one line per outline
// entry (number or front/back, title, document and current version, or
// "planned"), then the folder documents the outline leaves out and the
// chapters removed from it.
func renderBookStatus(out io.Writer, b []byte) error {
	var m struct {
		Entries []struct {
			Kind             string `json:"kind"`
			Number           int    `json:"number"`
			DocumentID       string `json:"document_id"`
			Title            string `json:"title"`
			CurrentVersionID string `json:"current_version_id"`
			Planned          bool   `json:"planned"`
		} `json:"entries"`
		NotInOutline []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"not_in_outline"`
		Removed []string `json:"removed"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	if len(m.Entries) == 0 && len(m.NotInOutline) == 0 && len(m.Removed) == 0 {
		_, err := fmt.Fprintln(out, "The outline is empty.")
		return err
	}
	var tw strings.Builder
	fmt.Fprintln(&tw, "Outline:")
	for _, e := range m.Entries {
		slot := fmt.Sprint(e.Number)
		if e.Number == 0 {
			slot = e.Kind
		}
		if e.Planned || e.DocumentID == "" {
			fmt.Fprintf(&tw, "  %s\t%s\tplanned\n", slot, e.Title)
			continue
		}
		fmt.Fprintf(&tw, "  %s\t%s\t%s\t%s\n", slot, e.Title, e.DocumentID, e.CurrentVersionID)
	}
	if len(m.NotInOutline) > 0 {
		fmt.Fprintln(&tw, "Not in outline:")
		for _, d := range m.NotInOutline {
			fmt.Fprintf(&tw, "  %s\t%s\n", d.ID, d.Title)
		}
	}
	if len(m.Removed) > 0 {
		fmt.Fprintln(&tw, "Removed from the outline:")
		for _, id := range m.Removed {
			fmt.Fprintf(&tw, "  %s\n", id)
		}
	}
	return writeTabbed(out, tw.String())
}

// writeTabbed writes tab-separated lines to out as aligned columns.
func writeTabbed(out io.Writer, text string) error {
	tw := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	if _, err := io.WriteString(tw, text); err != nil {
		return err
	}
	return tw.Flush()
}

// bookLink is a readingOrder or toc entry of the manifest.
type bookLink struct {
	Title      string `json:"title"`
	Properties *struct {
		DocumentID string `json:"documentId"`
		Number     int    `json:"number"`
		Kind       string `json:"kind"`
	} `json:"properties"`
}

// renderBookSummary prints GET /v1/books/{id}: the front matter, then each
// part of the toc with its chapters and placeholders, then the back matter.
// The toc is used for the chapters because placeholders are counted in
// numberOfChapters but only the toc lists them.
func renderBookSummary(out io.Writer, b []byte) error {
	var m struct {
		Metadata struct {
			Identifier       string `json:"identifier"`
			Title            string `json:"title"`
			NumberOfChapters int    `json:"numberOfChapters"`
		} `json:"metadata"`
		ReadingOrder []bookLink `json:"readingOrder"`
		TOC          []struct {
			Title    string     `json:"title"`
			Children []bookLink `json:"children"`
		} `json:"toc"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	var tw strings.Builder
	chapters := "chapters"
	if m.Metadata.NumberOfChapters == 1 {
		chapters = "chapter"
	}
	fmt.Fprintf(&tw, "%s (%s, %d %s)\n", m.Metadata.Title, m.Metadata.Identifier, m.Metadata.NumberOfChapters, chapters)
	matter := func(kind string) {
		for _, item := range m.ReadingOrder {
			if item.Properties != nil && item.Properties.Kind == kind {
				writeBookLink(&tw, item)
			}
		}
	}
	matter("front")
	for _, part := range m.TOC {
		if part.Title != "" {
			fmt.Fprintf(&tw, "  %s\n", part.Title)
		}
		for _, item := range part.Children {
			writeBookLink(&tw, item)
		}
	}
	matter("back")
	return writeTabbed(out, tw.String())
}

// writeBookLink prints one manifest entry: its number (or front/back), its
// title, and its document ID, or "planned" for a placeholder.
func writeBookLink(tw *strings.Builder, item bookLink) {
	p := item.Properties
	if p == nil {
		fmt.Fprintf(tw, "  %s\n", item.Title)
		return
	}
	slot := p.Kind
	if p.Number > 0 {
		slot = fmt.Sprint(p.Number)
	}
	where := p.DocumentID
	if p.Kind == "planned" || where == "" {
		where = "planned"
	}
	fmt.Fprintf(tw, "  %s\t%s\t%s\n", slot, item.Title, where)
}

func booksOutlineCmd(g *globals, out io.Writer) *cobra.Command {
	c := &cobra.Command{Use: "outline", Short: "Pull and push a book's outline"}

	pull := &cobra.Command{Use: "pull <book_id> [file]", Short: "Download the outline as JSON", Long: "Download the current outline with its version ID.\nWrites to the file, or to stdout when the file is omitted or \"-\".\nEdit the JSON, then run `slashdocs books outline push`.", Args: wrapArgs(cobra.RangeArgs(1, 2)), RunE: func(cmd *cobra.Command, args []string) error {
		cl, err := client(g)
		if err != nil {
			return err
		}
		b, err := cl.do("GET", apiPath("/v1/books/%s/outline", args[0]), nil, "")
		if err != nil {
			return err
		}
		// The pulled file is always JSON, whatever --json says.
		var pretty bytes.Buffer
		if err := json.Indent(&pretty, b, "", "  "); err != nil {
			return err
		}
		pretty.WriteByte('\n')
		if len(args) < 2 || args[1] == "-" {
			_, err = out.Write(pretty.Bytes())
			return err
		}
		if err := os.WriteFile(args[1], pretty.Bytes(), 0o600); err != nil {
			return err
		}
		var pulled struct {
			VersionID string `json:"version_id"`
			Number    int    `json:"number"`
		}
		_ = json.Unmarshal(b, &pulled)
		return confirm(out, g, fmt.Sprintf("Pulled outline version %d (%s) of %s to %s.", pulled.Number, pulled.VersionID, args[0], args[1]))
	}}

	var baseVersion, note string
	push := &cobra.Command{Use: "push <book_id> <file>", Short: "Save an edited outline", Long: "Save an outline as a new version.\nThe file may be the JSON from `books outline pull` or a bare outline.\n--base-version is the version you edited; it defaults to the version_id in a pulled file.\nAfter a successful push, a pulled file's version_id and number move to the new version,\nso the same file can be edited and pushed again.\nUse - to read the file from stdin.\n\nExample:\n  slashdocs books outline pull book_… outline.json\n  slashdocs books outline push book_… outline.json --note \"add chapter\"", Args: exactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		return pushOutline(g, out, args[0], args[1], baseVersion, note)
	}}
	push.Flags().StringVar(&baseVersion, "base-version", "", "outline version you edited (default: version_id in a pulled file)")
	push.Flags().StringVar(&note, "note", "", "short note describing the change")

	c.AddCommand(pull, push)
	return c
}

// pushOutline saves the outline in path (a pulled file, a bare outline, or
// - for stdin) as a new version of book. After a successful push from a
// pulled file, it moves the file to the new version.
func pushOutline(g *globals, out io.Writer, book, path, baseVersion, note string) error {
	raw, _, err := readFileArg(path)
	if err != nil {
		return err
	}
	outline, fileVersion, err := parseOutlineFile(raw)
	if err != nil {
		return usageError{err}
	}
	base := baseVersion
	if base == "" {
		base = fileVersion
	}
	if base == "" {
		return usageError{errors.New("--base-version is required when the file is not a pulled outline")}
	}
	body := map[string]any{"base_version_id": base, "outline": outline}
	if note != "" {
		body["note"] = note
	}
	// A pushed pulled file is moved to the version it created, so the
	// same file can be edited and pushed again.
	file := ""
	if fileVersion != "" && path != "-" {
		file = path
	}
	var fileErr error
	return action(g, out, func(cl *Client) ([]byte, error) {
		b, err := cl.doJSON("PUT", apiPath("/v1/books/%s/outline", book), body)
		if err != nil {
			return nil, explainOutlineError(err, book, base)
		}
		if file != "" {
			fileErr = updatePulledFile(file, raw, b)
		}
		return b, nil
	}, func(m map[string]any) string {
		msg := fmt.Sprintf("Saved outline version %v (%s).", value(m, "number"), fmt.Sprint(value(m, "version_id")))
		if fileErr != nil {
			msg += fmt.Sprintf(" Could not update %s (%v); push it next time with --base-version %v.", file, fileErr, value(m, "version_id"))
		}
		return msg
	})
}

// parseOutlineFile accepts a pulled outline ({"version_id", …, "outline"}) or
// a bare outline, and returns the outline plus any version ID it carried.
func parseOutlineFile(raw []byte) (outline json.RawMessage, versionID string, err error) {
	if !json.Valid(raw) {
		var x any
		return nil, "", fmt.Errorf("the outline file is not valid JSON: %w", json.Unmarshal(raw, &x))
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(raw, &top) != nil || top == nil {
		return nil, "", errors.New("the outline file must be a JSON object: the output of `books outline pull`, or an outline")
	}
	inner, pulled := top["outline"]
	if !pulled {
		return raw, "", nil
	}
	_ = json.Unmarshal(top["version_id"], &versionID)
	return inner, versionID, nil
}

// updatePulledFile rewrites the version_id and number of the pulled outline
// file at path to those of the version saved (the PUT response), keeping the
// file's other fields and their order.
func updatePulledFile(path string, raw, saved []byte) error {
	var v struct {
		VersionID string `json:"version_id"`
		Number    int    `json:"number"`
	}
	if err := json.Unmarshal(saved, &v); err != nil {
		return err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if _, err := dec.Token(); err != nil { // the opening brace
		return err
	}
	var obj bytes.Buffer
	obj.WriteByte('{')
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return err
		}
		var field json.RawMessage
		if err := dec.Decode(&field); err != nil {
			return err
		}
		switch key {
		case "version_id":
			field, err = json.Marshal(v.VersionID)
		case "number":
			field, err = json.Marshal(v.Number)
		}
		if err != nil {
			return err
		}
		name, err := json.Marshal(key)
		if err != nil {
			return err
		}
		if obj.Len() > 1 {
			obj.WriteByte(',')
		}
		obj.Write(name)
		obj.WriteByte(':')
		obj.Write(field)
	}
	obj.WriteByte('}')
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, obj.Bytes(), "", "  "); err != nil {
		return err
	}
	pretty.WriteByte('\n')
	return os.WriteFile(path, pretty.Bytes(), 0o600)
}

// bookDoc is a folder document the outline does not place.
type bookDoc struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// explainBookExists names the existing book when the folder already is one.
func explainBookExists(err error) error {
	var ae *APIError
	if !errors.As(err, &ae) || ae.Code != "book_exists" {
		return err
	}
	var payload struct {
		Error struct {
			Details struct {
				BookID string `json:"book_id"`
			} `json:"details"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(ae.Body), &payload) != nil || payload.Error.Details.BookID == "" {
		return err
	}
	id := payload.Error.Details.BookID
	ae.Message = fmt.Sprintf("This folder is already book %s. See it with `slashdocs books show %s`.", id, id)
	return ae
}

// explainOutlineError turns a conflict or validation failure into text that
// says what to do next while keeping the APIError status for exit codes.
func explainOutlineError(err error, book, base string) error {
	var ae *APIError
	if !errors.As(err, &ae) {
		return err
	}
	switch ae.Status {
	case 409:
		var payload struct {
			Error struct {
				Details struct {
					CurrentVersionID string `json:"current_version_id"`
				} `json:"details"`
			} `json:"error"`
		}
		_ = json.Unmarshal([]byte(ae.Body), &payload)
		current := payload.Error.Details.CurrentVersionID
		pull := fmt.Sprintf("`slashdocs books outline pull %s <new file>`", book)
		if current != "" {
			ae.Message = fmt.Sprintf("The outline changed since version %s (now %s). Run %s and re-apply your changes there.", base, current, pull)
		} else {
			ae.Message = fmt.Sprintf("The outline changed since version %s. Run %s and re-apply your changes there.", base, pull)
		}
		return ae
	case 422:
		var payload struct {
			Error struct {
				Details struct {
					Problems []struct {
						Path    string `json:"path"`
						Message string `json:"message"`
					} `json:"problems"`
				} `json:"details"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(ae.Body), &payload) != nil || len(payload.Error.Details.Problems) == 0 {
			return err
		}
		lines := make([]string, 0, len(payload.Error.Details.Problems))
		for _, p := range payload.Error.Details.Problems {
			lines = append(lines, p.Path+": "+p.Message)
		}
		ae.Message = "The outline has problems:\n" + strings.Join(lines, "\n")
		return ae
	}
	return err
}
