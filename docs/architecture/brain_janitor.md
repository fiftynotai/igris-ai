# Brain Janitor (FR-119) — memory-hygiene MVP

The **janitor** is the FOURTH self-describing instance of the agnostic cognition
host (FR-118), the structural twin of **synapse** (FR-211). Where synapse
CONNECTS memory nodes (forms typed edges) and `/promote` PROMOTES learnings to
durable docs, the janitor **CLEANS** *within* the memory layer: it removes
duplication, rewards re-discovered knowledge, and prunes stale review debt.

## Scope: CLEAN vs CONNECT vs PROMOTE

| Concern | Owner | What it does |
|---------|-------|--------------|
| **CLEAN** (this) | `janitor` (FR-119) | Near-dupe merge proposals, TD-086 confidence bumps, stale-pending rejection. Operates on `learnings` rows in place. |
| **CONNECT** | `synapse` (FR-211) | Infers typed edges (`related_to`/`supersedes`/`derived_from`/`duplicates`) between learnings. Never mutates a learning. |
| **PROMOTE** | `/promote` skill | Lifts a proven local learning to a global/durable context doc. Human-driven curation, not an LLM extractor. |

The janitor deliberately does NOT connect or promote — a merged duplicate simply
vanishes from recall; the surviving learning carries the rolled-up signal.

## Structure (Decision E)

The janitor is a hybrid: one LLM duty + three deterministic duties.

```
components/janitor/
  index.ts       — component wrapper: resolveJanitorConfig (nested-only),
                   schema(), igris_janitor_run_now tool, janitor_engine cron
                   (daily 04:00), janitor.bootstrap_failed emit
  types.ts       — JanitorConfig + DEFAULT_JANITOR_CONFIG + DuplicatePair +
                   MergeProposal + JanitorRunResult
  schema.ts      — brain_maintenance_runs table + learnings.deleted_at/merged_into
  candidates.ts  — buildDuplicatePairs: normalized-fingerprint embedding KNN
  prompts.ts     — merge-judgment system + user prompts
  validator.ts   — validateJanitorResponse: cite-check + verdict allow-list
  hygiene.ts     — applyConfidenceBumps / rejectStalePending / surfaceReEvalRejections
  runner.ts      — runJanitor: deterministic sweep + runExtractor + audit row

cognition/extractors/janitor.ts  — the LLM near-dupe MERGE instance (6 slots)
subconscious/actions/kinds.ts    — applyMergeLearnings + applyReEvaluateRejection
```

