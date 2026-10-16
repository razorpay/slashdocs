package server

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/bots"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// allocateServiceAccountName creates a service account, retrying with freshly
// generated random domains until it finds an unused name. It returns the
// created account, or the last error if every attempt collides.
func allocateServiceAccountName(c *gin.Context, r repo.Repository, p auth.Principal, label, explicitDomain string) (repo.ServiceAccount, string, error) {
	explicit := explicitDomain != ""
	attempts := saNameMaxAttempts
	if explicit {
		attempts = 1
	}
	var lastErr error
	for i := 0; i < attempts; i++ {
		domain := explicitDomain
		if !explicit {
			if i < saNameShortDomainAttempts {
				domain = bots.GenerateDomain()
			} else {
				domain = bots.GenerateDomainExtended()
			}
		}
		fullName := bots.Compose(label, domain)
		sa, err := r.CreateServiceAccount(c.Request.Context(), p, fullName)
		if err == nil {
			return sa, fullName, nil
		}
		lastErr = err
		if !errors.Is(err, repo.ErrConflict) {
			return repo.ServiceAccount{}, "", err
		}
	}
	return repo.ServiceAccount{}, "", lastErr
}

// createServiceAccountResponse is the payload of POST /v1/service-accounts.
// It carries the freshly minted key token, shown exactly once.
type createServiceAccountResponse struct {
	ID       string              `json:"id"`
	Label    string              `json:"label"`
	Name     string              `json:"name"`
	Owner    serviceAccountOwner `json:"owner"`
	Disabled bool                `json:"disabled"`
	Grants   []any               `json:"grants"`
	Key      serviceAccountKey   `json:"key"`
}

type serviceAccountOwner struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

// serviceAccountKey is a newly created key with its one-time token; it is
// also the payload of POST /v1/service-accounts/{id}/keys.
type serviceAccountKey struct {
	ID    string `json:"id"`
	Token string `json:"token"`
}

// CreateServiceAccount godoc
// @Summary Create service account
// @Tags service-accounts
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Produce json
// @Success 201 {object} createServiceAccountResponse
// @Router /v1/service-accounts [post]
func (h handlers) createServiceAccount(c *gin.Context) {
	p := current(c)
	if p.Type != auth.PrincipalUser {
		forbidden(c, "user principal required")
		return
	}
	var in struct {
		Label  string `json:"label"`
		Domain string `json:"domain"`
	}
	if !requireJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "Tell us a name for your bot.")
		return
	}
	if err := bots.ValidateLabel(in.Label); err != nil {
		badRequest(c, "Use letters, numbers, and hyphens for the bot's name.")
		return
	}
	if in.Domain != "" {
		if err := bots.ValidateDomain(in.Domain); err != nil {
			badRequest(c, "Addresses must end in .bot.")
			return
		}
	}
	sa, fullName, err := allocateServiceAccountName(c, h.deps.repository, *p, in.Label, in.Domain)
	if err != nil {
		if errors.Is(err, repo.ErrConflict) && in.Domain != "" {
			c.JSON(http.StatusConflict, errorResponse("address_taken", "Someone already uses "+fullName+". Try a different address.", nil))
			return
		}
		internalErr(c, err)
		return
	}
	token, hash, err := auth.NewBearerToken(auth.ServiceAccountPrefix)
	if err != nil {
		internalErr(c, err)
		return
	}
	keyID, err := h.deps.repository.CreateServiceAccountKey(c.Request.Context(), sa.ID, "default", hash)
	if err != nil {
		internalErr(c, err)
		return
	}
	incServiceAccount("created", actorType(c))
	incServiceAccount("key_created", actorType(c))
	c.JSON(http.StatusCreated, createServiceAccountResponse{
		ID:       sa.ID,
		Label:    in.Label,
		Name:     sa.Name,
		Owner:    serviceAccountOwner{ID: sa.Owner.ID, Email: sa.Owner.Email},
		Disabled: sa.Disabled,
		Grants:   []any{},
		Key:      serviceAccountKey{ID: keyID, Token: token},
	})
}

