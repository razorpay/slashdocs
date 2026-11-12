package kvevents

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

type testSource struct {
	mu sync.Mutex

	revisions    map[string]int64
	events       map[string][]repo.DocumentKVEvent
	currentCalls map[string]int
	listCalls    map[string]int
	failures     map[string]int
	listFn       func(context.Context, string, int64, int32) ([]repo.DocumentKVEvent, error)
}

func newTestSource() *testSource {
	return &testSource{
		revisions:    make(map[string]int64),
		events:       make(map[string][]repo.DocumentKVEvent),
		currentCalls: make(map[string]int),
		listCalls:    make(map[string]int),
		failures:     make(map[string]int),
	}
}

func (s *testSource) CurrentDocumentKVRevision(_ context.Context, documentID string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.currentCalls[documentID]++
	return s.revisions[documentID], nil
}

func (s *testSource) ListDocumentKVEvents(ctx context.Context, documentID string, afterRevision int64, limit int32) ([]repo.DocumentKVEvent, error) {
	s.mu.Lock()
	s.listCalls[documentID]++
	if s.failures[documentID] > 0 {
		s.failures[documentID]--
		s.mu.Unlock()
		return nil, errors.New("injected fetch failure")
	}
	fn := s.listFn
	events := append([]repo.DocumentKVEvent(nil), s.events[documentID]...)
	s.mu.Unlock()
	if fn != nil {
		return fn(ctx, documentID, afterRevision, limit)
	}
	return eventsAfter(events, afterRevision, limit), nil
}

func (s *testSource) setEvents(documentID string, events ...repo.DocumentKVEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events[documentID] = append([]repo.DocumentKVEvent(nil), events...)
}

func (s *testSource) calls(documentID string) (current, list int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.currentCalls[documentID], s.listCalls[documentID]
}

func eventsAfter(events []repo.DocumentKVEvent, afterRevision int64, limit int32) []repo.DocumentKVEvent {
	out := make([]repo.DocumentKVEvent, 0, len(events))
	for _, event := range events {
		if event.Revision > afterRevision {
			out = append(out, event)
			if len(out) == int(limit) {
				break
			}
		}
	}
	return out
}

type manualTicker struct {
	ticks   chan time.Time
	stopped chan struct{}
	stopOne sync.Once
}

func newManualTicker() *manualTicker {
	return &manualTicker{ticks: make(chan time.Time, 8), stopped: make(chan struct{})}
}

func (t *manualTicker) C() <-chan time.Time { return t.ticks }
func (t *manualTicker) Stop()               { t.stopOne.Do(func() { close(t.stopped) }) }
func (t *manualTicker) tick()               { t.ticks <- time.Now() }

type manualClock struct {
	created    chan *manualTicker
	sleepCalls chan time.Duration
	sleepGate  <-chan struct{}
}

func newManualClock() *manualClock {
	return &manualClock{
		created:    make(chan *manualTicker, 16),
		sleepCalls: make(chan time.Duration, 16),
	}
}

func (c *manualClock) NewTicker(time.Duration) eventTicker {
	ticker := newManualTicker()
	c.created <- ticker
	return ticker
}

func (c *manualClock) Sleep(ctx context.Context, delay time.Duration) error {
	select {
	case c.sleepCalls <- delay:
	default:
	}
	if c.sleepGate == nil {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.sleepGate:
		return nil
	}
}

type listenerResult struct {
	documentID string
	err        error
}

type testListener struct {
	results  chan listenerResult
	closed   chan struct{}
	closeOne sync.Once
}

func newTestListener() *testListener {
	return &testListener{results: make(chan listenerResult, 16), closed: make(chan struct{})}
}

func (l *testListener) Wait(ctx context.Context) (string, error) {
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case result := <-l.results:
		return result.documentID, result.err
	}
}

func (l *testListener) Close(context.Context) error {
	l.closeOne.Do(func() { close(l.closed) })
	return nil
}

type factoryResult struct {
	listener Listener
	err      error
}

type testListenerFactory struct {
	mu       sync.Mutex
	results  []factoryResult
	calls    int
	notified []string
}

func (f *testListenerFactory) Notify(_ context.Context, payload string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.notified = append(f.notified, payload)
	return nil
}

func (f *testListenerFactory) Open(context.Context) (Listener, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if len(f.results) == 0 {
		return nil, errors.New("no scripted listener")
	}
	result := f.results[0]
	f.results = f.results[1:]
	return result.listener, result.err
}

