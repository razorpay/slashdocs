package testdb_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/razorpay/slashdocs/api/internal/testdb"
)

// TestDatabasesAreMigratedAndIsolated verifies that each New call yields its
// own fully migrated database: rows written in one are invisible in the other.
func TestDatabasesAreMigratedAndIsolated(t *testing.T) {
	ctx := context.Background()
	first, err := pgx.Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := first.Close(ctx); err != nil {
			t.Errorf("close first database connection: %v", err)
		}
	}()
	second, err := pgx.Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := second.Close(ctx); err != nil {
			t.Errorf("close second database connection: %v", err)
		}
	}()

	if _, err := first.Exec(ctx, `INSERT INTO users (id, email) VALUES ('usr_1', 'a@example.com')`); err != nil {
		t.Fatalf("insert into migrated schema: %v", err)
	}
	var count int
	if err := second.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("databases are not isolated: second database has %d users", count)
	}
}
