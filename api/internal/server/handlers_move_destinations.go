package server

import (
	"crypto/hmac"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

const (
	moveDestinationCursorAudience = "move-destination-cursor"
	moveDestinationCursorTTL      = 30 * time.Minute
	moveDestinationDefaultLimit   = 50
	moveDestinationSearchLimit    = 25
	moveDestinationQueryMax       = 200
	moveDestinationCursorMax      = 4096
	moveSourceTokenLength         = len("ms1.") + 86
)

type moveDestinationSourceResponse struct {
	Kind     string `json:"kind"`
	FolderID string `json:"folder_id,omitempty"`
	Token    string `json:"token,omitempty"`
}

type moveDestinationResourceResponse struct {
	Type             string                        `json:"type"`
	ID               string                        `json:"id"`
	Title            string                        `json:"title"`
	CanMove          bool                          `json:"can_move"`
	CannotMoveReason string                        `json:"cannot_move_reason,omitempty"`
	Source           moveDestinationSourceResponse `json:"source"`
}

type moveDestinationRootResponse struct {
	Selectable      bool   `json:"selectable"`
	Current         bool   `json:"current"`
	Reason          string `json:"reason,omitempty"`
	CanCreateChild  bool   `json:"can_create_child"`
	WouldLoseAccess bool   `json:"would_lose_access,omitempty"`
}

type moveDestinationLevelResponse struct {
	Parent *string                    `json:"parent"`
	Items  []repo.MoveDestinationNode `json:"items"`
	Before string                     `json:"before,omitempty"`
	After  string                     `json:"after,omitempty"`
}

type moveDestinationsResponse struct {
	Resource             moveDestinationResourceResponse `json:"resource"`
	Documents            moveDestinationRootResponse     `json:"documents"`
	Path                 []string                        `json:"path"`
	PathRestrictedPrefix bool                            `json:"path_restricted_prefix"`
	Levels               []moveDestinationLevelResponse  `json:"levels"`
	Focus                string                          `json:"focus,omitempty"`
}

type moveDestinationChildrenResponse struct {
	Parent *string                    `json:"parent"`
	Items  []repo.MoveDestinationNode `json:"items"`
	Before string                     `json:"before,omitempty"`
	After  string                     `json:"after,omitempty"`
	Next   string                     `json:"next,omitempty"`
}

type moveDestinationSearchResponse struct {
	Items   []repo.MoveDestinationNode `json:"items"`
	HasMore bool                       `json:"has_more"`
}

type moveDestinationCursor struct {
	Version       int    `json:"v"`
	PrincipalType string `json:"pt"`
	PrincipalID   string `json:"pi"`
	ResourceType  string `json:"rt"`
	ResourceID    string `json:"ri"`
	Parent        string `json:"p"`
	Direction     string `json:"d"`
	Title         string `json:"t"`
	ID            string `json:"i"`
}

func (h handlers) moveDestinations(c *gin.Context) {
	if !requireResolvedGroupsForAggregate(c) {
		return
	}
	resourceType, resourceID, ok := moveDestinationResourceParams(c)
	if !ok {
		return
	}
	includeOrgWide := h.deps.deployment == DeploymentOrg
	reveal := strings.TrimSpace(c.Query("reveal"))
	bootstrap, err := h.deps.repository.BootstrapMoveDestinations(c.Request.Context(), *current(c), resourceType, resourceID, reveal, moveDestinationDefaultLimit, includeOrgWide)
	if err != nil {
		h.respondMoveDestinationReadError(c, err)
		return
	}
	resource := bootstrap.Resource

	response := moveDestinationsResponse{
		Resource: moveDestinationResourceResponse{
			Type: resource.Type, ID: resource.ID, Title: resource.Title, CanMove: resource.CanMove,
			CannotMoveReason: resource.CannotMoveReason,
		},
		Path: bootstrap.Path, PathRestrictedPrefix: bootstrap.PathRestricted,
		Documents: moveDestinationRootResponse{
			Selectable:      resource.CanMove && resource.Source.Kind != "root",
			Current:         resource.Source.Kind == "root",
			CanCreateChild:  resource.CanMove,
			WouldLoseAccess: resource.WouldLoseAccess,
		},
	}
	response.Resource.Source = h.moveDestinationSource(*current(c), resource)
	if response.Documents.Current {
		response.Documents.Reason = "current"
	} else if !resource.CanMove {
		response.Documents.Reason = "view_only"
	}

	for _, level := range bootstrap.Levels {
		response.Levels = append(response.Levels, h.moveDestinationLevel(*current(c), resourceType, resourceID, level.Parent, level.Page))
	}
	response.Focus = bootstrap.Focus
	c.JSON(http.StatusOK, response)
}

func (h handlers) moveDestinationChildren(c *gin.Context) { //nolint:gocyclo // Cursor, anchor, and signed pagination validation stay together at the HTTP boundary.
	if !requireResolvedGroupsForAggregate(c) {
		return
	}
	resourceType, resourceID, ok := moveDestinationResourceParams(c)
	if !ok {
		return
	}
	parent := strings.TrimSpace(c.Query("parent"))
	if parent == "" {
		badRequest(c, "parent is required")
		return
	}
	if parent == "root" {
		parent = ""
	}
	limit, ok := boundedMoveDestinationLimit(c, moveDestinationDefaultLimit)
	if !ok {
		return
	}
	var key *repo.MoveDestinationKey
	rawCursor := c.Query("cursor")
	anchor := strings.TrimSpace(c.Query("anchor"))
	direction := strings.TrimSpace(c.Query("direction"))
	if len(rawCursor) > moveDestinationCursorMax {
		c.JSON(http.StatusBadRequest, errorResponse("invalid_cursor", "invalid cursor", nil))
		return
	}
	if cursor := strings.TrimSpace(rawCursor); cursor != "" {
		if anchor != "" || direction != "" {
			badRequest(c, "cursor and anchor pagination are mutually exclusive")
			return
		}
		key, ok = h.verifyMoveDestinationCursor(cursor, *current(c), resourceType, resourceID, parent)
		if !ok {
			c.JSON(http.StatusBadRequest, errorResponse("invalid_cursor", "invalid cursor", nil))
			return
		}
	} else if anchor != "" || direction != "" {
		if anchor == "" || (direction != "before" && direction != "after") {
			badRequest(c, "anchor requires direction before or after")
			return
		}
	}
	includeOrgWide := h.deps.deployment == DeploymentOrg
	page, err := h.deps.repository.ListMoveDestinations(c.Request.Context(), *current(c), resourceType, resourceID, parent, key, anchor, direction, limit, includeOrgWide)
	if err != nil {
		h.respondMoveDestinationReadError(c, err)
		return
	}
	response := moveDestinationChildrenResponse{Parent: nullableMoveDestinationParent(parent), Items: page.Items}
	if page.Before != nil {
		response.Before = h.signMoveDestinationCursor(*current(c), resourceType, resourceID, parent, "before", *page.Before)
	}
	if page.After != nil {
		response.After = h.signMoveDestinationCursor(*current(c), resourceType, resourceID, parent, "after", *page.After)
	}
	if key != nil && key.Before || direction == "before" {
		response.Next = response.Before
	} else {
		response.Next = response.After
	}
	c.JSON(http.StatusOK, response)
}

func (h handlers) searchMoveDestinations(c *gin.Context) {
	if !requireResolvedGroupsForAggregate(c) {
		return
	}
	resourceType, resourceID, ok := moveDestinationResourceParams(c)
	if !ok {
		return
	}
	query := strings.TrimSpace(c.Query("q"))
	if len([]rune(query)) < 2 || len(query) > moveDestinationQueryMax {
		badRequest(c, "q must be between 2 and 200 characters")
		return
	}
	limit, ok := boundedMoveDestinationLimit(c, moveDestinationSearchLimit)
	if !ok {
		return
	}
	if limit > moveDestinationSearchLimit {
		limit = moveDestinationSearchLimit
	}
	result, err := h.deps.repository.SearchMoveDestinations(c.Request.Context(), *current(c), resourceType, resourceID, query, limit, h.deps.deployment == DeploymentOrg)
	if err != nil {
		h.respondMoveDestinationReadError(c, err)
		return
	}
	c.JSON(http.StatusOK, moveDestinationSearchResponse{Items: result.Items, HasMore: result.HasMore})
}

type moveDocumentDestination struct {
	Kind     string `json:"kind"`
	FolderID string `json:"folder_id,omitempty"`
}

type moveDocumentRequest struct {
	Destination           moveDocumentDestination `json:"destination"`
	SourceToken           string                  `json:"source_token"`
	AcknowledgeAccessLoss bool                    `json:"acknowledge_access_loss,omitempty"`
}

type moveDocumentUndo struct {
	Destination moveDocumentDestination `json:"destination"`
	SourceToken string                  `json:"source_token"`
}

type moveDocumentResponse struct {
	DocumentID        string                  `json:"document_id"`
	Moved             bool                    `json:"moved"`
	Destination       moveDocumentDestination `json:"destination"`
	PermissionWarning *permissionWarning      `json:"permission_warning,omitempty"`
	Undo              *moveDocumentUndo       `json:"undo"`
	AccessLost        bool                    `json:"access_lost,omitempty"`
}

func (h handlers) moveDocument(c *gin.Context) {
	if !requireJSON(c) {
		return
	}
	var request moveDocumentRequest
	if c.ShouldBindJSON(&request) != nil || request.SourceToken == "" {
		badRequest(c, "invalid move")
		return
	}
	destination := ""
	switch request.Destination.Kind {
	case "root":
		if request.Destination.FolderID != "" {
			badRequest(c, "root destination cannot have folder_id")
			return
		}
	case "folder":
		if request.Destination.FolderID == "" {
			badRequest(c, "folder destination needs folder_id")
			return
		}
		destination = request.Destination.FolderID
	default:
		badRequest(c, "invalid destination")
		return
	}
	if !requireResolvedGroupsForAggregate(c) {
		return
	}
	principal := *current(c)
	documentID := c.Param("id")
	result, previousSource, undoAllowed, err := h.deps.repository.MoveDocument(c.Request.Context(), principal, documentID, destination, request.AcknowledgeAccessLoss, func(source repo.MoveSource) bool {
		return h.verifyMoveSourceToken(request.SourceToken, principal, documentID, source)
	})
	if err != nil {
		respondDocumentMoveError(c, err)
		return
	}
	if result.Moved {
		h.accessChanged(c, documentID)
	}
	response := moveDocumentResponse{DocumentID: documentID, Moved: result.Moved, Destination: request.Destination, AccessLost: result.AccessLost}
	if result.PermissionWarning {
		response.PermissionWarning = mayBroadenAccessWarning(folderDocumentWarningMessage)
	}
	if result.Moved && undoAllowed {
		undoDestination := moveDocumentDestination{Kind: previousSource.Kind, FolderID: previousSource.FolderID}
		newSource := repo.MoveSource{Kind: "root"}
		if destination != "" {
			newSource = repo.MoveSource{Kind: "folder", FolderID: destination}
		}
		response.Undo = &moveDocumentUndo{
			Destination: undoDestination,
			SourceToken: h.signMoveSourceToken(principal, documentID, newSource),
		}
	}
	c.JSON(http.StatusOK, response)
}

func moveDestinationResourceParams(c *gin.Context) (string, string, bool) {
	resourceType := strings.TrimSpace(c.Query("resource_type"))
	resourceID := strings.TrimSpace(c.Query("resource_id"))
	if (resourceType != "document" && resourceType != "folder") || resourceID == "" {
		badRequest(c, "resource_type and resource_id are required")
		return "", "", false
	}
	return resourceType, resourceID, true
}

func boundedMoveDestinationLimit(c *gin.Context, maximum int) (int, bool) {
	limit := maximum
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			badRequest(c, "invalid limit")
			return 0, false
		}
		limit = parsed
	}
	if limit > maximum {
		limit = maximum
	}
	return limit, true
}