// CreateOwnershipTransfer godoc
// @Summary Initiate service account ownership transfer
// @Tags service-accounts
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Service account ID"
// @Success 201 {object} repo.OwnershipTransfer
// @Router /v1/service-accounts/{id}/transfer [post]
func (h handlers) createOwnershipTransfer(c *gin.Context) {
	if !h.needServiceAccountOwner(c, c.Param("id")) {
		return
	}
	var in struct {
		ToUserEmail string `json:"to_user_email"`
	}
	if !requireJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil || in.ToUserEmail == "" {
		badRequest(c, "to_user_email is required")
		return
	}
	x, err := h.deps.repository.CreateOwnershipTransfer(c.Request.Context(), c.Param("id"), *current(c), in.ToUserEmail)
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusCreated, x)
}

// ListOwnershipTransfers godoc
// @Summary List service account ownership transfers
// @Tags service-accounts
// @Security bearerAuth
// @Security cookieAuth
// @Success 200 {object} listResponse[repo.OwnershipTransfer]
// @Router /v1/service-accounts/transfers [get]
func (h handlers) listOwnershipTransfers(c *gin.Context) {
	items, err := h.deps.repository.ListOwnershipTransfers(c.Request.Context(), *current(c))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, listResponse[repo.OwnershipTransfer]{Items: items})
}

// AcceptOwnershipTransfer godoc
// @Summary Accept ownership transfer
// @Tags service-accounts
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Transfer ID"
// @Success 200 {object} repo.OwnershipTransfer
// @Router /v1/service-accounts/transfers/{id}/accept [post]
func (h handlers) acceptOwnershipTransfer(c *gin.Context) {
	x, err := h.deps.repository.AcceptOwnershipTransfer(c.Request.Context(), c.Param("id"), *current(c))
	if err != nil {
		switch {
		case errors.Is(err, repo.ErrNotFound):
			notFound(c)
		case errors.Is(err, repo.ErrNotTransferTarget):
			forbidden(c, "you are not the recipient of this transfer")
		case errors.Is(err, repo.ErrTransferNotPending):
			c.JSON(http.StatusConflict, errorResponse("invalid_transfer_state", "transfer is not pending", nil))
		default:
			internalErr(c, err)
		}
		return
	}
	c.JSON(http.StatusOK, x)
}

// DeclineOwnershipTransfer godoc
// @Summary Decline ownership transfer
// @Tags service-accounts
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Transfer ID"
// @Success 204
// @Router /v1/service-accounts/transfers/{id}/decline [post]
func (h handlers) declineOwnershipTransfer(c *gin.Context) {
	if err := h.deps.repository.DeclineOwnershipTransfer(c.Request.Context(), c.Param("id"), *current(c)); err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			c.JSON(http.StatusConflict, errorResponse("invalid_transfer_state", "transfer is not pending or not found", nil))
			return
		}
		internalErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// ListServiceAccounts godoc
// @Summary List service accounts
// @Tags service-accounts
// @Security bearerAuth
// @Security cookieAuth
// @Success 200 {object} listResponse[repo.ServiceAccount]
// @Router /v1/service-accounts [get]
func (h handlers) listServiceAccounts(c *gin.Context) {
	items, err := h.deps.repository.ListServiceAccounts(c.Request.Context(), *current(c))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, listResponse[repo.ServiceAccount]{Items: items})
}

// resolveServiceAccountUpdateName validates raw (which may be a bare label or a
// full .bot address) and returns the full canonical bot address.
func resolveServiceAccountUpdateName(c *gin.Context, r repo.Repository, saID, raw string) (string, bool) {
	if strings.Contains(raw, "@") {
		at := strings.Index(raw, "@")
		label, domain, ok := bots.Split(raw)
		if !ok {
			if at == 0 || bots.ValidateLabel(raw[:at]) != nil {
				badRequest(c, "Use letters, numbers, and hyphens for the bot's name.")
				return "", false
			}
			badRequest(c, "Addresses must end in .bot.")
			return "", false
		}
		if err := bots.ValidateLabel(label); err != nil {
			badRequest(c, "Use letters, numbers, and hyphens for the bot's name.")
			return "", false
		}
		if err := bots.ValidateDomain(domain); err != nil {
			badRequest(c, "Addresses must end in .bot.")
			return "", false
		}
		return bots.Compose(label, domain), true
	}

	if err := bots.ValidateLabel(raw); err != nil {
		badRequest(c, "Use letters, numbers, and hyphens for the bot's name.")
		return "", false
	}
	sa, err := r.GetServiceAccount(c.Request.Context(), saID)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return "", false
		}
		internalErr(c, err)
		return "", false
	}
	_, currentDomain, ok := bots.Split(sa.Name)
	if !ok {
		currentDomain = bots.GenerateDomain()
	}
	return bots.Compose(raw, currentDomain), true
}

