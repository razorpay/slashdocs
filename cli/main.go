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
	if err := cli.Run(os.Stdout, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(cli.ExitCode(err))
	}
}