func nullableMoveDestinationParent(parent string) *string {
	if parent == "" {
		return nil
	}
	return &parent
}

func (h handlers) moveDestinationLevel(p auth.Principal, resourceType, resourceID, parent string, page repo.MoveDestinationPage) moveDestinationLevelResponse {
	level := moveDestinationLevelResponse{Parent: nullableMoveDestinationParent(parent), Items: page.Items}
	if page.Before != nil {
		level.Before = h.signMoveDestinationCursor(p, resourceType, resourceID, parent, "before", *page.Before)
	}
	if page.After != nil {
		level.After = h.signMoveDestinationCursor(p, resourceType, resourceID, parent, "after", *page.After)
	}
	return level
}

func (h handlers) signMoveDestinationCursor(p auth.Principal, resourceType, resourceID, parent, direction string, key repo.MoveDestinationKey) string {
	payload, _ := json.Marshal(moveDestinationCursor{
		Version: 1, PrincipalType: string(p.Type), PrincipalID: p.ID, ResourceType: resourceType,
		ResourceID: resourceID, Parent: parent, Direction: direction, Title: key.Title, ID: key.ID,
	})
	return (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).SignForAudience(string(payload), moveDestinationCursorAudience, moveDestinationCursorTTL)
}

func (h handlers) verifyMoveDestinationCursor(value string, p auth.Principal, resourceType, resourceID, parent string) (*repo.MoveDestinationKey, bool) {
	subject, ok := (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).VerifyAudience(value, moveDestinationCursorAudience)
	if !ok {
		return nil, false
	}
	var cursor moveDestinationCursor
	if json.Unmarshal([]byte(subject), &cursor) != nil || cursor.Version != 1 || cursor.ID == "" || cursor.Title == "" {
		return nil, false
	}
	if cursor.PrincipalType != string(p.Type) || cursor.PrincipalID != p.ID || cursor.ResourceType != resourceType || cursor.ResourceID != resourceID || cursor.Parent != parent {
		return nil, false
	}
	if cursor.Direction != "after" && cursor.Direction != "before" {
		return nil, false
	}
	return &repo.MoveDestinationKey{Title: cursor.Title, ID: cursor.ID, Before: cursor.Direction == "before"}, true
}

