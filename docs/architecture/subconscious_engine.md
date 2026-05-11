# Subconscious Engine

**Briefs:** FR-106 — Subconscious Engine (Light) + FR-108 — Conflict Detector for Learnings (LLM verification layer)
**Status:** Phase 1 (stalled + gap + lifecycle) shipped (`99b709d`). Phase 2 (conflict + pattern + smoothing + arch doc) shipped (`3a0e424`). FR-108 (LLM verification + acted-action edge materialization) shipped this PR.
**Schema:** Per-component migrations v1 + v2 in `brain-mcp-server/src/engine/components/subconscious/schema.ts`. No v3 — FR-108 fits in existing `suggestions.evidence` JSON.

---

## Why a passive observer

The subconscious engine is the system's quiet hand. It sweeps the brain on a
6-hour cron, looks for things that *might* be worth noticing, and queues them
as `suggestions` rows. It does NOT mutate briefs, learnings, goals, edges, or
any other domain table from the detector layer. It does NOT write to disk
outside its own working tables, and does NOT block any user-facing surface.

**FR-108 update:** the engine now optionally calls an LLM via headless Claude
Code (`claude -p`) to verify conflict candidates. The call is gated on the
heuristic — the LLM never scans pair-wise. When `claude` is not on PATH (e.g.
on the VPS), a `noopVerifier` activates automatically and heuristic candidates
surface unchanged. See "Conflict — LLM verification" below.

What "passive" buys us:

1. **Trust through restraint.** A detector that flags a stalled brief but
   refuses to change its status is far less likely to corrupt the brain than
   one that "fixes" things eagerly. A bad suggestion costs the user a glance;
   a bad mutation costs them a recovery.
2. **Compositional safety.** Detectors are pure
   `(ReadOnlyDb, DetectorConfig) => SuggestionCandidate[]` functions. New
   detectors slot in without touching any cross-cutting concern. Phase 1
   shipped two; Phase 2 shipped two more; future detectors plug in the same way.
3. **Reviewable cadence.** The `/awaken` and `/scan --suggestions` surfaces
   show only what the user opted-in to seeing. Dismiss-loop suppression
   ensures noisy detectors get quieter over time without code changes.

The engine is `engine/components/subconscious/` rather than the brief's
suggested `subconscious/` directory because every domain capability shipped
since FR-110 lives under `engine/components/`. See FR-106 plan, Concern 1 for
the full justification.

---

## Lifecycle of a suggestion

```
detector emits SuggestionCandidate (pure function)
        │
        ▼
runner: smoothPatterns ──► drops pattern candidates lacking
        │                  3 distinct runs in 14d window
        ▼
runner: dedupe against existing pending (evidence_signature key)
        │
        ▼
runner: shouldSuppress (dismiss-loop gate)
        │ ├─► dismiss_count >= dismiss_suppress_count -> permanent suppress
        │ └─► single dismiss within dismiss_cooldown_days -> cooldown suppress
        ▼
runner: insertSuggestion -> emits subconscious.suggestion_emitted
        │
        ▼
user dismisses (signature -> dismissed_patterns) OR acts (positive signal)
        │
        ▼
TTL expiry: pending >30d, dismissed >90d, observations >30d (v2)
```

Every transition is logged via the `subconscious.*` events the monitoring
component already maps in `brain-mcp-server/src/engine/components/monitoring/index.ts:73-76`.
No Phase 2 event-name additions — the new detectors emit the same
`subconscious.suggestion_emitted` and `subconscious.suggestion_suppressed`
events as Phase 1.

---

## Read-only enforcement — the two layers

The detectors must never mutate the brain. Two independent layers enforce this:

1. **`ReadOnlyDb` wrapper.** A thin shim around `better-sqlite3` that rejects
   any `prepare()` whose first non-whitespace token is not `select` or `with`
   (case-insensitive). Implemented at
   `brain-mcp-server/src/engine/components/subconscious/readonly-db.ts:32-46`.
   The check trips at preparation time, not execution, so the developer sees
   the failure at the call site rather than mid-run.

