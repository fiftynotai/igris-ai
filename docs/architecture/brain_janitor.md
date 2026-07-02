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
`dupe_cosine_floor` (0.90, M1/FR-116) that ALSO clear the normalized-token
Jaccard gate `overlap` ≥ `dupe_min_overlap` (0.6) — both gates must pass, so the
lower cosine floor catches more rephrased dupes (#163) without flooding the LLM
with same-topic-but-distinct pairs. **Critical:** the query embedding is derived from the
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

`enabled` (false), `dupe_cosine_floor` (0.90), `dupe_min_overlap` (0.6), `top_k` (5), `max_pairs` (200),
`auto_merge` (false), `auto_merge_threshold` (0.95), `rediscovery_bump_n` (3),
`reject_recur_n` (5), `stale_days` (14), plus the envelope
(`llm_timeout_ms`/`llm_daily_budget`/`min_input_bytes`/`harness`). The `enabled`
flag gates the LLM engine, the `janitor_engine` cron, AND the deterministic sweep
— one on/off switch. Ships OFF; OPERATIONS flips it after the engine is verified
live.

## Contradiction resolution — the arbiter instance (FR-116 M2)

The **arbiter** is the FIFTH cognition instance and the CLEAN mandate's second
LLM duty. Where the janitor MERGES near-duplicates, the arbiter RESOLVES
CONTRADICTIONS — two same-topic learnings that make opposing claims ("use X" vs
"X is wrong, use Z"). It is a DISTINCT instance (its own candidate signal, prompt,
and output verb) but is CO-SCHEDULED under the janitor runner (Decision #4A): it
rides the SINGLE `cognition.janitor.enabled` flag + the `janitor_engine` cron +
the shared `brain_maintenance_runs` audit row. No new flag, no new cron, no engine
or registry edit — one barrel line in `cognition/extractors/index.ts` plus the
component-internal modules under `components/arbiter/`.

```
components/arbiter/
  types.ts       — ArbiterConfig + DEFAULT_ARBITER_CONFIG + ContradictionPair +
                   ContradictionProposal + resolveArbiterConfig (nested-only,
                   enabled DERIVED from cognition.janitor.enabled)
  candidates.ts  — buildContradictionPairs: same-topic KNN band + opposition cue
  prompts.ts     — resolve-contradiction system + user prompts
  validator.ts   — validateArbiterResponse: cite-check + verdict allow-list

cognition/extractors/arbiter.ts  — the LLM contradiction instance (6 slots)
subconscious/actions/kinds.ts    — applyResolveContradiction
janitor/runner.ts                — co-drives the arbiter after the near-dupe extractor
```

### Opposition candidate signal (Decision #7)

`buildContradictionPairs` embeds each APPROVED learning's normalized fingerprint,
runs a vec0 KNN, and keeps neighbours whose cosine is in the SAME-TOPIC band
`[contradiction_cosine_floor` (0.80)`, contradiction_cosine_ceil` (0.995)`]` AND
that fire a cheap deterministic OPPOSITION cue: **negation-polarity XOR** (exactly
one side carries a negation cue like `not`/`avoid`/`wrong`/`deprecated`) OR an
**antonym pair** (enable/disable, always/never). High cosine makes the pair
comparable; the cue makes it likely opposing. The upper ceiling excludes
near-identical restatements so the arbiter + janitor candidate sets stay disjoint.

### The three resolutions (`applyResolveContradiction`)

- **newer_wins** — the older claim is obsolete. Set the loser
  `review_status='superseded'` (Decision #1 — a NEW review_status value auto-
  excluded by every `='approved'` reader → ZERO read-path sweep, mirroring
  `'merged'`), stamp the AUDIT-ONLY `deleted_at` + `superseded_by`, and write a
  `supersedes` edge winner→loser (`supersedes` is ALREADY in `VALID_EDGE_TYPES` —
  no vocabulary change in M2). The winner is untouched.
- **both_valid_scope** — NOT a true conflict: both hold under different scopes.
  NON-DESTRUCTIVE — append a `[valid-scope: …]` annotation to each learning's
  content (NULLing its embedding for the FR-220 re-embed scan). Neither is deleted.
- **evolved_merge** — the conflict resolves into a single evolved understanding:
  write the synthesized content onto the winner, roll `seen_again_count`, and
  supersede the loser (like newer_wins).

Every path is a single transaction, idempotent (a no-op when the loser is already
superseded / the scope already annotated), validates every target id resolves, and
never throws. It fires ONLY via operator `igris_suggestion_apply_action` or the
default-OFF `auto_resolve` fork (human-in-the-loop preserved).

### Config (`cognition.janitor.contradiction.*`, nested-only, default OFF)

`contradiction_cosine_floor` (0.80), `contradiction_cosine_ceil` (0.995), `top_k`
(5), `max_pairs` (200), `auto_resolve` (false), `auto_resolve_threshold` (0.95),
plus the envelope (`llm_timeout_ms`/`llm_daily_budget`/`min_input_bytes`/`harness`).
`enabled` is DERIVED from `cognition.janitor.enabled` — one switch for the whole
janitor pipeline. The v2 `'janitor'` migration adds
`brain_maintenance_runs.contradictions_proposed`/`contradictions_resolved` (the
arbiter counters, aggregated into the shared row) + `learnings.superseded_by`.

## Surfaces

- `igris_janitor_run_now` — manual/cron run tool (tool #108). Runs the near-dupe
  MERGE extractor AND the co-scheduled arbiter contradiction extractor.
- `/scan` §6.9 + `/boot` — a janitor health line read from the
  `cognition.janitor.*` lifecycle events + the latest `brain_maintenance_runs`
  row, gated behind `cognition.janitor.enabled`.
- Merge proposals render through the existing `igris_suggestion_list`
  (`source_module='janitor'`).
