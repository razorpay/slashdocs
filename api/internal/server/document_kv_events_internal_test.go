package server

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

type streamAuthorizationCheck struct {
	principal  auth.Principal
	documentID string
}

type streamAuthorizationRepository struct {
	role  repo.Role
	err   error
	calls chan streamAuthorizationCheck
	// doc is the document of the stream, when the test gives one.
	doc *repo.Document
}

func (r *streamAuthorizationRepository) GetDocument(context.Context, string) (repo.Document, error) {
	if r.doc == nil {
		return repo.Document{}, repo.ErrNotFound
	}
	return *r.doc, nil
}

func (r *streamAuthorizationRepository) ListDocumentKVEvents(context.Context, string, int64, int32) ([]repo.DocumentKVEvent, error) {
	return nil, nil
}

func (r *streamAuthorizationRepository) RoleForDocument(_ context.Context, principal auth.Principal, documentID string) (repo.Role, error) {
	r.calls <- streamAuthorizationCheck{principal: principal, documentID: documentID}
	return r.role, r.err
}

type streamResponseWriter struct {
	header http.Header
	writes chan string
}

func newStreamResponseWriter() *streamResponseWriter {
	return &streamResponseWriter{header: make(http.Header), writes: make(chan string, 1)}
}

func (w *streamResponseWriter) Header() http.Header { return w.header }

func (*streamResponseWriter) WriteHeader(int) {}

func (w *streamResponseWriter) Write(body []byte) (int, error) {
	w.writes <- string(body)
	return len(body), nil
}

func (*streamResponseWriter) Flush() {}

func TestDocumentKVStreamReauthorizesOnKeepalive(t *testing.T) {
	principal := auth.Principal{Type: auth.PrincipalUser, ID: "viewer_1"}
	lookupErr := errors.New("authorization lookup failed")
	credentialErr := errors.New("credential lookup failed")

	for _, tc := range []struct {
		name                   string
		authenticatedPrincipal auth.Principal
		authenticateErr        error
		role                   repo.Role
		roleErr                error
		checksRole             bool
		continues              bool
	}{
		{
			name:                   "viewer remains connected",
			authenticatedPrincipal: principal,
			role:                   repo.RoleViewer,
			checksRole:             true,
			continues:              true,
		},
		{
			name:                   "revoked viewer is disconnected",
			authenticatedPrincipal: principal,
			role:                   repo.RoleNone,
			checksRole:             true,
		},
		{
			name:                   "authorization lookup failure closes fail-safe",
			authenticatedPrincipal: principal,
			roleErr:                lookupErr,
			checksRole:             true,
		},
		{name: "revoked credential is disconnected", authenticateErr: auth.ErrUnauthorized},
		{name: "credential lookup failure closes fail-safe", authenticateErr: credentialErr},
		{
			name:                   "changed principal is disconnected",
			authenticatedPrincipal: auth.Principal{Type: auth.PrincipalUser, ID: "viewer_2"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			keepAlive := make(chan time.Time, 1)
			authenticateCalls := make(chan struct{}, 1)
			repository := &streamAuthorizationRepository{
				role:  tc.role,
				err:   tc.roleErr,
				calls: make(chan streamAuthorizationCheck, 1),
			}
			writer := newStreamResponseWriter()
			stream := &documentKVStream{
				ctx:        ctx,
				writer:     writer,
				flusher:    writer,
				repository: repository,
				authenticate: func(context.Context) (*auth.Principal, error) {
					authenticateCalls <- struct{}{}
					if tc.authenticateErr != nil {
						return nil, tc.authenticateErr
					}
					p := tc.authenticatedPrincipal
					return &p, nil
				},
				principal:  principal,
				documentID: "doc_stream",
				keepAlive:  keepAlive,
			}
			done := make(chan struct{})
			go func() {
				stream.run(make(chan repo.DocumentKVEvent))
				close(done)
			}()

			keepAlive <- time.Now()
			select {
			case <-authenticateCalls:
			case <-time.After(time.Second):
				t.Fatal("stream did not re-check credentials on keepalive")
			}
			if tc.checksRole {
				select {
				case check := <-repository.calls:
					if check.principal.Type != principal.Type || check.principal.ID != principal.ID || check.documentID != stream.documentID {
						t.Fatalf("authorization check = %#v, want principal %#v document %q", check, principal, stream.documentID)
					}
				case <-time.After(time.Second):
					t.Fatal("stream did not re-check document authorization on keepalive")
				}
			}

			if tc.continues {
				select {
				case write := <-writer.writes:
					if write != ": keepalive\n\n" {
						t.Fatalf("keepalive write = %q", write)
					}
				case <-time.After(time.Second):
					t.Fatal("authorized stream did not send a keepalive")
				}
				cancel()
			} else {
				select {
				case write := <-writer.writes:
					t.Fatalf("unauthorized stream wrote %q before closing", write)
				case <-done:
				case <-time.After(time.Second):
					t.Fatal("unauthorized stream did not close")
				}
				if !tc.checksRole {
					select {
					case check := <-repository.calls:
						t.Fatalf("credential failure performed document authorization check %#v", check)
					default:
					}
				}
			}

			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("stream did not stop")
			}
		})
	}
}