func (f *testListenerFactory) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func testEvent(documentID string, revision int64) repo.DocumentKVEvent {
	return repo.DocumentKVEvent{
		DocumentID: documentID,
		Revision:   revision,
		Changes: []repo.DocumentKVChange{{
			Key:       "status",
			Operation: "set",
			Revision:  revision,
		}},
	}
}

func receiveEvent(t *testing.T, events <-chan repo.DocumentKVEvent) repo.DocumentKVEvent {
	t.Helper()
	select {
	case event, ok := <-events:
		if !ok {
			t.Fatal("event channel closed before delivery")
		}
		return event
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for KV event")
		return repo.DocumentKVEvent{}
	}
}

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition was not met before timeout")
}

func TestParseMode(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		raw  string
		want Mode
	}{
		{"", ModeAuto},
		{" auto ", ModeAuto},
		{"NOTIFY", ModeNotify},
		{"poll", ModePoll},
	} {
		got, err := ParseMode(tc.raw)
		if err != nil || got != tc.want {
			t.Errorf("ParseMode(%q) = %q, %v; want %q", tc.raw, got, err, tc.want)
		}
	}
	if _, err := ParseMode("sometimes"); err == nil {
		t.Fatal("ParseMode accepted an unknown mode")
	}
}

func TestBrokerForcedNotifyFailureAndAutoFallback(t *testing.T) {
	source := newTestSource()
	openErr := errors.New("LISTEN is unavailable")

	forcedFactory := &testListenerFactory{results: []factoryResult{{err: openErr}}}
	if broker, err := newBroker(context.Background(), Config{Mode: ModeNotify, Logger: testLogger()}, source, forcedFactory, newManualClock()); err == nil || broker != nil || !errors.Is(err, openErr) {
		t.Fatalf("forced notify broker = %#v, %v; want wrapped startup failure", broker, err)
	}

	autoFactory := &testListenerFactory{results: []factoryResult{{err: openErr}}}
	clock := newManualClock()
	broker, err := newBroker(context.Background(), Config{Mode: ModeAuto, Logger: testLogger()}, source, autoFactory, clock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(broker.Close)
	if broker.RequestedMode() != ModeAuto || broker.ActiveMode() != ModePoll {
		t.Fatalf("modes = requested %q active %q, want auto/poll", broker.RequestedMode(), broker.ActiveMode())
	}
	events, unsubscribe, err := broker.Subscribe(context.Background(), "doc_fallback")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unsubscribe)
	source.setEvents("doc_fallback", testEvent("doc_fallback", 1))
	ticker := <-clock.created
	ticker.tick()
	if event := receiveEvent(t, events); event.Revision != 1 {
		t.Fatalf("fallback poll delivered revision %d, want 1", event.Revision)
	}
}

// Regression test: the default configuration (auto mode, no dedicated
// listener URL) used to hand New a nil *PostgresListenerFactory boxed into a
// non-nil ListenerFactory interface, defeating the nil guard and panicking on
// Open instead of falling back to polling.
func TestBrokerTreatsTypedNilListenerFactoryAsPolling(t *testing.T) {
	source := newTestSource()
	var factory *PostgresListenerFactory
	broker, err := New(context.Background(), Config{Mode: ModeAuto, PollInterval: 10 * time.Millisecond, Logger: testLogger()}, source, factory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(broker.Close)
	if broker.ActiveMode() != ModePoll {
		t.Fatalf("active mode = %q, want %q", broker.ActiveMode(), ModePoll)
	}
	events, unsubscribe, err := broker.Subscribe(context.Background(), "doc_typed_nil")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unsubscribe)
	source.setEvents("doc_typed_nil", testEvent("doc_typed_nil", 1))
	if event := receiveEvent(t, events); event.Revision != 1 {
		t.Fatalf("poll fallback delivered revision %d, want 1", event.Revision)
	}
}

