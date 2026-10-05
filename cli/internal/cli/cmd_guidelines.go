package cli

import (
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/razorpay/aidocs/internal/guidelines"
)

func guidelinesCmd(g *globals, out io.Writer) *cobra.Command {
	return &cobra.Command{
		Use:   "guidelines [section] [sub-section...]",
		Short: "Print HTML authoring guidelines",
		Long:  "Print aidocs HTML authoring guidelines. With no arguments, prints an index. Pass a section path for details, such as `aidocs guidelines rendering theme`.",
		Args:  cobra.ArbitraryArgs,
		RunE: func(_ *cobra.Command, args []string) error {
			text, err := guidelineText(args)
			if err != nil {
				return err
			}
			if g.json {
				return renderValue(out, g, okValue("content", text))
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
	return "", usageError{fmt.Errorf("unknown guidelines section %q\nRun: aidocs guidelines\nAvailable sections:\n%s", strings.Join(args, " "), guidelineSectionList())}
}

func guidelineIndex() string {
	var b strings.Builder
	b.WriteString("aidocs document authoring guidelines\n\n")
	b.WriteString("Run a section command for details:\n")
	for _, p := range guidelines.Pages {
		fmt.Fprintf(&b, "  aidocs guidelines %-24s %s\n", strings.Join(p.Path, " "), p.Summary)
	}
	b.WriteString("\nCommon shortcuts:\n")
	b.WriteString("  aidocs guidelines assets       -> aidocs guidelines core assets\n")
	b.WriteString("  aidocs guidelines theme        -> aidocs guidelines rendering theme\n")
	b.WriteString("  aidocs guidelines kv           -> aidocs guidelines interactivity kv\n")
	b.WriteString("  aidocs guidelines github       -> aidocs guidelines interactivity github\n")
	b.WriteString("  aidocs guidelines publishing   -> aidocs guidelines core publishing\n")
	b.WriteString("\nFor a full dump:\n")
	b.WriteString("  aidocs guidelines all\n")
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
		lines = append(lines, "  aidocs guidelines "+strings.Join(p.Path, " "))
	}
	lines = append(lines, "  aidocs guidelines all")
	return strings.Join(lines, "\n")
}
