# OS KPIs — `igris kpi` and the ceremony record (FR-268)

**What this is.** The seven numbers that say whether the Igris OS is getting
faster or slower and where the cost sits, computed **on read** from records
that controls enforce — never stored, never a dashboard, never a harness's
files (R1–R5 of the brief). One verb, `igris kpi`, prints them; `--sql`
prints the seven derivations plus the KPI 7 coverage sub-query (8 statements)
verbatim so `sqlite3` reproduces every figure on any harness; `--alarm` prints the one line `/scan` renders. One NEW record
ships with it: the **ceremony record** (`ceremony_events`), the brain-timed
start/stop pair for `/boot`, `/rest`, `/register` and `/hunt` INIT, written
by `igris ceremony start|stop` — a verb the four skills call as their first
and last executable step, with an authoring validator that fails when a
skill loses the call.

**What it answers** (the operator, 2026-08-26): *"we don't have exact number
to tell me if i'm not tripping … without numbers we can't actually evaluate
the system or know the pain points."*

---

## 1. The seven KPIs and where each comes from

| # | KPI | record | grain | since when the record can carry it |
|---|---|---|---|---|
| 1 | **Capacity** — brain-bracket agent minutes, invocations, briefs, per project per week | `hunt_runs` (`agent_events`, FR-267) | per stop/error row, attributed to the row's week | rows with a non-NULL `duration_ms`: **2026-08-26 16:57:03 UTC** onward (the first FR-267 brain-timed stop) |
| 2 | **Throughput** — Done per week and per active day, per project | `brief_status` (Done rows) + active days from `agent_events` ∪ `ceremony_events` | per project-week | Done: the whole `brief_status` history; active days: **2026-08-14** onward (`activity_floor`), and undercounted until the FR-267 event gate (2026-08-26) made emission mechanical |
| 3 | **Effort mix** of Done — leading size token, XS+S share | `brief_status` | per project-week-effort | the whole history |
| 4 | **Minutes per hunt by phase** — nearest-rank median / p75 of hunt totals, phase shares | `hunt_runs` | per hunt (`project`, `brief_id`), attributed to the week of its LAST stop/error row | as KPI 1 |
| 5 | **Rounds per hunt** — hunts resumed, resumed share, avg extra rounds | `hunt_runs.round` | per hunt, same attribution | as KPI 1 |
| 6 | **Model per role** — per-invocation minutes and tool calls by `agent` × `model_requested` | `hunt_runs` + `agent_events.metadata` (`$.tool_calls`) joined by `event_id` | per invocation, over the whole window (not per week) | minutes as KPI 1; tool calls only once stop rows carry `metadata.tool_calls` (0 rows do, 2026-08-27) |
| 7 | **Ceremony cost** — runs, median / p75 minutes per ceremony per week, plus coverage (starts, stops, unpaired) | `ceremony_runs` / `ceremony_events` (this brief) | per run / per project-ceremony-week | **2026-08-27 07:24:52 UTC** onward (the first stamp, the live proof in §6) |

## 2. Conventions (stated once; the verb prints `tz: UTC` and every `week_start`)