func TestPollBrokerCoalescesFiveHundredSubscribers(t *testing.T) {
	source := newTestSource()
	clock := newManualClock()
	broker, err := newBroker(context.Background(), Config{Mode: ModePoll, PollInterval: time.Hour, Logger: testLogger()}, source, nil, clock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(broker.Close)

	const subscriberCount = 500
	channels := make([]<-chan repo.DocumentKVEvent, 0, subscriberCount)
	unsubscribes := make([]func(), 0, subscriberCount)
	for range subscriberCount {
		events, unsubscribe, err := broker.Subscribe(context.Background(), "doc_500")
		if err != nil {
			t.Fatal(err)
		}
		channels = append(channels, events)
		unsubscribes = append(unsubscribes, unsubscribe)
	}

	var ticker *manualTicker
	select {
	case ticker = <-clock.created:
	case <-time.After(time.Second):
		t.Fatal("document poll ticker was not created")
	}
	source.setEvents("doc_500", testEvent("doc_500", 1))
	ticker.tick()
	for i, events := range channels {
		if event := receiveEvent(t, events); event.Revision != 1 {
			t.Fatalf("subscriber %d received revision %d, want 1", i, event.Revision)
		}
	}
	if current, list := source.calls("doc_500"); current != 1 || list != 1 {
		t.Fatalf("source calls = current %d list %d, want 1/1 for 500 subscribers", current, list)
	}
	if len(clock.created) != 0 {
		t.Fatal("more than one per-document poll ticker was created")
	}
	for _, unsubscribe := range unsubscribes {
		unsubscribe()
	}
	select {
	case <-ticker.stopped:
	case <-time.After(time.Second):
		t.Fatal("last unsubscribe did not stop the document poll ticker")
	}
}

func TestBrokerCoalescesDirtySignalsWhileFetchIsRunning(t *testing.T) {
	source := newTestSource()
	started := make(chan struct{})
	release := make(chan struct{})
	var blockOne sync.Once
	event := testEvent("doc_dirty", 1)
	source.listFn = func(ctx context.Context, _ string, afterRevision int64, limit int32) ([]repo.DocumentKVEvent, error) {
		blockOne.Do(func() {
			close(started)
			select {
			case <-release:
			case <-ctx.Done():
			}
		})
		return eventsAfter([]repo.DocumentKVEvent{event}, afterRevision, limit), nil
	}
	listener := newTestListener()
	factory := &testListenerFactory{results: []factoryResult{{listener: listener}}}
	broker, err := newBroker(context.Background(), Config{Mode: ModeNotify, Logger: testLogger()}, source, factory, newManualClock())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(broker.Close)
	events, unsubscribe, err := broker.Subscribe(context.Background(), "doc_dirty")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unsubscribe)

	broker.markDirty("doc_dirty")
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("first dirty fetch did not start")
	}
	for range 100 {
		broker.markDirty("doc_dirty")
	}
	close(release)
	if got := receiveEvent(t, events); got.Revision != 1 {
		t.Fatalf("revision = %d, want 1", got.Revision)
	}
	waitFor(t, func() bool {
		_, list := source.calls("doc_dirty")
		return list == 2
	})
	if _, list := source.calls("doc_dirty"); list != 2 {
		t.Fatalf("100 concurrent dirty signals caused %d fetches, want 2 including the in-flight fetch", list)
	}
}

func TestBrokerRetriesFetchWithoutLosingEvent(t *testing.T) {
	source := newTestSource()
	source.failures["doc_retry"] = 1
	source.setEvents("doc_retry", testEvent("doc_retry", 1))
	clock := newManualClock()
	broker, err := newBroker(context.Background(), Config{Mode: ModePoll, PollInterval: time.Hour, Logger: testLogger()}, source, nil, clock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(broker.Close)
	events, unsubscribe, err := broker.Subscribe(context.Background(), "doc_retry")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unsubscribe)
	ticker := <-clock.created
	ticker.tick()
	if event := receiveEvent(t, events); event.Revision != 1 {
		t.Fatalf("revision = %d, want 1 after retry", event.Revision)
	}
	if _, list := source.calls("doc_retry"); list != 2 {
		t.Fatalf("list calls = %d, want failed attempt plus retry", list)
	}
	select {
	case <-clock.sleepCalls:
	default:
		t.Fatal("fetch failure did not use retry backoff")
	}
}

func TestBrokerReconnectResyncsEveryActiveDocument(t *testing.T) {
	source := newTestSource()
	first := newTestListener()
	second := newTestListener()
	factory := &testListenerFactory{results: []factoryResult{{listener: first}, {listener: second}}}
	broker, err := newBroker(context.Background(), Config{Mode: ModeNotify, Logger: testLogger()}, source, factory, newManualClock())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(broker.Close)

	aEvents, unsubscribeA, err := broker.Subscribe(context.Background(), "doc_a")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unsubscribeA)
	bEvents, unsubscribeB, err := broker.Subscribe(context.Background(), "doc_b")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unsubscribeB)
	source.setEvents("doc_a", testEvent("doc_a", 1))
	source.setEvents("doc_b", testEvent("doc_b", 1))

	first.results <- listenerResult{err: errors.New("connection lost")}
	if event := receiveEvent(t, aEvents); event.DocumentID != "doc_a" {
		t.Fatalf("document A resync delivered %q", event.DocumentID)
	}
	if event := receiveEvent(t, bEvents); event.DocumentID != "doc_b" {
		t.Fatalf("document B resync delivered %q", event.DocumentID)
	}
	if factory.callCount() != 2 {
		t.Fatalf("listener opens = %d, want initial plus reconnect", factory.callCount())
	}
	select {
	case <-first.closed:
	default:
		t.Fatal("disconnected listener was not closed")
	}
}

