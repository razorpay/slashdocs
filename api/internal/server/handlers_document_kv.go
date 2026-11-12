package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

const (
	maxKVKeyBytes     = 128
	maxKVValueBytes   = 64 * 1024
	maxKVPatchBytes   = 256 * 1024
	maxKVPatchChanges = 256
)

func (h handlers) listDocumentKV(c *gin.Context) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, repo.RoleViewer) {
		return
	}
	out, err := h.deps.repository.ListDocumentKV(c.Request.Context(), docID)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}

func (h handlers) patchDocumentKV(c *gin.Context) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, repo.RoleEditor) {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxKVPatchBytes+1)
	var in struct {
		Set    map[string]json.RawMessage `json:"set"`
		Delete []string                   `json:"delete"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) || strings.Contains(err.Error(), "http: request body too large") {
			c.JSON(http.StatusRequestEntityTooLarge, errorResponse("payload_too_large", "KV patch exceeds 256 KiB", nil))
			return
		}
		badRequest(c, "invalid KV patch")
		return
	}
	set, deleteKeys, ok := normalizeKVPatch(c, in.Set, in.Delete)
	if !ok {
		return
	}
	out, err := h.deps.repository.PatchDocumentKV(c.Request.Context(), docID, set, deleteKeys, *current(c))
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, out)
}

func normalizeKVPatch(c *gin.Context, inSet map[string]json.RawMessage, inDelete []string) (map[string]json.RawMessage, []string, bool) {
	set := map[string]json.RawMessage{}
	deleteSeen := map[string]bool{}
	var deleteKeys []string
	for key, raw := range inSet {
		if !validKVKey(key) {
			badRequest(c, "invalid KV key")
			return nil, nil, false
		}
		if isJSONNull(raw) {
			if !deleteSeen[key] {
				deleteSeen[key] = true
				deleteKeys = append(deleteKeys, key)
			}
			continue
		}
		if len(raw) > maxKVValueBytes {
			c.JSON(http.StatusRequestEntityTooLarge, errorResponse("payload_too_large", "KV value exceeds 64 KiB", nil))
			return nil, nil, false
		}
		set[key] = append(json.RawMessage(nil), raw...)
	}
	for _, key := range inDelete {
		if !validKVKey(key) {
			badRequest(c, "invalid KV key")
			return nil, nil, false
		}
		delete(set, key)
		if !deleteSeen[key] {
			deleteSeen[key] = true
			deleteKeys = append(deleteKeys, key)
		}
	}
	if len(set)+len(deleteKeys) > maxKVPatchChanges {
		c.JSON(http.StatusRequestEntityTooLarge, errorResponse("payload_too_large", "KV patch has too many keys", nil))
		return nil, nil, false
	}
	return set, deleteKeys, true
}

func isJSONNull(raw json.RawMessage) bool {
	return strings.EqualFold(strings.TrimSpace(string(raw)), "null")
}

func validKVKey(key string) bool {
	if key == "" || len(key) > maxKVKeyBytes {
		return false
	}
	for _, r := range key {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			continue
		}
		switch r {
		case '.', '_', ':', '-':
			continue
		default:
			return false
		}
	}
	return true
}
