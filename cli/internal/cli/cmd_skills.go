package cli

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/spf13/cobra"
)

func skillsCmd(g *globals, out io.Writer) *cobra.Command {
	cmd := &cobra.Command{Use: "skills", Short: "Manage bundled agent skills"}
	cmd.AddCommand(skillsUpdateCmd(g, out))
	return cmd
}

func skillsUpdateCmd(g *globals, out io.Writer) *cobra.Command {
	return &cobra.Command{
		Use:   "update",
		Short: "Reinstall the agent skill bundled with this CLI",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, args []string) error {
			paths, err := installBundledSkill()
			if err != nil {
				return err
			}
			if g.quiet {
				return nil
			}
			if g.json {
				b, err := json.Marshal(map[string]any{"items": []any{map[string]any{"name": "slashdocs", "status": "updated", "paths": paths}}})
				if err != nil {
					return err
				}
				return render(out, g, b)
			}
			if err := confirm(out, g, "Updated slashdocs skill"); err != nil {
				return err
			}
			for _, p := range paths {
				_, _ = fmt.Fprintln(out, "  "+p)
			}
			return nil
		},
	}
}