func TestAutoBrokerDowngradesToCoalescedPollingAfterReconnectFailures(t *testing.T) {
	source := newTestSource()
	initial := newTestListener()
	reconnectErr := errors.New("LISTEN remains unavailable")
	factory := &testListenerFactory{results: []factoryResult{
		{listener: initial},
		{err: reconnectErr},
		{err: reconnectErr},
		{err: reconnectErr},
	}}
	clock := newManualClock()
	broker, err := newBroker(context.Background(), Config{Mode: ModeAuto, PollInterval: time.Hour, Logger: testLogger()}, source, factory, clock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(broker.Close)
	if broker.ActiveMode() != ModeNotify {
		t.Fatalf("initial active mode = %q, want notify", broker.ActiveMode())
	}

	events, unsubscribe, err := broker.Subscribe(context.Background(), "doc_downgrade")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unsubscribe)
	source.setEvents("doc_downgrade", testEvent("doc_downgrade", 1))
	initial.results <- listenerResult{err: errors.New("connection lost")}

	if event := receiveEvent(t, events); event.Revision != 1 {
		t.Fatalf("downgrade resync delivered revision %d, want 1", event.Revision)
	}
	waitFor(t, func() bool { return broker.ActiveMode() == ModePoll })
	if factory.callCount() != 1+autoReconnectLimit {
		t.Fatalf("listener opens = %d, want initial plus %d failed reconnects", factory.callCount(), autoReconnectLimit)
	}
	select {
	case <-initial.closed:
	default:
		t.Fatal("disconnected listener was not closed")
	}

	var ticker *manualTicker
	select {
	case ticker = <-clock.created:
	case <-time.After(time.Second):
		t.Fatal("poll ticker was not activated after auto downgrade")
	}
	source.setEvents("doc_downgrade", testEvent("doc_downgrade", 1), testEvent("doc_downgrade", 2))
	ticker.tick()
	if event := receiveEvent(t, events); event.Revision != 2 {
		t.Fatalf("post-downgrade poll delivered revision %d, want 2", event.Revision)
	}
	if len(clock.created) != 0 {
		t.Fatal("auto downgrade created more than one poll loop for the document")
	}
}

func TestBrokerCloseStopsWorkersAndClosesSubscribers(t *testing.T) {
	source := newTestSource()
	clock := newManualClock()
	broker, err := newBroker(context.Background(), Config{Mode: ModePoll, PollInterval: time.Hour, Logger: testLogger()}, source, nil, clock)
	if err != nil {
		t.Fatal(err)
	}
	events, _, err := broker.Subscribe(context.Background(), "doc_close")
	if err != nil {
		t.Fatal(err)
	}
	ticker := <-clock.created

	done := make(chan struct{})
	go func() {
		broker.Close()
		broker.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("broker Close did not stop all workers")
	}
	if _, ok := <-events; ok {
		t.Fatal("subscriber channel remained open after broker Close")
	}
	select {
	case <-ticker.stopped:
	default:
		t.Fatal("poll ticker remained active after broker Close")
	}
	if _, _, err := broker.Subscribe(context.Background(), "doc_close"); !errors.Is(err, errBrokerClosed) {
		t.Fatalf("Subscribe after Close error = %v, want errBrokerClosed", err)
	}
}

