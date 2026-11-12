package cli

import (
	"bufio"
	"context"
	_ "embed" // Enable the go:embed directive for the login page below.
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

// loginTimeout bounds how long we wait for the browser OAuth flow to complete.
const loginTimeout = 5 * time.Minute

type callbackResult struct {
	code string
	err  error
}

func loginCallbackHandler(state string, resultCh chan<- callbackResult) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Only /callback carries the OAuth result; anything else (favicon,
		// stray reloads after completion) gets a friendly page.
		if r.URL.Path != "/callback" {
			writeLoginPage(w, http.StatusOK, true, loginDoneDetail)
			return
		}
		res, detail := loginCallback(r.URL.Query(), state)
		status := http.StatusOK
		if res.err != nil {
			status = http.StatusBadRequest
		}
		writeLoginPage(w, status, res.err == nil, detail)
		sendCallbackResult(resultCh, res)
	})
	return mux
}

const loginDoneDetail = "You can close this tab and return to your terminal."

// loginCallback reads the OAuth result from a callback query. detail is the
// text for the browser page.
func loginCallback(q url.Values, state string) (res callbackResult, detail string) {
	switch {
	case q.Get("state") != state:
		return callbackResult{err: errors.New("login callback returned an unexpected state value")}, "The login request could not be verified. Please run the command again."
	case q.Get("error") != "":
		return callbackResult{err: errors.New("login failed: " + q.Get("error"))}, "The identity provider reported an error: " + q.Get("error")
	case q.Get("code") == "":
		return callbackResult{err: errors.New("login callback did not include an authorization code")}, "No authorization code was returned. Please run the command again."
	}
	return callbackResult{code: q.Get("code")}, loginDoneDetail
}

// readPastedCallback finishes a login whose browser runs on another machine,
// for example over SSH, where the redirect to this machine's loopback listener
// fails. The user pastes the callback URL that the browser could not open. It
// must be a /callback URL with this login's state (the login URL carries the
// same state), and its code is useless without the PKCE verifier that never
// leaves this process.
func readPastedCallback(in io.Reader, errOut io.Writer, state string, resultCh chan<- callbackResult) {
	lines := bufio.NewScanner(in)
	for lines.Scan() {
		line := strings.TrimSpace(lines.Text())
		if line == "" {
			continue
		}
		u, err := url.Parse(line)
		if err != nil || u.Path != "/callback" || u.Query().Get("state") != state {
			// Do not echo the input: it can hold an authorization code.
			_, _ = fmt.Fprintln(errOut, "That is not the callback URL of this login. Paste the full http://127.0.0.1 URL from the browser address bar.")
			continue
		}
		res, _ := loginCallback(u.Query(), state)
		sendCallbackResult(resultCh, res)
		return
	}
}

// sendCallbackResult keeps the first result. The login waits for only one.
func sendCallbackResult(resultCh chan<- callbackResult, res callbackResult) {
	select {
	case resultCh <- res:
	default:
	}
}

func startLoginCallbackServer(ln net.Listener, state string, resultCh chan<- callbackResult) (*http.Server, <-chan error) {
	srv := &http.Server{
		Handler:           loginCallbackHandler(state, resultCh),
		ReadHeaderTimeout: 5 * time.Second,
	}
	serveErrCh := make(chan error, 1)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErrCh <- err
		}
	}()
	return srv, serveErrCh
}

// waitForLoginCode returns the authorization code of the first login callback.
func waitForLoginCode(ctx context.Context, resultCh <-chan callbackResult, serveErrCh <-chan error) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, loginTimeout)
	defer cancel()
	select {
	case res := <-resultCh:
		return res.code, res.err
	case err := <-serveErrCh:
		return "", fmt.Errorf("serve login callback: %w", err)
	case <-ctx.Done():
		return "", fmt.Errorf("timed out waiting for login callback after %s; run slashdocs auth login again", loginTimeout)
	}
}