2. **`PRAGMA data_version` invariant test.** `data_version` increments on any
   write to the database. The integrity test in
   `brain-mcp-server/src/engine/components/subconscious/__tests__/integrity.test.ts:139-160`
   captures `data_version` before and after each detector invocation. The
   assertion is invariance for the detector phase only — the runner DOES
   write (to `suggestions`, `dismissed_patterns`, `pattern_observations`),
   and that's allowed.

Why both: the wrapper catches the developer-ergonomics class of mistake
("I accidentally typed `INSERT INTO`"); the data_version test catches whatever
the wrapper missed (regression safety net for hypothetical SQL forms that
sneak past the SELECT/WITH whitelist).

---

## Detector contracts

Every detector has the same shape:

```typescript
function detectFoo(db: ReadOnlyDb, config: DetectorConfig): SuggestionCandidate[]
```

Three guarantees:

- **Pure.** No global state, no I/O outside the read-only DB handle, no
  randomness. Two calls with the same `(db, config)` return the same
  candidates in the same order.
- **Fail-soft.** Missing tables return `[]`, not exceptions. The detectors
  use try/catch around the SQL `prepare()` calls — see
  `detectors/stalled.ts:65-68` and `detectors/gap.ts:103, 150`. This matters
  because the engine boots before all components have finished applying
  migrations, and detectors should tolerate transient empty schemas.
- **Bounded.** The runner caps the per-project work each detector does:
  conflict has `conflict_max_pairs_per_project` (default 100); pattern is
  inherently bounded by the GROUP BY cardinality (≤7 for DOW, agent count
  for retry).

The runner inserts the returned candidates itself; detectors never write.

---

## Per-detector behavior

### Stalled (Phase 1)

Single SQL query against `brief_status` for rows where
`status IN ('In Progress', 'Ready')` and the days-since-update exceeds the
configured threshold band. Priority bands per
`brain-mcp-server/src/engine/components/subconscious/detectors/stalled.ts:99-115`:

| Status      | medium | high |
|-------------|--------|------|
| In Progress | ≥14d   | >30d |
| Ready       | ≥30d   | >60d |

Below the medium band: silently ignored. `low` priority is never emitted —
short stalls are noise.

### Gap (Phase 1)

Two sub-queries merged into a single output:

- **Project quiet** — `detectors/gap.ts:70-124`. CTE over `projects` LEFT
  JOIN `learnings` and `brief_status`, picks `MAX(activity)` per project.
  Active projects whose latest activity exceeds `gap_quiet_medium_days`
  surface as medium; beyond `gap_quiet_high_days` as high.
- **Done with unchecked AC** — `detectors/gap.ts:137-169`. Joins
  `brief_status` (terminal status) against `brief_files.content` with
  `LIKE '%- [ ]%'`. Always emits at high — a "Done" brief with unchecked
  acceptance criteria almost certainly went out unfinished.

### Conflict (Phase 2)

Pair-wise scan over recent learnings for probable contradictions. The
heuristic combines two cheap similarity measures:

- **Cosine** captures *semantic* closeness via the embedding vectors.
- **Jaccard** captures *lexical* overlap via tokenized title+content.

A pair high in cosine AND low in Jaccard — same topic, different vocabulary —
is the canonical signature of "one says X, the other says not-X." Defaults at
`conflict_cosine_threshold = 0.85` and `conflict_jaccard_threshold = 0.5`
(`types.ts:DEFAULT_DETECTOR_CONFIG`).

Per-pair short-circuit at
`brain-mcp-server/src/engine/components/subconscious/detectors/conflict.ts:138-148`:
cosine is computed first, and pairs below the threshold skip the
(more expensive) tokenize+intersect step. Most pairs are below 0.85, so the
short-circuit reclaims most of the O(N²) cost.

Per-project candidate cap: matches sort by `cosine DESC` and the top
`conflict_max_pairs_emitted` (default 5) are emitted. Without this cap, a
project full of similar bug-fix learnings could emit dozens of "conflicts"
per run.

