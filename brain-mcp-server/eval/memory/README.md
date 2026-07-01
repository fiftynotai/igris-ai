# FR-188 — Memory-System Evaluation Suite

A standalone, re-runnable regression gate for the brain's memory retrieval. It
seeds a **sealed synthetic corpus** into a fresh temp DB, drives the **shipped**
memory handlers directly (not via MCP transport), and emits a JSON + Markdown
scorecard.

## Run

```bash
# from brain-mcp-server/
npm run eval:memory -- --out /tmp/eval-memory-scorecard.json
# or directly
./node_modules/.bin/tsx eval/memory/src/run.ts --out /tmp/scorecard.json --k 10
```

Flags: `--corpus`, `--queryset`, `--no-answer`, `--gating`, `--promotion`,
`--out`, `--k`. Writes `<out>.json` + `<out>.md`. Human summary goes to stderr;
stdout stays clean.

Smoke + parser unit tests: `npm test` (the `eval/**/__tests__` glob is included).

## How it works

- **Seam:** `run.ts` sets `IGRIS_DB_PATH` to a fresh temp file *before* the first
  `getDb()` call (in `seed.ts`), so the real handlers transparently run against
  the fixture. `IGRIS_DISABLE_VEC=1` forces BM25-only.
- **Seeding = production write path:** the corpus is inserted via the real
  `handleMemoryStore` — real embeddings, `learnings_fts` triggers, and the
  sqlite-vec table exactly as production writes them. The scorecard reflects
  production retrieval geometry, not a re-implemented insert.
- **No ranking re-implementation:** the runner calls `handleMemoryRecall` /
  `_search` / `_hybrid_search` and parses the ranked ids out of the text
  envelope (`parse.ts`). This is the deliberate difference from
  `scripts/recall_bench.ts` (which reproduces the SQL for a live-DB directional
  number). FR-188 tests *shipped behavior* end-to-end — boosts + FR-109 gate +
  no-answer sentinel + promotion pointer — with zero lockstep-drift risk.

## Blindness (the anti-circularity defense)

Questions were authored **first**; the learnings were then phrased with
deliberately different vocabulary. The runner **measures** per-query content-word
Jaccard overlap and bands each query (low `<0.06` / med `<0.12` / high). The
**headline is blind hit@5 on the LOW band** — the adversarial "no shared
distinctive tokens" case that is genuine semantic recall. This number is
*expected to be lower* than a lexically-overlapping benchmark; that is the honest
citable figure.

## Dimensions — MVP vs deferred

| # | Dimension | Status | Notes |
|---|-----------|--------|-------|
| 1 | Blind recall (hit@k) | **LIVE** | Real `handleMemoryRecall`; headline = LOW-band hit@5 |
| 3 | Ranking (MRR, nDCG@5) | **LIVE** | Same pass as #1 |
| 2 | No-answer precision | **LIVE** | Headline = BM25 SEARCH refusal rate. Vector recall/hybrid have no relevance floor (kNN always returns nearest) — reported as a system property, not pass/fail |
| 7 | Review-status gating (FR-109) | **LIVE** | Pending rows must never surface; `handleMemoryGet` still returns them by id |
| 6 | Cross-project promotion | **LIVE (slice)** | Designed true-dup + distinct pairs; TP/FP/FN via `scope` column + `Auto-promoted` note |
| 9 | Latency | **LIVE (informational)** | Wall-clock per recall call; not a gate |
| 4 | Affinity-boost A/B | **DEFERRED** | Boosts are inside the handler, not parameterizable → needs a reproduce-ranking harness |
| 5 | Dedup correctness | **DEFERRED** | Covered by `scripts/dedup_corpus_eval.ts` + `perception/__tests__/dedup.test.ts` |
| 8 | Staleness | **DEFERRED** | No aging metric defined yet |

Deferred dims emit a `[eval] dimension X DEFERRED` log line and a `"deferred"`
marker in the scorecard JSON — no silent scope-cut.

## Corpus invariants

See `corpus/README.md`. In short: titles are unique except the intentional
promotion pairs (inserted last); ≥10 `pending_review` rows for the gating dim;
designed true-dup + same-title-distinct promotion pairs.

## Determinism

Fixed corpus + pinned embedding model (`Xenova/all-MiniLM-L6-v2`, 384-dim) +
deterministic RRF ⇒ identical metrics across runs/machines, given the same
vector-channel availability. When sqlite-vec is unavailable, the suite degrades
to BM25-only and records `vector_channel: false` — absolute recall differs, so
gate thresholds must be channel-aware.
