package googlegroups

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	ReadOnlyScope   = "https://www.googleapis.com/auth/cloud-identity.groups.readonly"
	discussionLabel = "cloudidentity.googleapis.com/groups.discussion_forum"
	securityLabel   = "cloudidentity.googleapis.com/groups.security"
	defaultEndpoint = "https://cloudidentity.googleapis.com/v1"
)

type GoogleGroup struct {
	ID         string
	CustomerID string
	Email      string
	Name       string
}

type GoogleGroupDirectory interface {
	SearchGroups(ctx context.Context, query string, limit int) ([]GoogleGroup, error)
	LookupGroup(ctx context.Context, email string) (GoogleGroup, error)
	TransitiveGroupsForMember(ctx context.Context, userEmail string) ([]GoogleGroup, error)
}

type RequestObserver func(operation, outcome string, elapsed time.Duration)

type HTTPDirectory struct {
	client     *http.Client
	endpoint   string
	customerID string
	timeout    time.Duration
	observe    RequestObserver
}

type HTTPDirectoryConfig struct {
	Client     *http.Client
	Endpoint   string
	CustomerID string
	Timeout    time.Duration
	Observer   RequestObserver
}

func NewHTTPDirectory(cfg HTTPDirectoryConfig) (*HTTPDirectory, error) {
	if cfg.Client == nil {
		return nil, errors.New("google groups HTTP client is required")
	}
	if !validCustomerID(cfg.CustomerID) {
		return nil, errors.New("google groups customer ID must begin with C")
	}
	if cfg.Endpoint == "" {
		cfg.Endpoint = defaultEndpoint
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 5 * time.Second
	}
	return &HTTPDirectory{
		client:     cfg.Client,
		endpoint:   strings.TrimRight(cfg.Endpoint, "/"),
		customerID: cfg.CustomerID,
		timeout:    cfg.Timeout,
		observe:    cfg.Observer,
	}, nil
}

func validCustomerID(id string) bool {
	return len(id) > 1 && id[0] == 'C' && !strings.ContainsAny(id, " /\\\t\r\n")
}

type directoryError struct {
	operation string
	code      string
	status    int
}

// ErrNotFound allows alternate directory implementations and hermetic tests to
// report a deleted or unknown group without exposing provider response data.
var ErrNotFound = errors.New("google group not found")

func (e *directoryError) Error() string { return "google groups " + e.operation + " failed" }

func ErrorCode(err error) string {
	var de *directoryError
	if errors.As(err, &de) {
		return de.code
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return "unavailable"
}

func IsNotFound(err error) bool {
	var de *directoryError
	return errors.Is(err, ErrNotFound) || (errors.As(err, &de) && de.status == http.StatusNotFound)
}

func (d *HTTPDirectory) SearchGroups(ctx context.Context, query string, limit int) ([]GoogleGroup, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []GoogleGroup{}, nil
	}
	if limit <= 0 || limit > 20 {
		limit = 20
	}
	cel := fmt.Sprintf(
		"parent == '%s' && ('%s' in labels || '%s' in labels) && (group_key.contains('%s') || display_name.contains('%s'))",
		celEscape("customers/"+d.customerID), discussionLabel, securityLabel, celEscape(query), celEscape(query),
	)
	values := url.Values{"query": {cel}, "view": {"BASIC"}, "pageSize": {fmt.Sprint(limit)}}
	groups := make([]GoogleGroup, 0, limit)
	for {
		var response struct {
			Groups        []apiGroup `json:"groups"`
			NextPageToken string     `json:"nextPageToken"`
		}
		if err := d.getJSON(ctx, "search", "/groups:search", values, &response); err != nil {
			return nil, err
		}
		for _, raw := range response.Groups {
			group, err := d.mapGroup(raw)
			if err != nil {
				continue
			}
			groups = append(groups, group)
			if len(groups) == limit {
				sortGroups(groups)
				return groups, nil
			}
		}
		if response.NextPageToken == "" {
			break
		}
		values.Set("pageToken", response.NextPageToken)
	}
	sortGroups(groups)
	return groups, nil
}

func (d *HTTPDirectory) LookupGroup(ctx context.Context, email string) (GoogleGroup, error) {
	email = strings.TrimSpace(strings.ToLower(email))
	if email == "" || !strings.Contains(email, "@") {
		return GoogleGroup{}, &directoryError{operation: "lookup", code: "invalid_group"}
	}
	var lookup struct {
		Name string `json:"name"`
	}
	if err := d.getJSON(ctx, "lookup", "/groups:lookup", url.Values{"groupKey.id": {email}}, &lookup); err != nil {
		return GoogleGroup{}, err
	}
	if !validResourceName(lookup.Name) {
		return GoogleGroup{}, &directoryError{operation: "lookup", code: "invalid_response"}
	}
	var raw apiGroup
	if err := d.getJSON(ctx, "get", "/"+lookup.Name, nil, &raw); err != nil {
		return GoogleGroup{}, err
	}
	group, err := d.mapGroup(raw)
	if err != nil {
		return GoogleGroup{}, &directoryError{operation: "get", code: "invalid_group"}
	}
	return group, nil
}