### Conflict — LLM verification (FR-108)

Heuristic candidates are passed through a verifier before they reach the
suggestion store. The verifier shells out to `claude -p` via
`child_process.spawn`, sends the two learnings as a stdin prompt, and parses
the response (`{is_conflict: bool, reason: string}`). Implementation:
`brain-mcp-server/src/engine/components/subconscious/verifier.ts`.

Three properties make the verifier safe to add to a passive observer:

1. **Heuristic-first gate.** The verifier ONLY runs on candidates the
   heuristic already flagged. It never scans all pairs. Bounded cost: at
   most `conflict_max_pairs_emitted` calls per project per run.
2. **Defensive failure mode.** Only an explicit clean rejection
   (`{is_conflict: false, status: 'verified'}`) drops a candidate. Every
   other outcome — `cli_missing`, `spawn_failed`, `timeout`, `parse_failed`
   — surfaces the candidate with `verifier_status` in evidence. Verifier
   failure NEVER silently swallows a real conflict.
3. **VPS-safe via auto-fallback.** `isClaudeCliAvailable()` runs at
   component init (cached). When `claude` is absent, `noopVerifier`
   activates and stamps `verifier_status='cli_missing'` on each candidate
   so dashboards can distinguish "verifier disabled" from "verified".

The subprocess uses array-form `spawn('claude', ['-p'], ...)` (no shell
interpolation), prompts via stdin (no argv quoting issues), enforces a
30s timeout (configurable via `verifier_timeout_ms`), and runs sequential
SIGTERM→SIGKILL cleanup with double-resolution prevention. JSON extraction
handles bare, fenced, preamble-prefixed, and Anthropic envelope shapes via
`extractJsonReply`.

Two new events fire from this layer:
- `subconscious.suggestion_verified` — emitted alongside `suggestion_emitted`
  for verifier-confirmed candidates.
- `subconscious.suggestion_rejected_by_verifier` — emitted when an explicit
  clean rejection drops a heuristic candidate. Monitoring listens to both
  for visibility into verifier behavior.

**Why headless Claude Code, not the API SDK.** Avoids new dependencies, no
API key management, billing flows through the user's existing Claude plan.
Trade-off: requires `claude` CLI on PATH and an interactive auth state, so
this layer is local-daemon-only by design (not VPS).

### Pattern (Phase 2)

Two heuristic sub-detectors that surface "interesting deviations" from a
baseline. Both cap at `medium` priority — patterns are observations, not
actions, and high priority would imply an urgency the detector cannot judge.

- **Day-of-week** (`detectors/pattern.ts:88-159`). Per-project aggregation
  over the last 365 days; uniform baseline is `total / 7`. Effect = `(observed - baseline) / total`. Emits when `|effect| >= pattern_min_effect`
  (default 0.15) AND total samples >= `pattern_min_samples` (default 30).
  `pattern_key = dow:{day}:{project_slug}`.
- **Agent retry rate** (`detectors/pattern.ts:165-237`). Cross-project
  aggregation over the last 30 days; baseline is the sample-weighted mean
  retry rate `SUM(retries)/SUM(total)`. One-sided gate — only surfaces
  agents *above* baseline (a low-flake agent is a non-issue). `pattern_key = agent_retry:{agent}` (no project_slug — retry rates are agent-scoped).

Pattern C (type velocity) is **deferred** to a follow-up TD. The "uniform
across types" baseline doesn't hold (BRs are naturally fewer than FRs in
healthy projects), and a per-project rolling baseline doubles the test
surface. See "Open questions" below.

---

## Pattern false-positive guards

Patterns attract more user pushback than any other detector category. Three
layers of defense:

1. **Sample size.** `pattern_min_samples` (default 30). Below this no
   emission, regardless of effect. Kills the "73% of 7 briefs were on Mondays"
   trap.
2. **Effect size.** `pattern_min_effect` (default 0.15) — proportion units
   from baseline. Below this the deviation is interesting noise, not signal.
