package cli

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

type globals struct {
	server, token        string
	json, quiet, verbose bool
}

// usageError marks an error as a CLI usage problem (bad flags/args) so ExitCode
// can map it to exit code 2 without fragile string matching.
type usageError struct{ err error }

func (e usageError) Error() string { return e.err.Error() }
func (e usageError) Unwrap() error { return e.err }

// errSADisabled is returned when service-account commands are turned off.
var errSADisabled = errors.New("service account commands are disabled by AIDOCS_DISABLE_SA_COMMANDS")

func Execute(args []string) (string, error) {
	var out bytes.Buffer
	err := Run(&out, args)
	return out.String(), err
}

// Run parses args and runs the CLI, writing command output to out. A failure is
// also reported on out as the single JSON value --json promises; the error is
// returned unchanged so callers keep the existing exit-code mapping.
func Run(out io.Writer, args []string) error {
	g := &globals{}
	root := newRoot(g, out)
	root.SetArgs(args)
	err := root.Execute()
	if err != nil {
		reportError(out, g, err)
	}
	return err
}

// NewRoot builds the command tree writing to out. Prefer Run, which also
// applies the --json error contract to a failed command.
func NewRoot(out io.Writer) *cobra.Command { return newRoot(&globals{}, out) }

func newRoot(g *globals, out io.Writer) *cobra.Command {
	root := &cobra.Command{Use: "aidocs", Short: "CLI for aidocs HTML document review", Long: "CLI for aidocs HTML document review.\n\nAgents: before authoring or publishing an aidocs document, run `aidocs guidelines` and follow that output.\n\nDefault output is compact, agent-friendly key=value text. Use --json for machine-readable JSON.\n\nWith --json, stdout carries exactly one JSON value: the API payload on success, {\"ok\": true} when the server returns no body, and {\"error\": {code, message, status, details}} on failure. Failures keep the server's code and details (a 409 version_conflict names current_version_id) and do not change the exit code. Codes for failures that never reached the API: usage, network, local. Commands taking several ids answer with one value listing each id's outcome. Help and usage text is not a result and stays plain text; -q suppresses the JSON value, leaving only the exit code.", SilenceUsage: true, SilenceErrors: true}
	// The root command has no action of its own, so any leftover positional
	// argument is an unknown subcommand. Classifying it here as a typed
	// usageError keeps the usage exit code reliable without string-matching
	// cobra's error text. Root needs a RunE (help, matching cobra's default
	// for bare `aidocs`) because cobra only validates Args on runnable
	// commands.
	root.RunE = func(cmd *cobra.Command, args []string) error { return cmd.Help() }
	root.Args = func(cmd *cobra.Command, args []string) error {
		if len(args) == 0 {
			return nil
		}
		msg := fmt.Sprintf("unknown command %q for %q", args[0], cmd.CommandPath())
		if s := cmd.SuggestionsFor(args[0]); len(s) > 0 {
			msg += "\n\nDid you mean this?\n\t" + strings.Join(s, "\n\t")
		}
		return usageError{errors.New(msg)}
	}
	root.PersistentPostRun = func(cmd *cobra.Command, args []string) {
		// Bare `aidocs` (help) is excluded so printing usage never hits the
		// network; root only became runnable to get typed unknown-command
		// errors from Args validation.
		if cmd.CommandPath() == "aidocs" || cmd.CommandPath() == "aidocs update" || cmd.CommandPath() == "aidocs skills update" || cmd.CommandPath() == "aidocs version" || cmd.CommandPath() == "aidocs guidelines" {
			return
		}
		c, err := client(g)
		if err != nil {
			return
		}
		maybeNudgeUpdate(g, c)
	}
	root.SetOut(out)
	root.SetErr(os.Stderr)
	root.SetFlagErrorFunc(func(cmd *cobra.Command, err error) error {
		return usageError{err}
	})
	root.PersistentFlags().StringVar(&g.server, "server", "", "API server URL")
	root.PersistentFlags().StringVar(&g.token, "token", "", "Bearer token")
	root.PersistentFlags().BoolVar(&g.json, "json", false, "JSON output")
	root.PersistentFlags().BoolVarP(&g.quiet, "quiet", "q", false, "quiet")
	root.PersistentFlags().BoolVarP(&g.verbose, "verbose", "v", false, "verbose")
	root.AddCommand(notificationsCmd(g, out, false), authCmd(g, out), contextCmd(g, out), docsCmd(g, out), foldersCmd(g, out), saRoot(g, out), openCmd(g, out), guidelinesCmd(g, out), configCmd(g, out), versionCmd(g, out), updateCmd(g, out), skillsCmd(g, out))
	return root
}

// exactArgs and minArgs validate the positional argument count and report a
// usageError (exit code 2) when it is wrong.
func exactArgs(n int) cobra.PositionalArgs { return wrapArgs(cobra.ExactArgs(n)) }
func minArgs(n int) cobra.PositionalArgs   { return wrapArgs(cobra.MinimumNArgs(n)) }

func wrapArgs(v cobra.PositionalArgs) cobra.PositionalArgs {
	return func(cmd *cobra.Command, args []string) error {
		if err := v(cmd, args); err != nil {
			return usageError{err}
		}
		return nil
	}
}