func (h handlers) moveDestinationSource(p auth.Principal, resource repo.MoveDestinationResource) moveDestinationSourceResponse {
	source := moveDestinationSourceResponse{Kind: resource.Source.Kind}
	if resource.Source.Kind == "folder" {
		if resource.SourceVisible {
			source.FolderID = resource.Source.FolderID
		} else {
			source.Kind = "restricted"
		}
	}
	if resource.Type == "document" && resource.CanMove {
		source.Token = h.signMoveSourceToken(p, resource.ID, resource.Source)
	}
	return source
}

func (h handlers) respondMoveDestinationReadError(c *gin.Context, err error) {
	if errors.Is(err, repo.ErrNotFound) || errors.Is(err, repo.ErrForbidden) {
		notFound(c)
		return
	}
	internalErr(c, err)
}

func (h handlers) signMoveSourceToken(p auth.Principal, documentID string, source repo.MoveSource) string {
	mac := hmac.New(sha512.New, moveSourceTokenKey(h.deps.sessionSecret))
	writeMoveSourceMACField(mac, "move-source-v1")
	writeMoveSourceMACField(mac, string(p.Type))
	writeMoveSourceMACField(mac, p.ID)
	writeMoveSourceMACField(mac, documentID)
	writeMoveSourceMACField(mac, source.Kind)
	writeMoveSourceMACField(mac, source.FolderID)
	return "ms1." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func moveSourceTokenKey(sessionSecret string) []byte {
	derive := hmac.New(sha512.New, []byte(sessionSecret))
	_, _ = derive.Write([]byte("slashdocs/move-source-token/key/v1"))
	return derive.Sum(nil)
}

func writeMoveSourceMACField(mac interface{ Write([]byte) (int, error) }, value string) {
	_, _ = fmt.Fprintf(mac, "%d:%s", len(value), value)
}

func (h handlers) verifyMoveSourceToken(value string, p auth.Principal, documentID string, source repo.MoveSource) bool {
	if len(value) != moveSourceTokenLength || !strings.HasPrefix(value, "ms1.") {
		return false
	}
	expected := h.signMoveSourceToken(p, documentID, source)
	return hmac.Equal([]byte(value), []byte(expected))
}