func TestPostgresListenerDeliversOnlyCommittedNotifications(t *testing.T) {
	store, databaseURL := openTestStore(t)
	listener, err := NewPostgresListenerFactory(databaseURL, store.Pool()).Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := listener.Close(ctx); err != nil {
			t.Errorf("close listener: %v", err)
		}
	})

	tx, err := store.Pool().Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(context.Background(), "SELECT pg_notify($1, $2)", postgresNotificationChannel, "doc_commit"); err != nil {
		t.Fatal(err)
	}
	waitCtx, cancelWait := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelWait()
	result := make(chan listenerResult, 1)
	go func() {
		documentID, waitErr := listener.Wait(waitCtx)
		result <- listenerResult{documentID: documentID, err: waitErr}
	}()
	select {
	case early := <-result:
		t.Fatalf("notification arrived before commit: %#v", early)
	case <-time.After(100 * time.Millisecond):
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case committed := <-result:
		if committed.err != nil || committed.documentID != "doc_commit" {
			t.Fatalf("committed notification = %#v", committed)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("committed notification was not delivered")
	}

	tx, err = store.Pool().Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(context.Background(), "SELECT pg_notify($1, $2)", postgresNotificationChannel, "doc_rollback"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	rollbackCtx, cancelRollback := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancelRollback()
	if documentID, err := listener.Wait(rollbackCtx); err == nil {
		t.Fatalf("rolled-back notification was delivered as %q", documentID)
	}
}

func TestPostgresPatchNotifiesOnceAndNoOpDoesNotNotify(t *testing.T) {
	store, databaseURL := openTestStore(t)
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "owner_notify", Email: "owner-notify@example.com", Name: "Owner"}
	document, _, err := store.CreateDocument(context.Background(), owner, "notify", []byte("<html></html>"))
	if err != nil {
		t.Fatal(err)
	}
	factory := NewPostgresListenerFactory(databaseURL, store.Pool())
	observer, err := factory.Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := observer.Close(ctx); err != nil {
			t.Errorf("close observer listener: %v", err)
		}
	})
	broker, err := New(context.Background(), Config{Mode: ModeNotify, Logger: testLogger()}, store, factory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(broker.Close)
	events, unsubscribe, err := broker.Subscribe(context.Background(), document.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unsubscribe)

	patched, err := store.PatchDocumentKV(context.Background(), document.ID, map[string]json.RawMessage{"ready": json.RawMessage("true")}, nil, owner)
	if err != nil {
		t.Fatal(err)
	}
	if event := receiveEvent(t, events); event.Revision != patched.Revision {
		t.Fatalf("event revision = %d, patch revision = %d", event.Revision, patched.Revision)
	}
	observeCtx, cancelObserve := context.WithTimeout(context.Background(), 3*time.Second)
	observedDocument, err := observer.Wait(observeCtx)
	cancelObserve()
	if err != nil || observedDocument != document.ID {
		t.Fatalf("observer notification = %q, %v; want %q", observedDocument, err, document.ID)
	}
	noOp, err := store.PatchDocumentKV(context.Background(), document.ID, nil, nil, owner)
	if err != nil {
		t.Fatal(err)
	}
	if noOp.Revision != patched.Revision || len(noOp.Changes) != 0 {
		t.Fatalf("no-op result = revision %d changes %d", noOp.Revision, len(noOp.Changes))
	}
	noNotifyCtx, cancelNoNotify := context.WithTimeout(context.Background(), 150*time.Millisecond)
	if documentID, err := observer.Wait(noNotifyCtx); err == nil {
		cancelNoNotify()
		t.Fatalf("no-op patch sent PostgreSQL notification for %q", documentID)
	}
	cancelNoNotify()
	select {
	case event := <-events:
		t.Fatalf("no-op patch emitted event %#v", event)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestPostgresDeleteNotifiesAndClosesBrokerSubscribers(t *testing.T) {
	store, databaseURL := openTestStore(t)
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "owner_delete_notify", Email: "owner-delete-notify@example.com", Name: "Owner"}
	document, _, err := store.CreateDocument(context.Background(), owner, "delete notify", []byte("<html></html>"))
	if err != nil {
		t.Fatal(err)
	}
	factory := NewPostgresListenerFactory(databaseURL, store.Pool())
	observer, err := factory.Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeTestListener(t, observer) })
	broker, err := New(context.Background(), Config{Mode: ModeNotify, Logger: testLogger()}, store, factory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(broker.Close)
	events, unsubscribe, err := broker.Subscribe(context.Background(), document.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unsubscribe)

	if err := store.DeleteDocument(context.Background(), document.ID); err != nil {
		t.Fatal(err)
	}
	observeCtx, cancelObserve := context.WithTimeout(context.Background(), 3*time.Second)
	observedDocument, err := observer.Wait(observeCtx)
	cancelObserve()
	if err != nil || observedDocument != document.ID {
		t.Fatalf("delete notification = %q, %v; want %q", observedDocument, err, document.ID)
	}
	select {
	case _, ok := <-events:
		if ok {
			t.Fatal("deleted document emitted an event instead of closing subscribers")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("deleted document subscriber was not closed")
	}

	if err := store.DeleteDocument(context.Background(), document.ID); err != nil {
		t.Fatal(err)
	}
	noNotifyCtx, cancelNoNotify := context.WithTimeout(context.Background(), 150*time.Millisecond)
	if duplicate, err := observer.Wait(noNotifyCtx); err == nil {
		cancelNoNotify()
		t.Fatalf("deleting an already-missing document sent notification for %q", duplicate)
	}
	cancelNoNotify()
}

func TestPostgresListenerDoesNotConsumeApplicationPoolConnection(t *testing.T) {
	databaseURL := testdb.New(t)
	u, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	query := u.Query()
	query.Set("pool_max_conns", "1")
	u.RawQuery = query.Encode()
	databaseURL = u.String()
	store, err := pgrepo.Connect(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)

	listener, err := NewPostgresListenerFactory(databaseURL, store.Pool()).Open(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeTestListener(t, listener) })
	if acquired := store.Pool().Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("dedicated listener left %d application pool connections acquired", acquired)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := store.Pool().Acquire(ctx)
	if err != nil {
		t.Fatalf("single-connection application pool was starved by listener: %v", err)
	}
	if _, err := conn.Exec(ctx, "SELECT pg_notify($1, $2)", postgresNotificationChannel, "doc_pool_one"); err != nil {
		conn.Release()
		t.Fatal(err)
	}
	conn.Release()
	if documentID, err := listener.Wait(ctx); err != nil || documentID != "doc_pool_one" {
		t.Fatalf("notification through single-connection pool = %q, %v", documentID, err)
	}
}