// run is the shared command body: build a client, perform the call, then render
// the response through the single output path.
func run(g *globals, out io.Writer, fn func(*Client) ([]byte, error)) error {
	c, err := client(g)
	if err != nil {
		return err
	}
	b, err := fn(c)
	if err != nil {
		return err
	}
	if err := render(out, g, b); err != nil {
		return err
	}
	return nil
}

func ExitCode(err error) int {
	if err == nil {
		return 0
	}
	var ae *APIError
	if errors.As(err, &ae) {
		switch ae.Status {
		case http.StatusUnauthorized, http.StatusForbidden:
			return 3
		case http.StatusNotFound:
			return 4
		case http.StatusConflict:
			return 5
		}
		return 1
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return 6
	}
	var uerr usageError
	if errors.As(err, &uerr) {
		return 2
	}
	if errors.Is(err, errSADisabled) {
		return 2
	}
	return 1
}

// simple builds a GET/DELETE-style command that takes a fixed arg count and
// posts no body.
func simple(g *globals, out io.Writer, use, method, path string, n int) *cobra.Command {
	return &cobra.Command{Use: use, Short: shortFor(use), Args: exactArgs(n), RunE: func(cmd *cobra.Command, args []string) error {
		return run(g, out, func(c *Client) ([]byte, error) {
			return c.do(method, path, nil, "")
		})
	}}
}

// simplePath builds a single-id command whose path template has one %s.
func simplePath(g *globals, out io.Writer, use, method, tmpl string) *cobra.Command {
	return &cobra.Command{Use: use + " <id>", Short: shortFor(use), Args: exactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		return run(g, out, func(c *Client) ([]byte, error) {
			return c.do(method, apiPath(tmpl, args[0]), nil, "")
		})
	}}
}

// mutate builds a bodyless mutating command (DELETE/POST) that reports the
// action conversationally instead of echoing the API payload. The path
// template's %s segments are filled from the positional args, and msg builds
// the confirmation line from those same args.
func mutate(g *globals, out io.Writer, use, short, method, tmpl string, n int, msg func(args []string) string) *cobra.Command {
	return &cobra.Command{Use: use, Short: short, Args: exactArgs(n), RunE: func(cmd *cobra.Command, args []string) error {
		return action(g, out, func(c *Client) ([]byte, error) {
			return c.do(method, apiPath(tmpl, args...), nil, "")
		}, func(map[string]any) string { return msg(args) })
	}}
}

func shortFor(use string) string {
	switch use {
	case "list":
		return "List resources"
	case "show":
		return "Show resource details"
	case "delete":
		return "Delete a resource"
	case "html":
		return "Print version HTML"
	case "revoke":
		return "Revoke a resource"
	}
	return ""
}

func first(v ...string) string {
	for _, x := range v {
		if x != "" {
			return x
		}
	}
	return ""
}

func normalizeServer(s string) string {
	if !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") {
		host := s
		if i := strings.Index(host, "/"); i >= 0 {
			host = host[:i]
		}
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if isLoopbackHost(host) {
			s = "http://" + s
		} else {
			s = "https://" + s
		}
	}
	return strings.TrimRight(s, "/")
}

// isLoopbackHost reports whether host is exactly a loopback address, so we only
// downgrade to http:// for genuine localhost (not e.g. localhost.evil.com).
func isLoopbackHost(host string) bool {
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1", "[::1]":
		return true
	}
	return false
}

func readFileArg(p string) ([]byte, string, error) {
	if p == "-" {
		b, err := io.ReadAll(os.Stdin)
		return b, "stdin.html", err
	}
	//nolint:gosec // G304: p is the explicit document path supplied by the CLI user.
	b, err := os.ReadFile(p)
	return b, filepath.Base(p), err
}

func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func pkceChallenge(v string) string {
	s := sha256.Sum256([]byte(v))
	return base64.RawURLEncoding.EncodeToString(s[:])
}

func openBrowser(u string) { _ = openBrowserErr(u) }

func openBrowserErr(u string) error {
	if os.Getenv("AIDOCS_NO_BROWSER") != "" {
		return nil
	}
	cmds := [][]string{{"open", u}, {"xdg-open", u}, {"rundll32", "url.dll,FileProtocolHandler", u}}
	var last error
	for _, c := range cmds {
		//nolint:gosec // G204: command names and arguments are fixed URL opener forms; u is passed directly without a shell.
		err := exec.Command(c[0], c[1:]...).Start()
		if err == nil {
			return nil
		}
		last = err
	}
	return fmt.Errorf("could not open browser: %w", last)
}

func parsePrincipal(s string) map[string]any {
	if strings.HasPrefix(s, "sa:") {
		// nosemgrep: detected-google-gcm-service-account - aidocs-native principal type, not a Google credential.
		return map[string]any{"type": "service_account", "id": strings.TrimPrefix(s, "sa:")}
	}
	v := strings.TrimPrefix(s, "user:")
	if strings.Contains(v, "@") {
		return map[string]any{"type": "user", "email": v}
	}
	return map[string]any{"type": "user", "id": v}
}
