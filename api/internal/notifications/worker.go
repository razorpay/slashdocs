package notifications

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/razorpay/aidocs/api/internal/auth"
	"github.com/razorpay/aidocs/api/internal/repo"
)

type Store interface {
	repo.Repository
	commentNotificationStore
	documentAccessNotificationStore
}

type commentNotificationStore interface {
	ClaimCommentNotification(context.Context) (*repo.CommentNotification, error)
	FinishCommentNotification(context.Context, repo.CommentNotification, time.Duration) error
	ReserveNotificationDelivery(context.Context, string) (bool, error)
}

type documentAccessNotificationStore interface {
	ClaimDocumentAccessNotification(context.Context) (*repo.DocumentAccessNotification, error)
	FinishDocumentAccessNotification(context.Context, repo.DocumentAccessNotification, time.Duration) error
	DirectDocumentGrantRole(context.Context, string, string) (repo.Role, error)
}
type Sender interface {
	Send(ctx context.Context, email string, message Message) error
}

type Message struct {
	Reason, Link, DocumentTitle, Highlight, Body string
	PreviousRole, Role                           repo.Role
	DirectAccess                                 bool
	Reply                                        bool
}
type Worker struct {
	Store            Store
	Sender           Sender
	AppOrigin        string
	ResolvePrincipal func(context.Context, *auth.Principal) *auth.Principal
}

func (w *Worker) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if err := w.DeliverNext(ctx); err != nil {
			slog.Error("comment notification processing failed")
		}
		if err := w.DeliverNextDocumentAccess(ctx); err != nil {
			slog.Error("document access notification processing failed")
		}
	}
}

func (w *Worker) DeliverNextDocumentAccess(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	n, err := w.Store.ClaimDocumentAccessNotification(ctx)
	if err != nil || n == nil {
		return err
	}
	retryAfter, err := w.deliverDocumentAccess(ctx, *n)
	if err != nil {
		retryAfter = time.Duration(1<<min(n.Attempts, 8)) * time.Second
		var delivery *DeliveryError
		deliveryCode := "internal"
		if errors.As(err, &delivery) {
			deliveryCode = delivery.Code
			if delivery.Permanent {
				retryAfter = 0
			} else {
				retryAfter = max(retryAfter, delivery.RetryAfter)
			}
		}
		slog.Warn("document access notification delivery failed", "delivery_code", deliveryCode, "will_retry", retryAfter > 0)
	}
	return w.Store.FinishDocumentAccessNotification(ctx, *n, retryAfter)
}

func (w *Worker) DeliverNext(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	n, err := w.Store.ClaimCommentNotification(ctx)
	if err != nil || n == nil {
		return err
	}
	retryAfter, err := w.deliver(ctx, *n)
	if err != nil {
		retryAfter = time.Duration(1<<min(n.Attempts, 8)) * time.Second
		var delivery *DeliveryError
		deliveryCode := "internal"
		if errors.As(err, &delivery) {
			deliveryCode = delivery.Code
			if delivery.Permanent {
				retryAfter = 0
			} else {
				retryAfter = max(retryAfter, delivery.RetryAfter)
			}
		}
		slog.Warn("comment notification delivery failed", "delivery_code", deliveryCode, "will_retry", retryAfter > 0)
	}
	return w.Store.FinishCommentNotification(ctx, *n, retryAfter)
}

