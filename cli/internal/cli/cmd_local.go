package cli

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
	"golang.org/x/term"

	docrender "github.com/razorpay/slashdocs/internal/render"
)

// The local daemon serves a folder of HTML documents on the loopback
// interface with the slashdocs documents app and its comments. It has no
// accounts, sharing, or versions: the files in the folder are the documents,
// and their comments are files next to them (see local_comments.go).

// Browsers and the macOS resolver send every *.localhost name to the loopback
// address, so this name needs no hosts entry or DNS setup.
const localHost = "slashdocs.localhost"

// localPorts are the ports that the server tries, in order, without --port.
// Port 80 gives a URL without a port. macOS lets a normal user use it. On
// Linux, systemd opens it for the server (see local_service.go).
var localPorts = []int{80, 7070}

func candidatePorts(port int) []int {
	if port != 0 {
		return []int{port}
	}
	return localPorts
}

// httpOrigin leaves out the default port, as browsers do.
func httpOrigin(host string, port int) string {
	if port == 80 {
		return "http://" + host
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(port))
}

func localURL(port int) string { return httpOrigin(localHost, port) }

func localAddr(port int) string { return net.JoinHostPort("127.0.0.1", strconv.Itoa(port)) }

// localApp is the `slashdocs local` web app, from `vite build --mode cli` in
// frontend/. Builds without it serve an error page.
//
//go:embed all:local_dist
var localApp embed.FS

// localSandbox lets a raw document run scripts and open links, but keeps it
// in an opaque origin.
const localSandbox = "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads"

type localInfo struct {
	URL     string `json:"url"`
	Port    int    `json:"port"`
	Dir     string `json:"dir"`
	PID     int    `json:"pid"`
	Version string `json:"version"`
}

// localEntry is a folder or a document. A folder has its entries, but not the
// entries of its subfolders.
type localEntry struct {
	Type     string       `json:"type"`
	Path     string       `json:"path"`
	Title    string       `json:"title"`
	Modified time.Time    `json:"modified"`
	Dir      string       `json:"dir,omitzero"`
	Entries  []localEntry `json:"entries,omitzero"`
	Raw      string       `json:"raw,omitzero"`
	Version  string       `json:"version,omitzero"`
}

// localOptions are the flags of `slashdocs local` and its commands.
type localOptions struct {
	port int
	dir  string
}

func localCmd(g *globals, out io.Writer) *cobra.Command {
	o := &localOptions{}
	c := &cobra.Command{Use: "local", Short: "Serve a folder of HTML documents on this machine", Long: "Serve a folder of HTML documents on this machine with the slashdocs viewer and comments.\n\nPut .html files (and folders of them) in the documents folder, then open the local URL. The server listens on this machine only. `start` runs it now and when you log in (macOS) or when the computer starts (Linux, with sudo)."}
	c.PersistentFlags().IntVar(&o.port, "port", 0, "local port (default 80, or 7070 if 80 is not available)")
	c.AddCommand(o.startCmd(g, out), o.stopCmd(g, out), o.statusCmd(g, out), o.serveCmd())
	return c
}

func (o *localOptions) dirFlag(cmd *cobra.Command) *cobra.Command {
	cmd.Flags().StringVar(&o.dir, "dir", "", "documents folder (default ~/slashdocs)")
	return cmd
}

// serveArgs is the command of the service. It gives only the flags that the
// user gave, so the defaults of a later release apply.
func (o *localOptions) serveArgs(cmd *cobra.Command) ([]string, error) {
	exe, err := executable()
	if err != nil {
		return nil, err
	}
	args := []string{exe, "local", "serve"}
	if cmd.Flags().Changed("dir") {
		abs, err := filepath.Abs(o.dir)
		if err != nil {
			return nil, err
		}
		args = append(args, "--dir", abs)
	}
	if o.port != 0 {
		args = append(args, "--port", strconv.Itoa(o.port))
	}
	return args, nil
}

func (o *localOptions) serveCmd() *cobra.Command {
	return o.dirFlag(&cobra.Command{Use: "serve", Short: "Run the local server in the foreground", Args: exactArgs(0), RunE: func(cmd *cobra.Command, _ []string) error {
		ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		return serveLocal(ctx, o.dir, o.port)
	}})
}

func (o *localOptions) startCmd(g *globals, out io.Writer) *cobra.Command {
	return o.dirFlag(&cobra.Command{Use: "start", Short: "Start the local server now and by itself later", Args: exactArgs(0), RunE: func(cmd *cobra.Command, _ []string) error {
		return o.start(cmd, g, out)
	}})
}

