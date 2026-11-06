package cli

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"

	"github.com/razorpay/slashdocs/skills"
)

// releaseServer serves version.json for one release of binary, signed by key
// as release signVersion, and counts the downloads of the binary.
type releaseServer struct {
	version, signVersion string
	key                  ed25519.PrivateKey
	downloads            int
}

func (rs *releaseServer) start(t *testing.T, binary []byte) *httptest.Server {
	sum := sha256.Sum256(binary)
	asset := serverAsset{OS: runtime.GOOS, Arch: runtime.GOARCH, URL: "/cli", Size: len(binary)}
	if rs.key != nil {
		asset.Signature = ed25519.Sign(rs.key, signedMessage(rs.signVersion, runtime.GOOS, runtime.GOARCH, sum[:]))
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/version.json":
			_ = json.NewEncoder(w).Encode(serverVersion{Version: rs.version, Assets: []serverAsset{asset}})
		case "/cli":
			rs.downloads++
			_, _ = w.Write(binary)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// setupUpdate makes this test run as CLI version local, trust a new release
// key, and update a temporary executable. It returns the private key and the
// path of the executable.
func setupUpdate(t *testing.T, local string) (ed25519.PrivateKey, string) {
	t.Setenv("HOME", t.TempDir())
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(t.TempDir(), "slashdocs")
	if err := os.WriteFile(exe, []byte("old binary"), 0o600); err != nil {
		t.Fatal(err)
	}
	oldVersion, oldKey, oldExecutable := Version, SigningPublicKey, executable
	Version, SigningPublicKey, executable = local, base64.StdEncoding.EncodeToString(pub), func() (string, error) { return exe, nil }
	t.Cleanup(func() { Version, SigningPublicKey, executable = oldVersion, oldKey, oldExecutable })
	return priv, exe
}

func runUpdate(t *testing.T, srv *httptest.Server, force bool) (bool, error) {
	_, changed, _, err := updateCLI(context.Background(), &Client{Base: srv.URL, HTTP: srv.Client()}, force)
	return changed, err
}

func TestUpdateCLIInstallsSignedNewerRelease(t *testing.T) {
	key, exe := setupUpdate(t, "v1.0.0")
	srv := (&releaseServer{version: "v1.1.0", signVersion: "v1.1.0", key: key}).start(t, []byte("new binary"))

	changed, err := runUpdate(t, srv, false)
	if err != nil || !changed {
		t.Fatalf("updateCLI = (%v, %v), want (true, nil)", changed, err)
	}
	if got := string(readTestFile(t, exe)); got != "new binary" {
		t.Fatalf("executable = %q, want the new binary", got)
	}
}

func TestUpdateCLIRefusesUntrustedBinaries(t *testing.T) {
	_, otherKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, release := range map[string]func(key ed25519.PrivateKey) *releaseServer{
		"unsigned": func(ed25519.PrivateKey) *releaseServer {
			return &releaseServer{version: "v1.1.0"}
		},
		"signed by another key": func(ed25519.PrivateKey) *releaseServer {
			return &releaseServer{version: "v1.1.0", signVersion: "v1.1.0", key: otherKey}
		},
		"signed for another version": func(key ed25519.PrivateKey) *releaseServer {
			return &releaseServer{version: "v9.0.0", signVersion: "v1.1.0", key: key}
		},
	} {
		t.Run(name, func(t *testing.T) {
			key, exe := setupUpdate(t, "v1.0.0")
			changed, err := runUpdate(t, release(key).start(t, []byte("attacker binary")), false)
			if !errors.Is(err, errUnsigned) || changed {
				t.Fatalf("updateCLI = (%v, %v), want (false, errUnsigned)", changed, err)
			}
			if got := string(readTestFile(t, exe)); got != "old binary" {
				t.Fatalf("executable = %q, want the old binary", got)
			}
		})
	}
}

func TestUpdateCLIWithoutSigningPublicKeyInstallsNothing(t *testing.T) {
	key, exe := setupUpdate(t, "v1.0.0")
	SigningPublicKey = ""
	rs := &releaseServer{version: "v1.1.0", signVersion: "v1.1.0", key: key}

	changed, err := runUpdate(t, rs.start(t, []byte("new binary")), false)
	if !errors.Is(err, errNoSigningPublicKey) || changed || rs.downloads != 0 {
		t.Fatalf("updateCLI = (%v, %v) with %d downloads, want errNoSigningPublicKey and no download", changed, err, rs.downloads)
	}
	if got := string(readTestFile(t, exe)); got != "old binary" {
		t.Fatalf("executable = %q, want the old binary", got)
	}
}

func TestAutoUpdateWithoutSigningPublicKeyMakesNoRequest(t *testing.T) {
	setupUpdate(t, "v1.0.0")
	SigningPublicKey = ""
	t.Setenv("SLASHDOCS_DISABLE_AUTO_UPDATE", "")
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1) }))
	t.Cleanup(srv.Close)

	maybeAutoUpdate(&globals{}, &Client{Base: srv.URL})
	if n := requests.Load(); n != 0 {
		t.Fatalf("auto-update made %d requests, want none", n)
	}
}

func TestUpdateCLINeverDowngrades(t *testing.T) {
	for _, force := range []bool{false, true} {
		key, _ := setupUpdate(t, "v1.1.0")
		rs := &releaseServer{version: "v1.0.0", signVersion: "v1.0.0", key: key}
		changed, err := runUpdate(t, rs.start(t, []byte("old release")), force)
		if err != nil || changed || rs.downloads != 0 {
			t.Fatalf("force=%v: updateCLI = (%v, %v) with %d downloads, want no update", force, changed, err, rs.downloads)
		}
	}
}

func TestUpdateCLIInstallsEmbeddedSkill(t *testing.T) {
	setupUpdate(t, "v1.0.0")
	home := os.Getenv("HOME")
	srv := (&releaseServer{version: "v1.0.0"}).start(t, nil)

	_, changed, skillRefreshed, err := updateCLI(context.Background(), &Client{Base: srv.URL, HTTP: srv.Client()}, false)
	if err != nil || changed || !skillRefreshed {
		t.Fatalf("updateCLI = (%v, %v, %v), want only the skill refreshed", changed, skillRefreshed, err)
	}
	for _, p := range []string{
		filepath.Join(home, ".agents", "skills", "slashdocs", "SKILL.md"),
		filepath.Join(home, ".claude", "skills", "slashdocs", "SKILL.md"),
	} {
		if got := readTestFile(t, p); string(got) != string(skills.Slashdocs) {
			t.Fatalf("%s is not the embedded skill", p)
		}
	}
}
