package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/bots"
	"github.com/razorpay/slashdocs/api/internal/googlegroups"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// resolveGrantPrincipal turns a grant request's address or inline principal
// spec into a concrete auth.Principal.
// Sentinel errors returned by resolveGrantPrincipal so callers can map them to
// HTTP responses without matching on error message text.
var (
	errInvalidAddress           = errors.New("invalid grant address")
	errPrincipalIDRequired      = errors.New("principal id required")
	errUnknownUserEmail         = errors.New("unknown user email")
	errGoogleGroupsDisabled     = errors.New("google groups disabled")
	errGoogleGroupEmailRequired = errors.New("google group email required")
)

// respondGrantPrincipalError maps a resolveGrantPrincipal failure onto its HTTP
// response. Document and folder sharing resolve principals identically, so the
// mapping lives here rather than being repeated per resource. principalType is
// the requested type, which decides whether an unclassified failure is a
// Google directory outage or a server fault.
func respondGrantPrincipalError(c *gin.Context, err error, principalType auth.PrincipalType) {
	switch {
	case errors.Is(err, errInvalidAddress):
		badRequest(c, "That doesn't look like an email or bot address.")
	case errors.Is(err, errPrincipalIDRequired):
		badRequest(c, "principal id, user email, or service account name is required")
	case errors.Is(err, errUnknownUserEmail):
		badRequest(c, "No slashdocs user exists for that email. Ask them to sign in once, then try again.")
	case errors.Is(err, errGoogleGroupsDisabled):
		badRequest(c, "Google Group sharing is disabled")
	case errors.Is(err, errGoogleGroupEmailRequired), googlegroups.IsNotFound(err):
		badRequest(c, "Select a verified Google Group result")
	case errors.Is(err, repo.ErrNotFound):
		notFound(c)
	case principalType == auth.PrincipalGoogleGroup:
		incGoogleGroupOperation("grant_resolution", "failure")
		c.JSON(http.StatusServiceUnavailable, errorResponse("dependency_unavailable", "Google Group directory is temporarily unavailable", nil))
	default:
		internalErr(c, err)
	}
}

type grantPrincipalInput struct {
	Type  auth.PrincipalType `json:"type" enums:"user,service_account,google_group,anyone"`
	ID    string             `json:"id,omitempty"`
	Email string             `json:"email,omitempty"`
	Name  string             `json:"name,omitempty"`
}

type grantInput struct {
	Address   string              `json:"address,omitempty"`
	Principal grantPrincipalInput `json:"principal"`
	Role      repo.Role           `json:"role" enums:"viewer,commenter,editor"`
}

func resolveGrantPrincipal(c *gin.Context, r repo.Repository, directory googlegroups.GoogleGroupDirectory, groupsEnabled bool, address string, principal auth.Principal) (auth.Principal, error) {
	// The "anyone" principal is the whole-server audience; it has no address and
	// no backing record to resolve.
	if principal.Type == auth.PrincipalAnyone {
		return auth.Principal{Type: auth.PrincipalAnyone}, nil
	}
	if principal.Type == auth.PrincipalGoogleGroup {
		if !groupsEnabled || directory == nil {
			return auth.Principal{}, errGoogleGroupsDisabled
		}
		if strings.TrimSpace(principal.Email) == "" {
			return auth.Principal{}, errGoogleGroupEmailRequired
		}
		// Never trust a caller-supplied group ID. Lookup+get verifies the
		// canonical address, immutable groups/{id}, customer, and group type.
		group, err := directory.LookupGroup(c.Request.Context(), principal.Email)
		if err != nil {
			return auth.Principal{}, err
		}
		if err := r.UpsertGoogleGroup(c.Request.Context(), repo.GoogleGroup{
			ID: group.ID, CustomerID: group.CustomerID, Email: group.Email,
			Name: group.Name, LastVerifiedAt: time.Now(),
		}); err != nil {
			return auth.Principal{}, err
		}
		return auth.Principal{Type: auth.PrincipalGoogleGroup, ID: group.ID, Email: group.Email, Name: group.Name}, nil
	}
	if address != "" {
		var err error
		principal, err = grantPrincipalFromAddress(address)
		if err != nil {
			return auth.Principal{}, err
		}
	}
	return resolveStoredGrantPrincipal(c.Request.Context(), r, principal)
}

func grantPrincipalFromAddress(address string) (auth.Principal, error) {
	_, domain, ok := bots.Split(address)
	if !ok {
		return auth.Principal{}, errInvalidAddress
	}
	if strings.HasSuffix(domain, ".bot") {
		return auth.Principal{Type: auth.PrincipalServiceAccount, Name: address}, nil
	}
	return auth.Principal{Type: auth.PrincipalUser, Email: address}, nil
}

