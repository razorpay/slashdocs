package server

import (
	"math"
	"testing"
	"time"
)

func TestPositionRequestValid(t *testing.T) {
	now := time.Now()
	base := func() positionRequest {
		return positionRequest{DeviceID: "device_laptop_1", DocumentID: "doc_1", VersionID: "ver_1", Progression: 0.5, ClientTS: now}
	}
	r := base()
	r.Progression = math.NaN()
	if r.valid(now) {
		t.Fatal("NaN progression must be rejected")
	}
	for in, want := range map[float64]float64{math.Inf(1): 1, math.Inf(-1): 0, 2: 1, -0.5: 0, 0.3: 0.3} {
		r := base()
		r.Progression = in
		if !r.valid(now) || r.Progression != want {
			t.Fatalf("progression %v: valid %v, clamped to %v, want %v", in, r.valid(now), r.Progression, want)
		}
	}
	r = base()
	r.ClientTS = now.Add(5*time.Minute + time.Second)
	if r.valid(now) {
		t.Fatal("client_ts more than five minutes ahead must be rejected")
	}
	r = base()
	r.ClientTS = now.Add(5 * time.Minute)
	if !r.valid(now) {
		t.Fatal("client_ts exactly five minutes ahead is allowed")
	}
	r = base()
	r.DeviceID = "abcdefgh"
	if !r.valid(now) {
		t.Fatal("an 8-character device id is allowed")
	}
	r.DeviceID = "abcdefg"
	if r.valid(now) {
		t.Fatal("a 7-character device id must be rejected")
	}
}