func closeTestListener(t *testing.T, listener Listener) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := listener.Close(ctx); err != nil {
		t.Errorf("close listener: %v", err)
	}
}

func openTestStore(t *testing.T) (*pgrepo.Store, string) {
	t.Helper()
	databaseURL := testdb.New(t)
	store, err := pgrepo.Connect(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	return store, databaseURL
}

func TestBrokerRelaysThroughNotificationsToEveryReplica(t *testing.T) {
	listener := newTestListener()
	factory := &testListenerFactory{results: []factoryResult{{listener: listener}}}
	broker, err := newBroker(context.Background(), Config{Mode: ModeNotify, Logger: testLogger()}, newTestSource(), factory, newManualClock())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(broker.Close)
	events, unsubscribe, err := broker.Subscribe(context.Background(), "doc_relay")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unsubscribe)

	relayed := repo.DocumentKVEvent{DocumentID: "doc_relay", Kind: repo.DocumentEventCursor, Data: []byte(`{"session":"s"}`)}
	if err := broker.Relay(context.Background(), relayed); err != nil {
		t.Fatal(err)
	}
	factory.mu.Lock()
	notified := append([]string(nil), factory.notified...)
	factory.mu.Unlock()
	if len(notified) != 1 || !strings.HasPrefix(notified[0], relayPayloadPrefix) {
		t.Fatalf("notified = %q, want one relay payload", notified)
	}
	listener.results <- listenerResult{documentID: notified[0]}
	if got := receiveEvent(t, events); got.Kind != repo.DocumentEventCursor || got.Revision != 0 || string(got.Data) != `{"session":"s"}` {
		t.Fatalf("relayed event = %#v", got)
	}

	large := relayed
	large.Data = []byte(`"` + strings.Repeat("x", maxRelayPayload) + `"`)
	if err := broker.Relay(context.Background(), large); !errors.Is(err, errRelayTooLarge) {
		t.Fatalf("large relay error = %v, want errRelayTooLarge", err)
	}
}

func TestBrokerRelayInPollModeKeepsRoomForStoredEvents(t *testing.T) {
	broker, err := newBroker(context.Background(), Config{Mode: ModePoll, PollInterval: time.Hour, Logger: testLogger()}, newTestSource(), nil, newManualClock())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(broker.Close)
	events, unsubscribe, err := broker.Subscribe(context.Background(), "doc_relay")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(unsubscribe)

	for range subscriberBuffer {
		if err := broker.Relay(context.Background(), repo.DocumentKVEvent{DocumentID: "doc_relay", Kind: repo.DocumentEventCursor}); err != nil {
			t.Fatal(err)
		}
	}
	if len(events) != subscriberBuffer/2 {
		t.Fatalf("buffered relayed events = %d, want %d", len(events), subscriberBuffer/2)
	}
	if got := receiveEvent(t, events); got.Kind != repo.DocumentEventCursor {
		t.Fatalf("event = %#v, want a cursor event", got)
	}
}
