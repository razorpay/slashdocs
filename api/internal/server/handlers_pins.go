package server

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

func (h handlers) listPins(c *gin.Context) {
	items, err := h.deps.repository.ListPins(c.Request.Context(), *current(c))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, listResponse[repo.Pin]{Items: items})
}
func (h handlers) putPin(c *gin.Context) {
	rt, rid := c.Param("resource_type"), c.Param("resource_id")
	var role repo.Role
	var err error
	switch rt {
	case "document":
		role, err = h.deps.repository.RoleForDocument(c.Request.Context(), *current(c), rid)
	case "folder":
		role, err = h.deps.repository.RoleForFolder(c.Request.Context(), *current(c), rid)
	}
	if err != nil {
		internalErr(c, err)
		return
	}
	if !atLeast(role, repo.RoleViewer) {
		forbidden(c, "viewer role required")
		return
	}
	if err := h.deps.repository.PutPin(c.Request.Context(), *current(c), rt, rid); err != nil {
		internalErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
func (h handlers) deletePin(c *gin.Context) {
	if err := h.deps.repository.DeletePin(c.Request.Context(), *current(c), c.Param("resource_type"), c.Param("resource_id")); err != nil {
		internalErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