// start starts the server under the service manager of the system, if it
// is not running.
func (o *localOptions) start(cmd *cobra.Command, g *globals, out io.Writer) error {
	if info, err := findLocal(o.port); err == nil {
		return confirm(out, g, "slashdocs local is already running at "+info.URL+" (serving "+info.Dir+")")
	}
	if info, err := findLocal(0); err == nil && o.port != 0 {
		return fmt.Errorf("slashdocs local is already running at %s: to change its port, run `slashdocs local stop` first", info.URL)
	}
	svc := serviceFor(o.port)
	if svc != nil && svc.root && os.Geteuid() != 0 {
		return asRoot(cmd, out)
	}
	args, err := o.serveArgs(cmd)
	if err != nil {
		return err
	}
	logs, note := localLog(), " It does not start again by itself, because this system has no service manager."
	if svc != nil {
		logs, note = svc.logs, " It starts again "+svc.startsAt+"."
		err = svc.install(args)
	} else {
		err = spawnLocal(args)
	}
	if err != nil {
		return err
	}
	info, err := waitLocal(o.port)
	if err != nil {
		return fmt.Errorf("slashdocs local did not start, see %s", logs)
	}
	return confirm(out, g, "slashdocs local is running at "+info.URL+" (serving "+info.Dir+")."+note)
}

func (o *localOptions) statusCmd(g *globals, out io.Writer) *cobra.Command {
	return &cobra.Command{Use: "status", Short: "Show the local server status", Args: exactArgs(0), RunE: func(*cobra.Command, []string) error {
		info, err := findLocal(o.port)
		if err != nil {
			return errors.New("slashdocs local is not running")
		}
		var autostart string
		if svc := serviceFor(o.port); svc != nil && svc.installed() {
			autostart = svc.startsAt
		}
		if g.json {
			b, _ := json.Marshal(struct {
				localInfo
				Autostart string `json:"autostart"`
			}{info, autostart})
			return render(out, g, b)
		}
		text := fmt.Sprintf("slashdocs local is running at %s (serving %s, pid %d).", info.URL, info.Dir, info.PID)
		if autostart != "" {
			text += " It starts " + autostart + "."
		}
		return message(out, g, text)
	}}
}

func (o *localOptions) stopCmd(g *globals, out io.Writer) *cobra.Command {
	return &cobra.Command{Use: "stop", Short: "Stop the local server, also later", Args: exactArgs(0), RunE: func(cmd *cobra.Command, _ []string) error {
		if svc := serviceFor(o.port); svc != nil && svc.installed() {
			if svc.root && os.Geteuid() != 0 {
				return asRoot(cmd, out)
			}
			if err := svc.uninstall(); err != nil {
				return err
			}
			return confirm(out, g, "Stopped slashdocs local. It does not start again by itself.")
		}
		info, err := findLocal(o.port)
		if err != nil {
			return message(out, g, "slashdocs local is not running.")
		}
		p, _ := os.FindProcess(info.PID)
		if err := p.Signal(syscall.SIGTERM); err != nil {
			return fmt.Errorf("stop slashdocs local (pid %d): %w", info.PID, err)
		}
		return confirm(out, g, "Stopped slashdocs local.")
	}}
}

// asRoot runs the command again with sudo, which asks for the password. It
// gives the flags that the user set, and the child writes to out.
func asRoot(cmd *cobra.Command, out io.Writer) error {
	exe, err := executable()
	if err != nil {
		return err
	}
	args := append([]string{"--", exe}, strings.Fields(cmd.CommandPath())[1:]...)
	cmd.Flags().Visit(func(f *pflag.Flag) { args = append(args, "--"+f.Name+"="+f.Value.String()) })
	sudo := exec.Command("sudo", args...) //nolint:gosec // G204: this binary with the arguments of this command.
	sudo.Stdin, sudo.Stdout, sudo.Stderr = os.Stdin, out, os.Stderr
	err = sudo.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		os.Exit(exit.ExitCode()) // sudo or the command told the user why
	}
	return err
}

// useLocal points a command with --local at slashdocs local, and starts it
// first if it is not running.
func useLocal(g *globals) error {
	if g.server != "" {
		return usageError{errors.New("use --local or --server, not both")}
	}
	info, err := findLocal(0)
	if err != nil {
		info, err = autoStartLocal()
	}
	g.server = info.URL
	return err
}

