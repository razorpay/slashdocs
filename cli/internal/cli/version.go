package cli

// Version, Commit, and SigningPublicKey are set with -ldflags in release
// builds. SigningPublicKey is the base64 ed25519 public key that examines the
// signatures of CLI releases. A build without it installs no updates. See
// docs/releasing.md.
var (
	Version          = "dev"
	Commit           = ""
	SigningPublicKey = ""
)
