package main

import (
	"fmt"
	"os"

	"github.com/razorpay/slashdocs/cli/internal/cli"
)

func main() {
	cli.MigrateLegacyInstall()
	if cli.InvokedAsLegacy(os.Args[0]) {
		cli.MigrateLegacyBinary()
		fmt.Fprint(os.Stderr, cli.RenameNotice())
		os.Exit(1)
	}
	if err := cli.NewRoot(os.Stdout).Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(cli.ExitCode(err))
	}
}
