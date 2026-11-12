package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// displayFields is the ordered set of keys rendered as a compact key=value row
// in the default (non-JSON) output. Fields absent from a payload are skipped;
// fields not listed here are omitted from the compact view (use --json for the
// full payload).
var displayFields = []string{
	"id", "document_id", "title", "name", "email", "type", "role",
	"enabled", "effective_enabled", "text", "level", "effective_role", "status", "disabled", "current_version_id", "number",
	"sha256", "token", "selected_text", "body", "url", "decision",
	"approval_status", "version_number", "note",
}

// render writes b to out, honoring --quiet and --json. It is the single output
// path for API response bodies. With --json it writes exactly one JSON value:
// {"ok": true} for an empty body, and a JSON string for a body that is not
// JSON, such as document HTML.
func render(out io.Writer, g *globals, b []byte) error {
	return renderHint(out, g, b, "")
}

func renderHint(out io.Writer, g *globals, b []byte, hint string) error {
	if g.quiet {
		return nil
	}
	if g.json && len(bytes.TrimSpace(b)) == 0 {
		b = []byte(`{"ok":true}`)
	}
	var x any
	if json.Unmarshal(b, &x) != nil {
		if !g.json {
			_, err := out.Write(append(bytes.TrimSpace(b), '\n'))
			return err
		}
		x = string(b)
	}
	if g.json {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		enc.SetEscapeHTML(false)
		return enc.Encode(x)
	}
	_, err := fmt.Fprintln(out, humanize(hint, x))
	return err
}

// renderValue renders v, a value that the CLI built, through render.
func renderValue(out io.Writer, g *globals, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return render(out, g, b)
}

// errorEnvelope is the --json form of a failed command, in the shape of the
// error responses of the server. An API error keeps the response of the
// server, with its code and details, and the message that the plain output
// shows, which a command can replace. Other errors get a code from their
// kind.
func errorEnvelope(err error) map[string]any {
	var ae *APIError
	if errors.As(err, &ae) {
		var v map[string]any
		if json.Unmarshal([]byte(ae.Body), &v) == nil && v["error"] != nil {
			if e, ok := v["error"].(map[string]any); ok {
				e["message"] = ae.Message
			}
			return v
		}
	}
	code := "cli_error"
	switch {
	case ae != nil:
		code = "api_error"
	case ExitCode(err) == 2:
		code = "usage"
	case ExitCode(err) == 6:
		code = "network"
	}
	return map[string]any{"error": map[string]any{"code": code, "message": err.Error()}}
}

// reportedError is a failure that the command already put in its --json
// output, so Run does not write a second JSON value.
type reportedError struct{ err error }

func (e reportedError) Error() string { return e.err.Error() }
func (e reportedError) Unwrap() error { return e.err }

// message writes a plain human-facing status line, honoring --quiet. It is the
// single path for non-payload status text (e.g. "Logged in"). With --json the
// line is the "message" of an {"ok": true} value.
func message(out io.Writer, g *globals, text string) error {
	if g.json {
		return renderValue(out, g, map[string]any{"ok": true, "message": text})
	}
	if g.quiet {
		return nil
	}
	_, err := fmt.Fprintln(out, text)
	return err
}

// confirm writes a conversational, action-indicative status line (prefixed with
// a check mark) so the caller can see what just happened rather than an
// API-shaped payload. Honors --quiet and --json, as message does.
func confirm(out io.Writer, g *globals, text string) error {
	if !g.json {
		text = "\u2713 " + text
	}
	return message(out, g, text)
}

// action performs a mutating call and reports it conversationally. With --json
// it prints the raw payload (machine-readable); with --quiet it prints nothing;
// otherwise it prints the confirmation built from the decoded response.
type actionOptions struct {
	after      func() error
	jsonFields func() map[string]any
}

