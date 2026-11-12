package cli

import (
	"io"

	"github.com/spf13/cobra"
)

func versionCmd(g *globals, out io.Writer) *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print CLI version",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if g.json {
				return renderValue(out, g, map[string]string{"version": Version, "commit": Commit})
			}
			text := "slashdocs " + Version
			if Commit != "" {
				text += " (" + Commit + ")"
			}
			return message(out, g, text)
		},
	}
}
