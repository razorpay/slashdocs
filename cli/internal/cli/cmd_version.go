package cli

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"
)

func versionCmd(g *globals, out io.Writer) *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print CLI version",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, args []string) error {
			if g.json {
				return renderValue(out, g, map[string]any{"version": Version, "commit": Commit})
			}
			if Commit != "" {
				_, _ = fmt.Fprintf(out, "aidocs %s (%s)\n", Version, Commit)
				return nil
			}
			_, _ = fmt.Fprintf(out, "aidocs %s\n", Version)
			return nil
		},
	}
}
