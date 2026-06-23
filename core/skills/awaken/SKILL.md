---
name: awaken
description: Start or resume session - loads state and continues work
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - mcp__igris-brain__igris_session_file_update
  - mcp__igris-brain__igris_coordination_config_get
  - mcp__igris-brain__igris_task_next
  - mcp__igris-brain__igris_agent_capability_list
  - mcp__igris-brain__igris_coordination_audit
  - mcp__igris-brain__igris_instance_remove
  - mcp__igris-brain__igris_brief_sync
  - mcp__igris-brain__igris_brief_create
  - mcp__igris-brain__igris_suggestion_list
  - mcp__igris-brain__igris_perception_review_pending
triggers:
  - "AWAKEN"
  - "ARISE"
  - "start session"
  - "resume session"
---

# AWAKEN - Start/Resume Session

Initialize Igris AI and resume any pending work.

## Execution

### 1. Load Context via Tree

Read `~/.igris/core/igris_tree.json` first — this is the **sole router** for what context to load.

1. Read `~/.igris/core/igris_tree.json`
2. Look up `tasks["/awaken"].load` to get the context file keys (e.g., `["igris_os", "soul", "coding_guidelines"]`)
3. For each key, resolve the file path from `context_files[key].path` (replace `{project}` with current project slug)
4. If `tasks["/awaken"].sections.igris_os` is set, use it to determine which sections to load:
   - `"ALL"` → read the entire file
   - Array (e.g., `["identity", "brief_protocol"]`) → read only those section ranges from `context_files.igris_os.sections`
5. Read all resolved files silently

**Always-needed files** (not in tree, needed for awaken mechanics):
- `~/.igris/USER.md` - User config (addressing mode, mask preference)
- `~/.igris/config.json` - Remote brain URL and API key

Do NOT hardcode context file paths — always derive them from the tree.

### 2. Load Session State — Gather

The session model is **per-instance** (see `session_protocol.md`): every instance owns one `session/instances/<instance_id>.md` file, keyed by its `instance_id`. There is no shared `CURRENT_SESSION.md`. `/awaken` does NOT read a single fixed file — it *gathers*: it enumerates the project's session files + the live instance registry, classifies each file (the Lock-2/3 truth table), and picks THE handoff. As of FR-195 the entire enumerate→classify→pick algorithm is OWNED by the `igris session gather` verb — the skill does not re-derive it.

