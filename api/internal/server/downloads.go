package server

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"net/http"
	"path"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/skills"
)

// BuildVersion and BuildCommit are set with -ldflags in release builds.
var (
	BuildVersion = "dev"
	BuildCommit  = ""
)

// download_dist holds the CLI binaries and, in release builds, a .sig file
// for each binary. See the Dockerfile for the signed message.
//
//go:embed download_dist/*
var downloadDist embed.FS

type cliAsset struct {
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	URL       string `json:"url"`
	SHA256    string `json:"sha256,omitempty"`
	Size      int    `json:"size,omitempty"`
	Signature []byte `json:"signature,omitempty"`
}

// versionResponse is the payload of GET /version.json.
type versionResponse struct {
	Version string     `json:"version"`
	Commit  string     `json:"commit"`
	Install string     `json:"install"`
	Assets  []cliAsset `json:"assets"`
}

var cliPlatforms = []struct{ os, arch string }{
	{"darwin", "arm64"},
	{"darwin", "amd64"},
	{"linux", "arm64"},
	{"linux", "amd64"},
}

func cliAssetName(goos, goarch string) string { return "slashdocs-" + goos + "-" + goarch }

func embeddedCLIAsset(goos, goarch string) ([]byte, bool) {
	return embeddedDownload(cliAssetName(goos, goarch))
}

func embeddedDownload(name string) ([]byte, bool) {
	b, err := downloadDist.ReadFile(path.Join("download_dist", name))
	return b, err == nil && len(b) > 0
}

var cachedCLIAssets = sync.OnceValue(func() []cliAsset {
	assets := make([]cliAsset, 0, len(cliPlatforms))
	for _, p := range cliPlatforms {
		asset := cliAsset{OS: p.os, Arch: p.arch, URL: "/cli/" + p.os + "/" + p.arch}
		if b, ok := embeddedCLIAsset(p.os, p.arch); ok {
			sum := sha256.Sum256(b)
			asset.SHA256 = hex.EncodeToString(sum[:])
			asset.Size = len(b)
		}
		asset.Signature, _ = embeddedDownload(cliAssetName(p.os, p.arch) + ".sig")
		assets = append(assets, asset)
	}
	return assets
})

func (h handlers) versionJSON(c *gin.Context) {
	c.JSON(http.StatusOK, versionResponse{Version: releaseVersion(), Commit: releaseCommit(), Install: "/install.sh", Assets: cachedCLIAssets()})
}

func (h handlers) downloadSkill(c *gin.Context) {
	// CLIs released before the rename from aidocs still fetch the skill by
	// its old name. They get the current skill.
	name := strings.TrimSpace(c.Param("name"))
	if name != "slashdocs" && name != "aidocs" {
		c.JSON(http.StatusNotFound, errorResponse("not_found", "skill is not available", nil))
		return
	}
	c.Header("Content-Disposition", `attachment; filename="SKILL.md"`)
	c.Data(http.StatusOK, "text/markdown; charset=utf-8", skills.Slashdocs)
}

func (h handlers) downloadCLI(c *gin.Context) {
	goos, goarch := c.Param("os"), c.Param("arch")
	if !validCLIPlatform(goos, goarch) {
		c.JSON(http.StatusNotFound, errorResponse("not_found", "unsupported platform", nil))
		return
	}
	b, ok := embeddedCLIAsset(goos, goarch)
	if !ok {
		c.JSON(http.StatusNotFound, errorResponse("not_found", "cli binary is not available in this build", nil))
		return
	}
	name := cliAssetName(goos, goarch)
	c.Header("Content-Disposition", `attachment; filename="`+name+`"`)
	c.Data(http.StatusOK, "application/octet-stream", b)
}

func validCLIPlatform(goos, goarch string) bool {
	for _, p := range cliPlatforms {
		if p.os == goos && p.arch == goarch {
			return true
		}
	}
	return false
}

func (h handlers) installScript(c *gin.Context) {
	base, ok := h.installBase(c)
	if !ok {
		c.Data(http.StatusInternalServerError, "text/plain; charset=utf-8", []byte("slashdocs server is missing APP_ORIGIN; cannot generate installer\n"))
		return
	}
	c.Data(http.StatusOK, "text/x-shellscript; charset=utf-8", []byte(strings.ReplaceAll(installScriptTemplate, "__BASE_URL__", base)))
}

