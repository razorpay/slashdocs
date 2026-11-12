package textedit

import "math"

// The diff is Myers' linear space algorithm on bytes, as in "An O(ND)
// Difference Algorithm and Its Variations" (1986). It is here and not a
// library because a byte diff gives byte offsets directly, and because the
// common library, github.com/sergi/go-diff, diffs runes (four times the
// memory of the text), searches substrings in quadratic time that its
// timeout does not stop, and allocates arrays as long as both texts.

// diffBudget bounds the work of one diff to the cost of comparing about
// 500 million bytes, less than a second, and its memory to a few hundred KiB.
// An edit step costs as much as stepCost bytes. When the budget runs out, the
// rest of each text counts as one change. That diff is coarse but correct.
const (
	diffBudget = 1 << 29
	stepCost   = 8
)

// change says that the later text replaced a[start:end] with size bytes.
type change struct{ start, end, size int }

type differ struct {
	a, b    []byte
	budget  int
	changes []change
}

// diff returns the changes that turn a into b, in order.
func diff(a, b []byte) []change {
	d := &differ{a: a, b: b, budget: diffBudget}
	d.compare(0, len(a), 0, len(b))
	return d.changes
}

// compare adds the changes that turn a[x0:x1] into b[y0:y1].
func (d *differ) compare(x0, x1, y0, y1 int) {
	if d.budget > 0 {
		from := x1 - x0
		for x0 < x1 && y0 < y1 && d.a[x0] == d.b[y0] {
			x0, y0 = x0+1, y0+1
		}
		for x0 < x1 && y0 < y1 && d.a[x1-1] == d.b[y1-1] {
			x1, y1 = x1-1, y1-1
		}
		d.budget -= from - (x1 - x0)
		if x0 < x1 && y0 < y1 {
			if x, y, ok := d.split(d.a[x0:x1], d.b[y0:y1]); ok {
				d.compare(x0, x0+x, y0, y0+y)
				d.compare(x0+x, x1, y0+y, y1)
				return
			}
		}
	}
	if x0 < x1 || y0 < y1 {
		d.changes = append(d.changes, change{x0, x1, y1 - y0})
	}
}

// split returns a point in the middle of a shortest edit path from a to b,
// which differ in their first and last bytes. It walks the path from both
// ends at the same time, one edit per step, until the two walks meet. It
// returns false when the budget runs out first.
func (d *differ) split(a, b []byte) (int, int, bool) {
	steps := min((len(a)+len(b)+1)/2, int(math.Sqrt(float64(d.budget/stepCost)))+1)
	fwd, rev := newWalk(steps, false), newWalk(steps, true)
	// When the lengths differ by an odd number, the forward walk is the one
	// that meets the other, else the reverse walk is.
	odd := (len(a)-len(b))%2 != 0
	for step := range steps {
		if x, y, ok := d.extend(a, b, fwd, rev, step, odd); ok {
			return x, y, true
		}
		if x, y, ok := d.extend(a, b, rev, fwd, step, !odd); ok {
			return x, y, true
		}
		if d.budget <= 0 {
			break
		}
	}
	return 0, 0, false
}

// walk holds the furthest x that a walk reached on each diagonal k = x - y,
// at v[off+k]. A reverse walk starts at the ends of the texts and counts
// from there.
type walk struct {
	v       []int
	off     int
	reverse bool
	// The walk skips the diagonals at its edges that left the grid.
	low, high int
}

func newWalk(steps int, reverse bool) *walk {
	w := &walk{v: make([]int, 2*steps+2), off: steps, reverse: reverse}
	for i := range w.v {
		w.v[i] = -1
	}
	w.v[w.off+1] = 0
	return w
}

// extend makes edit number step of the walk w on each of its diagonals. When
// meet is set and w meets other, it returns the point of the forward walk
// there.
func (d *differ) extend(a, b []byte, w, other *walk, step int, meet bool) (int, int, bool) {
	n, m := len(a), len(b)
	for k := -step + w.low; k <= step-w.high; k += 2 {
		x, y := d.follow(a, b, w, k, step)
		switch {
		case x > n:
			w.high += 2
		case y > m:
			w.low += 2
		case meet:
			// other walks the same diagonal from the other end.
			j := w.off + n - m - k
			if j < 0 || j >= len(other.v) || other.v[j] == -1 || x+other.v[j] < n {
				continue
			}
			if w.reverse {
				return other.v[j], other.v[j] - (j - w.off), true
			}
			return x, y, true
		}
	}
	return 0, 0, false
}

// follow makes one more edit on the diagonal k of the walk w, then follows
// the equal bytes, and returns where it ends.
func (d *differ) follow(a, b []byte, w *walk, k, step int) (int, int) {
	i := w.off + k
	x := w.v[i-1] + 1
	if k == -step || (k != step && w.v[i-1] < w.v[i+1]) {
		x = w.v[i+1]
	}
	y := x - k
	from := x
	for n, m := len(a), len(b); x < n && y < m; x, y = x+1, y+1 {
		if w.reverse && a[n-x-1] != b[m-y-1] || !w.reverse && a[x] != b[y] {
			break
		}
	}
	d.budget -= x - from + stepCost
	w.v[i] = x
	return x, y
}
