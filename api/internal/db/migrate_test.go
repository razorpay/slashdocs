package db_test

import (
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/pressly/goose/v3"

	aidb "github.com/razorpay/slashdocs/api/internal/db"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

func TestCommentMentionMigrationsSplitTriggerFromLegacyCleanup(t *testing.T) {
	databaseURL := testdb.New(t)
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close database: %v", err)
		}
	})
	setMigrationTestFS(t)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 17); err != nil {
		t.Fatalf("down to migration 17: %v", err)
	}

	seedMigrationGraph(t, database)
	const marker = "\u2063"
	insertMigrationComment(t, database, "cmt_legacy_marker", "Hello "+marker+"@admin"+marker)

	// Migration 18 is deliberately short: it installs schema and the trigger,
	// but does not scan and rewrite the existing comments table.
	if err := goose.UpTo(database, "migrations", 18); err != nil {
		t.Fatalf("up to migration 18: %v", err)
	}
	if got := migrationCommentBody(t, database, "cmt_legacy_marker"); !strings.Contains(got, marker) {
		t.Fatalf("migration 18 unexpectedly scanned legacy body %q", got)
	}
	insertMigrationComment(t, database, "cmt_after_trigger_legacy", "Legacy "+marker+"@admin"+marker)
	if got := migrationCommentBody(t, database, "cmt_after_trigger_legacy"); got != "Legacy @admin" {
		t.Fatalf("post-18 legacy body = %q, want database invariant to remove markers", got)
	}
	insertMigrationComment(t, database, "cmt_structured", "New @admin")

	// Status updates preserve associations. Any body write from an old writer,
	// including a marker-only change with the same visible text, clears offsets
	// whose identity and placement can no longer be trusted.
	if _, err := database.Exec(`
		INSERT INTO comment_mentions(comment_id, principal_type, principal_id, offset_utf16, length_utf16, label_text)
		VALUES ('cmt_structured', 'user', 'usr_migration', 4, 6, '@admin')`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE comments SET status = 'resolved' WHERE id = 'cmt_structured'`); err != nil {
		t.Fatal(err)
	}
	assertMigrationMentionCount(t, database, "cmt_structured", 1)
	if _, err := database.Exec(`UPDATE comments SET body = body || chr(8291) WHERE id = 'cmt_structured'`); err != nil {
		t.Fatal(err)
	}
	if got := migrationCommentBody(t, database, "cmt_structured"); got != "New @admin" {
		t.Fatalf("marker-only old-writer body update = %q", got)
	}
	assertMigrationMentionCount(t, database, "cmt_structured", 0)
	if _, err := database.Exec(`
		INSERT INTO comment_mentions(comment_id, principal_type, principal_id, offset_utf16, length_utf16, label_text)
		VALUES ('cmt_structured', 'user', 'usr_migration', 4, 6, '@admin')`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`UPDATE comments SET body = 'Changed ' || chr(8291) || '@admin' WHERE id = 'cmt_structured'`); err != nil {
		t.Fatal(err)
	}
	if got := migrationCommentBody(t, database, "cmt_structured"); got != "Changed @admin" {
		t.Fatalf("old-writer body update = %q", got)
	}
	assertMigrationMentionCount(t, database, "cmt_structured", 0)

	// Exercise the production migrator through the latest migration, including
	// the separate migration-19 cleanup.
	if err := aidb.Migrate(databaseURL); err != nil {
		t.Fatalf("production migrate through 19: %v", err)
	}
	if got := migrationCommentBody(t, database, "cmt_legacy_marker"); got != "Hello @admin" {
		t.Fatalf("migration 19 cleanup body = %q", got)
	}
	if got := migrationCommentBody(t, database, "cmt_after_trigger_legacy"); got != "Legacy @admin" {
		t.Fatalf("migration 18 invariant body changed after cleanup: %q", got)
	}
	assertMentionMigrationObjects(t, database)
	version, err := goose.GetDBVersion(database)
	if err != nil || version != 45 {
		t.Fatalf("migration version = %d, %v; want 45", version, err)
	}

	// The cleanup cannot reconstruct markers, so migration 19's Down is a
	// deliberate no-op; migration 18's objects must remain usable at version 18.
	setMigrationTestFS(t)
	if err := goose.DownTo(database, "migrations", 18); err != nil {
		t.Fatalf("down migration 19: %v", err)
	}
	if got := migrationCommentBody(t, database, "cmt_legacy_marker"); got != "Hello @admin" {
		t.Fatalf("migration 19 Down reconstructed body %q", got)
	}
	assertMentionMigrationObjects(t, database)

	// A full rollback removes the invariant and all structured metadata. Legacy
	// servers can write their marker format again, but migration 19's historical
	// cleanup remains irreversible.
	if err := goose.DownTo(database, "migrations", 17); err != nil {
		t.Fatalf("down migration 18: %v", err)
	}
	assertMentionMigrationObjectsAbsent(t, database)
	insertMigrationComment(t, database, "cmt_after_rollback", "Rollback "+marker+"@admin"+marker)
	if got := migrationCommentBody(t, database, "cmt_after_rollback"); got != "Rollback "+marker+"@admin"+marker {
		t.Fatalf("legacy write after rollback = %q, want markers preserved", got)
	}
	if err := aidb.Migrate(databaseURL); err != nil {
		t.Fatalf("restore latest migrations: %v", err)
	}
	if got := migrationCommentBody(t, database, "cmt_after_rollback"); got != "Rollback @admin" {
		t.Fatalf("cleanup after re-upgrade body = %q", got)
	}
}

// Migration 42 adds read marks to a database that already has threads. A
// mark goes with its thread, a reader that cannot sign in takes none, and
// Down removes the table.
func TestCommentReadsMigration(t *testing.T) {
	databaseURL := testdb.New(t)
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	setMigrationTestFS(t)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 41); err != nil {
		t.Fatal(err)
	}
	seedMigrationGraph(t, database)
	insertMigrationComment(t, database, "cmt_before_reads", "Before")
	if err := aidb.Migrate(databaseURL); err != nil {
		t.Fatalf("migrate to 42 on existing threads: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO comment_reads(thread_id, principal_type, principal_id) VALUES ('cmt_before_reads', 'user', 'usr_migration')`); err != nil {
		t.Fatalf("mark an existing thread read: %v", err)
	}
	if _, err := database.Exec(`INSERT INTO comment_reads(thread_id, principal_type, principal_id) VALUES ('cmt_before_reads', 'anonymous', 'x')`); err == nil {
		t.Fatal("an anonymous reader took a read mark")
	}
	if _, err := database.Exec(`DELETE FROM comments WHERE id = 'cmt_before_reads'`); err != nil {
		t.Fatal(err)
	}
	var marks int
	if err := database.QueryRow(`SELECT count(*) FROM comment_reads`).Scan(&marks); err != nil || marks != 0 {
		t.Fatalf("read marks after the thread went = %d, %v; want 0", marks, err)
	}
	setMigrationTestFS(t)
	if err := goose.DownTo(database, "migrations", 41); err != nil {
		t.Fatalf("down migration 42: %v", err)
	}
	var table sql.NullString
	if err := database.QueryRow(`SELECT to_regclass('public.comment_reads')::text`).Scan(&table); err != nil || table.Valid {
		t.Fatalf("comment_reads after Down = %v, %v; want gone", table, err)
	}
}

