package cli

import (
	"cmp"
	"encoding/xml"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"text/template"
)

// The local server runs under the service manager of the system, so it
// starts by itself and again after a crash. On macOS it is a launchd agent
// of the user, as `brew services` makes. On Linux only root can use port 80,
// so it is a systemd system socket that opens the port and a service that
// runs the server as the user, as the Ollama installer makes. Installing
// them needs sudo.

const (
	localLabel = "com.razorpay.slashdocs.local" // the launchd agent
	localUnit  = "slashdocs-local"              // the systemd units
)

// localService runs `slashdocs local serve` for the user.
type localService struct {
	serviceManager
	root     bool   // install and uninstall need root
	startsAt string // when the service starts by itself
	logs     string // where the server output goes
}

type serviceManager interface {
	// install writes the service files, then starts the service now and
	// when startsAt tells.
	install(args []string) error
	// uninstall stops the service and removes its files.
	uninstall() error
	// restart makes the server use the binary after an update.
	restart() error
	installed() bool
}

// serviceFor returns the service of this system for the port (0 for the
// default), or nil if the system has no service manager, as in a container
// without systemd.
func serviceFor(port int) *localService {
	switch runtime.GOOS {
	case "darwin":
		return &localService{launchAgent{}, false, "when you log in", localLog()}
	case "linux":
		out, _ := exec.Command("systemctl", "is-system-running").Output()
		if s := strings.TrimSpace(string(out)); s == "running" || s == "degraded" {
			return &localService{systemdSocket{port}, true, "when this computer starts", "journalctl -u " + localUnit}
		}
	}
	return nil
}

func localLog() string { return filepath.Join(configBase(), cliName, "local.log") }

// runService runs a service manager command and includes its output in the
// error.
func runService(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput() //nolint:gosec // G204: launchctl and systemctl with arguments from this file.
	if err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// writeService writes a service file from a template.
func writeService(path string, t *template.Template, data any) error {
	var b strings.Builder
	if err := t.Execute(&b, data); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), configDirPerm); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(b.String()), 0o644) //nolint:gosec // G306: service managers read these files, and they hold no secrets.
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

type launchAgent struct{}

// KeepAlive starts the server again after a crash, but not after a stop.
var launchAgentPlist = template.Must(template.New("plist").Funcs(template.FuncMap{"xml": func(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}}).Parse(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{{xml .Label}}</string>
	<key>ProgramArguments</key>
	<array>
{{- range .Args}}
		<string>{{xml .}}</string>
{{- end}}
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>StandardOutPath</key>
	<string>{{xml .Log}}</string>
	<key>StandardErrorPath</key>
	<string>{{xml .Log}}</string>
</dict>
</plist>
`))

func (launchAgent) path() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", localLabel+".plist")
}

func (launchAgent) target() string { return fmt.Sprintf("gui/%d/%s", os.Getuid(), localLabel) }

func (a launchAgent) install(args []string) error {
	if err := os.MkdirAll(filepath.Dir(localLog()), configDirPerm); err != nil {
		return err
	}
	data := map[string]any{"Label": localLabel, "Args": args, "Log": localLog()}
	if err := writeService(a.path(), launchAgentPlist, data); err != nil {
		return err
	}
	_ = runService("launchctl", "bootout", a.target()) // an agent from an earlier start
	return runService("launchctl", "bootstrap", fmt.Sprintf("gui/%d", os.Getuid()), a.path())
}

func (a launchAgent) uninstall() error {
	return errors.Join(runService("launchctl", "bootout", a.target()), os.Remove(a.path()))
}

func (a launchAgent) restart() error { return runService("launchctl", "kickstart", "-k", a.target()) }

func (a launchAgent) installed() bool { return fileExists(a.path()) }

// systemdService runs the server as the user. systemd starts it at the
// first connection to the socket, with the open socket.
var systemdService = template.Must(template.New("service").Funcs(template.FuncMap{"exec": systemdExec}).Parse(`[Unit]
Description=slashdocs local documents
Requires={{.Unit}}.socket

[Service]
ExecStart={{exec .Args}}
User={{.User}}
Restart=on-failure
RestartSec=3
`))

var systemdSocketUnit = template.Must(template.New("socket").Parse(`[Unit]
Description=slashdocs local documents

[Socket]
ListenStream={{.Addr}}

[Install]
WantedBy=sockets.target
`))

// systemdExec quotes arguments for ExecStart, where $ and % have meanings.
func systemdExec(args []string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "$", "$$", "%", "%%")
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = `"` + r.Replace(a) + `"`
	}
	return strings.Join(quoted, " ")
}

// systemdSocket listens on port, or on the first free default port if it is 0.
type systemdSocket struct{ port int }

// freePort returns the first default port that is free. The socket unit
// must have one port, because systemd opens it before the server starts.
func freePort() int {
	for _, p := range localPorts {
		if l, err := net.Listen("tcp", localAddr(p)); err == nil {
			_ = l.Close()
			return p
		}
	}
	return localPorts[0]
}

func systemdPath(ext string) string { return filepath.Join("/etc/systemd/system", localUnit+ext) }

// install runs as root under sudo, and the server runs as the user of sudo.
func (s systemdSocket) install(args []string) error {
	u, err := user.Lookup(os.Getenv("SUDO_USER"))
	if err != nil || u.Uid == "0" {
		return errors.New("run `slashdocs local start` from your user account, not as root")
	}
	if err := writeService(systemdPath(".service"), systemdService, map[string]any{"Unit": localUnit, "User": u.Username, "Args": args}); err != nil {
		return err
	}
	if err := writeService(systemdPath(".socket"), systemdSocketUnit, map[string]any{"Addr": localAddr(cmp.Or(s.port, freePort()))}); err != nil {
		return err
	}
	return errors.Join(
		runService("systemctl", "daemon-reload"),
		runService("systemctl", "enable", "--now", localUnit+".socket"),
	)
}

func (systemdSocket) uninstall() error {
	return errors.Join(
		runService("systemctl", "disable", "--now", localUnit+".socket", localUnit+".service"),
		os.Remove(systemdPath(".socket")),
		os.Remove(systemdPath(".service")),
		runService("systemctl", "daemon-reload"),
	)
}

// restart stops the server, which runs as this user. systemd starts it
// again at the next connection.
func (systemdSocket) restart() error {
	out, err := exec.Command("systemctl", "show", "--property=MainPID", "--value", localUnit+".service").Output()
	if err != nil {
		return err
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	if pid == 0 {
		return nil // systemd has not started it yet
	}
	return syscall.Kill(pid, syscall.SIGTERM)
}

func (systemdSocket) installed() bool { return fileExists(systemdPath(".socket")) }