// PatchServiceAccount godoc
// @Summary Update service account
// @Tags service-accounts
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Service account ID"
// @Success 200 {object} repo.ServiceAccount
// @Router /v1/service-accounts/{id} [patch]
func (h handlers) patchServiceAccount(c *gin.Context) {
	if !h.needServiceAccountOwner(c, c.Param("id")) {
		return
	}
	var in struct {
		Name     *string `json:"name"`
		Disabled *bool   `json:"disabled"`
	}
	if !requireJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid body")
		return
	}
	var newName string
	if in.Name != nil {
		var ok bool
		newName, ok = resolveServiceAccountUpdateName(c, h.deps.repository, c.Param("id"), strings.TrimSpace(*in.Name))
		if !ok {
			return
		}
	}
	sa, err := h.deps.repository.UpdateServiceAccount(c.Request.Context(), c.Param("id"), newName, in.Disabled)
	if err != nil {
		if errors.Is(err, repo.ErrConflict) {
			c.JSON(http.StatusConflict, errorResponse("address_taken", "Someone already uses "+newName+". Try a different address.", nil))
			return
		}
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, sa)
}

// CreateServiceAccountKey godoc
// @Summary Create service account key
// @Tags service-accounts
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Service account ID"
// @Success 201 {object} serviceAccountKey
// @Router /v1/service-accounts/{id}/keys [post]
func (h handlers) createServiceAccountKey(c *gin.Context) {
	if !h.needServiceAccountOwner(c, c.Param("id")) {
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	// Body is optional here; an absent name defaults to "default".
	if requestHasBody(c) {
		if !requireJSON(c) {
			return
		}
		if err := c.ShouldBindJSON(&in); err != nil {
			badRequest(c, "invalid body")
			return
		}
	}
	if in.Name == "" {
		in.Name = "default"
	}
	token, hash, err := auth.NewBearerToken(auth.ServiceAccountPrefix)
	if err != nil {
		internalErr(c, err)
		return
	}
	id, err := h.deps.repository.CreateServiceAccountKey(c.Request.Context(), c.Param("id"), in.Name, hash)
	if err != nil {
		internalErr(c, err)
		return
	}
	incServiceAccount("key_created", actorType(c))
	c.JSON(http.StatusCreated, serviceAccountKey{ID: id, Token: token})
}

// ListServiceAccountKeys godoc
// @Summary List service account keys
// @Tags service-accounts
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Service account ID"
// @Success 200 {object} listResponse[repo.ServiceAccountKey]
// @Router /v1/service-accounts/{id}/keys [get]
func (h handlers) listServiceAccountKeys(c *gin.Context) {
	if !h.needServiceAccountOwner(c, c.Param("id")) {
		return
	}
	items, err := h.deps.repository.ListServiceAccountKeys(c.Request.Context(), c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, listResponse[repo.ServiceAccountKey]{Items: items})
}

// RevokeServiceAccountKey godoc
// @Summary Revoke service account key
// @Tags service-accounts
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Service account ID"
// @Param key_id path string true "Key ID"
// @Success 204
// @Router /v1/service-accounts/{id}/keys/{key_id} [delete]
func (h handlers) revokeServiceAccountKey(c *gin.Context) {
	if !h.needServiceAccountOwner(c, c.Param("id")) {
		return
	}
	if err := h.deps.repository.RevokeServiceAccountKey(c.Request.Context(), c.Param("id"), c.Param("key_id")); err != nil {
		internalErr(c, err)
		return
	}
	incServiceAccount("key_revoked", actorType(c))
	c.Status(http.StatusNoContent)
}

func (h handlers) needServiceAccountOwner(c *gin.Context, saID string) bool {
	p := current(c)
	if p.Type != auth.PrincipalUser {
		forbidden(c, "service account owner required")
		return false
	}
	sa, err := h.deps.repository.GetServiceAccount(c.Request.Context(), saID)
	if err != nil && !errors.Is(err, repo.ErrNotFound) {
		internalErr(c, err)
		return false
	}
	if err != nil || sa.Owner.ID != p.ID {
		forbidden(c, "service account owner required")
		return false
	}
	return true
}
