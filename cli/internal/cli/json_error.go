package cli

import (
	"errors"
	"io"
	"net/url"
)

// Stable codes for the --json error envelope when a failure did not come from
// the API; an API failure keeps the server's own code instead. They are part
// of the CLI's documented contract, so they must not change casually.
const (
	// errCodeUsage is a bad flag or argument (exit code 2).
	errCodeUsage = "usage"
	// errCodeNetwork is a server that could not be reached (exit code 6).
	errCodeNetwork = "network"
	// errCodeLocal is anything the CLI itself hit: configuration, the
	// filesystem, an unparseable response (exit code 1).
	errCodeLocal = "local"
	// errCodeAPI is a non-2xx response whose body carried no code of its own.
	errCodeAPI = "api_error"
)

// renderedError marks a failure whose machine-readable report the command has
// already written, so the top-level reporter does not add a second JSON value
// (multi-id commands report one outcome per id). It unwraps to the original
// error, leaving ExitCode's mapping untouched.
type renderedError struct{ err error }

func (e renderedError) Error() string { return e.err.Error() }
func (e renderedError) Unwrap() error { return e.err }

// reportError writes the --json error envelope for a failed command. The human
// text still goes to stderr, so this is only the machine-readable half of the
// same report, and --quiet silences it like any other stdout output.
func reportError(out io.Writer, g *globals, err error) {
	if !g.json || g.quiet {
		return
	}
	var reported renderedError
	if errors.As(err, &reported) {
		return
	}
	_ = renderValue(out, g, map[string]any{"error": errorPayload(err)})
}

// errorPayload describes err as the body of the error envelope. An API failure
// keeps the server's code, status, and details verbatim.
func errorPayload(err error) map[string]any {
	var ae *APIError
	if errors.As(err, &ae) {
		body := map[string]any{"code": first(ae.Code, errCodeAPI), "message": ae.Message, "status": ae.Status}
		if ae.Details != nil {
			body["details"] = ae.Details
		}
		return body
	}
	return map[string]any{"code": errorCode(err), "message": err.Error()}
}

// errorCode classifies a non-API failure in the order ExitCode uses, so a code
// and an exit code can never disagree about what went wrong.
func errorCode(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		return errCodeNetwork
	}
	var uerr usageError
	if errors.As(err, &uerr) {
		return errCodeUsage
	}
	if errors.Is(err, errSADisabled) {
		return errCodeUsage
	}
	return errCodeLocal
}
