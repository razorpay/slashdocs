package cli

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/mod/semver"

	"github.com/razorpay/slashdocs/skills"
)

var (
	errNoSigningPublicKey = errors.New("this CLI build has no signing public key, so it installs no updates")
	errUnsigned           = errors.New("the CLI download does not have a valid release signature")
)

// signingPublicKey decodes SigningPublicKey. The CLI installs only binaries
// that the matching private key signs, so a server, even a malicious one,
// cannot make the CLI run code that the maintainers did not release.
func signingPublicKey() (ed25519.PublicKey, error) {
	k, err := base64.StdEncoding.DecodeString(SigningPublicKey)
	if err != nil || len(k) != ed25519.PublicKeySize {
		return nil, errNoSigningPublicKey
	}
	return k, nil
}

// executable is the binary that an update replaces. Tests replace it.
var executable = os.Executable

type serverVersion struct {
	Version string        `json:"version"`
	Commit  string        `json:"commit"`
	Assets  []serverAsset `json:"assets"`
}

type serverAsset struct {
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	URL       string `json:"url"`
	Size      int    `json:"size"`
	Signature []byte `json:"signature"`
}

// signedMessage is the text that the release build signs for each CLI
// binary (see the Dockerfile). It binds the binary to its version and
// platform, so a server cannot give an old signed binary a new version.
func signedMessage(version, goos, goarch string, sum []byte) []byte {
	return fmt.Appendf(nil, "slashdocs %s %s/%s %x", version, goos, goarch, sum)
}

func maybeNudgeUpdate(g *globals, c *Client) { maybeAutoUpdate(g, c) }

func maybeAutoUpdate(g *globals, c *Client) {
	// A build without a signing public key, such as `make cli`, can never
	// install an update, so it does not look for one.
	if _, err := signingPublicKey(); err != nil || Version == "" || env("SLASHDOCS_DISABLE_AUTO_UPDATE") != "" {
		return
	}
	// This check is best-effort housekeeping after a command: use the
	// short-timeout client and bound the whole operation so a slow server
	// never noticeably delays the CLI. Failures stay silent unless --verbose.
	c = &Client{Base: c.Base, Token: c.Token, HTTP: updateHTTPClient}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if g.verbose {
		fmt.Fprintf(os.Stderr, "checking for slashdocs update at %s/version.json\n", c.Base)
	}
	v, binaryChanged, skillRefreshed, err := updateCLI(ctx, c, false)
	if g.verbose && err == nil && !binaryChanged && !skillRefreshed {
		fmt.Fprintf(os.Stderr, "slashdocs is up to date or no release is available (local=%s, server=%s).\n", Version, v.Version)
	}
	if err != nil {
		printManualUpdate(v, err, g.verbose)
		return
	}
	if binaryChanged {
		fmt.Fprintf(os.Stderr, "slashdocs updated to %s; the next command will use the new CLI.\n", v.Version)
	} else if skillRefreshed && g.verbose {
		fmt.Fprintln(os.Stderr, "slashdocs skill refreshed.")
	}
}

