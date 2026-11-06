package cli

import (
	"bytes"
	"encoding/json"
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
	"sha256", "token", "selected_text", "body", "url",
}

// render writes b to out, honoring --quiet and --json. It is the single output
// path for API response bodies.
func render(out io.Writer, g *globals, b []byte) error {
	return renderHint(out, g, b, "")
}

func renderHint(out io.Writer, g *globals, b []byte, hint string) error {
	if g.quiet {
		return nil
	}
	var x any
	if json.Unmarshal(b, &x) == nil {
		if g.json {
			enc := json.NewEncoder(out)
			enc.SetIndent("", "  ")
			return enc.Encode(x)
		}
		_, err := fmt.Fprintln(out, humanize(hint, x))
		return err
	}
	_, err := out.Write(append(bytes.TrimSpace(b), '\n'))
	return err
}

// message writes a plain human-facing status line, honoring --quiet. It is the
// single path for non-payload status text (e.g. "Logged in").
func message(out io.Writer, g *globals, text string) error {
	if g.quiet {
		return nil
	}
	_, err := fmt.Fprintln(out, text)
	return err
}

// confirm writes a conversational, action-indicative status line (prefixed with
// a check mark) so the caller can see what just happened rather than an
// API-shaped payload. Honors --quiet.
func confirm(out io.Writer, g *globals, text string) error {
	if g.quiet {
		return nil
	}
	_, err := fmt.Fprintln(out, "\u2713 "+text)
	return err
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

func printPushedVersion(out io.Writer, g *globals, docID, server string, b []byte) error {
	if g.quiet {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return render(out, g, b)
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
	// slashdocs local keeps only the current version, so it has no number.
	version := fmt.Sprint(value(m, "id"))
	if num := value(m, "number"); num != nil {
		version = fmt.Sprint(num) + " (" + version + ")"
	}
	if err := confirm(out, g, fmt.Sprintf("Pushed version %s to %s. Review it at %s", version, docID, url)); err != nil {
		return err
	}
	return printOrgWideViewerNudge(out, g, docID)
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
	for _, key := range []string{"owner", "principal", "created_by"} {
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
	if len(parts) == 0 {
		return fmt.Sprintf("%v", m)
	}
	return strings.Join(parts, "  ")
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
