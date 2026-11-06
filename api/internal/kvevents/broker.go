// Package kvevents coalesces persisted document events (KV changes and live
// document, comment, and presence events) and fans them out to every SSE
// subscriber in a server process. It also relays ephemeral events, such as
// cursor moves, that are never stored.
package kvevents

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

const (
	defaultPollInterval = 2 * time.Second
	fetchLimit          = int32(100)
	subscriberBuffer    = 32
	listenerCloseWait   = 3 * time.Second
	maxReconnectDelay   = 5 * time.Second
	autoReconnectLimit  = 3
	// relayPayloadPrefix marks a notification that carries a relayed event
	// instead of the ID of a document with new stored events.
	relayPayloadPrefix = "__slashdocs_relay__:"
	// maxRelayPayload is the PostgreSQL limit on a notification payload.
	maxRelayPayload = 7999
)

var (
	errBrokerClosed     = errors.New("document KV event broker is closed")
	errDocumentInactive = errors.New("document KV event subscription is inactive")
	errRelayTooLarge    = errors.New("relayed document event is too large")
)

// Mode selects how a Broker learns that new persisted events are available.
type Mode string

const (
	// ModeAuto uses PostgreSQL notifications when they can be verified and
	// otherwise falls back to coalesced polling.
	ModeAuto Mode = "auto"
	// ModeNotify requires PostgreSQL LISTEN/NOTIFY support.
	ModeNotify Mode = "notify"
	// ModePoll uses one poll loop per document with active subscribers.
	ModePoll Mode = "poll"
)

// ParseMode validates a slashdocs_KV_EVENTS_MODE value. An empty value selects
// automatic detection.
func ParseMode(raw string) (Mode, error) {
	mode := Mode(strings.ToLower(strings.TrimSpace(raw)))
	if mode == "" {
		mode = ModeAuto
	}
	switch mode {
	case ModeAuto, ModeNotify, ModePoll:
		return mode, nil
	default:
		return "", fmt.Errorf("SLASHDOCS_KV_EVENTS_MODE must be %q, %q, or %q (got %q)", ModeAuto, ModeNotify, ModePoll, raw)
	}
}

// Source is the narrow persistence surface the event broker needs.
type Source interface {
	CurrentDocumentKVRevision(ctx context.Context, documentID string) (int64, error)
	ListDocumentKVEvents(ctx context.Context, documentID string, afterRevision int64, limit int32) ([]repo.DocumentKVEvent, error)
}

// Subscriber is the event-stream surface consumed by the HTTP server.
type Subscriber interface {
	Subscribe(ctx context.Context, documentID string) (<-chan repo.DocumentKVEvent, func(), error)
	Relay(ctx context.Context, event repo.DocumentKVEvent) error
}

// ListenerFactory opens a verified notification connection and sends
// notifications to every listener.
type ListenerFactory interface {
	Open(ctx context.Context) (Listener, error)
	Notify(ctx context.Context, payload string) error
}

// Listener waits for payloads published on the notification channel: the ID
// of a document with new stored events, or a relayed event.
type Listener interface {
	Wait(ctx context.Context) (string, error)
	Close(ctx context.Context) error
}

// Config controls event delivery. PollInterval is primarily useful to callers
// that need a shorter interval in a controlled environment; zero uses 2s.
type Config struct {
	Mode         Mode
	PollInterval time.Duration
	Logger       *slog.Logger
}

type eventTicker interface {
	C() <-chan time.Time
	Stop()
}

type eventClock interface {
	NewTicker(time.Duration) eventTicker
	Sleep(context.Context, time.Duration) error
}

type realEventClock struct{}

type realEventTicker struct{ ticker *time.Ticker }

func (realEventClock) NewTicker(interval time.Duration) eventTicker {
	return &realEventTicker{ticker: time.NewTicker(interval)}
}

