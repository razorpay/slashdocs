package server

import (
	"strings"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// principalResponse renders a principal with its optional identity fields.
type principalResponse struct {
	Type       auth.PrincipalType `json:"type"`
	ID         string             `json:"id"`
	Email      string             `json:"email,omitempty"`
	Name       string             `json:"name,omitempty"`
	PictureURL string             `json:"picture_url,omitempty"`
}

// userResponse is principalResponse without the "type" field, for endpoints
// that already convey the principal type separately.
type userResponse struct {
	ID         string `json:"id"`
	Email      string `json:"email,omitempty"`
	Name       string `json:"name,omitempty"`
	PictureURL string `json:"picture_url,omitempty"`
}

// commentPlacementResponse locates a comment's anchor within a version.
type commentPlacementResponse struct {
	VersionID   string      `json:"version_id"`
	Status      string      `json:"status"`
	Anchor      repo.Anchor `json:"anchor"`
	MatchedText string      `json:"matched_text"`
	Confidence  float64     `json:"confidence"`
}

// commentMentionResponse identifies a principal and the exact visible label in
// the comment body. Offset and length are UTF-16 code units so browser clients
// can use them directly with JavaScript string slicing.
type commentMentionPrincipalResponse struct {
	Type       commentMentionPrincipalType `json:"type"`
	ID         string                      `json:"id"`
	Email      string                      `json:"email,omitempty"`
	Name       string                      `json:"name,omitempty"`
	PictureURL string                      `json:"picture_url,omitempty"`
}

type commentMentionResponse struct {
	Principal commentMentionPrincipalResponse `json:"principal"`
	// Offset is the zero-based start in UTF-16 code units.
	Offset int64 `json:"offset"`
	// Length is the range length in UTF-16 code units.
	Length int64 `json:"length"`
}

// commentResponse is the API shape of a comment. current_placement and
// replies are present on root comments only; Replies is a pointer so an
// empty-but-present reply list ("replies": []) survives marshalling.
type commentResponse struct {
	ID                 string                    `json:"id"`
	Author             principalResponse         `json:"author"`
	Body               string                    `json:"body"`
	Status             string                    `json:"status"`
	CreatedOnVersionID string                    `json:"created_on_version_id"`
	CreatedAt          string                    `json:"created_at,omitempty"`
	ResolvedAt         string                    `json:"resolved_at,omitempty"`
	Edited             bool                      `json:"edited,omitempty"`
	ParentCommentID    string                    `json:"parent_comment_id,omitempty"`
	Mentions           []commentMentionResponse  `json:"mentions"`
	Reactions          []commentReactionResponse `json:"reactions"`
	SelectedText       string                    `json:"selected_text,omitempty"`
	Anchor             *repo.Anchor              `json:"anchor,omitempty"`
	CurrentPlacement   *commentPlacementResponse `json:"current_placement,omitempty"`
	Replies            *[]commentResponse        `json:"replies,omitempty"`
}

// commentReactionResponse is one emoji group on a comment. Reacted reports
// whether the principal making the request is among the reactors, which is why
// rendering a comment needs a viewer.
type commentReactionResponse struct {
	Emoji    string              `json:"emoji"`
	Count    int                 `json:"count"`
	Reacted  bool                `json:"reacted"`
	Reactors []principalResponse `json:"reactors"`
}

func commentsJSON(items []repo.Comment, placementVersionID string, placementHTML []byte, viewer auth.Principal) []commentResponse {
	// Stringify the version body once for all placement checks below.
	haystack := string(placementHTML)
	roots := make([]repo.Comment, 0, len(items))
	byID := map[string]int{}
	for _, cm := range items {
		if cm.ParentCommentID == "" {
			byID[cm.ID] = len(roots)
			if cm.Replies == nil {
				cm.Replies = []repo.Comment{}
			}
			roots = append(roots, cm)
		}
	}
	for _, cm := range items {
		if cm.ParentCommentID == "" {
			continue
		}
		rootID := cm.RootCommentID
		if rootID == "" {
			rootID = cm.ParentCommentID
		}
		if i, ok := byID[rootID]; ok {
			roots[i].Replies = append(roots[i].Replies, cm)
		}
	}
	out := make([]commentResponse, 0, len(roots))
	for _, cm := range roots {
		out = append(out, commentJSON(cm, placementVersionID, haystack, viewer))
	}
	return out
}

// commentPlacement reports whether a comment's selected text still appears in
// the given version, returning its placement status, a confidence score, and
// the matched text. placementHTML is the already-stringified version body.
func commentPlacement(cm repo.Comment, placementVersionID, placementHTML string) (status string, confidence float64, matched string) {
	status = placementAttached
	confidence = 1.0
	matched = cm.SelectedText
	if placementVersionID != cm.VersionID && len(placementHTML) > 0 && !strings.Contains(placementHTML, cm.SelectedText) {
		status = placementOrphaned
		confidence = 0
		matched = ""
	}
	return
}

func userJSON(p auth.Principal) userResponse {
	return userResponse{ID: p.ID, Email: p.Email, Name: p.Name, PictureURL: p.PictureURL}
}

func principalJSON(p auth.Principal) principalResponse {
	return principalResponse{Type: p.Type, ID: p.ID, Email: p.Email, Name: p.Name, PictureURL: p.PictureURL}
}

func commentJSON(cm repo.Comment, placementVersionID, placementHTML string, viewer auth.Principal) commentResponse {
	out := commentBaseJSON(cm, viewer)
	if cm.ParentCommentID == "" {
		if placementVersionID == "" {
			placementVersionID = cm.VersionID
		}
		status, confidence, matched := commentPlacement(cm, placementVersionID, placementHTML)
		out.CurrentPlacement = &commentPlacementResponse{
			VersionID:   placementVersionID,
			Status:      status,
			Anchor:      cm.Anchor,
			MatchedText: matched,
			Confidence:  confidence,
		}
		if cm.Replies != nil {
			replies := commentsReplyJSON(cm.Replies, viewer)
			out.Replies = &replies
		}
	}
	return out
}

func commentBaseJSON(cm repo.Comment, viewer auth.Principal) commentResponse {
	out := commentResponse{
		ID:                 cm.ID,
		Author:             principalJSON(cm.Author),
		Body:               cm.Body,
		Status:             cm.Status,
		CreatedOnVersionID: cm.VersionID,
		CreatedAt:          cm.CreatedAt,
		ResolvedAt:         cm.ResolvedAt,
		Edited:             cm.Edited,
		ParentCommentID:    cm.ParentCommentID,
		Mentions:           commentMentionsJSON(cm.Mentions),
		Reactions:          commentReactionsJSON(cm.Reactions, viewer),
	}
	if cm.SelectedText != "" {
		out.SelectedText = cm.SelectedText
		anchor := cm.Anchor
		out.Anchor = &anchor
	}
	return out
}

func commentMentionsJSON(items []repo.CommentMention) []commentMentionResponse {
	out := make([]commentMentionResponse, 0, len(items))
	for _, mention := range items {
		out = append(out, commentMentionResponse{
			Principal: commentMentionPrincipalResponse{
				Type:       commentMentionPrincipalType(mention.Principal.Type),
				ID:         mention.Principal.ID,
				Email:      mention.Principal.Email,
				Name:       mention.Principal.Name,
				PictureURL: mention.Principal.PictureURL,
			},
			Offset: mention.OffsetUTF16,
			Length: mention.LengthUTF16,
		})
	}
	return out
}

// commentReactionsJSON groups raw reaction rows into per-emoji counts and
// marks the ones the viewer joined. The repository returns rows in
// first-reaction order, so accumulating into a slice keyed by a side index
// preserves that order; ranging a map here would reshuffle the groups on every
// request.
func commentReactionsJSON(items []repo.CommentReaction, viewer auth.Principal) []commentReactionResponse {
	out := make([]commentReactionResponse, 0, len(items))
	at := make(map[string]int, len(items))
	for _, reaction := range items {
		i, ok := at[reaction.Emoji]
		if !ok {
			i = len(out)
			at[reaction.Emoji] = i
			out = append(out, commentReactionResponse{Emoji: reaction.Emoji})
		}
		out[i].Count++
		out[i].Reactors = append(out[i].Reactors, principalJSON(reaction.Principal))
		// Compare type as well as id: principal ids are only unique within a
		// principal type, so id alone would conflate a user with a service
		// account that happens to share it.
		if reaction.Principal.Type == viewer.Type && reaction.Principal.ID == viewer.ID {
			out[i].Reacted = true
		}
	}
	return out
}

func commentsReplyJSON(items []repo.Comment, viewer auth.Principal) []commentResponse {
	out := make([]commentResponse, 0, len(items))
	for _, cm := range items {
		out = append(out, commentBaseJSON(cm, viewer))
	}
	return out
}
