package server_test

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/googlegroups"
	"github.com/razorpay/slashdocs/api/internal/server"
)

type postgresGroupDirectory struct {
	mu          sync.Mutex
	group       googlegroups.GoogleGroup
	memberships map[string][]googlegroups.GoogleGroup
}

func (d *postgresGroupDirectory) SearchGroups(context.Context, string, int) ([]googlegroups.GoogleGroup, error) {
	return []googlegroups.GoogleGroup{d.group}, nil
}
func (d *postgresGroupDirectory) LookupGroup(context.Context, string) (googlegroups.GoogleGroup, error) {
	return d.group, nil
}
func (d *postgresGroupDirectory) TransitiveGroupsForMember(_ context.Context, email string) ([]googlegroups.GoogleGroup, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]googlegroups.GoogleGroup(nil), d.memberships[email]...), nil
}

func TestGoogleGroupGrantAndMembershipWithPostgres(t *testing.T) {
	group := googlegroups.GoogleGroup{ID: "groups/platform", CustomerID: "C123", Email: "platform@example.com", Name: "Platform"}
	directory := &postgresGroupDirectory{
		group: group,
		memberships: map[string][]googlegroups.GoogleGroup{
			fixtureStranger.Email: {group},
		},
	}
	e := newConfiguredTestEnv(t, server.Config{
		Environment:               server.EnvProduction,
		Deployment:                server.DeploymentOrg,
		GoogleGroupsEnabled:       true,
		GoogleGroupsMembershipTTL: time.Nanosecond,
	}, server.WithGoogleGroupDirectory(directory))

	body := `{"principal":{"type":"google_group","email":"platform@example.com"},"role":"viewer"}`
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", body, map[string]string{
		"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusCreated)

	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureStranger),
	})
	assertStatus(t, rr, http.StatusOK)

	directory.mu.Lock()
	directory.memberships[fixtureStranger.Email] = nil
	directory.mu.Unlock()
	time.Sleep(time.Microsecond)
	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureStranger),
	})
	assertStatus(t, rr, http.StatusForbidden)
}
