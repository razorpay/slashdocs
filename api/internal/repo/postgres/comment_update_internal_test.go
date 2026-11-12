package postgres

import (
	"testing"

	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
)

func TestCommentFromUpdateEdited(t *testing.T) {
	for _, edited := range []bool{false, true} {
		for _, changed := range []bool{false, true} {
			got := commentFromUpdate(dbsqlc.GetCommentForUpdateRow{Edited: edited}, changed)
			if got.Edited != (edited || changed) {
				t.Errorf("edited=%v changed=%v: got %v", edited, changed, got.Edited)
			}
		}
	}
}