func loginCmd(g *globals, out io.Writer) *cobra.Command {
	var name string
	var noBrowser bool
	cmd := &cobra.Command{Use: "login [server]", Short: "Log in through a slashdocs server", Example: "  slashdocs auth login slashdocs.example.com\n  slashdocs auth login   # reuses the active context's server", Args: cobra.MaximumNArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		srv := first(g.server, env("SLASHDOCS_SERVER"))
		if len(args) > 0 {
			srv = args[0]
		}
		if srv == "" {
			// No default host is baked into the binary; fall back to the
			// active context (set by a previous login or by install.sh).
			cfg, _ := loadConfig()
			srv = cfg.Contexts[cfg.ActiveContext].serverOr("")
		}
		if srv == "" {
			return usageError{errNoServer}
		}
		srv, err := serverURL(srv)
		if err != nil {
			return err
		}
		verifier := randomToken(32)
		challenge := pkceChallenge(verifier)
		state := randomToken(18)
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return err
		}
		resultCh := make(chan callbackResult, 1)
		redirect := "http://" + ln.Addr().String() + "/callback"
		srvHTTP, serveErrCh := startLoginCallbackServer(ln, state, resultCh)
		// Shut down gracefully so the browser finishes loading the success page
		// before the listener closes (an abrupt Close races the final response).
		defer func() {
			sdCtx, sdCancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer sdCancel()
			_ = srvHTTP.Shutdown(sdCtx)
		}()
		loginURL := srv + "/v1/auth/google/start?mode=cli&state=" + url.QueryEscape(state) + "&cli_redirect=" + url.QueryEscape(redirect) + "&code_challenge=" + url.QueryEscape(challenge)
		// The URL is progress, not the result, so it goes to stderr.
		_, _ = fmt.Fprintln(cmd.ErrOrStderr(), "Log in at "+loginURL+"\nIf the browser runs on another machine, paste here the http://127.0.0.1 URL that it fails to open.")
		if !noBrowser {
			openBrowser(loginURL)
		}
		go readPastedCallback(cmd.InOrStdin(), cmd.ErrOrStderr(), state, resultCh)

		code, err := waitForLoginCode(cmd.Context(), resultCh, serveErrCh)
		if err != nil {
			return err
		}

		cl := &Client{Base: srv, HTTP: apiHTTPClient}
		b, err := cl.doJSON("POST", "/v1/auth/cli/exchange", map[string]any{"code": code, "code_verifier": verifier, "name": first(name, ctxName(srv))})
		if err != nil {
			return err
		}
		var cred map[string]any
		if err := json.Unmarshal(b, &cred); err != nil {
			return fmt.Errorf("could not parse login response: %w", err)
		}
		cfg, err := loadConfig()
		if err != nil {
			return err
		}
		if cfg.Contexts == nil {
			cfg.Contexts = map[string]*Context{}
		}
		cn := ctxName(srv)
		cfg.ActiveContext = cn
		cfg.Contexts[cn] = &Context{Server: srv, Credential: storeCredentialToken(cn, cred), Pulled: map[string]string{}}
		if err := saveConfig(cfg); err != nil {
			return err
		}
		return confirm(out, g, "Logged in to "+srv+".")
	}}
	cmd.Flags().StringVar(&name, "name", "", "credential name")
	cmd.Flags().BoolVar(&noBrowser, "no-browser", false, "print the login URL without opening a browser")
	return cmd
}

func whoamiCmd(g *globals, out io.Writer) *cobra.Command {
	return &cobra.Command{Use: "whoami", Short: "Show the authenticated principal and server", RunE: func(cmd *cobra.Command, args []string) error {
		cl, err := client(g)
		if err != nil {
			return err
		}
		b, err := cl.do("GET", "/v1/me", nil, "")
		if err != nil {
			return err
		}
		if g.quiet {
			return nil
		}
		if g.json {
			return render(out, g, b)
		}
		var m map[string]any
		if json.Unmarshal(b, &m) != nil {
			return render(out, g, b)
		}
		_, err = fmt.Fprintln(out, humanize("", m)+"  server="+cl.Base)
		return err
	}}
}

func logoutCmd(g *globals, out io.Writer) *cobra.Command {
	var localOnly, keepKeychain bool
	cmd := &cobra.Command{Use: "logout", Short: "Revoke and remove the stored credential for the active context", RunE: func(cmd *cobra.Command, args []string) error {
		name, cx, cfg, err := currentContextE(g)
		if err != nil {
			return err
		}
		if name == "" {
			return errors.New("no active context; nothing to log out of")
		}
		if !localOnly {
			if id, ok := cx.Credential["id"].(string); ok && id != "" {
				cl, err := client(g)
				if err != nil {
					return err
				}
				if _, err := cl.do("DELETE", apiPath("/v1/auth/cli/credentials/%s", id), nil, ""); err != nil {
					return err
				}
			}
		}
		if !keepKeychain {
			deleteCredentialToken(name, cx.Credential)
		}
		delete(cfg.Contexts, name)
		if cfg.ActiveContext == name {
			cfg.ActiveContext = ""
		}
		if err := saveConfig(cfg); err != nil {
			return err
		}
		return confirm(out, g, "Logged out of "+name+".")
	}}
	cmd.Flags().BoolVar(&localOnly, "local", false, "only remove the local credential; do not revoke on the server")
	cmd.Flags().BoolVar(&keepKeychain, "keep-keychain", false, "preserve keychain token entry while removing config (for backups/tests)")
	return cmd
}

//go:embed login_page.html
var loginPageHTML string

var loginPageTmpl = template.Must(template.New("login").Parse(loginPageHTML))

// writeLoginPage serves the OAuth callback tab, styled to match the slashdocs web
// theme. The page lives in login_page.html (embedded); tone is selected by a
// body class so no markup or styles are injected.
func writeLoginPage(w http.ResponseWriter, status int, ok bool, detail string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Signal a complete response so the browser doesn't keep the connection
	// open past the listener's graceful shutdown.
	w.Header().Set("Connection", "close")
	w.WriteHeader(status)

	data := struct{ Class, Title, Detail string }{Class: "ok", Title: "You're signed in", Detail: detail}
	if !ok {
		data.Class, data.Title = "err", "Login failed"
	}
	_ = loginPageTmpl.Execute(w, data)
}

func authCmd(g *globals, out io.Writer) *cobra.Command {
	c := &cobra.Command{Use: "auth", Short: "Authentication commands"}
	c.AddCommand(loginCmd(g, out), whoamiCmd(g, out), logoutCmd(g, out))
	return c
}
