package server

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

func (h handlers) searchUsers(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	if len(q) < 2 {
		c.JSON(http.StatusOK, listResponse[auth.Principal]{Items: []auth.Principal{}})
		return
	}
	ctx := c.Request.Context()
	// On a public server anyone can sign in, so a few letters must not list
	// strangers. There, a partial query finds only the caller's contacts.
	var items []auth.Principal
	var err error
	if h.deps.deployment == DeploymentOrg {
		items, err = h.deps.repository.SearchUsersByEmail(ctx, q)
	} else {
		items, err = h.deps.repository.SearchContacts(ctx, *current(c), q)
	}
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, listResponse[auth.Principal]{Items: items})
}