func resolveStoredGrantPrincipal(ctx context.Context, r repo.Repository, principal auth.Principal) (auth.Principal, error) {
	switch {
	case principal.Type == auth.PrincipalUser && principal.ID == "" && principal.Email != "":
		p, err := r.UserByEmail(ctx, principal.Email)
		if errors.Is(err, repo.ErrNotFound) {
			return auth.Principal{}, errUnknownUserEmail
		}
		if err != nil {
			return auth.Principal{}, err
		}
		return p, nil
	case principal.Type == auth.PrincipalServiceAccount && principal.ID == "" && principal.Name != "":
		sa, err := r.GetServiceAccountByName(ctx, principal.Name)
		if err != nil {
			return auth.Principal{}, err
		}
		return auth.Principal{Type: auth.PrincipalServiceAccount, ID: sa.ID, Name: sa.Name}, nil
	default:
		if principal.ID == "" {
			return auth.Principal{}, errPrincipalIDRequired
		}
		if principal.Type == auth.PrincipalUser {
			return r.ResolveUser(ctx, principal.ID)
		}
		exists, err := r.PrincipalExists(ctx, principal)
		if err != nil {
			return auth.Principal{}, err
		}
		if !exists {
			return auth.Principal{}, repo.ErrNotFound
		}
		return principal, nil
	}
}

// createGrantResponse is the payload of POST /v1/documents/{id}/grants.
type createGrantResponse struct {
	ID        string         `json:"id"`
	Resource  grantResource  `json:"resource"`
	Principal grantPrincipal `json:"principal"`
	Role      repo.Role      `json:"role"`
	GrantedBy grantGrantedBy `json:"granted_by"`
}

type grantResource struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type grantPrincipal struct {
	Type  auth.PrincipalType `json:"type"`
	ID    string             `json:"id"`
	Email string             `json:"email,omitempty"`
	Name  string             `json:"name,omitempty"`
}

type grantGrantedBy struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

// CreateGrant godoc
// @Summary Create document grant
// @Tags grants
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 201 {object} createGrantResponse
// @Router /v1/documents/{id}/grants [post]
func (h handlers) createGrant(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleEditor) {
		return
	}
	p := current(c)
	var in grantInput
	if !requireJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid grant")
		return
	}
	if !validGrantRole(in.Role) {
		badRequest(c, "invalid role")
		return
	}
	principal := auth.Principal{Type: in.Principal.Type, ID: in.Principal.ID, Email: in.Principal.Email, Name: in.Principal.Name}
	resolved, err := resolveGrantPrincipal(c, h.deps.repository, h.deps.googleGroupDirectory, h.deps.googleGroupsEnabled, in.Address, principal)
	if err != nil {
		respondGrantPrincipalError(c, err, in.Principal.Type)
		return
	}
	g, err := h.deps.repository.CreateGrant(c.Request.Context(), "document", c.Param("id"), resolved, in.Role, *p)
	if err != nil {
		internalErr(c, err)
		return
	}
	incGrant("created", string(g.Role), string(g.Principal.Type), actorType(c))
	c.JSON(http.StatusCreated, createGrantResponse{
		ID:       g.ID,
		Resource: grantResource{Type: "document", ID: g.DocumentID},
		Principal: grantPrincipal{
			Type:  g.Principal.Type,
			ID:    g.Principal.ID,
			Email: g.Principal.Email,
			Name:  g.Principal.Name,
		},
		Role:      g.Role,
		GrantedBy: grantGrantedBy{ID: g.GrantedBy.ID, Email: g.GrantedBy.Email},
	})
}

// PatchGrant godoc
// @Summary Update document grant
// @Tags grants
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param grant_id path string true "Grant ID"
// @Success 200 {object} repo.Grant
// @Router /v1/documents/{id}/grants/{grant_id} [patch]
func (h handlers) patchGrant(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleEditor) {
		return
	}
	var in struct {
		Role repo.Role `json:"role"`
	}
	if !requireJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil || !validGrantRole(in.Role) {
		badRequest(c, "invalid grant")
		return
	}
	g, err := h.deps.repository.UpdateGrant(c.Request.Context(), c.Param("id"), c.Param("grant_id"), in.Role, *current(c))
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	incGrant("updated", string(g.Role), string(g.Principal.Type), actorType(c))
	c.JSON(http.StatusOK, g)
}

// DeleteGrant godoc
// @Summary Delete document grant
// @Tags grants
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param grant_id path string true "Grant ID"
// @Success 204
// @Router /v1/documents/{id}/grants/{grant_id} [delete]
func (h handlers) deleteGrant(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleEditor) {
		return
	}
	if err := h.deps.repository.DeleteGrant(c.Request.Context(), c.Param("id"), c.Param("grant_id"), *current(c)); err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	incGrant("deleted", labelUnknown, labelUnknown, actorType(c))
	c.Status(http.StatusNoContent)
}