// autoStartLocal does `slashdocs local start` with the default folder and
// port. It writes to stderr, so the output of the command stays clean.
func autoStartLocal() (localInfo, error) {
	svc := serviceFor(0)
	switch {
	case svc != nil && svc.installed():
		return localInfo{}, errors.New("slashdocs local does not answer on port 80 or 7070: if you started it with --port, use --server slashdocs.localhost:<port>")
	case svc != nil && svc.root && os.Geteuid() != 0 && !term.IsTerminal(int(os.Stdin.Fd())):
		return localInfo{}, errors.New("slashdocs local is not running: to start it, run `slashdocs local start` in a terminal")
	}
	start := NewRoot(os.Stderr)
	start.SetArgs([]string{"local", "start"})
	if err := start.Execute(); err != nil {
		return localInfo{}, err
	}
	return findLocal(0)
}

// restartLocal makes a running server use the binary after an update.
func restartLocal() {
	if svc := serviceFor(0); svc != nil && svc.installed() {
		_ = svc.restart()
	}
}

// spawnLocal runs the server in a new session, so it continues after the
// terminal closes. It is for systems without a service manager.
func spawnLocal(args []string) error {
	if err := os.MkdirAll(filepath.Dir(localLog()), configDirPerm); err != nil {
		return err
	}
	log, err := os.OpenFile(localLog(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, configFilePerm)
	if err != nil {
		return err
	}
	defer func() { _ = log.Close() }()
	cmd := exec.Command(args[0], args[1:]...) //nolint:gosec // G204: re-runs this binary with its own flags.
	cmd.Stdout, cmd.Stderr = log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// waitLocal waits until a server answers.
func waitLocal(port int) (info localInfo, err error) {
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if info, err = findLocal(port); err == nil {
			return info, nil
		}
	}
	return info, err
}

// findLocal returns the server on the first candidate port that answers.
func findLocal(port int) (info localInfo, err error) {
	for _, p := range candidatePorts(port) {
		if info, err = getLocalInfo(p); err == nil {
			return info, nil
		}
	}
	return info, err
}

// getLocalInfo asks the IP address, because the Go resolver on Linux does not
// resolve *.localhost names.
func getLocalInfo(port int) (localInfo, error) {
	var info localInfo
	c := http.Client{Timeout: time.Second}
	resp, err := c.Get("http://" + localAddr(port) + "/_/info")
	if err != nil {
		return info, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return info, errors.New(resp.Status)
	}
	return info, json.NewDecoder(resp.Body).Decode(&info)
}

func serveLocal(ctx context.Context, dir string, port int) error {
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		dir = filepath.Join(home, "slashdocs")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(abs, configDirPerm); err != nil {
		return err
	}
	root, err := os.OpenRoot(abs)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	l, err := listenLocal(port)
	if err != nil {
		return err
	}
	_, p, _ := net.SplitHostPort(l.Addr().String())
	port, _ = strconv.Atoi(p)
	info := localInfo{URL: localURL(port), Port: port, Dir: abs, PID: os.Getpid(), Version: Version}
	srv := &http.Server{Handler: localHandler(root, info, currentLocalPrincipal()), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		_ = srv.Shutdown(context.WithoutCancel(ctx))
	}()
	fmt.Fprintf(os.Stderr, "slashdocs local: serving %s at %s\n", abs, info.URL)
	if err := srv.Serve(l); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// listenLocal returns the socket that systemd opened for this server, or
// listens on the first candidate port that is free.
func listenLocal(port int) (net.Listener, error) {
	if os.Getenv("LISTEN_PID") == strconv.Itoa(os.Getpid()) && os.Getenv("LISTEN_FDS") == "1" {
		f := os.NewFile(3, "systemd socket")
		defer func() { _ = f.Close() }()
		return net.FileListener(f)
	}
	var errs []error
	for _, p := range candidatePorts(port) {
		l, err := listenLoopback(p)
		if err == nil {
			return l, nil
		}
		errs = append(errs, err)
	}
	return nil, errors.Join(errs...)
}

// listenLoopback listens on the loopback address. macOS lets a normal user
// use a port below 1024 only on all addresses. Then the server listens on all
// addresses, and closes the connections from other computers.
func listenLoopback(port int) (net.Listener, error) {
	l, err := net.Listen("tcp", localAddr(port))
	if errors.Is(err, syscall.EACCES) {
		l, err = net.Listen("tcp", ":"+strconv.Itoa(port))
	}
	if err != nil {
		return nil, err
	}
	return loopbackListener{l}, nil
}

type loopbackListener struct{ net.Listener }

func (l loopbackListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if a, ok := c.RemoteAddr().(*net.TCPAddr); ok && a.IP.IsLoopback() {
			return c, nil
		}
		_ = c.Close()
	}
}

// localHandler serves the app on localHost and documents on the loopback
// address. The two origins keep document scripts away from the app and its
// API, as the separate render origin of the server does.
func localHandler(root *os.Root, info localInfo, me localPrincipal) http.Handler {
	docs := root.FS()
	app, _ := fs.Sub(localApp, "local_dist")
	renderOrigin, _ := url.Parse(httpOrigin("127.0.0.1", info.Port))
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	// A render token gives a frame of the app one document. Without tokens,
	// a document could read the other documents from the render origin.
	token := func(doc string) string {
		m := hmac.New(sha256.New, key)
		m.Write([]byte(doc))
		return hex.EncodeToString(m.Sum(nil))
	}
	writeInfo := func(w http.ResponseWriter, _ *http.Request) { writeLocalJSON(w, info) }

	files := http.StripPrefix("/_/raw", http.FileServerFS(docs))
	site := http.NewServeMux()
	site.Handle("GET /_/", http.StripPrefix("/_", http.FileServerFS(app)))
	site.HandleFunc("GET /_/raw/{path...}", func(w http.ResponseWriter, r *http.Request) {
		if isHidden(cleanLocal(r.PathValue("path"))) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Security-Policy", "sandbox "+localSandbox)
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	})
	site.HandleFunc("GET /_/info", writeInfo)
	site.HandleFunc("GET /_/api/entry/{path...}", func(w http.ResponseWriter, r *http.Request) {
		e, err := getLocalEntry(docs, cleanLocal(r.PathValue("path")))
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		if e.Type == "folder" {
			e.Dir = filepath.Join(info.Dir, e.Path)
		}
		writeLocalJSON(w, e)
	})
	site.HandleFunc("GET /v1/me", func(w http.ResponseWriter, _ *http.Request) {
		writeLocalJSON(w, map[string]localPrincipal{"principal": me})
	})
	site.HandleFunc("POST /v1/documents/{id}/versions/{version}/render-token", func(w http.ResponseWriter, r *http.Request) {
		doc := cleanLocal(r.PathValue("id"))
		if !isLocalDoc(docs, doc) {
			writeLocalError(w, errLocalDocNotFound)
			return
		}
		u := *renderOrigin
		u.Path = "/_/render/" + doc
		// The version changes the URL, so the frame shows each change.
		u.RawQuery = url.Values{"v": {r.PathValue("version")}, "token": {token(doc)}}.Encode()
		writeLocalJSON(w, map[string]string{"token": token(doc), "url": u.String()})
	})
	store := &localDocs{root: root, me: me, url: info.URL}
	store.registerDocuments(site)
	store.registerComments(site)
	for _, method := range []string{"GET", "POST", "PUT", "PATCH", "DELETE"} {
		site.HandleFunc(method+" /v1/", func(w http.ResponseWriter, _ *http.Request) {
			writeLocalError(w, localError{http.StatusNotImplemented, "slashdocs local does not support this command"})
		})
	}
	// The CLI prints document links of the server.
	site.HandleFunc("GET /app/d/{id}", func(w http.ResponseWriter, r *http.Request) {
		//nolint:gosec // G710: docURL is always on the origin of the app.
		http.Redirect(w, r, store.docURL(cleanLocal(r.PathValue("id")), r.URL.Query(), ""), http.StatusFound)
	})
	// Folders and documents open in the app. Other files, such as images,
	// open as they are.
	site.HandleFunc("GET /{path...}", func(w http.ResponseWriter, r *http.Request) {
		p := cleanLocal(r.PathValue("path"))
		if st, err := fs.Stat(docs, first(p, ".")); err == nil && !st.IsDir() && !isHTML(p) {
			//nolint:gosec // G710: rawURL is always a path on this server.
			http.Redirect(w, r, rawURL(p), http.StatusFound)
			return
		}
		page, err := fs.ReadFile(app, "local.html")
		if err != nil {
			http.Error(w, "this slashdocs CLI was built without the local app: run `make cli`", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(page)
	})

	renders := localRenders(docs, info, token)
	protected := http.NewCrossOriginProtection().Handler(site)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			host = r.Host
		}
		switch {
		case host == localHost:
			protected.ServeHTTP(w, r)
		// Other host names are refused, so a DNS rebinding page cannot read
		// local documents through the browser.
		case isLoopbackHost(host):
			renders.ServeHTTP(w, r)
		default:
			http.Error(w, "slashdocs local accepts only loopback host names", http.StatusForbidden)
		}
	})
}

