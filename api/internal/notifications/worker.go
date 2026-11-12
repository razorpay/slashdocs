package notifications

import (
	"context"
	"errors"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

type Store interface {
	repo.Repository
	commentNotificationStore
	documentAccessNotificationStore
	documentAccessRequestNotificationStore
	approvalNotificationStore
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
type approvalNotificationStore interface {
	ClaimApprovalNotification(context.Context) (*repo.ApprovalNotification, error)
	FinishApprovalNotification(context.Context, repo.ApprovalNotification, time.Duration) error
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

// Worker delivers each queued message through every provider in Senders,
// which maps a provider name to its sender.
type Worker struct {
	Store            Store
	Senders          map[string]Sender
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
		if err := w.DeliverNextApproval(ctx); err != nil {
			w.logProcessingFailure("approval")
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
	retryAfter, err := w.deliverDocumentAccessRequest(ctx, n)
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
	retryAfter, err := w.deliverDocumentAccess(ctx, n)
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
	retryAfter, err := w.deliver(ctx, n)
	if err != nil {
		var deliveryCode string
		retryAfter, deliveryCode = notificationRetry(n.Attempts, err)
		slog.Warn("comment notification delivery failed", "delivery_code", deliveryCode, "will_retry", retryAfter > 0)
	}
	return w.Store.FinishCommentNotification(ctx, *n, retryAfter)
}

// notificationRetry retries while any provider can still deliver. The logged
// code names each failed provider.
func notificationRetry(attempts int, err error) (time.Duration, string) {
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		var retryAfter time.Duration
		var codes []string
		for _, err := range joined.Unwrap() {
			delay, code := notificationRetry(attempts, err)
			if failed, ok := err.(providerError); ok {
				code = failed.provider + ":" + code
			}
			retryAfter, codes = max(retryAfter, delay), append(codes, code)
		}
		return retryAfter, strings.Join(codes, ",")
	}
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

func (w *Worker) deliver(ctx context.Context, n *repo.CommentNotification) (time.Duration, error) {
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

func (w *Worker) deliverDocumentAccess(ctx context.Context, n *repo.DocumentAccessNotification) (time.Duration, error) {
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
	return 0, w.send(ctx, &n.FinishedProviders, p.Email, Message{
		Reason: n.Reason, Link: DocumentURL(w.AppOrigin, n.DocumentID), DocumentTitle: doc.Title,
		PreviousRole: n.PreviousRole, Role: n.Role, DirectAccess: n.Source == "direct",
	})
}

func (w *Worker) deliverDocumentAccessRequest(ctx context.Context, n *repo.DocumentAccessRequestNotification) (time.Duration, error) {
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
	return 0, w.send(ctx, &n.FinishedProviders, recipient.Email, Message{
		Reason: "access_requested", Link: DocumentURL(w.AppOrigin, n.DocumentID) + "?share=1",
		DocumentTitle: doc.Title, Requester: n.RequesterLabel,
	})
}

func (w *Worker) DeliverNextApproval(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	n, err := w.Store.ClaimApprovalNotification(ctx)
	if err != nil || n == nil {
		return err
	}
	retryAfter, err := w.deliverApproval(ctx, n)
	if err != nil {
		var deliveryCode string
		retryAfter, deliveryCode = notificationRetry(n.Attempts, err)
		slog.Warn("approval notification delivery failed", "delivery_code", deliveryCode, "will_retry", retryAfter > 0)
	}
	return w.Store.FinishApprovalNotification(ctx, *n, retryAfter)
}

func (w *Worker) deliverApproval(ctx context.Context, n *repo.ApprovalNotification) (time.Duration, error) {
	recipient, err := w.Store.ResolveUser(ctx, n.RecipientID)
	if errors.Is(err, repo.ErrNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if recipient.Email == "" {
		return 0, nil
	}
	prefs, err := w.Store.NotificationPreferences(ctx, recipient, n.DocumentID)
	if err != nil || !prefs.EffectiveEnabled {
		return 0, err
	}
	if permitted, err := w.canRead(ctx, recipient, n.DocumentID); err != nil || !permitted {
		return 0, err
	}
	doc, err := w.Store.GetDocument(ctx, n.DocumentID)
	if errors.Is(err, repo.ErrNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	message, current, err := w.approvalMessage(ctx, *n, doc)
	if err != nil || !current {
		return 0, err
	}
	allowed, err := w.Store.ReserveNotificationDelivery(ctx, recipient.ID)
	if err != nil {
		return 0, err
	}
	if !allowed {
		return 6 * time.Second, nil
	}
	return 0, w.send(ctx, &n.FinishedProviders, recipient.Email, message)
}

// approvalMessage describes the approver's current state. It reports false
// when the event no longer holds: the approver was removed, or revoked or
// replaced their decision by one on other content.
func (w *Worker) approvalMessage(ctx context.Context, n repo.ApprovalNotification, doc repo.Document) (Message, bool, error) {
	approver := auth.Principal{Type: auth.PrincipalType(n.ApproverType), ID: n.ApproverID}
	message := Message{Link: ApprovalsURL(w.AppOrigin, doc.ID), DocumentTitle: doc.Title}
	if n.Reason == repo.ApprovalNotificationRequested {
		requests, err := w.Store.ListApprovalRequests(ctx, doc.ID)
		if err != nil {
			return Message{}, false, err
		}
		for _, r := range requests {
			if samePrincipal(r.Approver, approver) {
				message.Reason, message.Actor = n.Reason, commentActor(r.RequestedBy)
				return message, true, nil
			}
		}
		return Message{}, false, nil
	}
	version, err := w.Store.GetVersion(ctx, doc.CurrentVersionID)
	if err != nil {
		return Message{}, false, err
	}
	decisions, err := w.Store.ListApprovals(ctx, doc.ID, version.SHA256)
	if err != nil {
		return Message{}, false, err
	}
	for _, a := range decisions {
		if samePrincipal(a.Approver, approver) {
			message.Reason, message.Actor, message.Body = "approval_"+a.Decision, commentActor(a.Approver), a.Note
			return message, true, nil
		}
	}
	return Message{}, false, nil
}

func samePrincipal(a, b auth.Principal) bool {
	return a.Type == b.Type && a.ID == b.ID
}

func (w *Worker) requesterStillDenied(ctx context.Context, n *repo.DocumentAccessRequestNotification) (bool, error) {
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

func (w *Worker) sendComment(ctx context.Context, email string, n *repo.CommentNotification, c repo.Comment) error {
	message, err := w.message(ctx, *n, c)
	if errors.Is(err, repo.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	return w.send(ctx, &n.FinishedProviders, email, message)
}

// providerError names the provider whose delivery failed.
type providerError struct {
	provider string
	error
}

func (e providerError) Unwrap() error { return e.error }

// send delivers through each provider not yet in finished. A provider is
// finished when it delivers or fails permanently, so a retry never repeats a
// message that a provider already showed to the recipient.
func (w *Worker) send(ctx context.Context, finished *[]string, email string, message Message) error {
	var errs []error
	for _, provider := range slices.Sorted(maps.Keys(w.Senders)) {
		if slices.Contains(*finished, provider) {
			continue
		}
		err := w.Senders[provider].Send(ctx, email, message)
		if err != nil {
			errs = append(errs, providerError{provider, err})
		}
		var delivery *DeliveryError
		if err == nil || errors.As(err, &delivery) && delivery.Permanent {
			*finished = append(*finished, provider)
		}
	}
	return errors.Join(errs...)
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