func (h handlers) installBase(c *gin.Context) (string, bool) {
	if base, ok := canonicalHTTPOrigin(h.deps.appOrigin); ok {
		return base, true
	}
	// Tests and local development may not configure APP_ORIGIN. Keep that path
	// usable, but do not derive public installer URLs from proxy-controlled
	// forwarding headers or arbitrary non-local Host values.
	if isLocalHost(c.Request.Host) {
		proto := "https"
		if c.Request.TLS == nil {
			proto = "http"
		}
		return proto + "://" + sanitizeHost(c.Request.Host), true
	}
	return "", false
}

func releaseVersion() string {
	if BuildVersion != "" {
		return BuildVersion
	}
	return "dev"
}

func releaseCommit() string {
	if BuildCommit != "" {
		return BuildCommit
	}
	return ""
}

const installScriptTemplate = `#!/bin/sh
# POSIX sh: users run "curl <server>/install.sh | sh".
set -eu

BASE_URL="${SLASHDOCS_BASE_URL:-__BASE_URL__}"
INSTALL_MODE="user"
for arg in "$@"; do
  case "$arg" in
    --user) INSTALL_MODE="user" ;;
    --system) INSTALL_MODE="system" ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os" in
  darwin|linux) ;;
  *) echo "unsupported OS: $os" >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="amd64" ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac

if command -v brew >/dev/null 2>&1 && brew list aidocs >/dev/null 2>&1; then
  echo "Removing Homebrew aidocs..."
  brew uninstall aidocs
fi

# The CLI was named aidocs before. An install under either name counts.
old_path="$(command -v slashdocs 2>/dev/null || command -v aidocs 2>/dev/null || true)"

# Replace an existing install in place. Otherwise prefer a writable dir that
# is already on PATH, so slashdocs works in this terminal with no extra step.
on_path() { case ":$PATH:" in *":$1:"*) return 0 ;; esac; return 1; }
if [ -n "${SLASHDOCS_INSTALL_DIR:-}" ]; then
  BIN_DIR="$SLASHDOCS_INSTALL_DIR"
elif [ "$INSTALL_MODE" = "system" ]; then
  BIN_DIR="/usr/local/bin"
elif [ -n "$old_path" ]; then
  BIN_DIR="$(dirname "$old_path")"
else
  BIN_DIR="$HOME/.local/bin"
  for dir in "$HOME/.local/bin" "$HOME/bin" /usr/local/bin; do
    if on_path "$dir" && [ -w "$dir" ]; then
      BIN_DIR="$dir"
      break
    fi
  done
fi
BIN_PATH="$BIN_DIR/slashdocs"

if [ -n "$old_path" ] && [ "$(dirname "$old_path")" != "$BIN_DIR" ]; then
  old_dir="$(dirname "$old_path")"
  echo "Existing slashdocs install found at $old_path." >&2
  echo "Remove it first, or install there with:" >&2
  echo "  curl -fsSL $BASE_URL/install.sh | SLASHDOCS_INSTALL_DIR=$old_dir sh" >&2
  echo "Target install path: $BIN_PATH" >&2
  exit 1
fi

bin_tmp="$(mktemp)"
skill_tmp="$(mktemp)"
trap 'rm -f "$bin_tmp" "$skill_tmp"' EXIT
url="$BASE_URL/cli/$os/$arch"
echo "Downloading slashdocs from $url"
curl -fsSL "$url" -o "$bin_tmp"
chmod +x "$bin_tmp"

skill_url="$BASE_URL/skills/slashdocs/SKILL.md"
echo "Downloading slashdocs skill from $skill_url"
curl -fsSL "$skill_url" -o "$skill_tmp"

if [ ! -d "$BIN_DIR" ]; then
  if [ "$INSTALL_MODE" = "system" ]; then
    mkdir -p "$BIN_DIR" 2>/dev/null || sudo mkdir -p "$BIN_DIR"
  else
    mkdir -p "$BIN_DIR"
  fi
fi
if [ -w "$BIN_DIR" ]; then
  sudo=""
elif [ "$INSTALL_MODE" = "system" ]; then
  sudo="sudo"
else
  echo "install dir is not writable: $BIN_DIR" >&2
  echo "Try: curl -fsSL $BASE_URL/install.sh | sh -s -- --system" >&2
  echo "Or set SLASHDOCS_INSTALL_DIR to a writable directory." >&2
  exit 1
fi
$sudo mv "$bin_tmp" "$BIN_PATH"
# The old aidocs name runs the same binary, which tells callers about the rename.
$sudo ln -sf slashdocs "$BIN_DIR/aidocs"

echo "Installed $($BIN_PATH version 2>/dev/null || echo slashdocs) at $BIN_PATH"

install_skill_dir() {
  skill_dir="$1"
  mkdir -p "$skill_dir"
  cp "$skill_tmp" "$skill_dir/SKILL.md"
}

install_skill_dir "$HOME/.agents/skills/slashdocs"
install_skill_dir "$HOME/.claude/skills/slashdocs"
echo "Installed slashdocs skill at:"
echo "  $HOME/.agents/skills/slashdocs/SKILL.md"
echo "  $HOME/.claude/skills/slashdocs/SKILL.md"

# Point a fresh CLI at the server this installer came from, so
# "curl <server>/install.sh | sh" ends with slashdocs already configured.
# An existing config is never touched: it may hold other contexts/credentials.
configure_default_context() {
  config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/slashdocs"
  config_path="$config_dir/config.json"
  if [ -e "$config_path" ]; then
    echo "Keeping existing slashdocs config at $config_path"
    return
  fi
  host="${BASE_URL#*://}"
  host="${host%%/*}"
  mkdir -p "$config_dir"
  chmod 700 "$config_dir"
  cat > "$config_path" <<EOF
{
  "active_context": "$host",
  "contexts": {
    "$host": {
      "server": "$BASE_URL",
      "pulled": {}
    }
  }
}
EOF
  chmod 600 "$config_path"
  echo "Configured slashdocs to use $BASE_URL (run 'slashdocs auth login' to sign in)."
}

configure_default_context

profile_for_current_shell() {
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh) echo "$HOME/.zshrc" ;;
    bash)
      if [ "$os" = "darwin" ]; then
        echo "$HOME/.bash_profile"
      else
        echo "$HOME/.bashrc"
      fi
      ;;
    fish) echo "$HOME/.config/fish/config.fish" ;;
    *) echo "$HOME/.profile" ;;
  esac
}

ensure_bin_dir_on_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return ;;
  esac

  export PATH="$BIN_DIR:$PATH"

  profile="$(profile_for_current_shell)"
  shell_name="$(basename "${SHELL:-}")"
  path_line="export PATH=\"$BIN_DIR:\$PATH\""
  if [ "$shell_name" = "fish" ]; then
    mkdir -p "$(dirname "$profile")" 2>/dev/null || {
      echo "Add $BIN_DIR to PATH to use this install."
      return
    }
    path_line="set -gx PATH \"$BIN_DIR\" \$PATH"
  fi

  touch "$profile" 2>/dev/null || {
    echo "Add $BIN_DIR to PATH to use this install."
    return
  }
  if grep -F "$BIN_DIR" "$profile" >/dev/null 2>&1; then
    echo "Exported $BIN_DIR into PATH for this install. It already appears in $profile."
    return
  fi
  {
    echo ""
    echo "# Added by slashdocs installer"
    echo "$path_line"
  } >> "$profile" || {
    echo "Add $BIN_DIR to PATH to use this install."
    return
  }
  echo "Added $BIN_DIR to PATH in $profile."
  echo "New terminals will pick this up automatically."
}

ensure_bin_dir_on_path

active_path="$(command -v slashdocs 2>/dev/null || true)"
if [ -n "$active_path" ] && [ "$active_path" != "$BIN_PATH" ]; then
  echo "Warning: 'slashdocs' currently resolves to $active_path."
  echo "Move $BIN_DIR earlier in PATH or remove the older install."
fi
`