// localRenders serves documents on the loopback address, to the frames of
// the app that have a render token.
func localRenders(docs fs.FS, info localInfo, token func(doc string) string) *http.ServeMux {
	renders := http.NewServeMux()
	renders.HandleFunc("GET /_/render/{path...}", func(w http.ResponseWriter, r *http.Request) {
		doc := cleanLocal(r.PathValue("path"))
		if !isLocalDoc(docs, doc) || !hmac.Equal([]byte(r.URL.Query().Get("token")), []byte(token(doc))) {
			http.NotFound(w, r)
			return
		}
		b, err := fs.ReadFile(docs, doc)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Security-Policy", docrender.CSP(info.URL))
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		//nolint:gosec // G705: the document is untrusted by design. It runs in a sandboxed frame on this render origin.
		_, _ = w.Write(docrender.Wrap(b, info.URL))
	})
	renders.HandleFunc("GET /_/info", func(w http.ResponseWriter, _ *http.Request) { writeLocalJSON(w, info) })
	renders.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		//nolint:gosec // G710: the redirect stays on this server.
		http.Redirect(w, r, info.URL+r.URL.RequestURI(), http.StatusFound)
	})
	return renders
}

func writeLocalJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// cleanLocal turns a URL path into a path relative to the documents folder.
// The root folder is "".
func cleanLocal(p string) string { return path.Clean("/" + p)[1:] }

