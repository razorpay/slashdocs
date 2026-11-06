package cli

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/skills"
)

func TestSkillsUpdateInstallsEmbeddedSkill(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	got, err := Execute([]string{"skills", "update"})
	if err != nil {
		t.Fatalf("skills update returned error: %v", err)
	}
	if !strings.Contains(got, "Updated slashdocs skill") {
		t.Fatalf("unexpected output: %q", got)
	}
	for _, p := range []string{
		filepath.Join(home, ".agents", "skills", "slashdocs", "SKILL.md"),
		filepath.Join(home, ".claude", "skills", "slashdocs", "SKILL.md"),
	} {
		if b := readTestFile(t, p); string(b) != string(skills.Slashdocs) {
			t.Fatalf("%s is not the embedded skill", p)
		}
	}
}
