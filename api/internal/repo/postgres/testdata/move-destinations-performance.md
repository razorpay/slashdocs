# Move-destination query evidence

Measured 2026-11-12 on PostgreSQL 17 Alpine in OrbStack (Apple Silicon), using
`TestMoveDestinationPerformanceEvidence` with one warm-up followed by 100 warm
samples per operation.

Dataset:

- 50,002 folders
- 45,000 top-level folders across 2,000 owners
- 10,000 top-level folders owned by the measured principal
- one parent with 5,000 direct children
- 5,000 active organisation-wide grants

Results:

| Operation | p50 | p90 | p95 | max | Proposed budget |
| --- | ---: | ---: | ---: | ---: | ---: |
| access-root page | 48.53 ms | 50.04 ms | 51.41 ms | 213.42 ms | 150 ms |
| full bootstrap, heavy principal | 50.53 ms | 51.45 ms | 52.51 ms | 66.84 ms | 150 ms |
| full bootstrap, ordinary principal | 31.39 ms | 32.49 ms | 33.12 ms | 36.95 ms | 150 ms |
| direct-child page | 1.39 ms | 1.50 ms | 1.53 ms | 1.68 ms | 50 ms |
| late anchored child window | 3.51 ms | 3.64 ms | 3.70 ms | 3.86 ms | 50 ms |
| capped literal search | 11.70 ms | 12.15 ms | 12.30 ms | 22.39 ms | 150 ms |

The child plan is `Limit -> Index Scan idx_folders_parent_title_id`: 51 rows,
five shared-hit blocks, no reads, and about 0.03 ms execution in the captured plan.

The access-root query is restricted to owned/direct user/group/org-grant entry
points and a depth-capped ancestor walk seeded only by nested entries; it no
longer scans every top-level folder or builds an access chain for every folder.
Its repeatable p95 is 51.41ms for a principal with about 15,000 access entries.
The isolated 213ms maximum is not reflected in full-bootstrap samples. Root
`EXPLAIN (ANALYZE, BUFFERS)` shows no temp spill or read blocks; the nested
ancestry set is 5,000 rows and its sort is an in-memory 426KiB quicksort. The
215ms explain execution is dominated by 171ms of one-time JIT compilation. This
is retained as a rollout note, not a reason to introduce a closure table or
materialized per-principal ACL.

Reproduce:

```sh
SLASHDOCS_MOVE_PERF=1 go test -p 1 ./api/internal/repo/postgres \
  -run TestMoveDestinationPerformanceEvidence -count=1 -v
```