Run the gather verb and read its JSON digest:
```bash
igris session gather --project <slug> [--self-instance-id <recovered-id>]
```
- `--self-instance-id` is OPTIONAL — pass it only if THIS harness can locate its own prior per-instance file (an `instance_id` persisted in the harness's working dir / `$CLAUDE_PROJECT_DIR` heuristics, the G4 chicken-and-egg). The common case omits it; the verb leaves `self_instance_id: null` and §3.7's heartbeat mints a fresh id. Gather is an *observer* — it never mints, never writes a session file (Lock-2 "nothing destructive in gather").
- The verb does ALL the classification: it enumerates `session_files` + the live `instances` registry, applies the Lock-2/3 truth table (LIVE SIBLING / ABANDONED LIVE / GENUINE HANDOFF), handles the FR-133 legacy `CURRENT_SESSION.md`-adoption fall-through, picks the newest GENUINE HANDOFF, and fetches content for THAT one only.

**The gather digest** (stdout JSON — read these fields):
```jsonc
{ "degraded": false,
  "handoff": {                  // null when fresh_start (no genuine handoff)
    "instance_id": "…|null",    // null for a legacy CURRENT_SESSION.md row
    "filename": "instances/<id>.md|CURRENT_SESSION.md",
    "mode": "REST MODE|null",   // the handoff file's **Mode:** line
    "resume_point": "…",        // feeds §5's resume display
    "next_steps": "…",          // seeds §3.7's LIVE file (resume carry-forward)
    "is_legacy": false },       // FR-133 legacy-adoption flag
  "self_instance_id": "…|null", // recovered (G4) else null → §3.7 mints
  "siblings":  [{ "instance_id": "…", "current_brief": "…|null", "last_active": "…" }],
  "crashed":   [{ "instance_id": "…", "last_active": "…", "scratchpad": "session/…" }],
  "fresh_start": false }        // true ⟺ handoff is null
```

**What the digest means for display (G5):**
- `handoff.resume_point` / `handoff.next_steps` → feed §5's resume display (only when `handoff.mode == "REST MODE"`; see §5).
- `siblings[]` → render a one-line-per-entry "Active siblings" list ("instance {short_id} on {current_brief}, last active {last_active}").
- `crashed[]` → render a one-line-per-entry "Crashed scratchpads" list ("instance {short_id} crashed mid-session — scratchpad at {scratchpad}"). This is the ABANDONED LIVE surface (§3.6.4 below is the same set — display only, NEVER destructive: no auto-archive, no ownership clear; Lock 1).
- `self_instance_id` → carry to §3.7 (recovered id to reuse, or null to mint).

All gather output is **display-only** — nothing destructive happens (the verb writes nothing to `session_files`; its only DB side-effect is the registry's own staleness maintenance, the same as the old `igris_instance_list` call).

**Degradation:** when the brain DB is absent the verb emits `{ "degraded": true, "fresh_start": true, "handoff": null, … }` and exits 0 — treat it as a fresh start (no resume). NEVER block session start on a degraded gather.

**Ordering contract:** gather MUST run BEFORE §3.7 register and BEFORE §3.8 housekeeping. The verbs are separate processes and do NOT enforce cross-process order — the skill's call sequence (gather → register → housekeeping) is the contract. H0's Lock-2 "the legacy row was provably read before it is archived" holds ONLY because this skill ran gather first.

### 3. Display Persona Greeting

Use the persona (from `soul`) and user config (from `USER.md`) already loaded in Step 1:
```
[PERSONA GREETING FROM soul context]

My capabilities:
- Brief management, session recovery, architecture enforcement
- Quality gates, protocol enforcement

Current mode: [mask level description from soul context]
```

### 3.5. Query Brain for Context (Optional)

If the `igris-brain` MCP server is available:
- Call `igris_memory_recall` with the current project slug and context="session start, current project priorities"
- Display any relevant cross-project learnings to the user
- Call `igris_project_register` to update `last_session_at` for this project
- Call `igris_session_recall` with days=2 to see recent cross-project activity
- If sessions returned, display a "Cross-Project Context" section:
  ```
  ### Cross-Project Context (last 48h)
  - project-a: Worked on BR-012 (auth fix), BUILDING phase
  - project-b: Completed FR-005 (dark mode)
  ```
- This gives a "welcome back" overview across all projects

If brain MCP is not available, skip this step silently. No errors, no warnings.

### 3.6. Sync with Remote Brain (boot-sync)

The entire VPS↔local sync — the brain row pull, the sync-queue drain, the session-file restore, and the definition refresh — is OWNED by the `igris boot-sync` verb (FR-195). It is the REMOTE channel: it drains the local `sync_queue.jsonl` (reusing the canonical atomic `sync data` primitive — FR-128 rename-then-process, crash recovery from stale `.draining-*` temps, per-entry strict-allow-list, `cache_path → content` resolution) AND pulls VPS→local rows over `GET /sync/pull`, merging them last-write-wins into the LOCAL brain DB. `session_files` and `definition_files` ride that same pull — there is no separate endpoint for them. Do NOT inline any of this in markdown — the atomicity + directionality contracts cannot be enforced from a skill recipe; the single CLI code path is the contract.

Run the boot-sync verb and read its JSON digest:
```bash
igris boot-sync --project <slug>
```

**The boot-sync digest** (stdout JSON — read these fields):
```jsonc
{ "degraded": false,                              // true ⟺ remote unconfigured
  "brain_pull":  { "ok": true, "summary": "5 learnings, 2 errors" },
  "queue_drain": { "ok": true, "drained": 3 },
  "session_files_pulled": 2,                       // session_files rows merged from the pull
  "definitions_updated": { "agents": 1, "skills": 0, "rules": 2, "prompts": 0 },
  "skipped": [] }                                  // one-line reasons any part was skipped
```

**Display from the digest:**
- `brain_pull.summary` → "Pulled {summary} from remote brain" (when `brain_pull.ok`).
- `queue_drain.drained` → "Drained {n} queued sync op(s)" (when `> 0`).
- `session_files_pulled` / `definitions_updated` → optional one-line restore/refresh summary.
- `skipped[]` → surface each as a one-line notice (e.g. "Brain pull skipped (remote unconfigured)").

**Degradation:** the verb ALWAYS exits 0 and NEVER blocks session start. When `degraded: true` (remote unconfigured) or any part fails (`ok: false`, recorded in `skipped[]`), display the one-line notice and continue — a missing/unreachable remote is a local-only run, not an error. Each part is independent: a failed pull does not abort the drain or vice-versa.

> **What replaced what (FR-195):** boot-sync subsumes the former §3.6 (`igris_brain_pull`), §3.6.1 (`igris_sync_queue_drain`), §3.6.1.1 (`igris sync data` local drain), §3.6.2 (`igris_session_file_pull`), and §3.6.3 (`igris_definition_pull`) — five separate MCP/CLI calls collapsed into one verb. The `_pull` (VPS→local restore) vs `_list` (state-aware local enumerate) distinction that mattered when the skill called both is now internal: §2 gather owns the `_list` side (classification); §3.6 boot-sync owns the `_pull` side (restore). They no longer share a call site to conflate.

### 3.6.4. Surface Stale Previous Instances (Mandatory)

Per Lock 1, heartbeat is **display-only** and NOTHING auto-destroys a stale instance. This section is a *display* of genuine crashes — it does NOT remove anything.

A clean `/rest` → `/awaken` cycle leaves nothing stale: `/rest` already calls `igris_instance_remove` in its §2.5 "Close Instance Ownership" step, so the prior instance is gone from the registry by the time `/awaken` runs. What this section surfaces is the *genuine crash* case — an instance that exited without `/rest`.

This is purely a display of the `crashed[]` list the §2 `igris session gather` digest ALREADY computed (the ABANDONED LIVE set — `state='live'` with an absent/stale owner). No new tool call is needed; the verb did the classification.

- For each entry in `gather.crashed[]`, surface it: "stale, unconfirmed — instance {short_id}, last active {last_active}; scratchpad at {scratchpad}".
- Do NOT call `igris_instance_remove`. Do NOT auto-archive its file. Do NOT clear its `current_brief`. Reclaim is an explicit operator action — never automatic.

If `gather` was degraded (empty `crashed[]`), render nothing. Do NOT block session start.

This is a read of genuine crashes, not a destructive sweep. Multi-instance is valid; a live sibling is left alone (it shows in the §2 "Active siblings" list from `gather.siblings[]`, not here).

### 3.7. Register Instance (Mandatory)

Registration — the heartbeat upsert + the LIVE per-instance file write — is OWNED by the `igris session register` verb (FR-195). It mints-or-recovers the `instance_id`, writes the heartbeat row, and writes `session/instances/<id>.md` at `state='live'` with the contract line shape (`**Instance ID:**`, `**Mode:** Active`, `**Active Brief:**`) that the phase-guard fallback and `/hunt` parse. It seeds the LIVE file's "Next Steps" from gather's chosen handoff so the resume context carries forward.

Run the register verb AFTER §2 gather (the ordering contract — gather's outputs feed register):
```bash
igris session register --project <slug> \
  [--self-instance-id <gather.self_instance_id>] \
  [--project-path <abs-project-dir>] \
  [--seed-next-steps "<gather.handoff.next_steps>"]
```
- `--self-instance-id` — pass `gather.self_instance_id` when it was recovered (non-null); OMIT it to mint a fresh UUID. (This is the G4 recover-or-mint decision, now resolved by gather + register together.)
- `--seed-next-steps` — pass `gather.handoff.next_steps` when gather selected a genuine handoff (the resume carry-forward, §3.7 step 2c). Omit on a fresh start.
- `--project-path` — the absolute project directory (the heartbeat's `project_path` field).

**The register digest** (stdout JSON — read these fields):
```jsonc
{ "degraded": false,
  "instance_id": "…",                  // recovered or freshly minted
  "minted": true,                       // false ⟺ an existing id was recovered+refreshed
  "live_file": "instances/<id>.md",     // relative to the project session dir
  "seeded_from_handoff": true }         // true ⟺ Next Steps were carried from gather's handoff
```

- Display: "Instance registered: {instance_id}".
- Carry `instance_id` forward — it is used for subsequent heartbeats (`/hunt`) and the ownership-close on `/rest`, and it is the `<instance_id>` §7 confirms the LIVE file for.
- The register verb is non-destructive (#230): a re-run of a recovered instance PRESERVES the existing on-disk LIVE file (it does not clobber the running instance's scratchpad back to a skeleton).

**Degradation:** when the brain DB is absent the verb emits `{ "degraded": true, … }` and exits 0 — display "Instance registration skipped (brain unavailable)" and continue. NEVER block session start.

### 3.8. Housekeeping Sweep (Mandatory)

The crash-robust, idempotent archive sweep (H0–H3) is OWNED by the `igris housekeeping` verb (FR-195). It is NOT a daemon, NOT scheduled — it runs once per `/awaken`, AFTER gather (§2) and AFTER registration (§3.7), BEFORE the assessment surfaces (§4). The verb's H0–H3 are individually crash-robust and idempotent; running it twice is harmless and a crash mid-sweep leaves a consistent state (Lock 4 — `session_protocol.md` §5). The header-presence guard (idempotency) and per-file append-then-delete (crash-robustness) are the exact atomicity contracts that "cannot be enforced from a skill recipe" — which is why this is CODE, not inline markdown.

Run the housekeeping verb (the ordering contract requires it AFTER gather + register):
```bash
igris housekeeping --project <slug>
```

What the verb does (faithful to the prior inline H0–H3):
- **H0** — retire the legacy `CURRENT_SESSION.md` row (`instance_id IS NULL`) that gather provably read this `/awaken`: flip its DB state to `archived` (content carried through unchanged, instance_id untouched) and move `session/CURRENT_SESSION.md` → `session/archive/CURRENT_SESSION-<updated_at>.md`. The Lock-2 "read-before-archive" invariant holds because the skill ran gather FIRST (the ordering contract).
- **H1** — RESTED → ARCHIVED supersession (the ONLY steady-state archiving): a `rested` file is archived only when a *newer* `rested` file from a *different* instance proves it was consumed. An ABANDONED LIVE file is NEVER archived here.
- **H2** — roll individual `session/archive/*.md` files older than 30 days into `session/archive/<YYYY-MM>.md` month digests (header-guarded, append-then-delete).
- **H3** — 150-file ceiling burst valve: if >150 individual files remain after H2, roll oldest-first into month digests until ≤150.

**The housekeeping digest** (stdout JSON — read these fields):
```jsonc
{ "degraded": false,
  "h0_legacy_retired": false,           // true ⟺ the legacy CURRENT_SESSION.md was retired this run
  "h1_archived": ["<id>-<ts>.md"],      // archive filenames produced by the supersession step
  "h2_rolled": 4,                        // individual files folded by the 30-day roll
  "h3_ceiling_rolled": 0,                // individual files folded by the 150-ceiling valve
  "noop": false }                        // true ⟺ nothing was touched (the common fresh-archive case)
```

- Display only when something happened: e.g. "Archived {h1_archived.length} superseded session(s); rolled {h2_rolled} into month digests." When `noop: true`, render nothing.

**Cost guard (preserved):** the verb touches ONLY `session/archive/` + the RESTED set + the one legacy row — NEVER LIVE files, NEVER the brief DB, NEVER the VPS. A fresh install with an empty archive is one list query + an empty dir read; `noop: true`.

**Degradation:** when the brain DB is absent the verb emits `{ "degraded": true, "noop": true, … }` and exits 0 — there are no session files to sweep on a fresh start. NEVER block session start.

### 4. Perform System Assessment

The MINIMAL system-assessment surface — brief-status summary + active blockers + git snapshot + active-instance count + upcoming goals — is OWNED by the `igris assess` verb (FR-195, decision D-A). It does the brief-dashboard summary SQL, reads `session/BLOCKERS.md`, runs `git status`, counts live instances, and lists goals due within 14 days. It DELIBERATELY OMITS the task queue (§4.5), suggestions (§4.8), and perception pending (§4.9) — those re-introduce ceremony noise and stay as the skill's own surfaces below; assess does not cover them.

Run the assess verb and render from its JSON digest:
```bash
igris assess --project <slug>
```

**The assess digest** (stdout JSON — read these fields):
```jsonc
{ "degraded": false,
  "briefs": { "total": 42, "by_status": { "Ready": 8, … }, "by_priority": { "P0": 1, … } },
  "blockers": ["…"],                          // active blockers from session/BLOCKERS.md
  "git": { "branch": "develop", "dirty": true, "ahead": 0 },
  "active_instances": 3,
  "goals_upcoming": [{ "goal_id": "GL-003", "title": "…", "deadline": "2026-05-01", "priority": "P1" }] }
```

Render the assessment from the digest:
- `briefs.by_status` / `briefs.by_priority` → identify Ready briefs to work on (feeds §6 recommendations); show the aggregate counts.
- `blockers[]` → surface active blockers (if any).
- `git` → "On {branch}{, dirty}{, ahead N}".
- `active_instances` → "Active Instances: {n}".
- `goals_upcoming[]` → see §4.7 (the goals surface is now part of this digest).

**Degradation:** when the brain DB is absent the verb emits `{ "degraded": true, "briefs": {total:0,…}, "goals_upcoming": [], "active_instances": 0, … }` and exits 0 — it STILL reads `blockers` + `git` (those do not need the DB). NEVER block session start.

### 4.5. Show Work Queue and Coordination Status (Optional)

If the `igris-brain` MCP server is available:

1. Call `igris_coordination_config_get` to check autonomous mode status
2. Call `igris_task_next` (no agent filter) to peek at the top pending task
3. Call `igris_task_list` with status="pending" and limit=5 to show the work queue
4. Display a work queue summary:

```
### Work Queue
| Task | Priority | Type | Due |
|------|----------|------|-----|
| t-abc123: Fix auth flow | P1 | brief | 2026-02-26 |
| t-def456: Update docs | P3 | operational | -- |

Autonomous Mode: [Enabled/Disabled]
Self-Healing: [Enabled/Disabled]
```

If brain MCP is NOT available or calls fail, skip silently. Do NOT block session start.

### 4.7. Goals Approaching Deadline (FR-110)

The upcoming-goals surface is now part of the §4 `igris assess` digest (`goals_upcoming[]` — active goals with a deadline within 14 days). Do NOT make a separate goal call; render from the digest.

For each entry in `assess.goals_upcoming[]`, render:

```
## Goals approaching deadline
- GL-003 "Ship v6.1" — due 2026-05-01 (P1)
- GL-001 "Compliance audit" — due 2026-05-12 (P1)
```

Each entry carries `goal_id` / `title` / `deadline` / `priority`. (The prior "N briefs serving" sub-line is dropped — the assess digest is the MINIMAL D-A surface and does not carry `serving_briefs_count`; run `/scan` for full goal progress.)

If `goals_upcoming[]` is empty, render nothing — no "No goals" line. Token budget: ~120 tokens.

### 4.8. Subconscious Suggestions (FR-106)

> **TD-102 (V7):** This entire section is gated behind the `subconscious.enabled`
> config flag, which defaults to `false` for V7. The rule-based engine had a
> 2% true-positive rate; the redesign is tracked under FR-118 (V7.1 headline).
> Re-enable is just a flag flip — no schedule re-bootstrap needed.

Read `~/.igris/config.json` and check `subconscious.enabled`. If the key is
absent, treat as `false`. If `false`, skip this section silently — render
nothing, do not call any suggestion MCP tools, do not surface a "disabled"
notice. Resume reading at §4.9.

If `igris-brain` MCP is available, call `igris_suggestion_list` with:
- `status` = `'pending'`
- `project_slug` = current project slug
- `limit` = `3`

Token budget: bounded to <=3 rows by `limit`. Render at most ~120 tokens.

If results are returned, render:

```
## Suggestions ({total} pending)
- [{priority}] {title} ({source_module})
- [{priority}] {title} ({source_module})
- [{priority}] {title} ({source_module})
```

Use the `total` count from the response (may exceed `limit`) so the user
knows how many are queued in total. Format each row as:
`- [{priority}] {title} ({source_module})` — keep it terse; the user can
run `igris_suggestion_list` directly for full details.

If zero results, render nothing — no "No suggestions" line. If the tool
is unavailable (older brain), skip silently.

### 4.9. Pending Perception Candidates (FR-109 / TD-066)

Extraction happens in a detached background process at session-end (spawned
by `session_end.sh` / `pre_compact.sh` via `perception_extract_and_persist.sh`).
This section is purely a SELECT — it surfaces whatever the background process
has committed since the last awaken. /awaken does NOT drain any inbox.

#### Pre-step (TD-074, TD-080): perception failure WARNING

Before rendering pending candidates, query the latest perception lifecycle
event so a recent failure surfaces prominently. **TD-080 fix (Gap A):** read
directly from the local DB via `sqlite3` (NOT via `igris_event_log` MCP) so
this machine's local-only events surface here. The MCP tool routes to the
remote brain, which misses any perception runs that happened on this machine
since the last `/rest`. Post-§3.6 pull, the local DB is the merged superset.

Run (substitute `$PROJECT_SLUG` for the current project slug):
```bash
# Defense-in-depth (TD-080 Q-3): refuse to interpolate if slug doesn't match
# the registered slug shape. Belt-and-suspenders against any future code path
# that broadens slug sourcing (e.g., env var override). Same posture as the
# other defensive guards in this section — skip silently if the slug came
# from an unexpected source.
if [[ ! "$PROJECT_SLUG" =~ ^[a-z0-9_-]+$ ]]; then
  return 0  # do not surface this section this run
fi

sqlite3 "$HOME/.igris/memory/knowledge.db" \
  "SELECT created_at, event_name, json_extract(payload, '\$.reason') AS reason
   FROM event_log
   WHERE component = 'perception' AND project_slug = '$PROJECT_SLUG'
   ORDER BY created_at DESC LIMIT 1;"
```

If the latest row's `event_name` is `'perception.run_failed'` AND no later
`'perception.run_succeeded'` row exists for the same project (defensive
follow-up to confirm the failure has not self-recovered), prepend a single
WARNING block before the pending list. Otherwise, render no warning and
proceed to the pending list as normal.

The defensive "no later success" check (substitute the failed row's
`created_at`):
```bash
# Defense-in-depth (TD-080 Q-3): refuse to interpolate if slug doesn't match
# the registered slug shape.
if [[ ! "$PROJECT_SLUG" =~ ^[a-z0-9_-]+$ ]]; then
  return 0
fi

sqlite3 "$HOME/.igris/memory/knowledge.db" \
  "SELECT COUNT(*) FROM event_log
   WHERE component = 'perception' AND project_slug = '$PROJECT_SLUG'
     AND event_name = 'perception.run_succeeded'
     AND created_at > '<failed_row_created_at>';"
```

A return of `0` confirms the failure is the latest terminal state.

**Defensive guards (TD-080):**
- Wrap each `sqlite3` invocation with a `command -v sqlite3 >/dev/null 2>&1`
  pre-check. If sqlite3 is absent on this machine, skip the WARNING silently.
- If the DB file is missing or the query errors, skip the WARNING silently.
  The `2>/dev/null || true` shell pattern absorbs both cases.

```
## Perception WARNING
Latest extraction FAILED at 2026-05-01 04:22 (reason: epipe_on_llm_stdin).
Recent session transcripts may not have produced learnings.
Investigate: tail ~/.igris/projects/{project}/session/perception_extract.log
```

Suppression rules (do NOT render the WARNING when):
- Latest event is `'perception.run_skipped'` — skipping is normal (60s
  min-window, bytes gate, disabled gate).
- Latest event is `'perception.run_started'` with no terminal event yet
  (in-flight run; /scan handles the "stuck RUNNING" surface).
- A `'perception.run_succeeded'` row exists with `created_at` newer than
  the failed row.

Token budget for the WARNING block: ~80 tokens. The pending list below
remains unchanged in budget (~150 tokens). Total §4.9 upper bound: ~230 tokens.

If `sqlite3` is unavailable or the DB file is missing, skip the WARNING silently.

#### Pending list

**TD-080 fix (Gap A):** read directly from the local DB via `sqlite3` (NOT
via `igris_perception_review_pending` MCP). Same rationale as the WARNING
above — local-only pending rows from this machine's recent extractions are
invisible to the remote-routed MCP tool. Post-§3.6 pull, the local DB is the
merged superset.

Run (substitute `$PROJECT_SLUG`):
```bash
# Defense-in-depth (TD-080 Q-3): refuse to interpolate if slug doesn't match
# the registered slug shape.
if [[ ! "$PROJECT_SLUG" =~ ^[a-z0-9_-]+$ ]]; then
  return 0
fi

sqlite3 "$HOME/.igris/memory/knowledge.db" \
  "SELECT title, source_extractor, confidence
   FROM learnings
   WHERE project = '$PROJECT_SLUG' AND review_status = 'pending_review'
   ORDER BY created_at DESC LIMIT 5;"

sqlite3 "$HOME/.igris/memory/knowledge.db" \
  "SELECT COUNT(*) FROM learnings
   WHERE project = '$PROJECT_SLUG' AND review_status = 'pending_review';"
```

The first query returns the top 5 pending rows for the rendered list. The
second returns the total count (matches the `total` field the MCP tool used
to provide). Token budget: bounded to <=5 rows. Render at most ~150 tokens.

If results are returned, render:

```
## Pending Learnings ({total} pending review)
- [{source_extractor}, conf {confidence}] {title}
- [{source_extractor}, conf {confidence}] {title}
```

Use the `total` count from the response (may exceed `limit`) so the user
knows the queue depth. The `source_extractor` field values are typically
`llm` (from background extraction) or `manual` (from direct memory_store
calls). Legacy rows from pre-TD-066 extractions may render as
`rule:learned_marker`, `rule:retry_chain`, `rule:blocker_resolution`, or
`rule:error_fingerprint` — these are read-side compatible and surface
verbatim. Show `approve` and `reject` MCP tools as next-step hints once per
session, not per row.

If zero results, render nothing — no "No pending" line. If `sqlite3` is
unavailable or the DB file is missing, skip silently (same defensive guards
as the WARNING block above).

If `auto_approve_enabled=true` is set in `~/.igris/config.json`'s `perception`
section, the background extractor inserts new rows as `approved` directly
and they bypass this surface — they appear in `recall`/`search` immediately
without operator review. Default is opt-in (off).

### 5. Display Resume Point (if resuming)

If the §2 `igris session gather` digest selected a genuine handoff with `handoff.mode == "REST MODE"`, display its resume point from the digest fields — `handoff.resume_point` and `handoff.next_steps` (the verb parsed these from the chosen handoff file's content), NOT from any fixed `CURRENT_SESSION.md`:
```
## Resuming Session

**Last Active:** [brief ID — from handoff.resume_point]
**Phase:** [phase — from handoff.resume_point]
**Next Steps:** [handoff.next_steps]
```

If `gather.fresh_start` is true (`handoff` is null), this is a fresh start — skip the resume display. (A legacy `CURRENT_SESSION.md` handoff with `is_legacy: true` is displayed identically — the resume is invisible to the user, exactly as pre-FR-126 `/awaken` read it.)

### 6. Display Recommendations

```
## Recommended Actions

1. [Primary - resume current or start highest priority]
2. [Secondary - show status or review briefs]
3. [Tertiary - other relevant action]
```

### 7. Update Session

`igris session register` (§3.7) already wrote this instance's LIVE per-instance file `~/.igris/projects/{project}/session/instances/<instance_id>.md` at `state='live'` (where `<instance_id>` is `register.instance_id` from the §3.7 digest), seeded from the handoff. §7 is the end-of-awaken confirm/refresh of THAT file — if the awakening surfaced anything that should land in the LIVE scratchpad (or once a hunt starts and `**Mode:**` flips to `HUNT MODE`), update it directly via `igris_session_file_update` with `project`, `filename=instances/<instance_id>.md`, `content`, `instance_id=<instance_id>`, `state='live'`. On a plain awaken with no further edits the register write already stands — no extra write is required.

The per-instance file replaces the old single `CURRENT_SESSION.md`. There is no Mode flip on a shared file; each instance owns and writes its own file freely.

Display: "Igris AI initialized. System ready."
