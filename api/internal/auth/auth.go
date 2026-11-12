package auth

import (
	"errors"
	"net/http"
)

type PrincipalType string

const (
	PrincipalUser           PrincipalType = "user"
	PrincipalServiceAccount PrincipalType = "service_account"
	PrincipalGoogleGroup    PrincipalType = "google_group"
	// PrincipalAnyone represents "everyone who can authenticate to this
	// server". On an org deployment the login gate scopes that set to the
	// org's members. It is stored as a grant with an empty principal id.
	PrincipalAnyone PrincipalType = "anyone"
	// PrincipalAnonymous represents an unauthenticated caller. A public
	// deployment gives it to a caller without credentials on the routes that
	// read a document, where only "anyone" grants apply to it.
	PrincipalAnonymous PrincipalType = "anonymous"
)

type Principal struct {
	Type       PrincipalType `json:"type"`
	ID         string        `json:"id"`
	Email      string        `json:"email,omitempty"`
	Name       string        `json:"name,omitempty"`
	PictureURL string        `json:"picture_url,omitempty"`

	// GoogleGroupIDs and GoogleGroupMembershipState are authorization inputs,
	// not principal profile data. Excluding them from JSON prevents a
	// user's group graph (and resolution failures) from leaking through API
	// responses that serialize the authenticated principal.
	GoogleGroupIDs             []string `json:"-"`
	GoogleGroupMembershipState string   `json:"-"`
}

const (
	GoogleGroupMembershipResolved    = "resolved"
	GoogleGroupMembershipUnavailable = "unavailable"
)

type Authenticator interface {
	Authenticate(r *http.Request) (*Principal, error)
}

var ErrUnauthorized = errors.New("unauthorized")

// ErrNotFound is the canonical "principal/record not found" sentinel. The repo
// layer's repo.ErrNotFound wraps this so that lower-level packages (e.g. this
// auth package, which must not import repo to avoid an import cycle) can still
// detect not-found results via errors.Is.
var ErrNotFound = errors.New("not found")
