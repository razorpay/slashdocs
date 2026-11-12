package cli

import (
	"context"
	"io"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

func updateCmd(g *globals, out io.Writer) *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "update",
		Short: "Update the slashdocs CLI",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := client(g)
			if err != nil {
				return err
			}
			ctx, cancel := context.WithTimeout(cmd.Context(), 30*time.Second)
			defer cancel()
			v, binaryChanged, skillRefreshed, err := updateCLI(ctx, c, force)
			if err != nil {
				return err
			}
			if g.json {
				return renderValue(out, g, map[string]any{"version": v.Version, "updated": binaryChanged, "skill_refreshed": skillRefreshed})
			}
			var lines []string
			switch {
			case binaryChanged:
				lines = append(lines, "Updated slashdocs to "+v.Version+".")
			case v.Version != "":
				lines = append(lines, "slashdocs is already up to date ("+v.Version+").")
			case !skillRefreshed:
				lines = append(lines, "No update information available.")
			}
			if skillRefreshed {
				lines = append(lines, "Refreshed slashdocs skill.")
			}
			return message(out, g, strings.Join(lines, "\n"))
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "reinstall even when the local version matches the server")
	return cmd
}
