package db_test

import (
	"context"
	"database/sql"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pressly/goose/v3"

	aidb "github.com/razorpay/slashdocs/api/internal/db"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

var bookTables = []string{"books", "book_outline_versions", "version_sections", "chapter_reads", "reading_positions"}

// TestBooksMigrationIndexesForeignKeys checks that every foreign key of the
// book tables leads some index, so a cascading document, version or book
// delete never scans these tables once per deleted row. It also checks that
// migration 34 builds no index on the existing versions table (that build
// would run under the ACCESS EXCLUSIVE lock of its ALTER TABLE) and that its
// Down restores version 33.
func TestBooksMigrationIndexesForeignKeys(t *testing.T) {
	databaseURL := testdb.New(t)
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := aidb.Migrate(databaseURL); err != nil {
		t.Fatal(err)
	}

	rows, err := database.Query(`
		SELECT c.conrelid::regclass::text, a.attname
		FROM pg_constraint c
		JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
		WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY($1)
		  AND NOT EXISTS (
		    SELECT 1 FROM pg_index i
		    WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])
		ORDER BY 1, 2`, bookTables)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var table, column string
		if err := rows.Scan(&table, &column); err != nil {
			t.Fatal(err)
		}
		t.Errorf("foreign key %s.%s leads no index", table, column)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	at34 := versionsIndexes(t, database)
	setMigrationTestFS(t)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 33); err != nil {
		t.Fatalf("down to 33: %v", err)
	}
	if got := versionsIndexes(t, database); !reflect.DeepEqual(got, at34) {
		t.Errorf("migration 34 adds indexes on versions: at 33 %v, at 34 %v", got, at34)
	}
	var left int
	if err := database.QueryRow(`SELECT count(*) FROM pg_class WHERE relname = ANY($1)`, bookTables).Scan(&left); err != nil {
		t.Fatal(err)
	}
	var column int
	if err := database.QueryRow(`SELECT count(*) FROM information_schema.columns WHERE table_name='versions' AND column_name='sections_indexed'`).Scan(&column); err != nil {
		t.Fatal(err)
	}
	if left != 0 || column != 0 {
		t.Errorf("after Down: %d book tables and %d sections_indexed columns remain", left, column)
	}
	if err := aidb.Migrate(databaseURL); err != nil {
		t.Fatalf("re-apply 34: %v", err)
	}
}

func versionsIndexes(t *testing.T, database *sql.DB) []string {
	t.Helper()
	rows, err := database.Query(`SELECT indexname FROM pg_indexes WHERE tablename = 'versions' ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		out = append(out, n)
	}
	return out
}

// TestBooksMigrationGivesUpOnABusyVersionsTable checks that migration 34
// waits a bounded time for its locks on versions. Without lock_timeout, an
// old pod's long read on versions would queue the ALTER TABLE, and every new
// versions read would queue behind it, stalling document views until the read
// ends. With it, the migration fails, the server does not start, and the
// deploy retries.
func TestBooksMigrationGivesUpOnABusyVersionsTable(t *testing.T) {
	databaseURL := testdb.New(t)
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := aidb.Migrate(databaseURL); err != nil {
		t.Fatal(err)
	}
	setMigrationTestFS(t)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 33); err != nil {
		t.Fatalf("down to 33: %v", err)
	}

	reader, err := database.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reader.Exec(`LOCK TABLE versions IN ACCESS SHARE MODE`); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	err = goose.UpToContext(ctx, database, "migrations", 34)
	if err == nil {
		t.Fatal("migration 34 applied while versions was locked")
	}
	if ctx.Err() != nil || !strings.Contains(err.Error(), "lock timeout") {
		t.Fatalf("migration 34 waited for the lock instead of timing out: %v", err)
	}
	if err := reader.Rollback(); err != nil {
		t.Fatal(err)
	}
	if err := goose.UpTo(database, "migrations", 34); err != nil {
		t.Fatalf("retry 34 after the read ended: %v", err)
	}
}