func (realEventClock) Sleep(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (t *realEventTicker) C() <-chan time.Time { return t.ticker.C }
func (t *realEventTicker) Stop()               { t.ticker.Stop() }

type documentState struct {
	id       string
	ctx      context.Context
	cancel   context.CancelFunc
	ready    chan struct{}
	readyOne sync.Once
	initErr  error
	cursor   int64
	dirty    chan struct{}
	polling  chan struct{}
	subs     map[uint64]chan repo.DocumentKVEvent
}

// Broker owns one process-wide notification listener and one worker for each
// document that currently has subscribers.
type Broker struct {
	ctx             context.Context
	cancel          context.CancelFunc
	source          Source
	listenerFactory ListenerFactory
	requestedMode   Mode
	activeMode      Mode
	pollInterval    time.Duration
	logger          *slog.Logger
	clock           eventClock

	mu        sync.RWMutex
	documents map[string]*documentState
	nextSubID uint64
	closed    bool
	wg        sync.WaitGroup
	closeOne  sync.Once
	done      chan struct{}
}

// New constructs a broker and verifies notification support before returning.
// In auto mode a failed verification selects polling; forced notify mode
// returns the verification error instead.
func New(ctx context.Context, cfg Config, source Source, listenerFactory ListenerFactory) (*Broker, error) {
	return newBroker(ctx, cfg, source, listenerFactory, realEventClock{})
}

func newBroker(ctx context.Context, cfg Config, source Source, listenerFactory ListenerFactory, clock eventClock) (*Broker, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if source == nil {
		return nil, errors.New("document KV event source is required")
	}
	requestedMode, err := ParseMode(string(cfg.Mode))
	if err != nil {
		return nil, err
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = defaultPollInterval
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if clock == nil {
		clock = realEventClock{}
	}
	listenerFactory = normalizeListenerFactory(listenerFactory)

	brokerCtx, cancel := context.WithCancel(ctx)
	b := &Broker{
		ctx:             brokerCtx,
		cancel:          cancel,
		source:          source,
		listenerFactory: listenerFactory,
		requestedMode:   requestedMode,
		pollInterval:    cfg.PollInterval,
		logger:          cfg.Logger,
		clock:           clock,
		documents:       make(map[string]*documentState),
		done:            make(chan struct{}),
	}

	if err := b.startDelivery(ctx); err != nil {
		cancel()
		return nil, err
	}

	if ctx.Done() != nil {
		go func() {
			select {
			case <-ctx.Done():
				b.Close()
			case <-b.done:
			}
		}()
	}
	return b, nil
}

// normalizeListenerFactory strips a nil *PostgresListenerFactory that was
// boxed into a non-nil interface value. Without this, the nil-factory
// fallback in startDelivery is defeated and Open dereferences a nil pointer.
func normalizeListenerFactory(factory ListenerFactory) ListenerFactory {
	if concrete, ok := factory.(*PostgresListenerFactory); ok && concrete == nil {
		return nil
	}
	return factory
}

func (b *Broker) startDelivery(ctx context.Context) error {
	b.activeMode = ModePoll
	if b.requestedMode == ModePoll {
		return nil
	}
	if b.listenerFactory == nil {
		if b.requestedMode == ModeNotify {
			return errors.New("PostgreSQL notification listener is required in notify mode")
		}
		b.logger.Info("document KV listener URL not configured; using polling")
		return nil
	}

	initial, err := b.listenerFactory.Open(ctx)
	if err != nil {
		if b.requestedMode == ModeNotify {
			return fmt.Errorf("establish document KV notification listener: %w", err)
		}
		b.logger.Warn("PostgreSQL notifications unavailable; using document KV polling",
			slog.Any("error", err))
		return nil
	}
	b.activeMode = ModeNotify
	b.wg.Add(1)
	go b.runListener(initial)
	return nil
}

// RequestedMode returns the configured mode before automatic detection.
func (b *Broker) RequestedMode() Mode { return b.requestedMode }

// ActiveMode returns the selected runtime mode.
func (b *Broker) ActiveMode() Mode {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.activeMode
}

// Subscribe registers one subscriber for a document. The first subscriber
// initializes the document cursor and starts its sole worker.
func (b *Broker) Subscribe(ctx context.Context, documentID string) (<-chan repo.DocumentKVEvent, func(), error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if documentID == "" {
		return nil, func() {}, errors.New("document ID is required")
	}

	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil, func() {}, errBrokerClosed
	}
	state := b.documents[documentID]
	initialize := false
	if state == nil {
		stateCtx, cancel := context.WithCancel(b.ctx)
		state = &documentState{
			id:      documentID,
			ctx:     stateCtx,
			cancel:  cancel,
			ready:   make(chan struct{}),
			dirty:   make(chan struct{}, 1),
			polling: make(chan struct{}, 1),
			subs:    make(map[uint64]chan repo.DocumentKVEvent),
		}
		if b.activeMode == ModePoll {
			activateDocumentPolling(state)
		}
		b.documents[documentID] = state
		b.wg.Add(1)
		initialize = true
	}
	b.nextSubID++
	subID := b.nextSubID
	events := make(chan repo.DocumentKVEvent, subscriberBuffer)
	state.subs[subID] = events
	b.mu.Unlock()

	var unsubscribeOne sync.Once
	unsubscribe := func() {
		unsubscribeOne.Do(func() { b.unsubscribe(state, subID) })
	}
	if initialize {
		go b.initializeDocument(state)
	}

	select {
	case <-state.ready:
		if state.initErr != nil {
			unsubscribe()
			return nil, func() {}, state.initErr
		}
		return events, unsubscribe, nil
	case <-ctx.Done():
		unsubscribe()
		return nil, func() {}, ctx.Err()
	case <-b.ctx.Done():
		unsubscribe()
		return nil, func() {}, errBrokerClosed
	}
}

func (b *Broker) initializeDocument(state *documentState) {
	defer b.wg.Done()
	revision, err := b.source.CurrentDocumentKVRevision(state.ctx, state.id)

	startWorker := false
	b.mu.Lock()
	current := b.documents[state.id] == state && !b.closed
	if !current && err == nil {
		err = errDocumentInactive
	}
	state.initErr = err
	if err != nil {
		if current {
			delete(b.documents, state.id)
			for id, ch := range state.subs {
				delete(state.subs, id)
				close(ch)
			}
		}
		state.cancel()
	} else {
		state.cursor = revision
		b.wg.Add(1)
		startWorker = true
	}
	state.readyOne.Do(func() { close(state.ready) })
	b.mu.Unlock()

	if startWorker {
		go b.runDocument(state)
	}
}

func (b *Broker) unsubscribe(state *documentState, subID uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.documents[state.id] != state {
		return
	}
	if ch, ok := state.subs[subID]; ok {
		delete(state.subs, subID)
		close(ch)
	}
	if len(state.subs) == 0 {
		delete(b.documents, state.id)
		state.cancel()
	}
}

func (b *Broker) runDocument(state *documentState) {
	defer b.wg.Done()
	var ticker eventTicker
	var ticks <-chan time.Time
	polling := state.polling
	defer func() {
		if ticker != nil {
			ticker.Stop()
		}
	}()

	for {
		select {
		case <-state.ctx.Done():
			return
		case <-polling:
			// The activation channel is buffered but never closed. Nil it after
			// the one transition so it cannot become a busy select case.
			ticker = b.clock.NewTicker(b.pollInterval)
			ticks = ticker.C()
			polling = nil
		case <-state.dirty:
			b.syncDocument(state)
		case <-ticks:
			b.syncDocument(state)
		}
	}
}

func (b *Broker) syncDocument(state *documentState) {
	for attempt := 0; ; attempt++ {
		err := b.fetchDocument(state)
		if err == nil || errors.Is(err, errDocumentInactive) {
			return
		}
		if errors.Is(err, repo.ErrNotFound) {
			b.dropDocument(state)
			return
		}
		b.logger.Warn("failed to fetch document KV events; retrying",
			slog.String("document_id", state.id),
			slog.Any("error", err))
		if err := b.clock.Sleep(state.ctx, reconnectDelay(attempt)); err != nil {
			return
		}
	}
}

func (b *Broker) fetchDocument(state *documentState) error {
	for {
		b.mu.Lock()
		if b.documents[state.id] != state {
			b.mu.Unlock()
			return errDocumentInactive
		}
		cursor := state.cursor
		b.mu.Unlock()

		events, err := b.source.ListDocumentKVEvents(state.ctx, state.id, cursor, fetchLimit)
		if err != nil {
			return err
		}
		advanced := false
		for _, event := range events {
			if event.DocumentID != state.id || event.Revision <= cursor || emptyKVEvent(event) {
				continue
			}
			if !b.publish(state, event) {
				return errDocumentInactive
			}
			cursor = event.Revision
			advanced = true
		}
		if len(events) < int(fetchLimit) || !advanced {
			return nil
		}
	}
}

// emptyKVEvent reports a KV event without changes. Other live event kinds
// carry no KV changes by design and are always delivered.
func emptyKVEvent(event repo.DocumentKVEvent) bool {
	return len(event.Changes) == 0 && (event.Kind == "" || event.Kind == repo.DocumentEventKV)
}

func (b *Broker) publish(state *documentState, event repo.DocumentKVEvent) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.documents[state.id] != state {
		return false
	}
	if event.Revision <= state.cursor {
		return true
	}
	state.cursor = event.Revision
	for id, ch := range state.subs {
		select {
		case ch <- event:
		default:
			delete(state.subs, id)
			close(ch)
		}
	}
	if len(state.subs) == 0 {
		delete(b.documents, state.id)
		state.cancel()
		return false
	}
	return true
}

