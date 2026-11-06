package cli

import (
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/razorpay/slashdocs/internal/guidelines"
)

func guidelinesCmd(_ *globals, out io.Writer) *cobra.Command {
	return &cobra.Command{
		Use:   "guidelines [section] [sub-section...]",
		Short: "Print HTML authoring guidelines",
		Long:  "Print slashdocs HTML authoring guidelines. With no arguments, prints an index. Pass a section path for details, such as `slashdocs guidelines rendering theme`.",
		Args:  cobra.ArbitraryArgs,
		RunE: func(_ *cobra.Command, args []string) error {
			text, err := guidelineText(args)
			if err != nil {
				return err
			}
			_, err = fmt.Fprint(out, text)
			return err
		},
	}
}

func guidelineText(args []string) (string, error) {
	if len(args) == 0 {
		return guidelineIndex(), nil
	}
	path := guidelines.NormalizePath(args)
	if len(path) == 1 && path[0] == "all" {
		return guidelineAll(), nil
	}
	if p, ok := guidelines.Find(path); ok {
		return p.Body, nil
	}
	return "", usageError{fmt.Errorf("unknown guidelines section %q\nRun: slashdocs guidelines\nAvailable sections:\n%s", strings.Join(args, " "), guidelineSectionList())}
}

func guidelineIndex() string {
	var b strings.Builder
	b.WriteString("slashdocs document authoring guidelines\n\n")
	b.WriteString("Run a section command for details:\n")
	for _, p := range guidelines.Pages {
		fmt.Fprintf(&b, "  slashdocs guidelines %-24s %s\n", strings.Join(p.Path, " "), p.Summary)
	}
	b.WriteString("\nCommon shortcuts:\n")
	b.WriteString("  slashdocs guidelines assets       -> slashdocs guidelines core assets\n")
	b.WriteString("  slashdocs guidelines theme        -> slashdocs guidelines rendering theme\n")
	b.WriteString("  slashdocs guidelines kv           -> slashdocs guidelines interactivity kv\n")
	b.WriteString("  slashdocs guidelines github       -> slashdocs guidelines interactivity github\n")
	b.WriteString("  slashdocs guidelines publishing   -> slashdocs guidelines core publishing\n")
	b.WriteString("\nFor a full dump:\n")
	b.WriteString("  slashdocs guidelines all\n")
	return b.String()
}

func guidelineAll() string {
	var b strings.Builder
	b.WriteString(guidelineIndex())
	for _, p := range guidelines.Pages {
		b.WriteString("\n---\n\n")
		b.WriteString(p.Body)
	}
	return b.String()
}

func guidelineSectionList() string {
	lines := make([]string, 0, len(guidelines.Pages)+1)
	for _, p := range guidelines.Pages {
		lines = append(lines, "  slashdocs guidelines "+strings.Join(p.Path, " "))
	}
	lines = append(lines, "  slashdocs guidelines all")
	return strings.Join(lines, "\n")
}
