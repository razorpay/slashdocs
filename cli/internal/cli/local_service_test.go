package cli

import (
	"encoding/xml"
	"net"
	"strconv"
	"strings"
	"testing"
	"text/template"
)

func TestLocalOrigins(t *testing.T) {
	if got := localURL(80); got != "http://slashdocs.localhost" {
		t.Errorf("localURL(80) = %q, want no port", got)
	}
	if got := httpOrigin("127.0.0.1", 7070); got != "http://127.0.0.1:7070" {
		t.Errorf("httpOrigin = %q", got)
	}
}

func TestListenLocalUsesTheNextFreePort(t *testing.T) {
	busy, err := net.Listen("tcp", localAddr(0))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = busy.Close() }()
	free, err := net.Listen("tcp", localAddr(0))
	if err != nil {
		t.Fatal(err)
	}
	freePort := tcpPort(t, free.Addr())
	_ = free.Close()

	old := localPorts
	localPorts = []int{tcpPort(t, busy.Addr()), freePort}
	defer func() { localPorts = old }()
	l, err := listenLocal(0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	if got := tcpPort(t, l.Addr()); got != freePort {
		t.Errorf("port = %d, want the free port %d", got, freePort)
	}
}

func TestLoopbackListenerClosesRemoteConnections(t *testing.T) {
	inner, err := net.Listen("tcp", ":0") //nolint:gosec // G102: the test needs a connection from an address that is not loopback.
	if err != nil {
		t.Fatal(err)
	}
	l := loopbackListener{inner}
	defer func() { _ = l.Close() }()
	port := strconv.Itoa(tcpPort(t, inner.Addr()))
	remote := nonLoopbackIP(t)

	accepted := make(chan net.Conn)
	go func() {
		c, err := l.Accept()
		if err == nil {
			accepted <- c
		}
	}()
	other, err := net.Dial("tcp", net.JoinHostPort(remote, port))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = other.Close() }()
	if _, err := other.Read(make([]byte, 1)); err == nil {
		t.Error("a connection from another address stayed open")
	}
	local, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", port))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = local.Close() }()
	c := <-accepted
	if host, _, _ := net.SplitHostPort(c.RemoteAddr().String()); !net.ParseIP(host).IsLoopback() {
		t.Errorf("accepted %s, want only loopback", host)
	}
	_ = c.Close()
}

func tcpPort(t *testing.T, a net.Addr) int {
	t.Helper()
	_, p, err := net.SplitHostPort(a.String())
	port, err2 := strconv.Atoi(p)
	if err != nil || err2 != nil {
		t.Fatalf("address %s has no port", a)
	}
	return port
}

// nonLoopbackIP returns an address of this computer that is not loopback, so
// a connection to it comes from that address.
func nonLoopbackIP(t *testing.T) string {
	t.Helper()
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && n.IP.To4() != nil {
			return n.IP.String()
		}
	}
	t.Skip("no network address other than loopback")
	return ""
}

func TestServiceFiles(t *testing.T) {
	args := []string{"/opt/my apps/slashdocs", "local", "serve", "--dir", `/docs/100% "$HOME"`}
	if got, want := systemdExec(args), `"/opt/my apps/slashdocs" "local" "serve" "--dir" "/docs/100%% \"$$HOME\""`; got != want {
		t.Errorf("systemdExec = %s, want %s", got, want)
	}

	render := func(tmpl *template.Template, data any) string {
		var b strings.Builder
		if err := tmpl.Execute(&b, data); err != nil {
			t.Fatal(err)
		}
		return b.String()
	}
	plist := render(launchAgentPlist, map[string]any{"Label": localLabel, "Args": []string{"/bin/slashdocs", "--dir", "/a&b"}, "Log": "/log"})
	var parsed struct {
		Strings []string `xml:"dict>array>string"`
	}
	if err := xml.Unmarshal([]byte(plist), &parsed); err != nil || strings.Join(parsed.Strings, " ") != "/bin/slashdocs --dir /a&b" {
		t.Errorf("plist arguments = %v, %v\n%s", parsed.Strings, err, plist)
	}

	unit := render(systemdService, map[string]any{"Unit": localUnit, "User": "ada", "Args": []string{"/bin/slashdocs"}})
	for _, want := range []string{"Requires=slashdocs-local.socket", `ExecStart="/bin/slashdocs"`, "User=ada", "Restart=on-failure"} {
		if !strings.Contains(unit, want) {
			t.Errorf("service unit has no %q:\n%s", want, unit)
		}
	}
	if socket := render(systemdSocketUnit, map[string]any{"Addr": localAddr(80)}); !strings.Contains(socket, "ListenStream=127.0.0.1:80") {
		t.Errorf("socket = %s", socket)
	}
}