func updateCLI(ctx context.Context, c *Client, force bool) (serverVersion, bool, bool, error) {
	paths, skillErr := installBundledSkill()
	skillRefreshed := len(paths) > 0
	v, ok := fetchServerVersion(ctx, c)
	if skillErr != nil {
		return v, false, false, skillErr
	}
	if !ok || v.Version == "" {
		return v, false, skillRefreshed, nil
	}
	// Never go back to an older version: an old release keeps its valid
	// signature, and also its old bugs.
	if cmp := semver.Compare(v.Version, Version); cmp < 0 || cmp == 0 && !force {
		return v, false, skillRefreshed, nil
	}
	asset, ok := v.asset(runtime.GOOS, runtime.GOARCH)
	if !ok || strings.TrimSpace(asset.URL) == "" {
		return v, false, skillRefreshed, fmt.Errorf("no CLI asset for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	if err := installCLIUpdate(ctx, c, v.Version, asset); err != nil {
		return v, false, skillRefreshed, err
	}
	restartLocal()
	return v, true, skillRefreshed, nil
}

// printManualUpdate does not suggest a `curl | sh` from the server: the
// server can be the attacker, and agents follow such suggestions.
func printManualUpdate(v serverVersion, err error, verbose bool) {
	if verbose {
		fmt.Fprintf(os.Stderr, "slashdocs auto-update failed: %v\n", err)
	}
	if v.Version != "" {
		fmt.Fprintf(os.Stderr, "slashdocs %s is available, but auto-update failed. Update with: slashdocs update\n", v.Version)
	}
}

func fetchServerVersion(ctx context.Context, c *Client) (serverVersion, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+"/version.json", nil)
	if err != nil {
		return serverVersion{}, false
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return serverVersion{}, false
	}
	defer func() {
		_ = res.Body.Close()
	}()
	if res.StatusCode != http.StatusOK {
		return serverVersion{}, false
	}
	var v serverVersion
	if err := json.NewDecoder(res.Body).Decode(&v); err != nil {
		return serverVersion{}, false
	}
	return v, true
}

func (v serverVersion) asset(goos, goarch string) (serverAsset, bool) {
	for _, a := range v.Assets {
		if a.OS == goos && a.Arch == goarch {
			return a, true
		}
	}
	return serverAsset{}, false
}

// installBundledSkill writes the skill embedded in this binary to each agent
// skill directory. The skill does not come from the server, because a skill
// is an instruction to the user's agents.
func installBundledSkill() ([]string, error) {
	dirs := bundledSkillDirs()
	if len(dirs) == 0 {
		return nil, fmt.Errorf("could not determine home directory for skill install")
	}
	installed := make([]string, 0, len(dirs))
	for _, dir := range dirs {
		//nolint:gosec // G301: agent skill directories contain public documentation and are intentionally traversable.
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
		p := filepath.Join(dir, "SKILL.md")
		//nolint:gosec // G306: bundled SKILL.md is public documentation, not user data or credentials.
		if err := os.WriteFile(p, skills.Slashdocs, 0o644); err != nil {
			return nil, err
		}
		installed = append(installed, p)
	}
	return installed, nil
}

func bundledSkillDirs() []string {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return nil
	}
	roots := skillRoots(home)
	for i, root := range roots {
		roots[i] = filepath.Join(root, cliName)
	}
	return roots
}

func skillRoots(home string) []string {
	return []string{filepath.Join(home, ".agents", "skills"), filepath.Join(home, ".claude", "skills")}
}

func installCLIUpdate(ctx context.Context, c *Client, version string, asset serverAsset) error {
	key, err := signingPublicKey()
	if err != nil {
		return err
	}
	exe, err := executable()
	if err != nil {
		return err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return err
	}
	url := strings.TrimSpace(asset.URL)
	if strings.HasPrefix(url, "/") {
		url = c.Base + url
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer func() {
		_ = res.Body.Close()
	}()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned HTTP %d", res.StatusCode)
	}
	dir := filepath.Dir(exe)
	tmp, err := os.CreateTemp(dir, ".slashdocs-update-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		_ = os.Remove(tmpName)
	}()
	h := sha256.New()
	written, err := io.Copy(io.MultiWriter(tmp, h), res.Body)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if asset.Size > 0 && int(written) != asset.Size {
		return fmt.Errorf("download size mismatch: got %d, want %d", written, asset.Size)
	}
	if !ed25519.Verify(key, signedMessage(version, asset.OS, asset.Arch, h.Sum(nil)), asset.Signature) {
		return errUnsigned
	}
	//nolint:gosec // G302: the signed CLI follows the installer's conventional world-executable mode.
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return err
	}
	return os.Rename(tmpName, exe)
}
