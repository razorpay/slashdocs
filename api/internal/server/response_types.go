package server

// listResponse is the standard envelope for list endpoints: the collection
// under a single "items" key.
type listResponse[T any] struct {
	Items []T `json:"items"`
}