// Relay sends an event that is not stored to the subscribers of its document.
// In notify mode the event goes through PostgreSQL to every server replica.
// In poll mode only the subscribers of this process get it.
func (b *Broker) Relay(ctx context.Context, event repo.DocumentKVEvent) error {
	if b.ActiveMode() != ModeNotify {
		b.deliver(event)
		return nil
	}
	raw, err := json.Marshal(event)
	if err != nil {
		return err
	}
	payload := relayPayloadPrefix + string(raw)
	if len(payload) > maxRelayPayload {
		return errRelayTooLarge
	}
	return b.listenerFactory.Notify(ctx, payload)
}

// deliver gives a relayed event to each subscriber with room for it. Relayed
// events use at most half of a buffer, so they never fill it and disconnect a
// subscriber that stored events must reach. A full subscriber misses the
// event, which the next relayed event replaces.
func (b *Broker) deliver(event repo.DocumentKVEvent) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	state := b.documents[event.DocumentID]
	if state == nil {
		return
	}
	for _, ch := range state.subs {
		if len(ch) >= cap(ch)/2 {
			continue
		}
		select {
		case ch <- event:
		default:
		}
	}
}

func (b *Broker) dropDocument(state *documentState) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.documents[state.id] != state {
		return
	}
	delete(b.documents, state.id)
	for id, ch := range state.subs {
		delete(state.subs, id)
		close(ch)
	}
	state.cancel()
}

