// Package testdb hands tests isolated, fully migrated PostgreSQL databases.
//
// One PostgreSQL server is shared per test binary: either the one named by
// SLASHDOCS_TEST_DATABASE_URL (for CI environments without Docker) or a
// disposable container started via testcontainers. A template database is
// migrated once per schema version, and every call to New clones it, so each
// test gets a private database in a few milliseconds.
package testdb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"

	"github.com/razorpay/slashdocs/api/internal/db"
)

// EnvURL is the environment variable that points tests at an existing
// PostgreSQL server instead of starting a container. The referenced role must
// be allowed to CREATE DATABASE.
const EnvURL = "SLASHDOCS_TEST_DATABASE_URL"

const containerImage = "postgres:17-alpine"

var setup struct {
	once     sync.Once
	adminURL string // connection string to the server's maintenance database
	template string // name of the migrated template database
	err      error
}

// closeConn is used on cleanup paths where the operation has already
// succeeded or the test server may be gone, leaving no useful recovery action.
func closeConn(ctx context.Context, conn *pgx.Conn) {
	_ = conn.Close(ctx)
}

// New returns a connection string for a fresh database that already has all
// migrations applied. The database is private to the calling test and dropped
// on cleanup. If no PostgreSQL server is reachable (no Docker and no
// SLASHDOCS_TEST_DATABASE_URL), the calling test is skipped with an explanation.
func New(t testing.TB) string {
	t.Helper()
	setup.once.Do(initServer)
	if setup.err != nil {
		t.Skipf("postgres unavailable: %v (start Docker or set %s to a database whose role may CREATE DATABASE)", setup.err, EnvURL)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, setup.adminURL)
	if err != nil {
		t.Fatalf("testdb: connect admin: %v", err)
	}
	defer closeConn(ctx, admin)

	name := "slashdocs_test_" + randomSuffix()
	if _, err := admin.Exec(ctx, fmt.Sprintf(`CREATE DATABASE %q TEMPLATE %q`, name, setup.template)); err != nil {
		t.Fatalf("testdb: clone template database: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		admin, err := pgx.Connect(ctx, setup.adminURL)
		if err != nil {
			return // the server (or its container) is already gone
		}
		defer closeConn(ctx, admin)
		_, _ = admin.Exec(ctx, fmt.Sprintf(`DROP DATABASE IF EXISTS %q WITH (FORCE)`, name))
	})
	return withDatabase(setup.adminURL, name)
}

// initServer resolves the shared PostgreSQL server (env override or a new
// container) and builds the migrated template database.
func initServer() {
	adminURL := os.Getenv(EnvURL)
	if adminURL == "" {
		containerURL, err := startContainer()
		if err != nil {
			setup.err = fmt.Errorf("starting %s container: %w", containerImage, err)
			return
		}
		adminURL = containerURL
	}
	setup.adminURL = adminURL
	setup.template, setup.err = ensureTemplate(adminURL)
}

// startContainer launches a disposable PostgreSQL container that lives for the
// rest of the test binary; testcontainers' reaper removes it afterwards.
func startContainer() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	ctr, err := tcpostgres.Run(ctx, containerImage,
		tcpostgres.WithDatabase("postgres"),
		tcpostgres.WithUsername("postgres"),
		tcpostgres.WithPassword("postgres"),
		tcpostgres.BasicWaitStrategies(),
	)
	if err != nil {
		return "", err
	}
	return ctr.ConnectionString(ctx, "sslmode=disable")
}

// ensureTemplate creates and migrates the template database for the current
// schema version if it does not exist yet. The name embeds a fingerprint of
// the migrations, and creation runs under an advisory lock, so concurrent test
// binaries sharing one server build it exactly once and reuse it afterwards.
func ensureTemplate(adminURL string) (string, error) {
	name := "slashdocs_test_tmpl_" + db.Fingerprint()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		return "", fmt.Errorf("connect %s: %w", redacted(adminURL), err)
	}
	defer closeConn(ctx, admin)

	const templateLockID = int64(0x6169646f6373) // "slashdocs"
	if _, err := admin.Exec(ctx, `SELECT pg_advisory_lock($1)`, templateLockID); err != nil {
		return "", err
	}
	defer func() {
		_, _ = admin.Exec(ctx, `SELECT pg_advisory_unlock($1)`, templateLockID)
	}()

	var exists bool
	if err := admin.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, name).Scan(&exists); err != nil {
		return "", err
	}
	if exists {
		return name, nil
	}
	if _, err := admin.Exec(ctx, fmt.Sprintf(`CREATE DATABASE %q`, name)); err != nil {
		return "", err
	}
	if err := db.Migrate(withDatabase(adminURL, name)); err != nil {
		// Drop the half-migrated database so the next run starts clean.
		_, _ = admin.Exec(ctx, fmt.Sprintf(`DROP DATABASE IF EXISTS %q WITH (FORCE)`, name))
		return "", fmt.Errorf("migrate template database: %w", err)
	}
	return name, nil
}

// withDatabase returns connURL pointed at the given database name.
func withDatabase(connURL, name string) string {
	u, err := url.Parse(connURL)
	if err != nil {
		panic(fmt.Sprintf("testdb: invalid connection URL %q: %v", redacted(connURL), err))
	}
	u.Path = "/" + name
	return u.String()
}

// redacted strips credentials from a connection URL for error messages.
func redacted(connURL string) string {
	u, err := url.Parse(connURL)
	if err != nil {
		return "<unparseable database url>"
	}
	return u.Redacted()
}

func randomSuffix() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
