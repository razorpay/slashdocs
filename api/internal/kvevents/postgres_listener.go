package kvevents

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	postgresNotificationChannel = "slashdocs_kv_events"
	probePayloadPrefix          = "__slashdocs_kv_probe__:"
	listenerProbeWait           = 3 * time.Second
)

// PostgresListenerFactory opens verified PostgreSQL LISTEN connections.
type PostgresListenerFactory struct {
	databaseURL string
	sender      NotificationSender
}

type postgresListener struct {
	conn     *pgx.Conn
	pending  []string
	closeOne sync.Once
	closeErr error
}

// NotificationSender emits the verification probe through the application's
// normal database pool, independently of the dedicated LISTEN connection.
type NotificationSender interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

// NewPostgresListenerFactory returns a factory that owns a dedicated pgx
// connection outside the application's pool. databaseURL must reach the same
// database directly or through a session-pooling proxy.
func NewPostgresListenerFactory(databaseURL string, sender NotificationSender) *PostgresListenerFactory {
	return &PostgresListenerFactory{databaseURL: databaseURL, sender: sender}
}

func (f *PostgresListenerFactory) Open(ctx context.Context) (_ Listener, returnErr error) {
	conn, err := f.connect(ctx)
	if err != nil {
		return nil, err
	}
	keep := false
	defer func() {
		if keep {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), listenerCloseWait)
		defer cancel()
		returnErr = errors.Join(returnErr, conn.Close(cleanupCtx))
	}()

	if _, err := conn.Exec(ctx, "LISTEN "+postgresNotificationChannel); err != nil {
		return nil, fmt.Errorf("LISTEN %s: %w", postgresNotificationChannel, err)
	}
	probe, err := newProbePayload()
	if err != nil {
		return nil, err
	}
	if err := f.Notify(ctx, probe); err != nil {
		return nil, fmt.Errorf("send LISTEN verification probe: %w", err)
	}
	pending, err := waitForProbe(ctx, conn, probe)
	if err != nil {
		return nil, err
	}

	keep = true
	return &postgresListener{conn: conn, pending: pending}, nil
}

// Notify publishes a payload to every listener through the application's pool.
func (f *PostgresListenerFactory) Notify(ctx context.Context, payload string) error {
	_, err := f.sender.Exec(ctx, "SELECT pg_notify($1, $2)", postgresNotificationChannel, payload)
	return err
}

func (f *PostgresListenerFactory) connect(ctx context.Context) (*pgx.Conn, error) {
	if strings.TrimSpace(f.databaseURL) == "" {
		return nil, errors.New("PostgreSQL listener database URL is required")
	}
	if f.sender == nil {
		return nil, errors.New("PostgreSQL notification sender is required")
	}
	// Parse with pgxpool so listener URLs may safely reuse DATABASE_URL values
	// containing pool_* settings. Only the underlying connection config is used;
	// the listener itself never consumes a pool slot.
	poolConfig, err := pgxpool.ParseConfig(f.databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse PostgreSQL listener database URL: %w", err)
	}
	conn, err := pgx.ConnectConfig(ctx, poolConfig.ConnConfig.Copy())
	if err != nil {
		return nil, fmt.Errorf("connect PostgreSQL listener: %w", err)
	}
	return conn, nil
}

func waitForProbe(ctx context.Context, conn *pgx.Conn, probe string) ([]string, error) {
	probeCtx, cancel := context.WithTimeout(ctx, listenerProbeWait)
	defer cancel()
	var pending []string
	for {
		notification, err := conn.WaitForNotification(probeCtx)
		if err != nil {
			return nil, fmt.Errorf("verify LISTEN notifications: %w", err)
		}
		if notification == nil || notification.Channel != postgresNotificationChannel {
			continue
		}
		if notification.Payload == probe {
			break
		}
		if notification.Payload != "" && !IsProbePayload(notification.Payload) {
			pending = append(pending, notification.Payload)
		}
	}
	return pending, nil
}

func (l *postgresListener) Wait(ctx context.Context) (string, error) {
	for {
		if len(l.pending) > 0 {
			documentID := l.pending[0]
			l.pending = l.pending[1:]
			return documentID, nil
		}
		notification, err := l.conn.WaitForNotification(ctx)
		if err != nil {
			return "", err
		}
		if notification == nil || notification.Channel != postgresNotificationChannel || notification.Payload == "" || IsProbePayload(notification.Payload) {
			continue
		}
		return notification.Payload, nil
	}
}

func (l *postgresListener) Close(ctx context.Context) error {
	l.closeOne.Do(func() {
		// Closing the owned session removes LISTEN state unconditionally. It is
		// never returned to the application's pool on either success or failure.
		l.closeErr = l.conn.Close(ctx)
	})
	return l.closeErr
}

// IsProbePayload reports whether a payload belongs to listener verification
// rather than a document event.
func IsProbePayload(payload string) bool {
	return strings.HasPrefix(payload, probePayloadPrefix)
}

func newProbePayload() (string, error) {
	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", fmt.Errorf("generate LISTEN verification probe: %w", err)
	}
	return probePayloadPrefix + hex.EncodeToString(random[:]), nil
}
