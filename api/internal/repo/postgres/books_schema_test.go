package postgres_test

import (
	"context"
	"testing"
)

func TestBooksSchemaCascades(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, err := s.EnsureUserByEmail(ctx, "book-owner@example.com")
	if err != nil {
		t.Fatalf("EnsureUserByEmail: %v", err)
	}
	doc, ver, err := s.CreateDocument(ctx, owner, "01 · Intro", []byte("<h2>A</h2><p>one two</p>"))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	if _, err := s.Pool().Exec(ctx, `INSERT INTO chapter_reads(user_id,document_id,seen_version_id,last_read_version_id) VALUES($1,$2,$3,$3)`, owner.ID, doc.ID, ver.ID); err != nil {
		t.Fatalf("insert chapter_reads: %v", err)
	}
	if err := s.DeleteDocument(ctx, doc.ID); err != nil {
		t.Fatalf("DeleteDocument: %v", err)
	}
	var n int
	if err := s.Pool().QueryRow(ctx, `SELECT count(*) FROM chapter_reads`).Scan(&n); err != nil {
		t.Fatalf("count chapter_reads: %v", err)
	}
	if n != 0 {
		t.Fatalf("chapter_reads rows after document delete = %d, want 0", n)
	}
}