func rawURL(p string) string { return (&url.URL{Path: "/_/raw/" + p}).EscapedPath() }

// getLocalEntry returns a folder with its entries, or a document.
func getLocalEntry(docs fs.FS, p string) (localEntry, error) {
	if isHidden(p) {
		return localEntry{}, fs.ErrNotExist
	}
	st, err := fs.Stat(docs, first(p, "."))
	if err != nil {
		return localEntry{}, err
	}
	e := newLocalEntry(docs, p, st)
	switch {
	case st.IsDir():
		e.Entries, err = listLocal(docs, p)
	case isHTML(p):
		var b []byte
		b, err = fs.ReadFile(docs, p)
		e.Raw, e.Version = rawURL(p), localVersion(b)
	default:
		err = fs.ErrNotExist
	}
	return e, err
}

func newLocalEntry(docs fs.FS, p string, st fs.FileInfo) localEntry {
	if p == "" {
		return localEntry{Type: "folder", Title: "Documents", Modified: st.ModTime()}
	}
	if st.IsDir() {
		return localEntry{Type: "folder", Path: p, Title: path.Base(p), Modified: st.ModTime()}
	}
	return localEntry{Type: "document", Path: p, Title: docTitle(docs, p), Modified: st.ModTime()}
}

// listLocal returns the folders, then the HTML documents of dir, each group
// with the most recent change first. Hidden files and other assets are not
// listed.
func listLocal(docs fs.FS, dir string) ([]localEntry, error) {
	des, err := fs.ReadDir(docs, first(dir, "."))
	if err != nil {
		return nil, err
	}
	entries := []localEntry{}
	for _, de := range des {
		p := path.Join(dir, de.Name())
		if strings.HasPrefix(de.Name(), ".") || !de.IsDir() && !isHTML(p) {
			continue
		}
		if st, err := de.Info(); err == nil {
			entries = append(entries, newLocalEntry(docs, p, st))
		}
	}
	slices.SortFunc(entries, func(a, b localEntry) int {
		if a.Type != b.Type {
			return strings.Compare(b.Type, a.Type) // "folder" before "document"
		}
		return b.Modified.Compare(a.Modified)
	})
	return entries, nil
}

var titleRE = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)

// docTitle returns the title in the state of a document, the <title> from
// the start of the HTML, or the file name without its extension.
func docTitle(docs fs.FS, p string) string {
	if t, _ := readLocalState(docs, p); t.Title != "" {
		return t.Title
	}
	if f, err := docs.Open(p); err == nil {
		defer func() { _ = f.Close() }()
		head := make([]byte, 16<<10)
		n, _ := io.ReadFull(f, head)
		if m := titleRE.FindSubmatch(head[:n]); m != nil {
			if t := strings.Join(strings.Fields(html.UnescapeString(string(m[1]))), " "); t != "" {
				return t
			}
		}
	}
	return strings.TrimSuffix(path.Base(p), path.Ext(p))
}

func isHTML(p string) bool {
	ext := strings.ToLower(path.Ext(p))
	return ext == ".html" || ext == ".htm"
}
