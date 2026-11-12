package server_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"slices"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/server"
)

// The fixture owner shares a document with the editor, commenter, and viewer.
func TestSearchUsersFindsOnlyContactsOnPublicServer(t *testing.T) {
	public := newTestEnv(t)
	org := newConfiguredTestEnv(t, server.Config{Environment: "test", Deployment: server.DeploymentOrg})
	everyone := []string{"Anurag", "Attacker", "Commenter", "Editor", "Owner", "Stranger", "Viewer"}

	for _, tc := range []struct {
		name   string
		env    *testEnv
		caller auth.Principal
		query  string
		want   []string
	}{
		{"sharer finds the people they share with", public, fixtureOwner, "example", []string{"Commenter", "Editor", "Owner", "Viewer"}},
		{"recipient finds the sharer", public, fixtureViewer, "example", []string{"Owner", "Viewer"}},
		{"stranger finds only self", public, fixtureStranger, "example", []string{"Stranger"}},
		{"full email finds anyone", public, fixtureViewer, "stranger@example.com", []string{"Stranger"}},
		{"org server finds everyone", org, fixtureStranger, "example", everyone},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := do(t, tc.env.h, http.MethodGet, "/v1/users?q="+url.QueryEscape(tc.query), "", map[string]string{
				"X-Test-Principal": principalHeader(tc.caller),
			})
			assertStatus(t, rr, http.StatusOK)
			var out struct {
				Items []auth.Principal `json:"items"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
				t.Fatalf("decode: %v", err)
			}
			got := make([]string, 0, len(out.Items))
			for _, p := range out.Items {
				got = append(got, p.Name)
			}
			slices.Sort(got)
			if !slices.Equal(got, tc.want) {
				t.Fatalf("names = %v, want %v", got, tc.want)
			}
		})
	}
}
