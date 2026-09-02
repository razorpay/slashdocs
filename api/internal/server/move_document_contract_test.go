package server

import (
	"encoding/json"
	"testing"

	"github.com/razorpay/aidocs/api/internal/repo"
)

func TestParseExpectedMoveSource(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    *repo.MoveSource
		wantErr bool
	}{
		{name: "omitted", raw: "", want: nil},
		{name: "root", raw: `{"kind":"root"}`, want: &repo.MoveSource{Kind: "root"}},
		{name: "folder", raw: `{"kind":"folder","folder_id":"fld_source"}`, want: &repo.MoveSource{Kind: "folder", FolderID: "fld_source"}},
		{name: "null is malformed", raw: "null", wantErr: true},
		{name: "invalid json", raw: `{"kind":`, wantErr: true},
		{name: "unknown kind", raw: `{"kind":"document"}`, wantErr: true},
		{name: "root with folder id", raw: `{"kind":"root","folder_id":"fld_source"}`, wantErr: true},
		{name: "folder without id", raw: `{"kind":"folder"}`, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var raw json.RawMessage
			if tt.raw != "" {
				raw = json.RawMessage(tt.raw)
			}
			got, err := parseExpectedMoveSource(raw)
			if (err != nil) != tt.wantErr {
				t.Fatalf("error = %v, wantErr=%v", err, tt.wantErr)
			}
			if tt.wantErr {
				return
			}
			if got == nil || tt.want == nil {
				if got != nil || tt.want != nil {
					t.Fatalf("source = %#v, want %#v", got, tt.want)
				}
				return
			}
			if *got != *tt.want {
				t.Fatalf("source = %#v, want %#v", got, tt.want)
			}
		})
	}
}