func action(g *globals, out io.Writer, fn func(*Client) ([]byte, error), msg func(m map[string]any) string, opts ...actionOptions) error {
	c, err := client(g)
	if err != nil {
		return err
	}
	b, err := fn(c)
	if err != nil {
		return err
	}
	if g.quiet {
		return nil
	}
	if g.json {
		if len(opts) > 0 && opts[0].jsonFields != nil {
			var m map[string]any
			if json.Unmarshal(b, &m) == nil {
				for k, v := range opts[0].jsonFields() {
					m[k] = v
				}
				nb, err := json.Marshal(m)
				if err != nil {
					return err
				}
				b = nb
			}
		}
		return render(out, g, b)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if err := confirm(out, g, msg(m)); err != nil {
		return err
	}
	if len(opts) > 0 && opts[0].after != nil {
		return opts[0].after()
	}
	return nil
}

// printPushedVersion reports a push. When other people edited the document
// since the base of the push, the server saved their edits and the push
// together, so the saved version is not the pushed file. fileUpdated says
// that the file now has the saved version. The caller learns that, or that
// pull, a command, gets the saved version into another file.
func printPushedVersion(out io.Writer, g *globals, docID, server string, m map[string]any, fileUpdated bool, pull string) error {
	note := ""
	if m["rebased"] == true {
		m["file_updated"] = fileUpdated
		note = "Other people edited this document while you worked. Your file now has their edits too."
		if !fileUpdated {
			note = fmt.Sprintf("Other people edited this document while you worked, and your file does not have their edits. Run %s, and make your next changes in that file.", pull)
		}
	}
	return printSavedVersion(out, g, docID, server, m, note)
}

// printSavedVersion reports m, the answer of a write that saves a version
// of a document: the change is in the document, and the link to it, then
// note when it is not empty. A write that left the document as it is saved
// no version.
func printSavedVersion(out io.Writer, g *globals, docID, server string, m map[string]any, note string) error {
	if g.quiet {
		return nil
	}
	url := browserURL(server, "/app/d/%s", docID)
	if g.json {
		m["url"] = url
		m["message"] = orgWideViewerNudge(g, docID)
		if value(m, "document_id") == nil {
			m["document_id"] = docID
		}
		nb, err := json.Marshal(m)
		if err != nil {
			return err
		}
		return render(out, g, nb)
	}
	if m["unchanged"] == true {
		return message(out, g, "Nothing changed.")
	}
	return confirm(out, g, strings.TrimSpace("Your change is in the document: "+url+"\n"+note))
}

func humanize(hint string, x any) string {
	m, _ := x.(map[string]any)
	if p, ok := m["principal"].(map[string]any); ok {
		if u, ok := m["user"].(map[string]any); ok {
			return compactRow(mergeMaps(p, u))
		}
		// Service accounts get the same treatment as users: merge the identity
		// object onto the principal so the bot's name (its address) and status
		// nosemgrep: generic.secrets.security.detected-google-gcm-service-account.detected-google-gcm-service-account - slashdocs service-account principal type, not a Google credential.
		// show, not just type=service_account.
		if sa, ok := m["service_account"].(map[string]any); ok {
			return compactRow(mergeMaps(p, sa))
		}
		return compactRow(p)
	}
	if ctxs, ok := m["contexts"].(map[string]any); ok {
		active, _ := m["active_context"].(string)
		if len(ctxs) == 0 {
			return "No contexts."
		}
		var lines []string
		for name, raw := range ctxs {
			cx, _ := raw.(map[string]any)
			prefix := " "
			if name == active {
				prefix = "*"
			}
			lines = append(lines, strings.TrimSpace(prefix+" "+name+"  server="+fmt.Sprint(value(cx, "server"))))
		}
		return strings.Join(lines, "\n")
	}
	if items, ok := value(m, "items").([]any); ok {
		if len(items) == 0 {
			return "No items."
		}
		var lines []string
		for _, it := range items {
			row, _ := it.(map[string]any)
			lines = append(lines, compactRow(row))
			// A comment thread shows its replies below it, so that an agent
			// reads the whole conversation.
			replies, _ := value(row, "replies").([]any)
			for _, r := range replies {
				reply, _ := r.(map[string]any)
				lines = append(lines, "  reply "+compactRow(reply))
			}
		}
		return strings.Join(lines, "\n")
	}
	if hint != "" {
		return hint + ": " + compactRow(m)
	}
	return compactRow(m)
}

func mergeMaps(a, b map[string]any) map[string]any {
	r := map[string]any{}
	for k, v := range a {
		r[k] = v
	}
	for k, v := range b {
		r[k] = v
	}
	return r
}

// value looks up a snake_case key in m, returning nil if m is nil or the key
// is absent.
func value(m map[string]any, key string) any {
	if m == nil {
		return nil
	}
	return m[key]
}

// compactRow renders a resource map as an ordered key=value line using the
// centralized displayFields schema.
func compactRow(m map[string]any) string {
	if m == nil {
		return "OK"
	}
	// Search rows nest the entity under "document" or "folder"; fall back to
	// that nested map so compact rows show the id and title, not just "type".
	nested, ok := value(m, "document").(map[string]any)
	if !ok {
		nested, _ = value(m, "folder").(map[string]any)
	}
	parts := []string{}
	for _, k := range displayFields {
		v := value(m, k)
		if v == nil {
			v = value(nested, k)
		}
		if v != nil && fmt.Sprint(v) != "" {
			parts = append(parts, fmt.Sprintf("%s=%v", k, v))
		}
	}
	for _, key := range []string{"owner", "principal", "created_by", "author", "approver"} {
		if p, ok := value(m, key).(map[string]any); ok {
			if label := principalLabel(p); label != "" {
				parts = append(parts, key+"="+label)
			}
		}
	}
	if ids := sourceGrantIDs(m); len(ids) > 0 {
		parts = append(parts, "grant_id="+strings.Join(ids, ","))
	}
	if mentions := mentionLabels(value(m, "mentions")); len(mentions) > 0 {
		parts = append(parts, "mentions="+strings.Join(mentions, ","))
	}
	if pin := pinLabel(value(m, "anchor")); pin != "" {
		parts = append(parts, "pin="+pin)
	}
	if len(parts) == 0 {
		return fmt.Sprintf("%v", m)
	}
	return strings.Join(parts, "  ")
}

// pinLabel names the element of a point comment by its label, or else by its
// target, or "element", or "page" for a point on the body; it is "" for a
// text comment. The row shows the start of the element's text as
// selected_text.
func pinLabel(anchor any) string {
	a, _ := anchor.(map[string]any)
	p, ok := value(a, "point").(map[string]any)
	if !ok {
		return ""
	}
	for _, key := range []string{"label", "target"} {
		if s, _ := value(p, key).(string); s != "" {
			return s
		}
	}
	if path, _ := value(p, "path").(string); path == "" {
		return "page"
	}
	return "element"
}

// sourceGrantIDs collects explicit grant ids from an effective-access row's
// sources; ownership sources carry none. Revoking a grant requires its id, so
// compact access rows must surface them.
func sourceGrantIDs(m map[string]any) []string {
	sources, ok := value(m, "sources").([]any)
	if !ok {
		return nil
	}
	ids := []string{}
	for _, raw := range sources {
		source, _ := raw.(map[string]any)
		if id, _ := value(source, "grant_id").(string); id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

func principalLabel(p map[string]any) string {
	for _, k := range []string{"name", "email", "id"} {
		if v := value(p, k); v != nil && fmt.Sprint(v) != "" {
			return fmt.Sprint(v)
		}
	}
	// The "anyone" principal has no name, email, or id; its type is the only
	// meaningful label (an access row showing no principal at all is worse).
	if v := value(p, "type"); v != nil && fmt.Sprint(v) != "" {
		return fmt.Sprint(v)
	}
	return ""
}

func mentionLabels(raw any) []string {
	items, _ := raw.([]any)
	labels := make([]string, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		mention, _ := item.(map[string]any)
		principal, _ := value(mention, "principal").(map[string]any)
		principalType, _ := value(principal, "type").(string)
		principalID, _ := value(principal, "id").(string)
		if principalType == "" || principalID == "" {
			continue
		}
		key := principalType + ":" + principalID
		if _, ok := seen[key]; ok {
			continue
		}
		label := principalLabel(principal)
		if label == "" {
			continue
		}
		seen[key] = struct{}{}
		labels = append(labels, "@"+label)
	}
	return labels
}
