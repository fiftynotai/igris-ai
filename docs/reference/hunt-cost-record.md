# Hunt cost record — `agent_events` (FR-267)

**What this is.** The durable, brain-timed, brief-keyed record of what every
hunt costs: one row per agent *invocation* (a `start`/`stop` pair), carrying
the role, the phase, the model the orchestrator chose, the round, and a
duration the brain computed from its own clock. Per-phase and per-hunt
figures are **derived** from these rows by the `hunt_runs` view — never
stored, so they cannot drift from the rows.

**What it answers** (the operator's question, 2026-08-26): *"in brief X with
size L we took 45 minutes to hunt — 10 on architect, 20 on forger, 10 on
sentinel and 10 on warden … and if a model is degraded or affecting the OS —
I wanna measure models too."* R1–R6 of the brief.

---

## 1. Retention decision (written down — AC 5)

| table | decision |
|---|---|
| `agent_events` | **Durable. No purge, no TTL, no size cap.** The 7-day purge that ran as a side effect of `igris_instance_list` (MCP) and `GET /api/instances` (HTTP) is deleted from both call sites; `brain-mcp-server/src/tools/__tests__/instances-list-no-purge.test.ts` lists instances and then still finds a 30-day-old row, and statically asserts no `DELETE FROM agent_events` exists anywhere under `src/`. |
| `event_log` | Unchanged — keeps its 30-day retention. It is ephemeral operational telemetry, not the cost record. |
| `agent_metrics` | **Frozen history.** Not dropped; not written or read by any tool, route, skill or dashboard. The ONLY runtime code that reads or writes its rows is the sync transport (`SYNC_TABLES` entry retained, plan §3.6): `igris_brain_push` SELECTs it via the templated `SELECT ${cols} FROM ${config.table}` in `handleBrainPush` and `mergeRows` INSERTs it as pass-through history (the LOCAL table holds 276 rows — measured by sentinel r3 at 2026-08-26 21:34 UTC and re-read at 21:41 and 22:02 UTC; the brief's filing-time count of 275 predates one `/rest` session row written at 15:01:12 UTC — 48 of them with February-2026 durations; the remote's count was not measured by FR-267, and TD-428 names a mechanism by which the two can differ). Every reader and writer (`igris_metrics_*`, `POST /api/metrics`, the FR-088 receiver's INSERT, the `/rest` bullet) is retired; the other source mentions (the frozen DDL in `db.ts`, the flat-file `SyncFileType` name, `export.ts`'s `EXCLUDED_STORES`, the one-time already-run `td402_fold_project_slugs.mjs`, and the egress-manifest category label in `brain-mcp-server/src/tools/egress-manifest.ts` — a disclosure label, not a query) neither read nor write it at runtime. Measured 2026-08-26 UTC with `grep -rnE 'FROM agent_metrics|INTO agent_metrics|UPDATE agent_metrics|DELETE FROM agent_metrics'` over `brain-mcp-server/src` and `cli/src`: **0** hits in non-test source; **1** with tests in scope — the orphan seeder `seedAgentMetric` in `brain-mcp-server/src/engine/components/subconscious/__tests__/fixtures/minimal-schema.ts` (its consumer was deleted in FR-118 M4b; a fixture, not a reader); `core/` has 0 mentions. |

Survives a machine change: `agent_events` is in `SYNC_TABLES`
(`brain-mcp-server/src/tools/sync.ts`) with the four new columns, so
`igris_brain_push` carries the rows to the VPS and a fresh brain pulls them
back. See §6 for the one residual in that path.

---

## 2. Schema and semantics

Migration **v3** of the instances component
(`brain-mcp-server/src/engine/components/instances/index.ts`) adds four
columns to `agent_events`, an index on `(brief_id, agent)`, the `hunt_runs`
view, and a one-time `0 → NULL` fold.

| column | type | who writes it | meaning |
|---|---|---|---|
| `model_requested` | TEXT — **required** at the gateway (`required` list) and in the handler (throws `igris_agent_event: model_requested is required (FR-267) — pass the model you chose or inherit:<your model>`); NULLABLE at the DDL | the caller | The model the orchestrator chose for the agent, or `inherit:<its own model id>`. An opaque string — nothing in the OS interprets it, so it is harness-agnostic (R6). NULLABLE at the DDL because SQLite cannot `ADD COLUMN … NOT NULL` without a default, and a `'unknown'` sentinel would break the NULL-not-fake rule; the 258 archaeology rows hold NULL. |
| `model_resolved` | TEXT, nullable | the caller, stop/error only | The model the harness *reports* the agent ran on, when it reports one. NULL otherwise. |
| `round` | INTEGER NOT NULL DEFAULT 1 | **the brain** | `1 + COUNT(prior start rows)` for the round key `(project, brief_id, agent)` (the pairing key when no brief is given). A resumed, re-prompted or re-run agent is a NEW invocation and a new round. A caller-supplied `round` is dropped. |
| `project` | TEXT, nullable | **the brain** | `instances.project_slug` looked up at write time, because `instances` rows are deleted on `/rest` and the join cannot be done later. A one-time backfill filled the archaeology rows whose instance still existed; the rest stay NULL, which is honest. |
| `duration_ms` | INTEGER, nullable | **the brain** | Computed in SQL on `stop`/`error` as the difference between the brain's own `created_at` of the matching `start` and `now` (second precision, one clock). NULL on `start`, on an unpaired stop, and on every pre-v3 row whose value was 0 — on this brain, all of them (the fold: measured 2026-08-26, 0 of 244 rows carried a duration or a token count before it; after it, 0 of the 258 pre-hunt rows (`id < 6651`) hold a duration and 0 hold a token count — measured 2026-08-26 UTC, so `0` was never a measurement). **Never accepted from a caller** — the property is deleted from the tool schema, so a call passing it is refused or discarded (MCP: rejected by `additionalProperties: false`; REST `POST /api/agent-event`: silently dropped — the route deletes `duration_ms` and `round` from the body before calling the handler). |
| `input_tokens`, `output_tokens`, `cache_read`, `cache_create` | INTEGER, nullable | the caller, stop/error only | Recorded only when the harness reports them; **NULL when unknown, never 0**. |

**Pairing.** A `stop`/`error` pairs with the latest `start` for the key
`(instance_id, agent, brief_id IS ?)` that has no later `stop`/`error` for the
same key (`findOpenStart` in `brain-mcp-server/src/tools/agent_events.ts`).
`retry` is a marker: it never consumes an open start. Pairing is re-derived
from the rows on any replica — there is no local-id foreign key, because `id`
differs per machine and the sync key is `(instance_id, agent, event_type,
created_at)`.

**Known limitation — concurrent same-role agents.** Two agents of the same
role running at once on the same brief and instance may mis-pair: per-
invocation counts stay right, durations may swap. Stated in the handler's
JSDoc; not fixed here.

**Known bias — the bracket overshoots.** A brain-timed `start → stop` bracket
includes the orchestrator's own overhead around the agent, so it overshoots
agent-active time by **1–6 min** per invocation (TD-420: 0.9–2.1 over five pairs —
sentinel 40.5/18.6/15.9 vs 39.1/16.5/14.9 transcript-timed, warden 13.9/5.9
vs 12.8/5.0; FR-267: 1.0–6.2 over its eleven pairs, median 2.2 — §7 table; no FR-266
bracket-vs-active pair exists in the record: `SELECT COUNT(*) FROM agent_events WHERE
brief_id='FR-266' AND json_extract(metadata,'$.harness_duration_ms') IS NOT NULL` → 0,
2026-08-26 22:02 UTC). The record states this; it does not
correct for it.

**The response echoes what the brain computed**, so the orchestrator sees it:
`Agent event recorded: forger stop (id: 6702, round 2, duration_ms 1834000,
model claude-…)`; an unpaired stop says `(no matching start — duration not
computed)`.

### The `hunt_runs` view (as shipped)

```sql
CREATE VIEW IF NOT EXISTS hunt_runs AS
  SELECT e.project, e.brief_id, bs.effort AS size, e.agent, e.round, e.phase,
         e.model_requested, e.model_resolved, e.event_type AS ended_with, e.result,
         e.duration_ms, ROUND(e.duration_ms / 60000.0, 1) AS minutes,
         CASE WHEN e.duration_ms IS NULL THEN NULL
              ELSE datetime(e.created_at, '-' || (e.duration_ms / 1000) || ' seconds') END AS started_at,
         e.created_at AS ended_at,
         e.input_tokens, e.output_tokens, e.cache_read, e.cache_create,
         e.instance_id, e.id AS event_id
  FROM agent_events e
  LEFT JOIN brief_status bs ON bs.project = e.project AND bs.brief_id = e.brief_id
  WHERE e.event_type IN ('stop', 'error');
```

One row per *completed* invocation (grain = the stop/error row); `size` comes
from `brief_status.effort`. Why a view and no new MCP tool: R5 (records, not a
dashboard), harness-agnostic (`sqlite3` reads it on any harness, including a
future Igris harness), zero tool-count churn. The read verb is `igris kpi`
(FR-268 — the seven OS KPIs over this view, `brief_status` and the ceremony
record; `docs/reference/os-kpis.md` carries the derivations).

---

## 3. The queries that answer R2 (verbatim from the FR-267 plan §2.5)

```sql
-- per agent / per model, one brief
SELECT brief_id, size, agent, model_requested, COUNT(*) AS rounds, ROUND(SUM(duration_ms)/60000.0,1) AS minutes
FROM hunt_runs WHERE project='igris-ai' AND brief_id='FR-267'
GROUP BY brief_id, size, agent, model_requested ORDER BY MIN(ended_at);
-- hunt total
SELECT brief_id, size, COUNT(*) AS invocations, ROUND(SUM(duration_ms)/60000.0,1) AS total_minutes,
       MIN(started_at) AS first_start, MAX(ended_at) AS last_end
FROM hunt_runs WHERE project='igris-ai' AND brief_id='FR-267' GROUP BY 1,2;
-- same role across two models (R3)
SELECT agent, model_requested, COUNT(*) AS n, ROUND(AVG(duration_ms)/60000.0,1) AS avg_minutes
FROM hunt_runs WHERE project='igris-ai' GROUP BY agent, model_requested ORDER BY agent, model_requested;
```

Run them with `sqlite3 -readonly ~/.igris/memory/knowledge.db` (the `/ops`
skill carries the third as its "hunt cost" block — unfiltered by project and `LIMIT 16`, per its own note).

---

## 4. The carrier and the control

- **Carrier:** the orchestrator, through `igris_agent_event` — the only actor
  present on every harness. Every call site in `core/skills/hunt/SKILL.md`
  (12 phase sites + the mender pair) passes `model_requested`; stop/error
  sites add `model_resolved` and the token counts only when the harness
  reports them; no site passes `duration_ms` or `round`.
  `scripts/validate_hunt_agent_event_sites.sh` derives exactly that from the
  skill text and hard-fails in `pre-commit` when it stops being true.
- **Control:** §3 of `scripts/git-hooks/commit-msg` refuses a `closes #X`
  commit when a role X's Agent Log names has no `agent_events` row for X
  (`core/enforcement/agent-event-coverage.md`; parser
  `core/scripts/brief_agent_log_roles.sh`; escape hatch
  `IGRIS_BYPASS_EVENT_GATE=1`, one-shot). Shown red-first on FR-256
  (`test/fixtures/event-gate/README.md`).
- **Retired:** the five `"type": "http"` hook groups in
  `.claude/settings.json` and the `POST /api/hooks/event` receiver they posted
  to (FR-088) — a carrier that exited 0 and landed nothing (L-1248 in config
  form). `docs/HOOK_EVENT_SCHEMA.md` is a stub pointing here.

---

## 5. Classification of the brief's historical numbers (AC 9)

| Number (as filed) | Class | Why |
|---|---|---|
| Per-brief per-agent minutes (TD-420 / FR-266 / BR-096 per-phase totals), rounds per agent, hunt total, wall-clock bracket, invocations per hunt, resumed-round share | **Reproducible going forward** from `hunt_runs` (first complete hunt = FR-267 itself) | The record now holds brain-timed pairs with `round`; known bias: the bracket overshoots agent-active time by 1–6 min (TD-420: 0.9–2.1 over five pairs; no FR-266 bracket-vs-active pair exists in the record (`SELECT COUNT(*) FROM agent_events WHERE brief_id='FR-266' AND json_extract(metadata,'$.harness_duration_ms') IS NOT NULL` → 0, 2026-08-26 22:02 UTC); FR-267: 1.0–6.2 over its eleven pairs, median 2.2 — §7 table — orchestrator overhead, brief §5) and is stated as such |
| Model per role; same role across two models | **Reproducible** (`model_requested`; `model_resolved` when a harness reports it) | R3 |
| Emission compliance (35 of 112 starts; 8 of 18 hunts with zero events) | **Reproducible in a stronger form**: the gate refuses the close, so the going-forward rate is measured as gate refusals + bypass uses; the 112 denominator was transcript-derived and is archaeology | L-1402 |
| Agent-time share of wall clock (90 % / 88 %) | **Reproducible** (SUM(duration) over the hunt's MIN(start)…MAX(end)) with the bias above | — |
| Tool calls per invocation, tool calls per active minute, opus-4-8 / opus-5 / fable-5 comparison table, Claude Code version series, the 1,119-segment / 432-invocation reconstruction | **One-time archaeology** — NOT re-derivable from what ships; the tooling was deliberately not kept (claude-only, R6) | Brief §Corrected measurements |
| Feb-2026 `agent_metrics` averages (2.8 / 5.0 / 5.3 / 1.6 min, 48 rows) | **Archaeology** — the 276 rows (measured 2026-08-26 21:34 UTC) stay in the table as history, unread by any surface | Decision 6 |
| Throughput from `closes #` footers (Aug 04–26 series; 4.6 → 2.2/day; 191 briefs Jun 29–Jul 5) | **Reproducible from git, not from this record** (`git log --grep 'closes #'`) | Not this brief's contract |
| Done per active day, XS+S share, capacity share by project, hunt wall-clock median/p75, "19 of 62 hunts > 4 h" | **Reproducible from `brief_status` + `hunt_runs` for hunts that emitted** — the OS-wide roll-up is `igris kpi` (`docs/reference/os-kpis.md`, FR-268); the filed values are archaeology because pre-ship hunts have no durations | `igris kpi` / `docs/reference/os-kpis.md` (FR-268) |
| Review-floor table (TD-425: forger 29/67/119 → sentinel 23/30/45.5) | **Reproducible going forward** (per-brief forger vs sentinel minutes from `hunt_runs`) | TD-425 depends on it |
| "opus-5 hunts median active 112.5 before / 112.0 after f578dd2" | **Archaeology** (transcript-timed "active" minutes; the record has brain brackets, not active time) | Different quantity — say so in the doc |

---

## 6. Residuals (measured, written down, not fixed here)

- **Same-second push boundary.** `handleBrainPush` in
  `brain-mcp-server/src/tools/sync.ts` selects rows changed *after*
  `sync_state.last_push_at` (`lastPushAt`) with second-precision timestamps,
  so a row written in the SAME second the previous push was stamped is
  skipped by every later push. Low per row, certain over time; the local DB
  stays complete. Touches all synced tables, so it is a TD, not this brief.
- **A remote that has not applied v3.** `mergeRows` on the remote INSERTs
  every column the payload carries; before the VPS runs migration v3 each
  `agent_events` row fails per-row with SQLite's
  `table agent_events has no column named model_requested`, the batch answers
  HTTP 207 and the auto-push path queues the rows for retry (BR-066); since
  BR-097 `igris_brain_push` does not advance an errored table's watermark
  either, so its rows are re-selected by the next push rather than queued.
  Rows are delayed, not lost — which is why Phase 6 deploys the VPS *before*
  the first push.
- **Concurrent same-role agents** may mis-pair (§2).
- **The bracket bias** of 1–6 min per invocation (§2; TD-420: 0.9–2.1 over five pairs; no FR-266 bracket-vs-active pair exists in the record (`SELECT COUNT(*) FROM agent_events WHERE brief_id='FR-266' AND json_extract(metadata,'$.harness_duration_ms') IS NOT NULL` → 0, 2026-08-26 22:02 UTC),
  FR-267: 1.0–6.2 over its eleven pairs, median 2.2 — §7 table) is stated, not corrected.
- **Retained on purpose:** the `SYNC_TABLES` `agent_metrics` transport entry in
  `brain-mcp-server/src/tools/sync.ts` (plan §3.6 — the transport that carries the historical rows to the VPS and
  back; removing it would delete nothing on the VPS, but it would stop a fresh
  machine's pull from restoring the history and move the pinned table count in
  the sync component's `auto-push.test.ts`);
  and two name collisions: `SyncFileType 'agent_metrics'` is a FLAT-FILE type
  (`cache/metrics/agent-metrics.json`), not the table; and the
  `/api/agent-metrics/summary` and `/by-project` routes are legacy *names*
  that read `agent_events`. All keep their names; renaming is churn.
- **Token totals are opaque on this harness.** The harness reports a single `total_tokens`
  figure per agent completion, not the four-way split the columns model; the orchestrator
  records it in `metadata.total_tokens` and the four columns stay NULL. `hunt_runs` does not
  read metadata, so per-agent token cost is not queryable from the view — FR-268 declined a
  token column (tokens are recorded when the harness reports them, never a headline;
  `igris kpi` KPI 6 reads `metadata.tool_calls` only); a candidate for a follow-up brief,
  not a fake split.
- **`DEFAULT 0` stays in the frozen DDL** for `duration_ms` and the four token columns (`db.ts`
  base CREATE and the component's v1 CREATE are frozen by the §2.1 rule; SQLite cannot alter a
  default in place). The handler writes explicit NULLs, so its rows are correct; any OTHER writer
  that omits the columns gets 0 — exactly what the pre-respawn rows demonstrated. A writer that
  is not the handler is a defect, not a supported path.
- **`orchestrator` in the parser's DENYLIST is documentary.** `is_denied()` matches any role
  ending in `orchestrator` first (the glob that also folds `hunt-orchestrator`); removing the
  array entry alone changes nothing (sentinel mutation c1 survived, c2 red). The comment beside
  the array says so.

---

## 7. Live evidence (Phase 6)

Measured on FR-267's own hunt, 2026-08-26 (UTC), after the brain was respawned on the
FR-267 bundle. Every figure below was read from stored rows, not from a carrier's exit code.

**R2 — per agent / per model (`hunt_runs`, plan §2.5 q1):**

```
brief_id|size|agent    |model_requested       |rounds|minutes
FR-267  |L   |architect|inherit:claude-fable-5|1     |29.2
FR-267  |L   |forger   |inherit:claude-fable-5|3     |102.4
FR-267  |L   |sentinel |inherit:claude-fable-5|1     |14.8
```

**Hunt total (q2):** `FR-267 | L | invocations=5 | total_minutes=146.4 | first_start=2026-08-26 16:27:49 | last_end=2026-08-26 19:44:26`
(warden and any later rounds accrue after this snapshot; re-run q1/q2 for the final figure.)

**Same role across models (q3, `WHERE project='igris-ai'`, run 2026-08-26 22:02:10 UTC by the
brain's own `datetime('now')`; the NULL-model groups are the pre-FR-267 archaeology rows,
which carry no duration; sentinel/warden n=3 because their review rounds 2–3 had landed —
the newest row in this output is 6675, warden r3's error row, `ended_at 2026-08-26 21:59:52` (read back from the row after writing this sentence — the first draft carried a guessed time)):**

```
agent    |model_requested       |n |avg_minutes
architect|                      |9 |
architect|inherit:claude-fable-5|1 |29.2
document |                      |4 |
forger   |                      |11|
forger   |inherit:claude-fable-5|4 |31.1
sentinel |                      |15|
sentinel |inherit:claude-fable-5|3 |11.5
warden   |                      |14|
warden   |inherit:claude-fable-5|3 |24.8
```

One post-ship model so far. The query separates models by construction; a second
model's rows form their own group the first time a role runs on one — the record
does not fabricate them. *(An earlier paste of this query, produced at ≈21:25 UTC and
mis-stamped "20:58 UTC", is superseded by the run above — warden round 3, item 1.)*


**Brain-timed rows, read back:** `6658 forger stop round 3 duration_ms 2351653` (the tool's own response text:
`Agent event recorded: forger stop (id: 6658, round 3, duration_ms 2351653, model inherit:claude-fable-5)`;
sentinel re-derived the bracket arithmetically: 2,351,000 ms + the sub-second part of `julianday('now')`);
`6660 sentinel stop round 1 duration_ms 886701`. Tokens are NULL on every row of the table —
both halves measured read-only on 2026-08-26 ≈20:50 UTC (00:50 on the +04 clock) over all 272 rows (ids 6393–6664):
`SELECT COUNT(*) FROM agent_events WHERE input_tokens=0 OR output_tokens=0 OR cache_read=0 OR cache_create=0`
→ 0 (no row holds a 0 token count, after the correction below), and
`SELECT COUNT(*) FROM agent_events WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cache_read IS NOT NULL OR cache_create IS NOT NULL`
→ 0 (no row holds a non-NULL token count — the four columns are NULL on every row, not merely never 0).

**Durability off-machine (decision 8):** `igris sync code` deployed the bundle to the VPS first
(rsync → `npm ci` → build → native-module smoke → `pm2 restart igris-brain`, 2 min 15 s, exit 0;
`/health` → `{"status":"ok"}`). Then `igris_brain_push` → 195 rows, `agent_events: 10 row(s)`.
`GET /api/instances/0c49d308-…/log` on the remote returned all ten FR-267 rows with
`round`, `duration_ms`, `model_requested`, `project` populated and token columns `null`
(remote ids 5816–5825). Local sync queue depth after the push: 0.

**Provenance of the pre-respawn rows (one-time corrections, cited in the brief's Agent Log):**
rows 6651–6657 were written by the OLD handler after the v3 migration had already landed
(TD-426). They were corrected once, from each row's own `metadata`, never invented:
`project='igris-ai'`; `model_requested = json_extract(metadata,'$.model_requested')`;
`round = json_extract(metadata,'$.round')`; start-row `duration_ms 0 → NULL`; token columns
`0 → NULL` (6654–6657); and the three harness-reported durations the orchestrator had passed
(6652 / 6654 / 6656) were moved to `metadata.harness_duration_ms` (1521884 / 1869505 / 1618415)
and `duration_ms` recomputed as the brain bracket from each paired start row
(1754000 / 2064999 / 1725000). The record is therefore uniformly brain-bracketed; the
harness-active figures survive as metadata for the bias measurement (bracket − active, all eleven pairs this hunt produced, brackets read from the rows on
2026-08-26 22:02 UTC and harness-active figures from `metadata.harness_duration_ms` or the
task notification quoted in the Agent Log):

```
id   agent     round type  bracket active delta
6652 architect 1     stop  29.2    25.4   3.9
6654 forger    1     stop  34.4    31.2   3.3
6656 forger    2     stop  28.8    27.0   1.8
6658 forger    3     stop  39.2    37.0   2.2
6660 sentinel  1     stop  14.8    11.5   3.3
6662 warden    1     error 40.9    34.7   6.2
6665 forger    4     stop  22.1    20.7   1.4
6667 sentinel  2     stop   9.3     8.2   1.0
6669 warden    2     error 15.0    13.7   1.3
6672 sentinel  3     error 10.5     9.2   1.2
6675 warden    3     error 18.6    14.8   3.8
                                   range 1.0–6.2, median 2.2
```

*(Deltas were computed from millisecond brackets and the notifications' second-level
active figures; the printed columns are rounded to one decimal, so `bracket − active`
can differ from `delta` by 0.1 on four rows. From the printed figures alone the floor
reads 1.1; the range, the median and the 1–6 min envelope hold either way.)*

The excess is orchestrator wait between the agent's return and its stop event, and it is
not bounded by anything in the record: warden r1's 6.2 min is the orchestrator mid-way
through the TD-429 cold-cache investigation when the review returned. TD-420's five pairs
measured 0.9–2.1; §2 therefore states 1–6 with the mechanism, not a rounding.

**The gate, red-first, on a real omission:** FR-256 (Done 2026-08-14, Agent Log names
architect/forger/sentinel, zero `agent_events` rows) —
`EVENT-GATE FR-256: VERDICT=FAIL roles=architect,forger,sentinel missing=architect,forger,sentinel`, `exit=1`.
Then on this brief before its review rows existed: `EVENT-GATE FR-267: WARN unpaired: sentinel`, `exit=0`.
FR-267's own closing commit is the first live green.

**Classification of the archaeology (§5) stands.** The first hunt fully reproducible from the
record is FR-267 itself, with the provenance caveat above.
