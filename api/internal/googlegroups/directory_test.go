package googlegroups

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func TestHTTPDirectorySearchEscapesFiltersAndPaginates(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		query := r.URL.Query().Get("query")
		for _, want := range []string{"parent == 'customers/C123'", discussionLabel, securityLabel, `group_key.contains('plat\'form')`} {
			if !strings.Contains(query, want) {
				t.Fatalf("query %q missing %q", query, want)
			}
		}
		if requests == 1 {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"groups": []any{
					groupJSON("groups/1", "customers/C123", "z@example.com", "Zulu"),
					groupJSON("groups/external", "customers/C999", "bad@example.com", "Bad"),
				},
				"nextPageToken": "next",
			})
			return
		}
		if r.URL.Query().Get("pageToken") != "next" {
			t.Fatalf("page token = %q", r.URL.Query().Get("pageToken"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"groups": []any{groupJSON("groups/2", "customers/C123", "a@example.com", "Alpha")},
		})
	}))
	defer server.Close()
	directory := newTestDirectory(t, server)

	groups, err := directory.SearchGroups(context.Background(), "plat'form", 20)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || len(groups) != 2 || groups[0].ID != "groups/2" || groups[1].ID != "groups/1" {
		t.Fatalf("requests=%d groups=%+v", requests, groups)
	}
}

func TestHTTPDirectoryLookupVerifiesImmutableGroup(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/groups:lookup":
			if got := r.URL.Query().Get("groupKey.id"); got != "platform@example.com" {
				t.Fatalf("lookup email = %q", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "groups/immutable"})
		case "/v1/groups/immutable":
			_ = json.NewEncoder(w).Encode(groupJSON("groups/immutable", "customers/C123", "renamed@example.com", "Platform"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	group, err := newTestDirectory(t, server).LookupGroup(context.Background(), "Platform@Example.com")
	if err != nil {
		t.Fatal(err)
	}
	if group.ID != "groups/immutable" || group.Email != "renamed@example.com" || group.CustomerID != "C123" {
		t.Fatalf("group = %+v", group)
	}
}

func TestHTTPDirectoryRejectsExternalMalformedAndDeletedGroups(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		group  map[string]any
	}{
		{name: "external", group: groupJSON("groups/1", "customers/C999", "group@example.com", "External")},
		{name: "malformed", group: groupJSON("not-a-group", "customers/C123", "group@example.com", "Malformed")},
		{name: "deleted", status: http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/groups:lookup" {
					_ = json.NewEncoder(w).Encode(map[string]any{"name": "groups/1"})
					return
				}
				if tc.status != 0 {
					http.Error(w, "sensitive response", tc.status)
					return
				}
				_ = json.NewEncoder(w).Encode(tc.group)
			}))
			defer server.Close()
			_, err := newTestDirectory(t, server).LookupGroup(context.Background(), "secret-user@example.com")
			if err == nil {
				t.Fatal("LookupGroup succeeded")
			}
			if strings.Contains(err.Error(), "secret-user") || strings.Contains(err.Error(), "sensitive response") {
				t.Fatalf("error leaked sensitive data: %v", err)
			}
			if tc.status == http.StatusNotFound && !IsNotFound(err) {
				t.Fatalf("IsNotFound(%v) = false", err)
			}
		})
	}
}

func TestHTTPDirectoryMapsDirectAndNestedTransitiveGroups(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("query")
		if !strings.Contains(query, "member_key_id == 'member@example.com'") || !strings.Contains(query, "parent == 'customers/C123'") || !strings.Contains(query, securityLabel) {
			t.Fatalf("query = %q", query)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"memberships": []any{
			map[string]any{"group": "groups/direct", "groupKey": map[string]any{"id": "direct@example.com"}, "displayName": "Direct", "relationType": "DIRECT", "labels": map[string]string{discussionLabel: ""}},
			map[string]any{"group": "groups/nested", "groupKey": map[string]any{"id": "nested@example.com"}, "displayName": "Nested", "relationType": "INDIRECT", "labels": map[string]string{securityLabel: ""}},
		}})
	}))
	defer server.Close()
	groups, err := newTestDirectory(t, server).TransitiveGroupsForMember(context.Background(), "Member@Example.com")
	if err != nil || len(groups) != 2 {
		t.Fatalf("groups=%+v err=%v", groups, err)
	}
}

func groupJSON(id, parent, email, name string) map[string]any {
	return map[string]any{"name": id, "parent": parent, "groupKey": map[string]any{"id": email}, "displayName": name, "labels": map[string]string{discussionLabel: ""}}
}

