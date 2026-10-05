package main

import (
	"fmt"
	"os"

	"github.com/razorpay/aidocs/cli/internal/cli"
)

func main() {
	if err := cli.Run(os.Stdout, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(cli.ExitCode(err))
	}
}
