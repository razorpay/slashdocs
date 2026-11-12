package auth

import (
	"context"
	"errors"
	"net/http"
)

type TokenResolver interface {
	ResolveBearerToken(ctx context.Context, tokenHash string) (Principal, error)
}
type UserResolver interface {
	ResolveUser(ctx context.Context, id string) (Principal, error)
}

type DBAuthenticator struct {
	Resolver interface {
		TokenResolver
		UserResolver
	}
	SessionSecret string
}

func (a DBAuthenticator) Authenticate(r *http.Request) (*Principal, error) {
	if token := BearerFromHeader(r.Header.Get("Authorization")); token != "" {
		p, err := a.Resolver.ResolveBearerToken(r.Context(), HashToken(token))
		if err != nil {
			// Only a genuine "not found" means the credential is invalid.
			// Propagate everything else (e.g. DB outages) as a 500 so real
			// failures are not masked as 401 Unauthorized.
			if errors.Is(err, ErrNotFound) {
				return nil, ErrUnauthorized
			}
			return nil, err
		}
		return &p, nil
	}
	if a.SessionSecret != "" {
		if ck, err := r.Cookie("slashdocs_session"); err == nil {
			uid, ok := (SessionCodec{Secret: []byte(a.SessionSecret)}).VerifySession(ck.Value)
			if ok {
				p, err := a.Resolver.ResolveUser(r.Context(), uid)
				if err != nil {
					// As with bearer auth, only a genuine "not found"
					// means the session is invalid; surface everything
					// else (e.g. DB outages) instead of masking as 401.
					if errors.Is(err, ErrNotFound) {
						return nil, ErrUnauthorized
					}
					return nil, err
				}
				return &p, nil
			}
		}
	}
	return nil, ErrUnauthorized
}
