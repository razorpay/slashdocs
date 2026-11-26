package notifications_test

import (
	"testing"

	"github.com/razorpay/slashdocs/api/internal/testdb"
)

// TestMain removes the PostgreSQL container that testdb starts for this test
// binary once the tests finish.
func TestMain(m *testing.M) { testdb.Main(m) }
