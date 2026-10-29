package googlegroups

import (
	"context"
	"sync"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

type MembershipStore interface {
	GoogleGroupMembershipSnapshot(ctx context.Context, userID string) (repo.GoogleGroupMembershipSnapshot, error)
	ReplaceGoogleGroupMemberships(ctx context.Context, userID string, groups []repo.GoogleGroup, syncedAt time.Time) error
	RecordGoogleGroupMembershipFailure(ctx context.Context, userID, errorCode string, attemptedAt time.Time) error
}

type MembershipObserver func(event, outcome string)

type ResolverConfig struct {
	Store         MembershipStore
	Directory     GoogleGroupDirectory
	TTL           time.Duration
	RetryCooldown time.Duration
	Now           func() time.Time
	Observer      MembershipObserver
}

type Resolver struct {
	store         MembershipStore
	directory     GoogleGroupDirectory
	ttl           time.Duration
	retryCooldown time.Duration
	now           func() time.Time
	observe       MembershipObserver

	mu      sync.Mutex
	flights map[string]*membershipFlight
}

type membershipFlight struct {
	done chan struct{}
	ids  []string
	err  bool
}

func NewResolver(cfg ResolverConfig) *Resolver {
	if cfg.TTL <= 0 {
		cfg.TTL = time.Minute
	}
	if cfg.RetryCooldown <= 0 {
		cfg.RetryCooldown = 5 * time.Second
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Resolver{
		store: cfg.Store, directory: cfg.Directory, ttl: cfg.TTL,
		retryCooldown: cfg.RetryCooldown, now: cfg.Now, observe: cfg.Observer,
		flights: map[string]*membershipFlight{},
	}
}

func (r *Resolver) Resolve(ctx context.Context, principal *auth.Principal) *auth.Principal {
	return r.resolve(ctx, principal, true)
}

// ResolveCached resolves memberships from a fresh cached snapshot only, and
// reports them unavailable otherwise. It never calls the directory, so a
// caller that gives up early cannot record a failure that starts the retry
// cooldown for the user's other requests.
func (r *Resolver) ResolveCached(ctx context.Context, principal *auth.Principal) *auth.Principal {
	return r.resolve(ctx, principal, false)
}

func (r *Resolver) resolve(ctx context.Context, principal *auth.Principal, refresh bool) *auth.Principal {
	if principal == nil {
		return nil
	}
	resolved := *principal
	resolved.GoogleGroupIDs = nil
	resolved.GoogleGroupMembershipState = ""
	// slashdocs service accounts are standalone machine identities and must never
	// inherit a human owner's Google Workspace memberships.
	if principal.Type != auth.PrincipalUser || r == nil || r.store == nil || r.directory == nil {
		return &resolved
	}

	now := r.now()
	snapshot, err := r.store.GoogleGroupMembershipSnapshot(ctx, principal.ID)
	if err == nil && freshSnapshot(snapshot.LastSuccessAt, now, r.ttl) {
		resolved.GoogleGroupIDs = append([]string(nil), snapshot.GroupIDs...)
		resolved.GoogleGroupMembershipState = auth.GoogleGroupMembershipResolved
		r.record("cache", "hit")
		return &resolved
	}
	if err == nil && snapshot.LastSuccessAt.IsZero() {
		r.record("cache", "miss")
	} else {
		r.record("cache", "stale")
	}
	if err != nil || !refresh || cooldownActive(snapshot, now, r.retryCooldown) {
		resolved.GoogleGroupMembershipState = auth.GoogleGroupMembershipUnavailable
		return &resolved
	}

	flight, owner := r.startFlight(principal.ID)
	if !owner {
		return awaitFlight(ctx, flight, resolved)
	}
	return r.refreshMemberships(ctx, principal, flight, resolved)
}

// awaitFlight waits on the refresh another caller already started, rather than
// issuing a second directory call for the same user.
func awaitFlight(ctx context.Context, flight *membershipFlight, resolved auth.Principal) *auth.Principal {
	select {
	case <-ctx.Done():
		resolved.GoogleGroupMembershipState = auth.GoogleGroupMembershipUnavailable
		return &resolved
	case <-flight.done:
		if flight.err {
			resolved.GoogleGroupMembershipState = auth.GoogleGroupMembershipUnavailable
			return &resolved
		}
		resolved.GoogleGroupIDs = append([]string(nil), flight.ids...)
		resolved.GoogleGroupMembershipState = auth.GoogleGroupMembershipResolved
		return &resolved
	}
}

// refreshMemberships fetches memberships from the directory, persists them, and
// releases the flight so waiters observe the same outcome. A failure is
// recorded on a non-cancellable context so the retry cooldown still applies
// when the caller's request was the thing that was cancelled.
func (r *Resolver) refreshMemberships(ctx context.Context, principal *auth.Principal, flight *membershipFlight, resolved auth.Principal) *auth.Principal {
	groups, refreshErr := r.directory.TransitiveGroupsForMember(ctx, principal.Email)
	ids := make([]string, 0, len(groups))
	stored := make([]repo.GoogleGroup, 0, len(groups))
	verifiedAt := r.now()
	if refreshErr == nil {
		for _, group := range groups {
			ids = append(ids, group.ID)
			stored = append(stored, repo.GoogleGroup{
				ID: group.ID, CustomerID: group.CustomerID, Email: group.Email,
				Name: group.Name, LastVerifiedAt: verifiedAt,
			})
		}
		refreshErr = r.store.ReplaceGoogleGroupMemberships(ctx, principal.ID, stored, verifiedAt)
	}
	if refreshErr != nil {
		code := ErrorCode(refreshErr)
		_ = r.store.RecordGoogleGroupMembershipFailure(context.WithoutCancel(ctx), principal.ID, code, verifiedAt)
		r.finishFlight(principal.ID, flight, nil, true)
		resolved.GoogleGroupMembershipState = auth.GoogleGroupMembershipUnavailable
		r.record("refresh", "failure")
		return &resolved
	}

	r.finishFlight(principal.ID, flight, ids, false)
	resolved.GoogleGroupIDs = ids
	resolved.GoogleGroupMembershipState = auth.GoogleGroupMembershipResolved
	r.record("refresh", "success")
	return &resolved
}

func freshSnapshot(lastSuccess, now time.Time, ttl time.Duration) bool {
	if lastSuccess.IsZero() || lastSuccess.After(now) {
		return false
	}
	return now.Sub(lastSuccess) < ttl
}

func cooldownActive(snapshot repo.GoogleGroupMembershipSnapshot, now time.Time, cooldown time.Duration) bool {
	return snapshot.LastErrorCode != "" && snapshot.LastAttemptAt.After(snapshot.LastSuccessAt) &&
		!snapshot.LastAttemptAt.After(now) && now.Sub(snapshot.LastAttemptAt) < cooldown
}

func (r *Resolver) startFlight(userID string) (*membershipFlight, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if existing := r.flights[userID]; existing != nil {
		return existing, false
	}
	flight := &membershipFlight{done: make(chan struct{})}
	r.flights[userID] = flight
	return flight, true
}

func (r *Resolver) finishFlight(userID string, flight *membershipFlight, ids []string, failed bool) {
	r.mu.Lock()
	flight.ids = append([]string(nil), ids...)
	flight.err = failed
	delete(r.flights, userID)
	close(flight.done)
	r.mu.Unlock()
}

func (r *Resolver) record(event, outcome string) {
	if r.observe != nil {
		r.observe(event, outcome)
	}
}