- **Weeks are Monday–Sunday in UTC.** `WEEK(x) = date(x, '-' || ((strftime('%w', x) + 6) % 7) || ' days')` — portable; no `%G/%V` (those need SQLite ≥ 3.46). The operator's +04 clock is never used: a `/rest` at 02:00 +04 on a Monday is Sunday UTC and belongs to the previous week.
- **The current week is included and marked `partial: true`.** The alarm never reads it.
- **Done date = `brief_status.updated_at` of a Done row.** The table has no completed-at column (measured: `db.ts` v2 DDL plus the `claimed_by` / `claimed_at` ALTERs are its only additions). Residual: a post-Done edit moves the brief's week. Status is matched with the TD-340 notation fold `replace(replace(replace(lower(status),' ',''),'-',''),'_','') = 'done'` — `Done(Resolvedbydec8d1f)` (one stray row) is not Done.
- **Effort is folded to its leading size token** — measured 2026-08-27 08:34:37 UTC (`sqlite3 -readonly`): `brief_status` holds 2,078 rows, 1,888 with a non-NULL `effort` in 59 distinct spellings (`S-Small (< 4h)`, `M-Medium (1-2d)`, `XL-Extra Large (>1w)` …), 190 NULL. 56 of the 59 spellings start with their token: `XS`, `S`, `M`, `L`, `XL`; NULL → `(none)`; the other 3 (`TBD`, `n/a`, `Tracking`) → `(other)`.
- **Active day** = a UTC date with ≥ 1 `agent_events` row (with a non-NULL `project`) or ≥ 1 `ceremony_events` row for the project. **A week that starts before the record's first activity day (`activity_floor`, 2026-08-14 on this brain) reads NULL per active day** — its denominator is not covered, and a ratio over a partial denominator is the L-1401 false finding (the first live reading, before this rule, printed `23.0` for week 2026-08-10 over ONE counted day).
- **Percentiles are nearest-rank:** the value at sorted row `max(1, ceil(n·p))`, in integer arithmetic `(num·n + den−1) / den` (median `(1*n + 1) / 2`, p75 `(3*n + 3) / 4`; `n` is a `COUNT`, so the division truncates). Stated so "median" is a defined quantity at n = 1, 2, 3.
- **A hunt is attributed to the week of its LAST stop/error row**; capacity (KPI 1) is attributed per row. KPIs 1/4/5/6 read rows with a non-NULL `duration_ms` only, so a hunt whose rows straddle `:since` loses its earlier rows (stated, not corrected).
- **Capacity is brain-bracket minutes** — the bracket overshoots agent-active time by 1–6 min per invocation (`hunt-cost-record.md` §7: median 2.2 over FR-267's eleven pairs). Labelled, not corrected.
- **NULL, never 0**, for every unknown (§18.12): an unpaired stop's duration, a week without activity, a model group without tool calls.

## 3. The derivations — verbatim from `igris kpi --sql` (2026-08-27)

Bind `:since` and `:project` as the header says. These are the SQL constants in
`cli/src/lib/kpi-read.ts` (`KPI_QUERIES`); the verb runs exactly these on a v4
brain (an older brain runs a narrowed `activity` CTE for KPI 2, named in
`skipped`; `kpi-read.test.ts` pins that the v4 path is byte-identical to the
constant), and this block is re-pasted from `igris kpi --sql` whenever one changes.

```sql
-- igris kpi --sql (FR-268): the seven OS KPI derivations plus the KPI 7 coverage sub-query (8 statements), verbatim.
-- Bind :since (Monday of the oldest week, UTC, 'YYYY-MM-DD') and :project (a slug, or NULL for every project):
--   sqlite3 -readonly ~/.igris/memory/knowledge.db
--   .parameter set :since '2026-08-17'
--   .parameter set :project NULL
-- Weeks are Monday–Sunday UTC: WEEK(x) = date(x, '-' || ((strftime('%w', x) + 6) % 7) || ' days')
-- Percentiles are nearest-rank (ceil(n·p), floored at 1): median rank (1 * n + 1) / 2, p75 rank (3 * n + 3) / 4.
-- Requires SQLite >= 3.25 (window functions); better-sqlite3 bundles a newer one, macOS ships 3.43+.
-- KPIs 1/4/5/6 read hunt_runs (instances migration v3); KPI 7 reads ceremony_runs / ceremony_events (v4).

-- capacity
SELECT project, date(ended_at, '-' || ((strftime('%w', ended_at) + 6) % 7) || ' days') AS week_start,
       CAST(ROUND(SUM(duration_ms) / 60000.0) AS INTEGER) AS agent_minutes,
       COUNT(*) AS invocations, COUNT(DISTINCT brief_id) AS briefs
  FROM hunt_runs
 WHERE duration_ms IS NOT NULL AND ended_at >= :since AND (:project IS NULL OR project = :project)
 GROUP BY 1, 2 ORDER BY 2, 1;

-- throughput
WITH done AS (
  SELECT project, date(updated_at, '-' || ((strftime('%w', updated_at) + 6) % 7) || ' days') AS week_start, COUNT(*) AS done
    FROM brief_status
   WHERE replace(replace(replace(lower(status), ' ', ''), '-', ''), '_', '') = 'done' AND updated_at >= :since AND (:project IS NULL OR project = :project)
   GROUP BY 1, 2),
activity AS (
  SELECT project, date(created_at) AS day FROM agent_events
   WHERE project IS NOT NULL AND created_at >= :since AND (:project IS NULL OR project = :project)
  UNION
  SELECT project, date(created_at) AS day FROM ceremony_events
   WHERE created_at >= :since AND (:project IS NULL OR project = :project)),
active_days AS (
  SELECT project, date(day, '-' || ((strftime('%w', day) + 6) % 7) || ' days') AS week_start, COUNT(*) AS active_days
    FROM activity GROUP BY 1, 2),
record_floor AS (
  SELECT MIN(day) AS day FROM (
    SELECT MIN(date(created_at)) AS day FROM agent_events WHERE project IS NOT NULL
    UNION ALL
    SELECT MIN(date(created_at)) AS day FROM ceremony_events)),
wk_keys AS (
  SELECT project, week_start FROM done UNION SELECT project, week_start FROM active_days)
SELECT k.project, k.week_start,
       COALESCE(d.done, 0) AS done,
       COALESCE(a.active_days, 0) AS active_days,
       CASE WHEN k.week_start < (SELECT day FROM record_floor) THEN NULL
            WHEN COALESCE(a.active_days, 0) = 0 THEN NULL
            ELSE ROUND(COALESCE(d.done, 0) * 1.0 / a.active_days, 2) END AS done_per_active_day
  FROM wk_keys k
  LEFT JOIN done d ON d.project = k.project AND d.week_start = k.week_start
  LEFT JOIN active_days a ON a.project = k.project AND a.week_start = k.week_start
 ORDER BY 2, 1;

-- effort_mix
WITH done AS (
  SELECT project, date(updated_at, '-' || ((strftime('%w', updated_at) + 6) % 7) || ' days') AS week_start, CASE WHEN effort IS NULL THEN '(none)' WHEN effort LIKE 'XS%' THEN 'XS' WHEN effort LIKE 'XL%' THEN 'XL' WHEN effort LIKE 'S%' THEN 'S' WHEN effort LIKE 'M%' THEN 'M' WHEN effort LIKE 'L%' THEN 'L' ELSE '(other)' END AS effort
    FROM brief_status
   WHERE replace(replace(replace(lower(status), ' ', ''), '-', ''), '_', '') = 'done' AND updated_at >= :since AND (:project IS NULL OR project = :project)),
mix AS (
  SELECT project, week_start, effort, COUNT(*) AS done FROM done GROUP BY 1, 2, 3)
SELECT project, week_start, effort, done,
       ROUND(SUM(CASE WHEN effort IN ('XS', 'S') THEN done ELSE 0 END) OVER (PARTITION BY project, week_start) * 1.0
             / SUM(done) OVER (PARTITION BY project, week_start), 2) AS xs_s_share
  FROM mix ORDER BY 2, 1, 3;

-- hunt_minutes
WITH hunts AS (
  SELECT project, brief_id,
         SUM(duration_ms) / 60000.0 AS total_min,
         SUM(CASE WHEN agent = 'architect' THEN duration_ms ELSE 0 END) / 60000.0 AS architect_min,
         SUM(CASE WHEN agent = 'forger' THEN duration_ms ELSE 0 END) / 60000.0 AS forger_min,
         SUM(CASE WHEN agent = 'sentinel' THEN duration_ms ELSE 0 END) / 60000.0 AS sentinel_min,
         SUM(CASE WHEN agent = 'warden' THEN duration_ms ELSE 0 END) / 60000.0 AS warden_min,
         SUM(CASE WHEN agent = 'mender' THEN duration_ms ELSE 0 END) / 60000.0 AS mender_min,
         SUM(CASE WHEN agent = 'document' THEN duration_ms ELSE 0 END) / 60000.0 AS document_min,
         MAX(ended_at) AS last_end
    FROM hunt_runs
   WHERE duration_ms IS NOT NULL AND brief_id IS NOT NULL AND ended_at >= :since AND (:project IS NULL OR project = :project)
   GROUP BY 1, 2),
ranked AS (
  SELECT h.*, date(last_end, '-' || ((strftime('%w', last_end) + 6) % 7) || ' days') AS week_start,
         ROW_NUMBER() OVER (PARTITION BY project, date(last_end, '-' || ((strftime('%w', last_end) + 6) % 7) || ' days') ORDER BY total_min) AS rn,
         COUNT(*) OVER (PARTITION BY project, date(last_end, '-' || ((strftime('%w', last_end) + 6) % 7) || ' days')) AS n
    FROM hunts h)
SELECT project, week_start, n AS hunts,
       ROUND(MAX(CASE WHEN rn = (1 * n + 1) / 2 THEN total_min END), 1) AS median_min,
       ROUND(MAX(CASE WHEN rn = (3 * n + 3) / 4 THEN total_min END), 1) AS p75_min,
       ROUND(SUM(architect_min) / SUM(total_min), 2) AS architect_share,
       ROUND(SUM(forger_min) / SUM(total_min), 2) AS forger_share,
       ROUND(SUM(sentinel_min) / SUM(total_min), 2) AS sentinel_share,
       ROUND(SUM(warden_min) / SUM(total_min), 2) AS warden_share,
       ROUND(SUM(mender_min) / SUM(total_min), 2) AS mender_share,
       ROUND(SUM(document_min) / SUM(total_min), 2) AS document_share
  FROM ranked GROUP BY 1, 2, 3 ORDER BY 2, 1;

-- hunt_rounds
WITH per_agent AS (
  SELECT project, brief_id, agent, MAX(round) AS max_round, MAX(ended_at) AS last_end
    FROM hunt_runs
   WHERE duration_ms IS NOT NULL AND brief_id IS NOT NULL AND ended_at >= :since AND (:project IS NULL OR project = :project)
   GROUP BY 1, 2, 3),
hunts AS (
  SELECT project, brief_id, SUM(max_round - 1) AS extra_rounds, MAX(last_end) AS last_end
    FROM per_agent GROUP BY 1, 2)
SELECT project, date(last_end, '-' || ((strftime('%w', last_end) + 6) % 7) || ' days') AS week_start, COUNT(*) AS hunts,
       SUM(CASE WHEN extra_rounds > 0 THEN 1 ELSE 0 END) AS hunts_resumed,
       ROUND(SUM(CASE WHEN extra_rounds > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 2) AS resumed_share,
       ROUND(AVG(extra_rounds), 2) AS avg_extra_rounds
  FROM hunts GROUP BY 1, 2 ORDER BY 2, 1;

-- model_per_role
WITH inv AS (
  SELECT h.agent, h.model_requested, h.minutes,
         CASE WHEN json_valid(e.metadata) THEN json_extract(e.metadata, '$.tool_calls') END AS tool_calls
    FROM hunt_runs h LEFT JOIN agent_events e ON e.id = h.event_id
   WHERE h.duration_ms IS NOT NULL AND h.ended_at >= :since AND (:project IS NULL OR h.project = :project)),
ranked AS (
  SELECT agent, model_requested, minutes, tool_calls,
         ROW_NUMBER() OVER (PARTITION BY agent, model_requested ORDER BY minutes) AS rn,
         COUNT(*) OVER (PARTITION BY agent, model_requested) AS n,
         ROW_NUMBER() OVER (PARTITION BY agent, model_requested ORDER BY (tool_calls IS NULL), tool_calls) AS trn,
         COUNT(tool_calls) OVER (PARTITION BY agent, model_requested) AS tn
    FROM inv)
SELECT agent, model_requested, n,
       ROUND(MAX(CASE WHEN rn = (1 * n + 1) / 2 THEN minutes END), 1) AS median_min,
       ROUND(MAX(CASE WHEN rn = (3 * n + 3) / 4 THEN minutes END), 1) AS p75_min,
       MAX(CASE WHEN tn > 0 AND trn = (1 * tn + 1) / 2 THEN tool_calls END) AS tool_calls_median,
       tn AS tool_calls_n
  FROM ranked GROUP BY agent, model_requested, n, tn ORDER BY 1, 2;

-- ceremony_cost
WITH runs AS (
  SELECT project, ceremony, date(ended_at, '-' || ((strftime('%w', ended_at) + 6) % 7) || ' days') AS week_start, minutes
    FROM ceremony_runs
   WHERE duration_ms IS NOT NULL AND ended_at >= :since AND (:project IS NULL OR project = :project)),
ranked AS (
  SELECT project, ceremony, week_start, minutes,
         ROW_NUMBER() OVER (PARTITION BY project, ceremony, week_start ORDER BY minutes) AS rn,
         COUNT(*) OVER (PARTITION BY project, ceremony, week_start) AS n
    FROM runs)
SELECT project, ceremony, week_start, n AS runs,
       ROUND(MAX(CASE WHEN rn = (1 * n + 1) / 2 THEN minutes END), 1) AS median_min,
       ROUND(MAX(CASE WHEN rn = (3 * n + 3) / 4 THEN minutes END), 1) AS p75_min
  FROM ranked GROUP BY 1, 2, 3, n ORDER BY 3, 1, 2;

-- ceremony_coverage
SELECT project, ceremony, date(created_at, '-' || ((strftime('%w', created_at) + 6) % 7) || ' days') AS week_start,
       SUM(event_type = 'start') AS starts,
       SUM(event_type = 'stop') AS stops,
       SUM(event_type = 'start') - SUM(event_type = 'stop') AS unpaired,
       SUM(event_type = 'stop' AND duration_ms IS NULL) AS unpaired_stops
  FROM ceremony_events
 WHERE created_at >= :since AND (:project IS NULL OR project = :project)
 GROUP BY 1, 2, 3 ORDER BY 3, 1, 2;

```

## 4. The ceremony record — contract

| item | value |
|---|---|
| table | `ceremony_events` — instances migration **v4** (`brain-mcp-server/src/engine/components/instances/index.ts`); view `ceremony_runs` (stop rows, with `minutes` and `started_at` derived from `duration_ms`) |
| columns | `project`, `ceremony`, `event_type` (`start` or `stop` — a DDL CHECK), `machine_hostname`, `instance_id` (NULL on `boot`'s start, which predates the mint), `brief_id` (`register` / `hunt-init`), `duration_ms` (SQL-computed on a paired stop; NULL on start and on an unpaired stop — never 0), `metadata` (`{}`), `created_at` (the DB's `datetime('now')`, UTC) |
| writer | `igris ceremony start\|stop --name <boot\|rest\|register\|hunt-init> [--project] [--instance-id] [--brief]` → `cli/src/lib/brain-db.ts#ceremonyEventWrite` (the CLI's local WRITE door, create-never: a brain without the table degrades with `ceremony_events absent — brain older than FR-268 (instances v4); rebuild cli + respawn the brain`). The verb **never passes a timestamp**; the slug defaults to the cwd basename (the `igris instance` / `igris detect` rule) so `boot`'s start runs before `igris detect`. |
| vocabulary | the verb's allowlist (`CEREMONY_NAMES`), NOT a DDL CHECK — SQLite cannot widen a CHECK, so a fifth ceremony is a verb edit + one skill pair + one validator row, never a migration |
| pairing | a stop pairs with the latest open start of `(project, ceremony, machine_hostname)` — a mirror of `agent_events.ts` `findOpenStart`; `duration_ms = CAST((julianday('now') − julianday(start.created_at)) * 86400000 AS INTEGER)` — a mirror of `DURATION_FROM_START_SQL`. Known limitation (the FR-267 class): two concurrent same-ceremony runs of one project on one host may mis-pair — counts stay right, durations may swap. |
| the four sites | `/boot` §0 (before `igris detect`) → §7 (before "Igris AI initialized"); `/rest` §0 → §3.5 (after the session-file update, before the confirm); `/register` §0 → §7 (after the confirm block); `/hunt` Phase 1 step 0 → after the Instance State line (before the phase machine). Each line is `… 2>/dev/null \|\| true`: a stamp never blocks a ceremony. |
| the control | **L1** `scripts/validate_ceremony_sites.sh` — HARD-fail in `pre-commit` when any of the four skills is staged: exactly one start + one stop per skill, named for that skill, heading-anchored (start above the first executable step, stop below the last), never inside an `igris_agent_event` window. Bats twin `test/validate_ceremony_sites.test.bash` (12 cases, every red proven landed). **L2** `igris kpi` KPI 7 coverage rows — `unpaired` (starts − stops) and `unpaired_stops` per project-week, and the `/scan` line's `unpaired N` — an OBSERVER, not a refusal. `core/enforcement/ceremony-stamp-coverage.md` names what neither layer covers. |
| retention | durable — no purge, no TTL, no cap (same as `agent_events`); `instances-list-no-purge.test.ts` scans `src/` for `DELETE FROM ceremony_events` with a planted-file arm |
| replication | in `SYNC_TABLES` (append; key `machine_hostname, project, ceremony, event_type, created_at` — the host is in the key so two machines' same-second rows never collide); disclosed in `docs/reference/sync-egress-manifest.md` (the table and its nine columns); the CLI twin `cli/src/lib/sync/egress-manifest.generated.ts` carries no table names by design — category summary, redacted columns and disclosure lines only — so its unchanged bytes after regeneration are not a missed regeneration; travels on the generic push (`/rest` §2.7 / `igris_brain_push`) — no bus event. **NOT** in `BOOT_SYNC_PULL_TABLES` and **NOT** in `EXPORT_TABLES` (§7). |

**Red-first (the omission case, at the authoring layer).** Run on the un-edited
skills before the stamps landed, 2026-08-27 UTC:

```
core/skills/boot/SKILL.md:0 -> no start site (expected one `igris ceremony start --name boot`)
core/skills/boot/SKILL.md:0 -> no stop site (expected one `igris ceremony stop --name boot`)
core/skills/rest/SKILL.md:0 -> no start site (expected one `igris ceremony start --name rest`)
core/skills/rest/SKILL.md:0 -> no stop site (expected one `igris ceremony stop --name rest`)
core/skills/register/SKILL.md:0 -> no start site (expected one `igris ceremony start --name register`)
core/skills/register/SKILL.md:0 -> no stop site (expected one `igris ceremony stop --name register`)
core/skills/hunt/SKILL.md:0 -> no start site (expected one `igris ceremony start --name hunt-init`)
core/skills/hunt/SKILL.md:0 -> no stop site (expected one `igris ceremony stop --name hunt-init`)
FAIL: 4 skills, 0 sites, 8 violation(s) under /Users/m.elamin/StudioProjects/igris-ai/core/skills
exit=1
```

After the edits: `OK: 4 skills, 8 sites`, exit 0.

## 5. The alarm (`/scan`'s one line)

`igris kpi --project <slug> --alarm` compares the last COMPLETE UTC week (W1)
with the one before (W0) for Done per active day (KPI 2) and median hunt
minutes (KPI 4); `!` marks |Δ| > 30 % (strictly greater — `+30%` does not
fire); `n/a` where either side is NULL; then W1's ceremony runs and medians
per name and its `unpaired` count. Always one line, never a second. `/scan`
renders `alarm.line` under `### KPI` and omits the section when the verb is
absent or degraded.

## 6. Live evidence (manual runbook, not CI — say so)

**The first brain-timed ceremony pair**, written by the rebuilt `igris`
(`cli/dist/index.js`, 2026-08-27 07:24 UTC) after the cli build's bundled-MCP
smoke boot applied instances v4 to the live brain (`engine_migrations`:
`instances|4|2026-08-27 07:23:55`):

```
$ igris ceremony start --name boot --project igris-ai --json
{"degraded":false,"ceremony":"boot","event_type":"start","project":"igris-ai","id":1,"created_at":"2026-08-27 07:24:52","paired":null,"paired_start_id":null,"duration_ms":null,"warnings":[],"skipped":[]}
$ igris ceremony stop --name boot --project igris-ai --json
{"degraded":false,"ceremony":"boot","event_type":"stop","project":"igris-ai","id":2,"created_at":"2026-08-27 07:24:54","paired":true,"paired_start_id":1,"duration_ms":2783,"warnings":[],"skipped":[]}
$ sqlite3 -readonly -header ~/.igris/memory/knowledge.db "SELECT * FROM ceremony_runs ORDER BY event_id DESC LIMIT 1;"
project|ceremony|machine_hostname|instance_id|brief_id|duration_ms|minutes|started_at|ended_at|event_id
igris-ai|boot|<host>|||2783|0.0|2026-08-27 07:24:52|2026-08-27 07:24:54|2
```

(`machine_hostname` redacted to `<host>` — `docs/` ships in the npm package; the row is otherwise verbatim.)

The bracket (`07:24:52 → 07:24:54`, with a 2 s sleep between the two calls)
read back as `duration_ms 2783` — the sub-second part is `julianday('now')`
at the stop against a second-precision `created_at` at the start, the same
±1 s the FR-267 brackets carry.

## 7. Residuals (measured, written down, not fixed here)

- **A push holds the watermark of a table the remote does not acknowledge (BR-097, fixed 2026-08-27; was: the watermark advanced and the rows were lost).** Read from `brain-mcp-server/src/tools/sync.ts` at the fix: `processSyncPush` (the remote's `POST /sync/push` body) still `continue`s over a table absent from its schema, but now names it in `skipped[]` (always present — `[]` when nothing was skipped) and answers `ok: false` / HTTP 207; a skipped table is NOT placed in `errors`, so a pre-BR-097 client does not queue it. Both local push clients — `handleBrainPush` (`igris_brain_push`, `/rest` §2.7, the perception extractor) and the auto-push `pushTables` in `brain-mcp-server/src/engine/components/sync/index.ts` — stamp `sync_state.last_push_at` for a table **only when the remote named it in `results` and not in `errors`**; a table that was skipped, errored, or simply unnamed by an older remote is held and re-selected in full by the next push, and the tool text prints `<table>: SKIPPED — not on remote yet (deploy first; rows retained locally)` (or `ERROR — …` / `UNACKNOWLEDGED — …`) with a headline that no longer says "successfully". A push against a remote that lacks the table therefore delays the rows; it no longer loses them. **Prevention stays the healthy path:** deploy the VPS (`igris sync code` → `/health` ok → `SELECT COUNT(*) FROM sqlite_master WHERE name='ceremony_events'` = 1 on the remote) BEFORE the first push after a rebuild — the skip line is a notice that the order was wrong, not a recovery step. **Recovery — only for a watermark stamped by a pre-BR-097 push** (FR-268's own early push was one, recovered by hand 2026-08-27 ~09:45 UTC): on the machine that pushed too early, `DELETE FROM sync_state WHERE remote_url = '<remote>' AND table_name = 'ceremony_events'` (the write door, not `-readonly`), then push again — the rows are still local (durable) and re-select from 1970. The stamp VALUE (`pushedAt = now()`, which can outrun a row committed after the SELECT) is TD-428's, together with the same-second boundary below.
- **The local series is per-machine.** `BOOT_SYNC_PULL_TABLES` (`cli/src/lib/brain-db.ts`) pulls neither `agent_events` nor `ceremony_events`, so a second emitting machine's rows reach the VPS but never this one; the VPS holds the union. Today one machine emits, so local = union. File a TD the day a second machine emits (a second verbatim CLI mirror of two column lists, row 103's sweep).
- **The pre-gate weeks undercount active days.** Before the FR-267 commit-msg event gate (2026-08-26) emission was prose and measured at 31 %: igris-ai's week 2026-08-17→23 shows 60 `agent_events` rows on exactly two dates (08-17, 08-18) and nothing 08-19→23, so `Done/active-day 6.5` for that week is a ratio over an undercounted denominator — reported, because the rule is mechanical, but NOT comparable with post-gate weeks. The first week with a mechanically-emitted denominator is 2026-08-31→09-06.
- **KPI 6 tool calls are NULL until rows carry them.** 0 of 296 `agent_events` rows hold `metadata.tool_calls` (2026-08-27; 13 hold `metadata.total_tokens`). The hunt skill's `## Agent Event Emission` rule 2 now names the key; the column fills as stop rows are written under it. A harness that reports nothing keeps it NULL — never 0.
- **Same-second push boundary** (TD-428) applies to this table as to every synced table.
- **`brief_status.updated_at` moves after Done** (LWW) → a Done brief can change week. Cross-checkable from git `closes #` footers, not this record's contract.
- **Concurrent same-ceremony runs on one host** may mis-pair (§4).
- **The `--alarm` W0 side is NULL on this brain until 2026-09-07** (the floor rule), so the first flag that can fire honestly compares 2026-08-24→30 with 2026-08-31→09-06, read on or after 2026-09-07.

## 8. Coverage — which weeks each KPI can honestly cover (L-1401)

| KPI | 2026-08-17 → 23 | 2026-08-24 → 30 (partial at the reading) | first FULL post-ship week |
|---|---|---|---|
| 1 capacity | **NULL** — every `duration_ms` before 2026-08-26 16:57 UTC is NULL (the FR-267 fold); the archaeology is not reproducible | from 2026-08-26 16:57 UTC: igris-ai 308 min / 14 invocations / 2 briefs (FR-267's 13 rows + FR-268's architect), mbrgea-ai 21 / 1 / 1, moca-ai-agent 21 / 1 / 1 | 2026-08-31 → 09-06 |
| 2 throughput | Done: yes (igris-ai 13, mbrgea-ai 12, moca-ai-agent 14, fifty-content-pipeline 2). Per active day: **not comparable** (§7 — denominator undercounted; moca-ai-agent and fifty-content-pipeline have 0 recorded days → NULL) | Done yes; per active day over the gated record (igris-ai 6 / 3 days = 2.00, mbrgea-ai 7 / 3 = 2.33, moca-ai-agent 5 / 2 = 2.50; fifty-dev 4 / 0 → NULL) | 2026-08-31 → 09-06 |
| 3 effort mix | yes | yes | already |
| 4 minutes per hunt | **NULL** (as KPI 1) | igris-ai 2 hunts: median 18.4 / p75 289.3 — the two hunts are FR-267 (289.3 min, complete) and FR-268 (18.4 min, IN PROGRESS at the reading); phase shares architect 15 % / forger 40 % / sentinel 11 % / warden 29 % / document 4 % | 2026-08-31 → 09-06 |
| 5 rounds per hunt | **NULL** (as KPI 1) | igris-ai 2 hunts, 1 resumed (FR-267: forger r4, sentinel r3, warden r4 → 8 extra rounds), `avg_extra_rounds 4.0` | 2026-08-31 → 09-06 |
| 6 model per role | **NULL** (as KPI 1) | 7 `agent × model_requested` groups over the window; `tool_calls_n = 0` everywhere | 2026-08-31 → 09-06 |
| 7 ceremony cost | **NULL** — no record existed | boot: 1 run, 0.0 min (the §6 proof pair), coverage 1 / 1 / 0 / 0 | 2026-08-31 → 09-06 |

**The AC "reproduced for at least one week after the record ships" is recorded,
not claimed, inside the hunt.** The reading below is the shape and the
derivation; the first full post-ship week is **2026-08-31 → 09-06**, to be read
with `igris kpi --weeks 1` (and `--project igris-ai --alarm`) **on or after
2026-09-07 UTC** and appended to §9 of this file.

## 9. First reading — `igris kpi --weeks 2` (read-only, 2026-08-27 07:35:41 UTC by the brain's clock)

Live brain at `~/.igris/memory/knowledge.db`; `agent_events` 296 rows
(2026-08-14 09:24:51 → 2026-08-27 07:00:53), 16 with a duration, the first
at 2026-08-26 16:57:03; `activity_floor` 2026-08-14. The two weeks are
2026-08-17→23 (complete) and 2026-08-24→30 (partial). Markdown as printed:

## OS KPIs (FR-268) — tz: UTC, weeks 2026-08-17 → 2026-08-30 (current week 2026-08-24 partial), project: all, generated 2026-08-27 07:35:41 UTC

### 1. Capacity — brain-bracket agent minutes per project per week
| project | week | agent_min | invocations | briefs |
|---|---|---|---|---|
| igris-ai | 2026-08-24 | 308 | 14 | 2 |
| mbrgea-ai | 2026-08-24 | 21 | 1 | 1 |
| moca-ai-agent | 2026-08-24 | 21 | 1 | 1 |

### 2. Throughput — Done per week / per active day
| project | week | done | active_days | done/active_day |
|---|---|---|---|---|
| fifty-content-pipeline | 2026-08-17 | 2 | 0 | — |
| igris-ai | 2026-08-17 | 13 | 2 | 6.50 |
| mbrgea-ai | 2026-08-17 | 12 | 2 | 6.00 |
| moca-ai-agent | 2026-08-17 | 14 | 0 | — |
| fifty-dev | 2026-08-24 | 4 | 0 | — |
| igris-ai | 2026-08-24 | 6 | 3 | 2.00 |
| mbrgea-ai | 2026-08-24 | 7 | 3 | 2.33 |
| moca-ai-agent | 2026-08-24 | 5 | 2 | 2.50 |

### 3. Effort mix of Done (XS+S share per project-week)
| project | week | effort | done | xs_s_share |
|---|---|---|---|---|
| fifty-content-pipeline | 2026-08-17 | S | 2 | 100% |
| igris-ai | 2026-08-17 | (none) | 3 | 23% |
| igris-ai | 2026-08-17 | L | 1 | 23% |
| igris-ai | 2026-08-17 | M | 5 | 23% |
| igris-ai | 2026-08-17 | S | 3 | 23% |
| igris-ai | 2026-08-17 | XL | 1 | 23% |
| mbrgea-ai | 2026-08-17 | L | 1 | 50% |
| mbrgea-ai | 2026-08-17 | M | 4 | 50% |
| mbrgea-ai | 2026-08-17 | S | 6 | 50% |
| mbrgea-ai | 2026-08-17 | XL | 1 | 50% |
| moca-ai-agent | 2026-08-17 | L | 1 | 43% |
| moca-ai-agent | 2026-08-17 | M | 7 | 43% |
| moca-ai-agent | 2026-08-17 | S | 6 | 43% |
| fifty-dev | 2026-08-24 | (none) | 4 | 0% |
| igris-ai | 2026-08-24 | L | 1 | 33% |
| igris-ai | 2026-08-24 | M | 3 | 33% |
| igris-ai | 2026-08-24 | S | 2 | 33% |
| mbrgea-ai | 2026-08-24 | (none) | 1 | 29% |
| mbrgea-ai | 2026-08-24 | L | 1 | 29% |
| mbrgea-ai | 2026-08-24 | M | 3 | 29% |
| mbrgea-ai | 2026-08-24 | S | 2 | 29% |
| moca-ai-agent | 2026-08-24 | (none) | 4 | 0% |
| moca-ai-agent | 2026-08-24 | M | 1 | 0% |

### 4. Minutes per hunt — median / p75, phase shares (week of the hunt's last row)
| project | week | hunts | median | p75 | architect | forger | sentinel | warden | mender | document |
|---|---|---|---|---|---|---|---|---|---|---|
| igris-ai | 2026-08-24 | 2 | 18.4 | 289.3 | 15% | 40% | 11% | 29% | 0% | 4% |
| mbrgea-ai | 2026-08-24 | 1 | 21.4 | 21.4 | 0% | 100% | 0% | 0% | 0% | 0% |
| moca-ai-agent | 2026-08-24 | 1 | 20.6 | 20.6 | 100% | 0% | 0% | 0% | 0% | 0% |

### 5. Rounds per hunt — resumed / retry rounds
| project | week | hunts | resumed | resumed_share | avg_extra_rounds |
|---|---|---|---|---|---|
| igris-ai | 2026-08-24 | 2 | 1 | 50% | 4.00 |
| mbrgea-ai | 2026-08-24 | 1 | 0 | 0% | 0.00 |
| moca-ai-agent | 2026-08-24 | 1 | 0 | 0% | 0.00 |

### 6. Model per role — per-invocation minutes (window), tool calls when reported
| agent | model_requested | n | median | p75 | tool_calls_median | tool_calls_n |
|---|---|---|---|---|---|---|
| architect | claude-opus-5 | 1 | 20.6 | 20.6 | — | 0 |
| architect | inherit:claude-fable-5 | 2 | 18.4 | 29.2 | — | 0 |
| document | inherit:claude-fable-5 | 1 | 13.2 | 13.2 | — | 0 |
| forger | inherit:claude-fable-5 | 4 | 28.8 | 34.4 | — | 0 |
| forger | opus | 1 | 21.4 | 21.4 | — | 0 |
| sentinel | inherit:claude-fable-5 | 3 | 10.5 | 14.8 | — | 0 |
| warden | inherit:claude-fable-5 | 4 | 15.0 | 18.6 | — | 0 |

### 7. Ceremony cost — runs, median / p75 minutes; coverage (unpaired goes red)
| project | ceremony | week | runs | median | p75 |
|---|---|---|---|---|---|
| igris-ai | boot | 2026-08-24 | 1 | 0.0 | 0.0 |

| project | ceremony | week | starts | stops | unpaired | unpaired_stops |
|---|---|---|---|---|---|---|
| igris-ai | boot | 2026-08-24 | 1 | 1 | 0 | 0 |

### Notes
- weeks are Monday–Sunday UTC; the operator's local clock is never used
- capacity is brain-bracket minutes (overshoots agent-active time by 1–6 min per invocation — FR-267 §7)
- Done date = brief_status.updated_at of a Done row (no completed-at column); a post-Done edit moves the brief's week
- a week that starts before the record's first activity day (activity_floor) reads NULL per active day — its denominator is not covered
- KPIs 1/4/5/6 read rows with a non-NULL duration_ms only (brain-timed since 2026-08-26); earlier weeks are empty for them, not zero
- the local series is per-machine: BOOT_SYNC_PULL_TABLES pulls neither event table; the VPS holds the union

`igris kpi --weeks 2 --json` (the same reading, as the machine surface — the
`weeks`, `alarm`, `skipped` and `notes` keys omitted here for length; `degraded: false`, `skipped: []`):

```json
{
 "generated_at": "2026-08-27 07:35:41",
 "since": "2026-08-17",
 "project": null,
 "activity_floor": "2026-08-14",
 "capacity": [
  {
   "project": "igris-ai",
   "week_start": "2026-08-24",
   "agent_minutes": 308,
   "invocations": 14,
   "briefs": 2
  },
  {
   "project": "mbrgea-ai",
   "week_start": "2026-08-24",
   "agent_minutes": 21,
   "invocations": 1,
   "briefs": 1
  },
  {
   "project": "moca-ai-agent",
   "week_start": "2026-08-24",
   "agent_minutes": 21,
   "invocations": 1,
   "briefs": 1
  }
 ],
 "throughput": [
  {
   "project": "fifty-content-pipeline",
   "week_start": "2026-08-17",
   "done": 2,
   "active_days": 0,
   "done_per_active_day": null
  },
  {
   "project": "igris-ai",
   "week_start": "2026-08-17",
   "done": 13,
   "active_days": 2,
   "done_per_active_day": 6.5
  },
  {
   "project": "mbrgea-ai",
   "week_start": "2026-08-17",
   "done": 12,
   "active_days": 2,
   "done_per_active_day": 6
  },
  {
   "project": "moca-ai-agent",
   "week_start": "2026-08-17",
   "done": 14,
   "active_days": 0,
   "done_per_active_day": null
  },
  {
   "project": "fifty-dev",
   "week_start": "2026-08-24",
   "done": 4,
   "active_days": 0,
   "done_per_active_day": null
  },
  {
   "project": "igris-ai",
   "week_start": "2026-08-24",
   "done": 6,
   "active_days": 3,
   "done_per_active_day": 2
  },
  {
   "project": "mbrgea-ai",
   "week_start": "2026-08-24",
   "done": 7,
   "active_days": 3,
   "done_per_active_day": 2.33
  },
  {
   "project": "moca-ai-agent",
   "week_start": "2026-08-24",
   "done": 5,
   "active_days": 2,
   "done_per_active_day": 2.5
  }
 ],
 "hunt_minutes": [
  {
   "project": "igris-ai",
   "week_start": "2026-08-24",
   "hunts": 2,
   "median_min": 18.4,
   "p75_min": 289.3,
   "architect_share": 0.15,
   "forger_share": 0.4,
   "sentinel_share": 0.11,
   "warden_share": 0.29,
   "mender_share": 0,
   "document_share": 0.04
  },
  {
   "project": "mbrgea-ai",
   "week_start": "2026-08-24",
   "hunts": 1,
   "median_min": 21.4,
   "p75_min": 21.4,
   "architect_share": 0,
   "forger_share": 1,
   "sentinel_share": 0,
   "warden_share": 0,
   "mender_share": 0,
   "document_share": 0
  },
  {
   "project": "moca-ai-agent",
   "week_start": "2026-08-24",
   "hunts": 1,
   "median_min": 20.6,
   "p75_min": 20.6,
   "architect_share": 1,
   "forger_share": 0,
   "sentinel_share": 0,
   "warden_share": 0,
   "mender_share": 0,
   "document_share": 0
  }
 ],
 "hunt_rounds": [
  {
   "project": "igris-ai",
   "week_start": "2026-08-24",
   "hunts": 2,
   "hunts_resumed": 1,
   "resumed_share": 0.5,
   "avg_extra_rounds": 4
  },
  {
   "project": "mbrgea-ai",
   "week_start": "2026-08-24",
   "hunts": 1,
   "hunts_resumed": 0,
   "resumed_share": 0,
   "avg_extra_rounds": 0
  },
  {
   "project": "moca-ai-agent",
   "week_start": "2026-08-24",
   "hunts": 1,
   "hunts_resumed": 0,
   "resumed_share": 0,
   "avg_extra_rounds": 0
  }
 ],
 "model_per_role": [
  {
   "agent": "architect",
   "model_requested": "claude-opus-5",
   "n": 1,
   "median_min": 20.6,
   "p75_min": 20.6,
   "tool_calls_median": null,
   "tool_calls_n": 0
  },
  {
   "agent": "architect",
   "model_requested": "inherit:claude-fable-5",
   "n": 2,
   "median_min": 18.4,
   "p75_min": 29.2,
   "tool_calls_median": null,
   "tool_calls_n": 0
  },
  {
   "agent": "document",
   "model_requested": "inherit:claude-fable-5",
   "n": 1,
   "median_min": 13.2,
   "p75_min": 13.2,
   "tool_calls_median": null,
   "tool_calls_n": 0
  },
  {
   "agent": "forger",
   "model_requested": "inherit:claude-fable-5",
   "n": 4,
   "median_min": 28.8,
   "p75_min": 34.4,
   "tool_calls_median": null,
   "tool_calls_n": 0
  },
  {
   "agent": "forger",
   "model_requested": "opus",
   "n": 1,
   "median_min": 21.4,
   "p75_min": 21.4,
   "tool_calls_median": null,
   "tool_calls_n": 0
  },
  {
   "agent": "sentinel",
   "model_requested": "inherit:claude-fable-5",
   "n": 3,
   "median_min": 10.5,
   "p75_min": 14.8,
   "tool_calls_median": null,
   "tool_calls_n": 0
  },
  {
   "agent": "warden",
   "model_requested": "inherit:claude-fable-5",
   "n": 4,
   "median_min": 15,
   "p75_min": 18.6,
   "tool_calls_median": null,
   "tool_calls_n": 0
  }
 ],
 "ceremony_cost": [
  {
   "project": "igris-ai",
   "ceremony": "boot",
   "week_start": "2026-08-24",
   "runs": 1,
   "median_min": 0,
   "p75_min": 0
  }
 ],
 "ceremony_coverage": [
  {
   "project": "igris-ai",
   "ceremony": "boot",
   "week_start": "2026-08-24",
   "starts": 1,
   "stops": 1,
   "unpaired": 0,
   "unpaired_stops": 0
  }
 ]
}
```

`igris kpi --project igris-ai --alarm` at the same reading:

```
KPI (UTC weeks 2026-08-10 → 2026-08-17): Done/active-day n/a → 6.5 (n/a) · hunt median n/a → n/a min (n/a) · no ceremonies · unpaired 0
```

(W0 = 2026-08-10 reads `n/a` by the floor rule; W1's `6.5` is over the
undercounted pre-gate denominator — §7. No flag can fire honestly before
2026-09-07.)

### Follow-up reading — due on or after 2026-09-07 UTC

_Append `igris kpi --weeks 1` and `igris kpi --project igris-ai --alarm --json` here, with the brain's `generated_at`._