3. **3-run smoothing.** A pattern_key must appear in
   `pattern_smoothing_runs` distinct runs (default 3) within
   `pattern_smoothing_window_days` (default 14) before the candidate
   surfaces. Smoothing logic in
   `brain-mcp-server/src/engine/components/subconscious/runner.ts:smoothPatterns`.
   This filters the one-off blips that any aggregation will throw off.

The smoothing gate uses a working table (`pattern_observations`, v2
migration) where each run inserts one row per `pattern_key`. The gate query
counts `DISTINCT run_id` within the recency window; the candidate emits
only when the count reaches the threshold. Record-then-gate ordering means
the 3rd consecutive run emits in the same run rather than waiting for a 4th.

---

## Conflict heuristic — cosine + Jaccard

Two complementary measures, neither sufficient on its own:

| Cosine | Jaccard | Signal |
|--------|---------|--------|
| high   | low     | **conflict** — same topic, different vocabulary |
| high   | high    | paraphrase — same fact, redundant phrasing       |
| low    | low     | unrelated                                         |
| low    | high    | shared boilerplate, unrelated topics              |

Cosine 0.85 between unit-normalized 384-dim sentence-transformer vectors
empirically corresponds to "topically same"; Jaccard 0.5 is permissive
enough that paraphrases of the same fact land above the threshold (paraphrases
typically score 0.55–0.95 Jaccard).

Worst-case false positive: two learnings on the same topic written years
apart with different vocabulary, both correct, captured from different
contexts. The detector flags them; the user dismisses with a reason; the
dismiss-loop records the signature; future suggestions with the same
signature get suppressed. The system self-corrects without any code change.

### Cosine-vs-L2 mechanics

The conflict detector reads raw embedding BLOBs from `learnings.embedding`
rather than going through `learnings_vec`'s `MATCH ... distance`. Why:

- `vec0` exposes only L2 distance via `MATCH`. There is no API for raw
  embeddings or for cosine directly.
- For unit-normalized vectors, the conversion `cosine = 1 - L2² / 2` is
  algebraically clean but easy to misremember (the `1 - L2/2` shortcut
  appears in some texts and is wrong). Better to avoid the conversion.
- `learnings.embedding` is already populated alongside the vec0 row by the
  insertion code at `brain-mcp-server/src/tools/memory.ts:188-194`. Same
  data, different storage form.
- `bufferToEmbedding` in `brain-mcp-server/src/utils/embeddings.ts:103-105`
  is a zero-copy `Float32Array` view over the BLOB — decoding cost is
  effectively free.

Embeddings are L2-normalized at production time
(`brain-mcp-server/src/utils/embeddings.ts:70-85`, `normalize: true`), so
cosine reduces to a 384-dim dot product. The detector clips the result to
`[-1, 1]` defensively in case normalization ever regresses
(`detectors/conflict.ts:cosineSimNormalized`).

---

## Phase 1 vs Phase 2 capability matrix

| Acceptance criterion (FR-106 brief) | Phase 1 | Phase 2 |
|-------------------------------------|---------|---------|
| `suggestions` table + indexes       | ✓ (commit `99b709d`) | — |
| `dismissed_patterns` table          | ✓ | — |
| `pattern_observations` table (v2)   | — | ✓ |
| 4 detector modules                  | stalled, gap | conflict, pattern |
| Pure `(db, config) -> Suggestion[]` | ✓ | ✓ |
| Scheduler entry created (cron 6h)   | ✓ | — |
| /awaken shows top 3 pending         | ✓ (`awaken/SKILL.md` §4.8) | — |
| /scan --suggestions full list       | — | ✓ (`scan/SKILL.md` §6.5) |
| 3+1 MCP tools (list/dismiss/acted/run) | ✓ | — |
| Engine NEVER mutates other tables   | ReadOnlyDb + integrity test | (still holds) |
| Unit tests per module               | stalled.test, gap.test | conflict.test, pattern.test |
| Architecture doc                    | — | this file |
| LLM verification layer (FR-108)     | — | ✓ (this PR) — `verifier.ts` |
| Acted-action edge materialization (FR-108) | — | ✓ (this PR) — `handlers.ts:323-420` |

