package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

func booksCmd(g *globals, out io.Writer) *cobra.Command {
	c := &cobra.Command{Use: "books", Short: "Manage books (folders of chapters)"}

	create := &cobra.Command{Use: "create <folder_id>", Short: "Make a folder a book", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		return action(g, out, func(cl *Client) ([]byte, error) {
			return cl.do("POST", apiPath("/v1/folders/%s/book", args[0]), nil, "")
		}, func(m map[string]any) string {
			return fmt.Sprintf("Created book %s from folder %s.", fmt.Sprint(value(m, "book_id")), args[0])
		})
	}}

	show := &cobra.Command{Use: "show <book_id>", Short: "Show a book's chapters", Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		cl, err := client(g)
		if err != nil {
			return err
		}
		b, err := cl.do("GET", apiPath("/v1/books/%s", args[0]), nil, "")
		if err != nil {
			return err
		}
		if g.json {
			return render(out, g, b)
		}
		if g.quiet {
			return nil
		}
		return renderBookSummary(out, b)
	}}

	status := simplePath(g, out, "status", "GET", "/v1/books/%s/status")
	status.Short = "Show chapters that are missing, removed or not in the outline"

	del := mutate(g, out, "delete <book_id>", "Delete a book's outline (the documents stay)", "DELETE", "/v1/books/%s", 1, func(a []string) string { return "Deleted book " + a[0] + "." })

	c.AddCommand(create, show, status, del, booksOutlineCmd(g, out))
	return c
}

func renderBookSummary(out io.Writer, b []byte) error {
	var m struct {
		Metadata struct {
			Title            string `json:"title"`
			NumberOfChapters int    `json:"numberOfChapters"`
		} `json:"metadata"`
		ReadingOrder []struct {
			Title      string `json:"title"`
			Properties *struct {
				DocumentID string `json:"documentId"`
				Number     int    `json:"number"`
				Kind       string `json:"kind"`
			} `json:"properties"`
		} `json:"readingOrder"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "%s (%d chapters)\n", m.Metadata.Title, m.Metadata.NumberOfChapters)
	for _, item := range m.ReadingOrder {
		if item.Properties == nil {
			fmt.Fprintf(&sb, "  %s\n", item.Title)
			continue
		}
		num := "-"
		if item.Properties.Number > 0 {
			num = fmt.Sprint(item.Properties.Number)
		}
		fmt.Fprintf(&sb, "  %s\t%s\t%s\n", num, item.Title, item.Properties.DocumentID)
	}
	_, err := io.WriteString(out, sb.String())
	return err
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
		var x any
		if err := json.Unmarshal(b, &x); err != nil {
			return err
		}
		pretty, err := json.MarshalIndent(x, "", "  ")
		if err != nil {
			return err
		}
		pretty = append(pretty, '\n')
		if len(args) < 2 || args[1] == "-" {
			_, err = out.Write(pretty)
			return err
		}
		if err := os.WriteFile(args[1], pretty, 0o600); err != nil {
			return err
		}
		if !g.quiet {
			_, err = fmt.Fprintf(out, "Wrote outline to %s.\n", args[1])
		}
		return err
	}}

	var baseVersion, note string
	push := &cobra.Command{Use: "push <book_id> <file>", Short: "Save an edited outline", Long: "Save an outline as a new version.\nThe file may be the JSON from `books outline pull` or a bare outline.\n--base-version is the version you edited; it defaults to the version_id in a pulled file.\nUse - to read the file from stdin.\n\nExample:\n  slashdocs books outline pull book_… outline.json\n  slashdocs books outline push book_… outline.json --note \"add chapter\"", Args: exactArgs(2), RunE: func(cmd *cobra.Command, args []string) error {
		raw, _, err := readFileArg(args[1])
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
		return action(g, out, func(cl *Client) ([]byte, error) {
			b, err := cl.doJSON("PUT", apiPath("/v1/books/%s/outline", args[0]), body)
			return b, explainOutlineError(err)
		}, func(m map[string]any) string {
			return fmt.Sprintf("Saved outline version %v (%s).", value(m, "number"), fmt.Sprint(value(m, "version_id")))
		})
	}}
	push.Flags().StringVar(&baseVersion, "base-version", "", "outline version you edited (default: version_id in a pulled file)")
	push.Flags().StringVar(&note, "note", "", "short note describing the change")

	c.AddCommand(pull, push)
	return c
}

// parseOutlineFile accepts a pulled outline ({"version_id", …, "outline"}) or
// a bare outline, and returns the outline plus any version ID it carried.
func parseOutlineFile(raw []byte) (outline json.RawMessage, versionID string, err error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return nil, "", fmt.Errorf("the outline file is not valid JSON: %w", err)
	}
	inner, pulled := top["outline"]
	if !pulled {
		return raw, "", nil
	}
	_ = json.Unmarshal(top["version_id"], &versionID)
	return inner, versionID, nil
}

// explainOutlineError turns a conflict or validation failure into text that
// says what to do next while keeping the APIError status for exit codes.
func explainOutlineError(err error) error {
	var ae *APIError
	if !errors.As(err, &ae) {
		return err
	}
	switch ae.Status {
	case 409:
		return &APIError{Status: ae.Status, Code: ae.Code, Body: ae.Body, Message: "Someone changed the outline since you pulled it. Pull again and re-apply your changes."}
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
		return &APIError{Status: ae.Status, Code: ae.Code, Body: ae.Body, Message: "The outline has problems:\n" + strings.Join(lines, "\n")}
	}
	return err
}
