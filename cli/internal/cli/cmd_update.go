package cli

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/spf13/cobra"
)

func updateCmd(g *globals, out io.Writer) *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "update",
		Short: "Update the aidocs CLI",
		Args:  exactArgs(0),
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
				return renderValue(out, g, map[string]any{"ok": true, "updated": binaryChanged, "skill_refreshed": skillRefreshed, "version": v.Version})
			}
			if binaryChanged {
				_, _ = fmt.Fprintf(out, "Updated aidocs to %s.\n", v.Version)
				if skillRefreshed {
					_, _ = fmt.Fprintln(out, "Refreshed aidocs skill.")
				}
				return nil
			}
			if skillRefreshed {
				_, _ = fmt.Fprintln(out, "Refreshed aidocs skill.")
				if v.Version != "" {
					_, _ = fmt.Fprintf(out, "aidocs is already up to date (%s).\n", v.Version)
				}
				return nil
			}
			if v.Version == "" {
				_, _ = fmt.Fprintln(out, "No update information available.")
				return nil
			}
			_, _ = fmt.Fprintf(out, "aidocs is already up to date (%s).\n", v.Version)
			return nil
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "reinstall even when the local version matches the server")
	return cmd
}