// Migration 44 writes no row: the versions that exist are sealed by the
// defaults, at seq 0. A server of the release before cannot write a version,
// because it would write it on a snapshot and remove typed text. Down is
// refused while a version is open, because that version has no content of
// its own.
func TestLiveDocumentMigration(t *testing.T) {
	databaseURL := testdb.New(t)
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	setMigrationTestFS(t)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 43); err != nil {
		t.Fatal(err)
	}
	seedMigrationGraph(t, database)
	exec := func(statement string) error {
		_, err := database.Exec(statement)
		return err
	}
	if err := aidb.Migrate(databaseURL); err != nil {
		t.Fatalf("migrate to 44 on existing versions: %v", err)
	}
	// A server of the release before saves a version with no seq.
	if err := exec(`INSERT INTO versions(id, document_id, number, html_blob_key, sha256, parent_version_id, created_by_type, created_by_id, client_change_id)
		VALUES ('ver_old_server', 'doc_migration', 2, 'typed.html', 'sha2', 'ver_migration', 'user', 'usr_migration', 'chg_1')`); err == nil || !strings.Contains(err.Error(), "seq") {
		t.Fatalf("a version of the release before: err = %v, want it refused", err)
	}
	var sealed, atZero, documentSeq int
	if err := database.QueryRow(`SELECT count(*) FILTER (WHERE sealed_at IS NOT NULL), count(*) FILTER (WHERE seq = 0),
		(SELECT seq FROM documents WHERE id = 'doc_migration') FROM versions`).Scan(&sealed, &atZero, &documentSeq); err != nil {
		t.Fatal(err)
	}
	if sealed != 1 || atZero != 1 || documentSeq != 0 {
		t.Fatalf("sealed versions = %d, versions at seq 0: %d, document seq = %d; want 1, 1, 0", sealed, atZero, documentSeq)
	}

	// An operation opens a version, with its author.
	for _, statement := range []string{
		`INSERT INTO versions(id, document_id, number, html_blob_key, sha256, parent_version_id, created_by_type, created_by_id, seq, sealed_at)
		 VALUES ('ver_open', 'doc_migration', 2, 'typed.html', '', 'ver_migration', 'user', 'usr_migration', 0, NULL)`,
		`INSERT INTO document_ops(document_id, seq, version_id, author_type, author_id, client_op_id, typed, replacements, sum)
		 VALUES ('doc_migration', 1, 'ver_open', 'user', 'usr_migration', 'op_1', true, '[]', 0)`,
		`INSERT INTO version_authors(version_id, author_type, author_id) VALUES ('ver_open', 'user', 'usr_migration')`,
		`UPDATE documents SET current_version_id = 'ver_open', seq = 1 WHERE id = 'doc_migration'`,
	} {
		if err := exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := exec(`INSERT INTO document_ops(document_id, seq, version_id, author_type, author_id, client_op_id, typed, replacements, sum)
		VALUES ('doc_migration', 2, 'ver_open', 'user', 'usr_migration', 'op_1', true, '[]', 0)`); err == nil {
		t.Fatal("a document took one client_op_id twice")
	}
	setMigrationTestFS(t)
	if err := goose.DownTo(database, "migrations", 43); err == nil || !strings.Contains(err.Error(), "a version is open") {
		t.Fatalf("down migration 44 with an open version: err = %v, want it refused", err)
	}
	if err := exec(`UPDATE versions SET sealed_at = now() WHERE id = 'ver_open'`); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 43); err != nil {
		t.Fatalf("down migration 44: %v", err)
	}
	var table sql.NullString
	if err := database.QueryRow(`SELECT to_regclass('public.document_ops')::text`).Scan(&table); err != nil || table.Valid {
		t.Fatalf("document_ops after Down = %v, %v; want gone", table, err)
	}
	if err := exec(`UPDATE versions SET client_change_id = 'chg_2' WHERE id = 'ver_open'`); err != nil {
		t.Fatalf("client_change_id after Down: %v", err)
	}
}

