package notifications

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

type Store interface {
	repo.Repository
	commentNotificationStore
	documentAccessNotificationStore
	documentAccessRequestNotificationStore
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
type documentAccessRequestNotificationStore interface {
	ClaimDocumentAccessRequestNotification(context.Context) (*repo.DocumentAccessRequestNotification, error)
	FinishDocumentAccessRequestNotification(context.Context, repo.DocumentAccessRequestNotification, time.Duration) error
}
type Sender interface {
	Send(ctx context.Context, email string, message Message) error
}

type Message struct {
	Reason, Link, DocumentTitle, Highlight, Body, Requester, Actor string
	PreviousRole, Role                                             repo.Role
	DirectAccess                                                   bool
	Reply                                                          bool
}
type Worker struct {
	Store            Store
	Sender           Sender
	AppOrigin        string
	ResolvePrincipal func(context.Context, *auth.Principal) *auth.Principal
	nextFailureLog   time.Time
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
			w.logProcessingFailure("comment")
		}
		if err := w.DeliverNextDocumentAccess(ctx); err != nil {
			w.logProcessingFailure("document_access")
		}
		if err := w.DeliverNextDocumentAccessRequest(ctx); err != nil {
			w.logProcessingFailure("document_access_request")
		}
	}
}

func (w *Worker) DeliverNextDocumentAccessRequest(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	n, err := w.Store.ClaimDocumentAccessRequestNotification(ctx)
	if err != nil || n == nil {
		return err
	}
	retryAfter, err := w.deliverDocumentAccessRequest(ctx, *n)
	if err != nil {
		var deliveryCode string
		retryAfter, deliveryCode = notificationRetry(n.Attempts, err)
		slog.Warn("document access request notification delivery failed", "delivery_code", deliveryCode, "will_retry", retryAfter > 0)
	}
	return w.Store.FinishDocumentAccessRequestNotification(ctx, *n, retryAfter)
}

func (w *Worker) logProcessingFailure(kind string) {
	now := time.Now()
	if now.Before(w.nextFailureLog) {
		return
	}
	w.nextFailureLog = now.Add(time.Minute)
	slog.Error("notification processing failed", "kind", kind)
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
		var deliveryCode string
		retryAfter, deliveryCode = notificationRetry(n.Attempts, err)
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
		var deliveryCode string
		retryAfter, deliveryCode = notificationRetry(n.Attempts, err)
		slog.Warn("comment notification delivery failed", "delivery_code", deliveryCode, "will_retry", retryAfter > 0)
	}
	return w.Store.FinishCommentNotification(ctx, *n, retryAfter)
}

func notificationRetry(attempts int, err error) (time.Duration, string) {
	delay := time.Duration(1<<min(attempts, 8)) * time.Second
	code := "internal"
	var delivery *DeliveryError
	if !errors.As(err, &delivery) {
		return delay, code
	}
	code = delivery.Code
	if delivery.Permanent {
		return 0, code
	}
	return max(delay, delivery.RetryAfter), code
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

func (w *Worker) deliverDocumentAccessRequest(ctx context.Context, n repo.DocumentAccessRequestNotification) (time.Duration, error) {
	recipient, err := w.Store.ResolveUser(ctx, n.RecipientID)
	if errors.Is(err, repo.ErrNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	doc, err := w.Store.GetDocument(ctx, n.DocumentID)
	if errors.Is(err, repo.ErrNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	ownerID, err := w.documentNotificationOwner(ctx, doc)
	if errors.Is(err, repo.ErrNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if recipient.ID != ownerID || recipient.Email == "" {
		return 0, nil
	}
	prefs, err := w.Store.NotificationPreferences(ctx, recipient, n.DocumentID)
	if err != nil || !prefs.EffectiveEnabled {
		return 0, err
	}
	denied, err := w.requesterStillDenied(ctx, n)
	if err != nil {
		return 0, err
	}
	if !denied {
		return 0, nil
	}
	allowed, err := w.Store.ReserveNotificationDelivery(ctx, recipient.ID)
	if err != nil {
		return 0, err
	}
	if !allowed {
		return 6 * time.Second, nil
	}
	return 0, w.Sender.Send(ctx, recipient.Email, Message{
		Reason: "access_requested", Link: DocumentURL(w.AppOrigin, n.DocumentID) + "?share=1",
		DocumentTitle: doc.Title, Requester: n.RequesterLabel,
	})
}

func (w *Worker) requesterStillDenied(ctx context.Context, n repo.DocumentAccessRequestNotification) (bool, error) {
	requester := auth.Principal{Type: auth.PrincipalType(n.RequesterType), ID: n.RequesterID}
	if w.ResolvePrincipal != nil && requester.Type == auth.PrincipalUser {
		requester = *w.ResolvePrincipal(ctx, &requester)
	}
	role, err := w.Store.RoleForDocument(ctx, requester, n.DocumentID)
	return role == repo.RoleNone, err
}

func (w *Worker) documentNotificationOwner(ctx context.Context, doc repo.Document) (string, error) {
	if doc.Owner.Type != auth.PrincipalServiceAccount {
		return doc.Owner.ID, nil
	}
	sa, err := w.Store.GetServiceAccount(ctx, doc.Owner.ID)
	if err != nil {
		return "", err
	}
	return sa.Owner.ID, nil
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
		Actor: commentActor(c.Author), Reply: c.ParentCommentID != "",
	}, nil
}

func commentActor(author auth.Principal) string {
	if author.Name != "" {
		return author.Name
	}
	if author.Email != "" {
		return author.Email
	}
	if author.ID != "" {
		return author.ID
	}
	return "Someone"
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
