package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// FeaturedSection is one titled row of documents and folders that the
// Documents page shows to every principal above their own items.
type FeaturedSection struct {
	Title       string   `json:"-"`
	Description string   `json:"description"`
	Permanent   bool     `json:"permanent"` // Principals cannot hide the items.
	Items       []string `json:"items"`     // Document and folder IDs.
}

// ParseFeatured reads the SLASHDOCS_FEATURED JSON object. Each key is a section
// title, and the key order is the section order.
func ParseFeatured(raw string) ([]FeaturedSection, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, errors.New("must be a JSON object that maps section titles to sections")
	}
	var sections []FeaturedSection
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return nil, err
		}
		title, ok := key.(string)
		if !ok {
			return nil, fmt.Errorf("section key %v is not a string", key)
		}
		section := FeaturedSection{Title: strings.TrimSpace(title)}
		if err := dec.Decode(&section); err != nil {
			return nil, fmt.Errorf("section %q: %w", section.Title, err)
		}
		if section.Title == "" || len(section.Items) == 0 {
			return nil, fmt.Errorf("section %q: a section needs a title and at least one item", section.Title)
		}
		for _, id := range section.Items {
			if featuredType(id) == "" {
				return nil, fmt.Errorf("section %q: %q is not a document (doc_) or folder (fld_) ID", section.Title, id)
			}
		}
		sections = append(sections, section)
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	return sections, nil
}

func featuredType(id string) string {
	switch {
	case strings.HasPrefix(id, "doc_"):
		return "document"
	case strings.HasPrefix(id, "fld_"):
		return "folder"
	}
	return ""
}

type featuredSectionResponse struct {
	Title       string             `json:"title"`
	Description string             `json:"description,omitempty"`
	Permanent   bool               `json:"permanent"`
	Items       []repo.FolderEntry `json:"items"`
}

// listFeatured returns each section with the items that the principal can
// view and did not hide. Sections with no such items are left out.
func (h handlers) listFeatured(c *gin.Context) {
	if !requireResolvedGroupsForAggregate(c) {
		return
	}
	ctx, p := c.Request.Context(), *current(c)
	hidden, err := h.deps.repository.ListHiddenFeaturedItems(ctx, p)
	if err != nil {
		internalErr(c, err)
		return
	}
	sections := []featuredSectionResponse{}
	for _, section := range h.deps.featured {
		out := featuredSectionResponse{Title: section.Title, Description: section.Description, Permanent: section.Permanent}
		for _, id := range section.Items {
			if !section.Permanent && slices.Contains(hidden, id) {
				continue
			}
			entry, err := h.featuredEntry(ctx, p, id)
			if err != nil {
				internalErr(c, err)
				return
			}
			if entry != nil {
				out.Items = append(out.Items, *entry)
			}
		}
		if len(out.Items) > 0 {
			sections = append(sections, out)
		}
	}
	c.JSON(http.StatusOK, listResponse[featuredSectionResponse]{Items: sections})
}

// featuredEntry loads one featured item. It returns nil when the item does
// not exist or the principal cannot view it.
func (h handlers) featuredEntry(ctx context.Context, p auth.Principal, id string) (*repo.FolderEntry, error) {
	r := h.deps.repository
	entry := repo.FolderEntry{Type: featuredType(id)}
	roleFor := r.RoleForDocument
	if entry.Type == "folder" {
		roleFor = r.RoleForFolder
	}
	role, err := roleFor(ctx, p, id)
	if err != nil || !atLeast(role, repo.RoleViewer) {
		return nil, err
	}
	if entry.Type == "folder" {
		var folder repo.Folder
		folder, err = r.GetFolder(ctx, id)
		entry.Folder = &folder
	} else {
		var document repo.Document
		document, err = r.GetDocument(ctx, id)
		entry.Document = repo.DocumentAsFolderEntry(document)
	}
	if errors.Is(err, repo.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &entry, nil
}

// hideFeatured hides an item for the principal. Items in permanent sections
// cannot be hidden.
func (h handlers) hideFeatured(c *gin.Context) {
	id := c.Param("id")
	hideable := slices.ContainsFunc(h.deps.featured, func(s FeaturedSection) bool {
		return !s.Permanent && slices.Contains(s.Items, id)
	})
	if !hideable {
		notFound(c)
		return
	}
	if err := h.deps.repository.HideFeaturedItem(c.Request.Context(), *current(c), id); err != nil {
		internalErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