func setMigrationTestFS(t *testing.T) {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration test path")
	}
	goose.SetBaseFS(os.DirFS(filepath.Dir(filename)))
}

func seedMigrationGraph(t *testing.T, database *sql.DB) {
	t.Helper()
	tx, err := database.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	statements := []string{
		`INSERT INTO users(id, email, name) VALUES ('usr_migration', 'migration@example.com', 'admin')`,
		`INSERT INTO documents(id, title, owner_id, owner_type) VALUES ('doc_migration', 'Migration', 'usr_migration', 'user')`,
		`INSERT INTO versions(id, document_id, number, html_blob_key, sha256, created_by_type, created_by_id) VALUES ('ver_migration', 'doc_migration', 1, 'migration.html', 'sha', 'user', 'usr_migration')`,
		`UPDATE documents SET current_version_id = 'ver_migration' WHERE id = 'doc_migration'`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func insertMigrationComment(t *testing.T, database *sql.DB, id, body string) {
	t.Helper()
	if _, err := database.Exec(`
		INSERT INTO comments(id, document_id, created_on_version_id, author_type, author_id, author_email, author_name, body, selected_text, anchor_json, root_comment_id)
		VALUES ($1, 'doc_migration', 'ver_migration', 'user', 'usr_migration', 'migration@example.com', 'admin', $2, 'fixture', '{}'::jsonb, $1)`, id, body); err != nil {
		t.Fatal(err)
	}
}

func migrationCommentBody(t *testing.T, database *sql.DB, id string) string {
	t.Helper()
	var body string
	if err := database.QueryRow(`SELECT body FROM comments WHERE id = $1`, id).Scan(&body); err != nil {
		t.Fatal(err)
	}
	return body
}

func assertMigrationMentionCount(t *testing.T, database *sql.DB, commentID string, want int) {
	t.Helper()
	var got int
	if err := database.QueryRow(`SELECT count(*) FROM comment_mentions WHERE comment_id = $1`, commentID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("comment %s mention count = %d, want %d", commentID, got, want)
	}
}

func assertMentionMigrationObjects(t *testing.T, database *sql.DB) {
	t.Helper()
	var table, index sql.NullString
	if err := database.QueryRow(`SELECT to_regclass('public.comment_mentions')::text, to_regclass('public.idx_comment_mentions_principal')::text`).Scan(&table, &index); err != nil {
		t.Fatal(err)
	}
	if !table.Valid || !index.Valid {
		t.Fatalf("migration objects = table %v index %v", table, index)
	}
	var trigger bool
	if err := database.QueryRow(`SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'normalize_comment_body_mentions_trigger' AND NOT tgisinternal)`).Scan(&trigger); err != nil {
		t.Fatal(err)
	}
	if !trigger {
		t.Fatal("normalization trigger is missing")
	}
}

func assertMentionMigrationObjectsAbsent(t *testing.T, database *sql.DB) {
	t.Helper()
	var table, index sql.NullString
	if err := database.QueryRow(`SELECT to_regclass('public.comment_mentions')::text, to_regclass('public.idx_comment_mentions_principal')::text`).Scan(&table, &index); err != nil {
		t.Fatal(err)
	}
	if table.Valid || index.Valid {
		t.Fatalf("mention migration objects remain after rollback: table %v index %v", table, index)
	}
	var trigger bool
	if err := database.QueryRow(`SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'normalize_comment_body_mentions_trigger' AND NOT tgisinternal)`).Scan(&trigger); err != nil {
		t.Fatal(err)
	}
	if trigger {
		t.Fatal("normalization trigger remains after rollback")
	}
}

func TestNotificationMigrationRecoversOccupiedVersion24(t *testing.T) {
	databaseURL := testdb.New(t)
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	setMigrationTestFS(t)
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	if err := goose.DownTo(database, "migrations", 23); err != nil {
		t.Fatal(err)
	}
	// Reproduce the deployed state: version 24 is recorded, but notification
	// objects are absent. Existing feature data must survive the repair.
	if _, err := database.Exec(`CREATE TABLE previous_feature (id integer PRIMARY KEY);
		INSERT INTO previous_feature VALUES (1);
		INSERT INTO goose_db_version (version_id, is_applied) VALUES (24, true)`); err != nil {
		t.Fatal(err)
	}
	if err := aidb.Migrate(databaseURL); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"notification_preferences", "document_notification_mutes", "comment_notification_outbox"} {
		var exists bool
		if err := database.QueryRow(`SELECT to_regclass($1) IS NOT NULL`, "public."+table).Scan(&exists); err != nil || !exists {
			t.Fatalf("notification table %s missing: %v", table, err)
		}
	}
	var columnExists bool
	if err := database.QueryRow(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='next_notification_at')`).Scan(&columnExists); err != nil || !columnExists {
		t.Fatalf("notification delivery gate missing: %v", err)
	}
	var count int
	if err := database.QueryRow(`SELECT count(*) FROM previous_feature`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("existing feature data changed: %d, %v", count, err)
	}
	// Rolling back only the repair must not remove a schema also owned by 24.
	setMigrationTestFS(t)
	if err := goose.DownTo(database, "migrations", 24); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`SELECT 1 FROM notification_preferences LIMIT 1`); err != nil {
		t.Fatal(err)
	}
}
