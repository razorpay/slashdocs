package db_test

import (
	"database/sql"
	"reflect"
	"testing"

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