func (d *HTTPDirectory) TransitiveGroupsForMember(ctx context.Context, userEmail string) ([]GoogleGroup, error) {
	userEmail = strings.TrimSpace(strings.ToLower(userEmail))
	if userEmail == "" || !strings.Contains(userEmail, "@") {
		return nil, &directoryError{operation: "memberships", code: "invalid_member"}
	}
	cel := fmt.Sprintf(
		"member_key_id == '%s' && ('%s' in labels || '%s' in labels) && parent == '%s'",
		celEscape(userEmail), discussionLabel, securityLabel, celEscape("customers/"+d.customerID),
	)
	values := url.Values{"query": {cel}, "pageSize": {"1000"}}
	groupsByID := map[string]GoogleGroup{}
	for {
		var response struct {
			Memberships   []groupRelation `json:"memberships"`
			NextPageToken string          `json:"nextPageToken"`
		}
		if err := d.getJSON(ctx, "memberships", "/groups/-/memberships:searchTransitiveGroups", values, &response); err != nil {
			return nil, err
		}
		for _, raw := range response.Memberships {
			if !validResourceName(raw.Group) || !managedGroup(raw.Labels) || strings.TrimSpace(raw.GroupKey.ID) == "" {
				continue
			}
			groupsByID[raw.Group] = GoogleGroup{
				ID: raw.Group, CustomerID: d.customerID,
				Email: strings.ToLower(strings.TrimSpace(raw.GroupKey.ID)), Name: raw.DisplayName,
			}
		}
		if response.NextPageToken == "" {
			break
		}
		values.Set("pageToken", response.NextPageToken)
	}
	groups := make([]GoogleGroup, 0, len(groupsByID))
	for _, group := range groupsByID {
		groups = append(groups, group)
	}
	sortGroups(groups)
	return groups, nil
}

type apiGroup struct {
	Name        string            `json:"name"`
	Parent      string            `json:"parent"`
	DisplayName string            `json:"displayName"`
	GroupKey    entityKey         `json:"groupKey"`
	Labels      map[string]string `json:"labels"`
}

type entityKey struct {
	ID string `json:"id"`
}

type groupRelation struct {
	Group       string            `json:"group"`
	DisplayName string            `json:"displayName"`
	GroupKey    entityKey         `json:"groupKey"`
	Labels      map[string]string `json:"labels"`
}

func (d *HTTPDirectory) mapGroup(raw apiGroup) (GoogleGroup, error) {
	if !validResourceName(raw.Name) || raw.Parent != "customers/"+d.customerID || !managedGroup(raw.Labels) {
		return GoogleGroup{}, errors.New("group is outside configured customer or unsupported")
	}
	email := strings.ToLower(strings.TrimSpace(raw.GroupKey.ID))
	if email == "" || !strings.Contains(email, "@") {
		return GoogleGroup{}, errors.New("group has no canonical email")
	}
	return GoogleGroup{ID: raw.Name, CustomerID: d.customerID, Email: email, Name: raw.DisplayName}, nil
}

func managedGroup(labels map[string]string) bool {
	_, discussion := labels[discussionLabel]
	_, security := labels[securityLabel]
	return discussion || security
}

func validResourceName(name string) bool {
	return strings.HasPrefix(name, "groups/") && len(name) > len("groups/") && !strings.ContainsAny(strings.TrimPrefix(name, "groups/"), "/ \\\t\r\n")
}

func sortGroups(groups []GoogleGroup) {
	sort.Slice(groups, func(i, j int) bool {
		if strings.EqualFold(groups[i].Name, groups[j].Name) {
			return groups[i].Email < groups[j].Email
		}
		return strings.ToLower(groups[i].Name) < strings.ToLower(groups[j].Name)
	})
}

func celEscape(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	return strings.ReplaceAll(value, "'", "\\'")
}

func (d *HTTPDirectory) getJSON(ctx context.Context, operation, path string, values url.Values, out any) error {
	ctx, cancel := context.WithTimeout(ctx, d.timeout)
	defer cancel()
	u := d.endpoint + path
	if len(values) > 0 {
		u += "?" + values.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return &directoryError{operation: operation, code: "invalid_request"}
	}
	started := time.Now()
	resp, err := d.client.Do(req)
	if err != nil {
		d.observeCall(operation, "unavailable", started)
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return &directoryError{operation: operation, code: "timeout"}
		}
		return &directoryError{operation: operation, code: "unavailable"}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		code := directoryErrorCode(resp.StatusCode)
		d.observeCall(operation, code, started)
		return &directoryError{operation: operation, code: code, status: resp.StatusCode}
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out); err != nil {
		d.observeCall(operation, "invalid_response", started)
		return &directoryError{operation: operation, code: "invalid_response", status: resp.StatusCode}
	}
	d.observeCall(operation, "success", started)
	return nil
}

// observeCall reports a call outcome when an observer is configured, so the
// callers above stay free of repeated nil checks.
func (d *HTTPDirectory) observeCall(operation, code string, started time.Time) {
	if d.observe != nil {
		d.observe(operation, code, time.Since(started))
	}
}

// directoryErrorCode maps an unsuccessful HTTP status onto the error taxonomy
// callers match on.
func directoryErrorCode(status int) string {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "permission_denied"
	case http.StatusNotFound:
		return "not_found"
	case http.StatusTooManyRequests:
		return "quota"
	default:
		return "unavailable"
	}
}
