# Move-destination query evidence

Measured 2026-11-12 on PostgreSQL 17 Alpine in OrbStack (Apple Silicon), using
`TestMoveDestinationPerformanceEvidence` with explicit table statistics, one
warm-up, and 100 warm samples per operation.

Dataset:

- 51,403 folders
- 45,000 top-level folders across 2,000 owners
- 10,000 top-level folders owned by the measured principal
- one parent with 5,000 direct children
- 5,000 active organisation-wide grants
- one 15-level path with 99 siblings around each non-root anchor
- one non-owner editor whose access is inherited from the path root

Results:

| Operation | p50 | p90 | p95 | max | Proposed budget |
| --- | ---: | ---: | ---: | ---: | ---: |
| production access-root page | 38.28 ms | 39.37 ms | **40.05 ms** | 58.12 ms | 150 ms |
| full bootstrap, heavy principal | 38.33 ms | 39.69 ms | **39.98 ms** | 46.04 ms | 150 ms |
| full bootstrap, ordinary principal | 22.94 ms | 23.60 ms | **24.10 ms** | 26.37 ms | 150 ms |
| full bootstrap, inherited editor at depth 15 | 39.37 ms | 40.05 ms | **40.27 ms** | 65.42 ms | 150 ms |
| direct-child page | 1.54 ms | 1.62 ms | **1.65 ms** | 1.72 ms | 50 ms |
| late anchored child window | 4.40 ms | 4.68 ms | **4.71 ms** | 4.99 ms | 50 ms |
| production access-filtered literal search | 77.41 ms | 83.81 ms | **93.66 ms** | 250.45 ms | 150 ms |

The child plan is `Limit -> Index Scan idx_folders_parent_title_id`: 51 rows,
five shared-hit blocks, no reads, and about 0.03 ms execution in the captured plan.

The access-root query builds its eligible set from an indexable union of owned
folders and matching grant rows, then performs a depth-capped ancestor walk
seeded only by nested entries. It no longer applies an owner-or-grant predicate
to every folder. The measurement calls the public production list method, which
uses a repeatable-read transaction and disables JIT locally for root pages. Its
p95 is 40.05ms for a principal with about 15,000 accessible roots.

The depth-15 bootstrap uses one candidate-window query per level, one batched
access-chain query, and one batched has-children query. A single row-numbered
materialized root window preserves the centered/top-up behavior without
separate before/anchor/after eligibility queries. PostgreSQL's planner still
chooses JIT for an isolated root `EXPLAIN` run outside the production
transaction: the captured explain takes 264.47ms, including 201.11ms compiling
the one-shot query. Both bootstrap and production root pagination use
transaction-local `SET LOCAL jit=off`; the setting resets at transaction end.

The search measurement now calls `SearchMoveDestinations`, including resource
authorization, access-first recursive filtering, safe breadcrumb materialization,
and child-state enrichment. Non-org searches do not seed the recursive walk from
`anyone` grants. The 93.66ms p95 remains within the proposed 150ms budget on the
heavy 20,000-entry access set; the isolated 250.45ms maximum is recorded rather than
hidden and should be watched in production telemetry.

Reproduce:

```sh
SLASHDOCS_MOVE_PERF=1 go test -p 1 ./api/internal/repo/postgres \
  -run TestMoveDestinationPerformanceEvidence -count=1 -v
```
