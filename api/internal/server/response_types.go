package server

// listResponse is the standard envelope for list endpoints: the collection
// under a single "items" key.
type listResponse[T any] struct {
	Items []T `json:"items"`
	// HasMore reports that another page exists. omitempty keeps the response shape of
	// endpoints that do not paginate byte-identical to before.
	HasMore bool `json:"has_more,omitempty"`
}
