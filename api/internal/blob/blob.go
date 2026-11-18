package blob

import "context"

type Pinger interface {
	Ping(ctx context.Context) error
}

type Store interface {
	Put(ctx context.Context, key string, contentType string, body []byte) error
	Get(ctx context.Context, key string) ([]byte, string, error)
	// Delete removes the object. It succeeds when the object is not there.
	Delete(ctx context.Context, key string) error
	// List returns the keys that start with prefix, in order. The blobs of a
	// document share a prefix, so this finds them after its versions are
	// gone.
	List(ctx context.Context, prefix string) ([]string, error)
}