---

## Dismiss-reason learning loop

Dismissing a suggestion writes its `evidence_signature` to
`dismissed_patterns`. The signature is module-specific
(`runner.ts:computeEvidenceSignature` at lines 178-217):

| Module    | Signature shape                       |
|-----------|----------------------------------------|
| stalled   | `brief:BR-XXX`                         |
| gap       | `gap:project_quiet:slug` OR `gap:done_unchecked:BR-XXX` |
| conflict  | `conflict:smaller_id:larger_id` (sorted pair) |
| pattern   | `pattern:dow:day:slug` OR `pattern:agent_retry:agent` |

Suppression rules in `runner.ts:shouldSuppress` at lines 228-259:

- `dismiss_count >= dismiss_suppress_count` (default 2) → permanent suppress
- `dismiss_count == 1` and dismissed within `dismiss_cooldown_days`
  (default 7) → cooldown suppress (re-emit allowed after the window)
- otherwise → emit

Acting on a suggestion (`igris_suggestion_acted`) is **not** fed into the
suppression loop. Acting is a positive signal — the suggestion was useful, so
surface it again next time it qualifies. We don't want to silence what works.

### Acted-action edge materialization (FR-108)

For conflict-class suggestions, the user's resolution choice writes a typed
edge to `entity_edges` (FR-105). This is the only path where the engine
mutates a domain table — and it's gated on explicit user intent via the
`igris_suggestion_acted` MCP tool, not detector logic.

| `action` | Edge written | Direction | Metadata |
|----------|--------------|-----------|----------|
| `'superseded'` | `supersedes` | `from=winner_id → to=loser_id` ("winner supersedes loser") | none |
| `'kept_both'` | `related_to` | `from=min(a,b) → to=max(a,b)` (sorted-pair, idempotent) | `{"reason":"non-conflict-on-review"}` |
| (omitted) | none | — | — (backward-compat for non-conflict suggestions) |

The suggestion UPDATE and the edge INSERT happen in a single
`db.transaction()` — if edge creation fails (e.g., entity_edges table
absent), the suggestion stays `pending`. Tests verify the rollback path.

Validation (handlers.ts:323-348): `action='superseded'` requires both
`winner_id` and `loser_id` (clear error if missing); ids must be distinct,
positive integers; invalid action values rejected with the enum list.

---

## Schedule self-bootstrap

On `engine.ready` the component captures the gateway dispatcher and
idempotently creates the `subconscious_engine` schedule (cron `0 */6 * * *`).
Code reference: `index.ts:86-117`. The bootstrap reads the existing
`schedules` table directly and dispatches `igris_schedule_create` only when
no row matches the well-known name — re-running init is a no-op.

Manual fire path: `igris_schedule_fire_now` against the schedule, OR direct
call to the `igris_subconscious_run` MCP tool. Both paths converge on
`runner.runAllDetectors`.

---

## TTL and cleanup

The runner's `expireStaleRows` (extended in Phase 2 to cover the new working
table) prunes three things on every invocation:

| Table                   | TTL window | Source of truth |
|-------------------------|------------|------------------|
| `suggestions` (pending)  | `pending_ttl_days` (default 30) | `created_at` |
| `suggestions` (dismissed)| `dismissed_ttl_days` (default 90) | `dismissed_at` |
| `pattern_observations`  | `pattern_observation_ttl_days` (default 30) | `observed_at` |

`pattern_observations` is intentionally NOT in `SYNC_TABLES`
(`brain-mcp-server/src/tools/sync.ts`). It's a working table — re-derivable
from raw aggregations on the next run, no cross-machine merge value. The
sync table count remains 26 unchanged.

---

## Open questions / Phase 3+ candidates

- **Parallel verifier batching.** Today the verifier loop is sequential
  (`Promise` per candidate awaited in order). Worst-case latency: 5 candidates
  × ~7s × N projects, well inside the 6h cron interval. If profiling shows
  pipeline duration as a concern, a `Promise.all` batch with a
  rate-limited semaphore is a future TD.
