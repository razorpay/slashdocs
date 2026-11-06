package cli

import (
	"fmt"
	"io"

	"github.com/spf13/cobra"
)

func versionCmd(out io.Writer) *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print CLI version",
		Args:  exactArgs(0),
		RunE: func(cmd *cobra.Command, args []string) error {
			if Commit != "" {
				_, _ = fmt.Fprintf(out, "slashdocs %s (%s)\n", Version, Commit)
				return nil
			}
			_, _ = fmt.Fprintf(out, "slashdocs %s\n", Version)
			return nil
		},
	}
}