// A viewer who missed the relayed event of an operation learns where the
// live document is from the next keep-alive.
func TestDocumentKVStreamSendsThePositionOnKeepalive(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	viewer := auth.Principal{Type: auth.PrincipalUser, ID: "viewer_1"}
	keepAlive := make(chan time.Time, 1)
	writer := newStreamResponseWriter()
	stream := &documentKVStream{
		ctx:     ctx,
		writer:  writer,
		flusher: writer,
		repository: &streamAuthorizationRepository{
			role:  repo.RoleViewer,
			calls: make(chan streamAuthorizationCheck, 1),
			doc:   &repo.Document{ID: "doc_stream", CurrentVersionID: "ver_open", Seq: 44},
		},
		authenticate: func(context.Context) (*auth.Principal, error) { return &viewer, nil },
		principal:    viewer,
		documentID:   "doc_stream",
		keepAlive:    keepAlive,
	}
	go stream.run(make(chan repo.DocumentKVEvent))

	keepAlive <- time.Now()
	for _, want := range []string{": keepalive\n\n", "event: document\ndata: {\"document_id\":\"doc_stream\",\"revision\":0,\"kind\":\"document\",\"changes\":null,\"data\":{\"seq\":44,\"version_id\":\"ver_open\"}}\n\n"} {
		select {
		case got := <-writer.writes:
			if got != want {
				t.Fatalf("stream wrote %q, want %q", got, want)
			}
		case <-time.After(time.Second):
			t.Fatalf("stream did not write %q", want)
		}
	}
}

// A change of a folder wakes every open stream. A stream examines the access
// of its viewer once for the folder changes of folderAccessDelay, and at once
// for a change of its own document.
func TestDocumentKVStreamExaminesFolderChangesOnceForEachDelay(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	viewer := auth.Principal{Type: auth.PrincipalUser, ID: "viewer_1"}
	checks := make(chan streamAuthorizationCheck, 10)
	writer := newStreamResponseWriter()
	stream := &documentKVStream{
		ctx:          ctx,
		writer:       writer,
		flusher:      writer,
		repository:   &streamAuthorizationRepository{role: repo.RoleViewer, calls: checks},
		authenticate: func(context.Context) (*auth.Principal, error) { return &viewer, nil },
		principal:    viewer,
		documentID:   "doc_stream",
		keepAlive:    make(chan time.Time),
	}
	events := make(chan repo.DocumentKVEvent)
	go stream.run(events)
	checked := func(within time.Duration) bool {
		select {
		case <-checks:
			return true
		case <-time.After(within):
			return false
		}
	}

	start := time.Now()
	for range 5 {
		events <- repo.DocumentKVEvent{Kind: repo.DocumentEventAccess}
	}
	if !checked(2 * folderAccessDelay) {
		t.Fatal("stream did not examine the access after a change of a folder")
	}
	if waited := time.Since(start); waited < folderAccessDelay {
		t.Fatalf("stream examined the access after %s, want %s", waited, folderAccessDelay)
	}
	if checked(folderAccessDelay + 100*time.Millisecond) {
		t.Fatal("stream examined the access more than once for one burst of folder changes")
	}

	events <- repo.DocumentKVEvent{DocumentID: "doc_stream", Kind: repo.DocumentEventAccess}
	if !checked(100 * time.Millisecond) {
		t.Fatal("stream did not examine the access at once after a change of its document")
	}
}