func newTestDirectory(t *testing.T, server *httptest.Server) *HTTPDirectory {
	t.Helper()
	directory, err := NewHTTPDirectory(HTTPDirectoryConfig{Client: server.Client(), Endpoint: server.URL + "/v1", CustomerID: "C123", Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return directory
}

type fakeMembershipStore struct {
	mu       sync.Mutex
	snapshot repo.GoogleGroupMembershipSnapshot
	replaced []repo.GoogleGroup
	failures int
}

func (s *fakeMembershipStore) GoogleGroupMembershipSnapshot(context.Context, string) (repo.GoogleGroupMembershipSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	snapshot := s.snapshot
	snapshot.GroupIDs = append([]string(nil), snapshot.GroupIDs...)
	return snapshot, nil
}
func (s *fakeMembershipStore) ReplaceGoogleGroupMemberships(_ context.Context, _ string, groups []repo.GoogleGroup, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.replaced = append([]repo.GoogleGroup(nil), groups...)
	ids := make([]string, 0, len(groups))
	for _, group := range groups {
		ids = append(ids, group.ID)
	}
	s.snapshot = repo.GoogleGroupMembershipSnapshot{GroupIDs: ids, LastAttemptAt: at, LastSuccessAt: at}
	return nil
}
func (s *fakeMembershipStore) RecordGoogleGroupMembershipFailure(_ context.Context, _ string, code string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failures++
	s.snapshot.LastAttemptAt = at
	s.snapshot.LastErrorCode = code
	return nil
}

type fakeDirectory struct {
	groups []GoogleGroup
	err    error
	calls  atomic.Int32
	gate   chan struct{}
}

func (d *fakeDirectory) SearchGroups(context.Context, string, int) ([]GoogleGroup, error) {
	return d.groups, d.err
}
func (d *fakeDirectory) LookupGroup(context.Context, string) (GoogleGroup, error) {
	if len(d.groups) == 0 {
		return GoogleGroup{}, d.err
	}
	return d.groups[0], d.err
}
func (d *fakeDirectory) TransitiveGroupsForMember(context.Context, string) ([]GoogleGroup, error) {
	d.calls.Add(1)
	if d.gate != nil {
		<-d.gate
	}
	return append([]GoogleGroup(nil), d.groups...), d.err
}

func TestResolverFreshEmptyStaleFailureAndCooldown(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	principal := &auth.Principal{Type: auth.PrincipalUser, ID: "usr_1", Email: "member@example.com"}

	store := &fakeMembershipStore{snapshot: repo.GoogleGroupMembershipSnapshot{GroupIDs: []string{}, LastSuccessAt: now.Add(-30 * time.Second)}}
	directory := &fakeDirectory{groups: []GoogleGroup{{ID: "groups/new", CustomerID: "C123", Email: "new@example.com"}}}
	resolver := NewResolver(ResolverConfig{Store: store, Directory: directory, TTL: time.Minute, Now: func() time.Time { return now }})
	got := resolver.Resolve(context.Background(), principal)
	if got.GoogleGroupMembershipState != auth.GoogleGroupMembershipResolved || len(got.GoogleGroupIDs) != 0 || directory.calls.Load() != 0 {
		t.Fatalf("fresh empty snapshot resolved as %+v calls=%d", got, directory.calls.Load())
	}

	store.snapshot.LastSuccessAt = now.Add(-time.Minute)
	got = resolver.Resolve(context.Background(), principal)
	if len(got.GoogleGroupIDs) != 1 || got.GoogleGroupIDs[0] != "groups/new" || directory.calls.Load() != 1 {
		t.Fatalf("stale refresh resolved as %+v calls=%d", got, directory.calls.Load())
	}

	now = now.Add(2 * time.Minute)
	directory.err = errors.New("google unavailable")
	got = resolver.Resolve(context.Background(), principal)
	if got.GoogleGroupMembershipState != auth.GoogleGroupMembershipUnavailable || len(got.GoogleGroupIDs) != 0 || store.failures != 1 {
		t.Fatalf("failed refresh resolved as %+v failures=%d", got, store.failures)
	}
	// Resolved value is irrelevant here; the assertion is that the cooldown
	// stopped this call from reaching the directory again.
	resolver.Resolve(context.Background(), principal)
	if directory.calls.Load() != 2 {
		t.Fatalf("cooldown made another call: %d", directory.calls.Load())
	}
}

func TestResolverCoalescesConcurrentRefreshAndSkipsServiceAccounts(t *testing.T) {
	now := time.Now()
	store := &fakeMembershipStore{}
	directory := &fakeDirectory{groups: []GoogleGroup{{ID: "groups/1", CustomerID: "C123", Email: "group@example.com"}}, gate: make(chan struct{})}
	resolver := NewResolver(ResolverConfig{Store: store, Directory: directory, Now: func() time.Time { return now }})
	p := &auth.Principal{Type: auth.PrincipalUser, ID: "usr_1", Email: "member@example.com"}
	results := make(chan *auth.Principal, 2)
	go func() { results <- resolver.Resolve(context.Background(), p) }()
	go func() { results <- resolver.Resolve(context.Background(), p) }()
	for directory.calls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	close(directory.gate)
	for range 2 {
		if got := <-results; len(got.GoogleGroupIDs) != 1 {
			t.Fatalf("resolved principal = %+v", got)
		}
	}
	if directory.calls.Load() != 1 {
		t.Fatalf("directory calls = %d, want 1", directory.calls.Load())
	}
	sa := resolver.Resolve(context.Background(), &auth.Principal{Type: auth.PrincipalServiceAccount, ID: "sa_1"})
	if sa.GoogleGroupMembershipState != "" || len(sa.GoogleGroupIDs) != 0 || directory.calls.Load() != 1 {
		t.Fatalf("service account received group state: %+v", sa)
	}
}
