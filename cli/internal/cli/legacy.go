package cli

import (
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// The CLI was named aidocs before it became slashdocs. This file moves what
// the old name left on a machine and keeps old shells and agents working.

const (
	cliName    = "slashdocs"
	legacyName = "aidocs"
)

// RenameNotice tells an agent or a person who ran the old name what to do.
// When slashdocs is not on PATH, it also gives the install command.
func RenameNotice() string {
	notice := "aidocs has been renamed to slashdocs. Run the same command with `slashdocs` instead of `aidocs`.\n" +
		"The agent skill is now named slashdocs too. Run `slashdocs guidelines` before you write a document.\n"
	if _, err := exec.LookPath(cliName); err != nil {
		_, cx, _ := currentContext(&globals{})
		notice += "slashdocs is not on PATH. Install it with: curl -fsSL " + first(cx.Server, "<your slashdocs server>") + "/install.sh | sh\n"
	}
	return notice
}

// env reads a SLASHDOCS_* variable and falls back to its pre-rename AIDOCS_*
// name, so shells and CI jobs set up for aidocs keep working.
func env(name string) string {
	return first(os.Getenv(name), os.Getenv("AIDOCS_"+strings.TrimPrefix(name, "SLASHDOCS_")))
}

// InvokedAsLegacy reports whether the binary ran under its old name.
func InvokedAsLegacy(arg0 string) bool {
	return strings.TrimSuffix(filepath.Base(arg0), ".exe") == legacyName
}

// MigrateLegacyInstall moves the old config directory and agent skills to
// their new names. It is best-effort and runs before every command, so it
// only costs a few stat calls once the move is done.
func MigrateLegacyInstall() {
	_ = renameIfFree(filepath.Join(configBase(), legacyName), filepath.Join(configBase(), cliName))
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	for _, root := range skillRoots(home) {
		// Move a real skill directory. Remove a stale copy or a symlink, whose
		// target keeps the old name. The next update writes a fresh skill.
		legacy := filepath.Join(root, legacyName)
		if info, err := os.Lstat(legacy); err == nil && info.Mode()&fs.ModeSymlink == 0 && renameIfFree(legacy, filepath.Join(root, cliName)) == nil {
			continue
		}
		_ = os.RemoveAll(legacy)
	}
}

// MigrateLegacyBinary runs when the binary starts as aidocs, which is what a
// pre-rename auto-update leaves behind. It renames the file to slashdocs and
// leaves aidocs as a symlink, so the old name keeps printing the rename notice.
func MigrateLegacyBinary() {
	if exe, err := os.Executable(); err == nil {
		migrateLegacyBinary(exe)
	}
}

func migrateLegacyBinary(exe string) {
	exe, err := filepath.EvalSymlinks(exe)
	if err != nil || filepath.Base(exe) != legacyName {
		return
	}
	if os.Rename(exe, filepath.Join(filepath.Dir(exe), cliName)) == nil {
		_ = os.Symlink(cliName, exe)
	}
}

// renameIfFree renames from to to. It never replaces an existing to.
func renameIfFree(from, to string) error {
	if _, err := os.Lstat(to); !errors.Is(err, fs.ErrNotExist) {
		return fs.ErrExist
	}
	return os.Rename(from, to)
}
