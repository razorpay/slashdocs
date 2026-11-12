// Package skills embeds the agent skills that slashdocs ships. The server
// serves these bytes to install.sh, and the CLI installs them from its own
// binary, so a server cannot change the skill that a CLI installs.
package skills

import _ "embed"

// Slashdocs is the content of slashdocs/SKILL.md.
//
//go:embed slashdocs/SKILL.md
var Slashdocs []byte