The LLM near-dupe MERGE is the cognition INSTANCE (rides `runExtractor`
unchanged — brain-isolated HOME, empty mcpServers, one-terminal-event-per-run,
lifecycle under `cognition.janitor.*`). The three deterministic hygiene duties
need no LLM and live in the RUNNER's sweep around `runExtractor`. The engine host
stays agnostic — it only ever sees the LLM extractor (AC #1).

## The four duties

### 1. Near-dupe merge (the LLM duty)

`buildDuplicatePairs` re-embeds each APPROVED learning's **normalized
fingerprint** (`normalizedFingerprint(title, content)` — the ONE canonical
derivation, #930/TD-087) and runs a vec0 KNN, keeping neighbours at cosine ≥
`dupe_cosine_floor` (0.95). **Critical:** the query embedding is derived from the
normalized fingerprint, never the raw stored text — a raw cosine understates
similarity (#930). The LLM then judges each pair `merge` / `keep_a` / `keep_b` /
`keep_both` (false positive). Actionable verdicts become a `suggestions` row
(`source_module='janitor'`, `suggested_action.kind='merge_learnings'`) for
operator review — OR, when `auto_merge=true` AND cosine ≥ `auto_merge_threshold`,
a direct `applyMergeLearnings`.

### 2. TD-086 confidence bumps

`applyConfidenceBumps` tallies `perception.rediscovery` events per rediscovered
learning; a learning re-discovered ≥ `rediscovery_bump_n` (3) times gets
`confidence += 0.05`, **clamped** to the CHECK 0–1 bound via `MIN(confidence +
0.05, 1.0)` (db.ts:164 — a bump past 1.0 would violate the constraint). Only
APPROVED learnings are bumped. The tally is windowed on the previous run's finish
time so a re-run does not double-bump (idempotency).

### 3. Stale-pending rejection

`rejectStalePending` flips `review_status='pending_review'` learnings older than
`stale_days` (14) to `'rejected'`. `review_status` has no CHECK constraint, so
`'rejected'` is legal without a table rebuild; the rejected row drops out of every
approved-filter reader.

### 4. Re-evaluation of rejections (DORMANT — Decision D)

`surfaceReEvalRejections` tallies `perception.rejected_pattern_recurring` events
and, past `reject_recur_n` (5), surfaces one `re_evaluate_rejection` suggestion.
**This source event never fires in production today** — reject is a hard DELETE,
so no rejected row survives to recur (perception/handlers.ts:427 gates the emit
behind an env var). The path is wired and activates automatically when FR-116
ships soft-delete-on-reject and flips the emit. Until then it is a no-op.

## Soft-delete mechanism (Decision A1)

The merge does NOT add a `deleted_at IS NULL` recall gate to the ~10 read paths.
Instead it sets the duplicate's `review_status='merged'` — and because
recall/search/sync ALREADY filter `review_status='approved'`
(`tools/memory.ts` ×10, `subconscious/digest.ts:248`, `tools/sync.ts:952`), the
merged row vanishes from everywhere with ZERO read-path sweep. `deleted_at` +
`merged_into` columns are stamped for AUDIT/lineage + FR-116 forward-compat, but
are **not** recall gates.

`review_status` is an LWW sync column; a merge stamps `updated_at` so `'merged'`
wins over a stale remote `'approved'` — acceptable for the MVP (FR-116 hardening
note).

## The merge executor (`applyMergeLearnings`)

The most consequential apply-action yet — the ONLY one that removes a learning
from recall. In a single transaction it: rolls `seen_again_count` into the
survivor (`survivor += duplicate + 1`); optionally rewrites the survivor's content
from `synthesized_content` (NULLing its embedding so the FR-220 post-merge scan
re-embeds it); writes a `derived_from` lineage edge survivor→duplicate; and
soft-deletes the duplicate. It validates both ids resolve and are distinct,
never throws, and is idempotent (re-applying on an already-merged row is a no-op).
It fires ONLY via operator `igris_suggestion_apply_action` or the default-OFF
`auto_merge` fork (human-in-the-loop invariant preserved).

## Audit: `brain_maintenance_runs`

One row per `runJanitor` invocation records `merges_proposed`, `merges_applied`,
`confidence_bumps`, `stale_rejected`, `re_eval_surfaced`, plus status / trigger /
timestamps / error. Created under the `'janitor'` migration key; FR-116 will
later share the table.

## Config (`cognition.janitor.*`, nested-only, default OFF)

`enabled` (false), `dupe_cosine_floor` (0.95), `top_k` (5), `max_pairs` (200),
`auto_merge` (false), `auto_merge_threshold` (0.95), `rediscovery_bump_n` (3),
`reject_recur_n` (5), `stale_days` (14), plus the envelope
(`llm_timeout_ms`/`llm_daily_budget`/`min_input_bytes`/`harness`). The `enabled`
flag gates the LLM engine, the `janitor_engine` cron, AND the deterministic sweep
— one on/off switch. Ships OFF; OPERATIONS flips it after the engine is verified
live.

## Surfaces

- `igris_janitor_run_now` — manual/cron run tool (tool #108).
- `/scan` §6.9 + `/boot` — a janitor health line read from the
  `cognition.janitor.*` lifecycle events + the latest `brain_maintenance_runs`
  row, gated behind `cognition.janitor.enabled`.
- Merge proposals render through the existing `igris_suggestion_list`
  (`source_module='janitor'`).