func (b *Broker) markDirty(documentID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	state := b.documents[documentID]
	if state == nil {
		return
	}
	select {
	case state.dirty <- struct{}{}:
	default:
	}
}

func (b *Broker) markAllDirty() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, state := range b.documents {
		select {
		case state.dirty <- struct{}{}:
		default:
		}
	}
}

func activateDocumentPolling(state *documentState) {
	select {
	case state.polling <- struct{}{}:
	default:
	}
}

func (b *Broker) downgradeToPolling(reason error) {
	b.mu.Lock()
	if b.closed || b.activeMode == ModePoll {
		b.mu.Unlock()
		return
	}
	b.activeMode = ModePoll
	for _, state := range b.documents {
		activateDocumentPolling(state)
		select {
		case state.dirty <- struct{}{}:
		default:
		}
	}
	b.mu.Unlock()

	b.logger.Warn("document KV notifications repeatedly failed; permanently using polling",
		slog.Int("reconnect_failures", autoReconnectLimit),
		slog.Any("error", reason))
}

func (b *Broker) runListener(initial Listener) {
	defer b.wg.Done()
	listener := initial
	defer func() {
		if listener != nil {
			b.closeListener(listener)
		}
	}()

	for {
		payload, err := listener.Wait(b.ctx)
		if err == nil {
			switch raw, relayed := strings.CutPrefix(payload, relayPayloadPrefix); {
			case relayed:
				var event repo.DocumentKVEvent
				if json.Unmarshal([]byte(raw), &event) == nil {
					b.deliver(event)
				}
			case payload != "" && !IsProbePayload(payload):
				b.markDirty(payload)
			}
			continue
		}
		b.closeListener(listener)
		listener = nil
		if b.ctx.Err() != nil {
			return
		}
		b.logger.Warn("document KV notification listener disconnected; reconnecting",
			slog.Any("error", err))

		failures := 0
		for listener == nil {
			if err := b.clock.Sleep(b.ctx, reconnectDelay(failures)); err != nil {
				return
			}
			next, openErr := b.listenerFactory.Open(b.ctx)
			if openErr != nil {
				failures++
				b.logger.Warn("failed to reconnect document KV notification listener",
					slog.Int("consecutive_failures", failures),
					slog.Any("error", openErr))
				if b.requestedMode == ModeAuto && failures >= autoReconnectLimit {
					b.downgradeToPolling(openErr)
					return
				}
				continue
			}
			listener = next
		}
		// LISTEN notifications are not durable. Fetch every subscribed document
		// once after reconnect so commits from the connection gap are recovered.
		b.markAllDirty()
		b.logger.Info("document KV notification listener reconnected")
	}
}

func (b *Broker) closeListener(listener Listener) {
	ctx, cancel := context.WithTimeout(context.Background(), listenerCloseWait)
	defer cancel()
	if err := listener.Close(ctx); err != nil && b.ctx.Err() == nil {
		b.logger.Warn("failed to close document KV notification listener",
			slog.Any("error", err))
	}
}

func reconnectDelay(attempt int) time.Duration {
	if attempt > 6 {
		attempt = 6
	}
	delay := 100 * time.Millisecond * time.Duration(1<<attempt)
	if delay > maxReconnectDelay {
		return maxReconnectDelay
	}
	return delay
}

// Close stops listener and document workers, then closes every subscriber.
// It is safe to call more than once.
func (b *Broker) Close() {
	b.closeOne.Do(func() {
		b.cancel()
		b.mu.Lock()
		b.closed = true
		for documentID, state := range b.documents {
			delete(b.documents, documentID)
			for id, ch := range state.subs {
				delete(state.subs, id)
				close(ch)
			}
			state.cancel()
		}
		b.mu.Unlock()
		b.wg.Wait()
		close(b.done)
	})
}