func (w *Worker) deliver(ctx context.Context, n repo.CommentNotification) (time.Duration, error) {
	p, err := w.Store.ResolveUser(ctx, n.RecipientID)
	if errors.Is(err, repo.ErrNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	c, err := w.Store.GetComment(ctx, n.CommentID)
	if errors.Is(err, repo.ErrNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if p.Email == "" || (c.Author.Type == p.Type && c.Author.ID == p.ID) {
		return 0, nil
	}
	prefs, err := w.Store.NotificationPreferences(ctx, p, c.DocumentID)
	if err != nil {
		return 0, err
	}
	if !prefs.EffectiveEnabled {
		return 0, nil
	}
	if permitted, err := w.canRead(ctx, p, c.DocumentID); err != nil || !permitted {
		return 0, err
	}
	allowed, err := w.Store.ReserveNotificationDelivery(ctx, p.ID)
	if err != nil {
		return 0, err
	}
	if !allowed {
		return 6 * time.Second, nil
	}
	return 0, w.sendComment(ctx, p.Email, n, c)
}

func (w *Worker) deliverDocumentAccess(ctx context.Context, n repo.DocumentAccessNotification) (time.Duration, error) {
	p, err := w.Store.ResolveUser(ctx, n.RecipientID)
	if errors.Is(err, repo.ErrNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if p.Email == "" {
		return 0, nil
	}
	prefs, err := w.Store.NotificationPreferences(ctx, p, n.DocumentID)
	if err != nil || !prefs.EffectiveEnabled {
		return 0, err
	}
	var currentRole repo.Role
	if n.Source == "direct" {
		currentRole, err = w.Store.DirectDocumentGrantRole(ctx, n.DocumentID, p.ID)
	} else {
		if w.ResolvePrincipal != nil {
			p = *w.ResolvePrincipal(ctx, &p)
		}
		currentRole, err = w.Store.RoleForDocument(ctx, p, n.DocumentID)
	}
	if err != nil {
		return 0, err
	}
	// A newer grant or membership change supersedes this claimed event. Its
	// transaction either queued the current state or made this message stale.
	if currentRole != n.Role {
		return 0, nil
	}
	doc, err := w.Store.GetDocument(ctx, n.DocumentID)
	if errors.Is(err, repo.ErrNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	allowed, err := w.Store.ReserveNotificationDelivery(ctx, p.ID)
	if err != nil {
		return 0, err
	}
	if !allowed {
		return 6 * time.Second, nil
	}
	return 0, w.Sender.Send(ctx, p.Email, Message{
		Reason: n.Reason, Link: DocumentURL(w.AppOrigin, n.DocumentID), DocumentTitle: doc.Title,
		PreviousRole: n.PreviousRole, Role: n.Role, DirectAccess: n.Source == "direct",
	})
}

func (w *Worker) sendComment(ctx context.Context, email string, n repo.CommentNotification, c repo.Comment) error {
	message, err := w.message(ctx, n, c)
	if errors.Is(err, repo.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return w.Sender.Send(ctx, email, message)
}

func (w *Worker) message(ctx context.Context, n repo.CommentNotification, c repo.Comment) (Message, error) {
	doc, err := w.Store.GetDocument(ctx, c.DocumentID)
	if err != nil {
		return Message{}, err
	}
	highlight := c.SelectedText
	if c.ParentCommentID != "" {
		root, err := w.Store.GetComment(ctx, c.RootCommentID)
		if err != nil {
			return Message{}, err
		}
		if root.DocumentID != c.DocumentID {
			return Message{}, repo.ErrNotFound
		}
		highlight = root.SelectedText
	}
	return Message{
		Reason: n.Reason, Link: CommentURL(w.AppOrigin, c.DocumentID, c.ID),
		DocumentTitle: doc.Title, Highlight: highlight, Body: c.Body,
		Reply: c.ParentCommentID != "",
	}, nil
}

func (w *Worker) canRead(ctx context.Context, p auth.Principal, documentID string) (bool, error) {
	if w.ResolvePrincipal != nil {
		p = *w.ResolvePrincipal(ctx, &p)
	}
	role, err := w.Store.RoleForDocument(ctx, p, documentID)
	if err != nil {
		return false, err
	}
	if role == repo.RoleNone {
		if p.GoogleGroupMembershipState == auth.GoogleGroupMembershipUnavailable {
			return false, errors.New("group access unavailable")
		}
		return false, nil
	}
	return true, nil
}