- **Memory consolidator.** Find clusters of paraphrases (high cosine + high
  Jaccard) and recommend merging. Current logic filters them out as noise,
  but they are themselves a valid signal — duplicate knowledge accumulates
  without intervention.
- **Cross-project patterns.** Same pattern observed in N projects → emit at
  portfolio scope. Requires expanding the `project_slug NULL` semantics in
  `suggestions` (currently NULL means "cross-project" but no detector emits
  cross-project candidates yet).
- **Pattern C — type velocity.** Per-project per-type counts vs. a 12-month
  rolling baseline. Honest math is doable but doubles the test surface and
  the baseline-bootstrap problem (a project's first month has no history).
  Captured here to avoid silent drift.
- **Statistical proper testing.** Replace heuristic effect-size gates with
  chi-squared / Fisher's exact for small N. Out of scope without a stats
  library; the heuristic gates are explicit about being heuristic.
- **Auto-status transition for goals.** Hooked at
  `docs/architecture/goals.md:201-203` — when every serving brief is Done,
  suggest (not perform) `goal -> achieved`. A new detector for FR-110
  integration; not in this phase.

---

## References

- **FR-106 brief** — Subconscious Engine (Light). The brief lives in the
  brain DB; query via `igris_brief_get FR-106`.
- **Phase 1 plan** — `~/.igris/projects/igris-ai/plans/FR-106-plan.md`.
- **Phase 2 plan** — `~/.igris/projects/igris-ai/plans/FR-106-phase2-plan.md`.
- **Phase 1 commit** — `99b709d`.

### Code map

| File | Role |
|------|------|
| `brain-mcp-server/src/engine/components/subconscious/index.ts` | Component factory + MCP tool registration + schedule bootstrap |
| `brain-mcp-server/src/engine/components/subconscious/schema.ts` | Migrations v1 (suggestions, dismissed_patterns) and v2 (pattern_observations) |
| `brain-mcp-server/src/engine/components/subconscious/types.ts` | Type definitions, `DEFAULT_DETECTOR_CONFIG` |
| `brain-mcp-server/src/engine/components/subconscious/readonly-db.ts` | SELECT/WITH whitelist wrapper |
| `brain-mcp-server/src/engine/components/subconscious/runner.ts` | Pipeline orchestration, smoothing, persistence, dismiss-loop |
| `brain-mcp-server/src/engine/components/subconscious/handlers.ts` | MCP tool handlers (list / dismiss / acted / run) |
| `brain-mcp-server/src/engine/components/subconscious/detectors/stalled.ts` | Stalled-brief detector |
| `brain-mcp-server/src/engine/components/subconscious/detectors/gap.ts` | Gap detector (project-quiet + done-with-unchecked-AC) |
| `brain-mcp-server/src/engine/components/subconscious/detectors/conflict.ts` | Conflict detector (cosine + Jaccard) |
| `brain-mcp-server/src/engine/components/subconscious/detectors/pattern.ts` | Pattern detector (DOW + agent retry) |
| `brain-mcp-server/src/engine/components/subconscious/verifier.ts` | LLM verifier — Claude headless subprocess + JSON extractor (FR-108) |
| `brain-mcp-server/src/engine/components/subconscious/__tests__/` | Per-module + integrity tests |

### Related briefs and docs

- **FR-105** — Typed Edges. Source of `goal` entity type and `serves_goal` edge type.
- **FR-107** — Provenance on Learnings. Same per-component migration pattern.
  See `docs/architecture/provenance.md`.
- **FR-108** — Conflict Detector for Learnings. Repositioned from "simple
  cosine+Jaccard detector" (which shipped as part of FR-106 Phase 2) to
  "LLM verification layer + acted-action edge materialization." See
  "Conflict — LLM verification" and "Acted-action edge materialization" above.
- **FR-110** — Goals as First-Class Entities. Cross-references this engine
  for future auto-status-transition detector. See `docs/architecture/goals.md`.
