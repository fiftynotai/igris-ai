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
  - mcp__igris-brain__igris_brief_dashboard
  - mcp__igris-brain__igris_session_file_get
  - mcp__igris-brain__igris_session_file_update
  - mcp__igris-brain__igris_session_file_list
  - mcp__igris-brain__igris_coordination_config_get
  - mcp__igris-brain__igris_task_next
  - mcp__igris-brain__igris_agent_capability_list
  - mcp__igris-brain__igris_coordination_audit
  - mcp__igris-brain__igris_instance_heartbeat
  - mcp__igris-brain__igris_instance_remove
  - mcp__igris-brain__igris_instance_list
  - mcp__igris-brain__igris_brief_sync
  - mcp__igris-brain__igris_brief_create
  - mcp__igris-brain__igris_goal_list
  - mcp__igris-brain__igris_suggestion_list
  - mcp__igris-brain__igris_event_log
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

### 0. Track Invocation
Silently emit a skill invocation event (never blocks execution):
```bash
bash "$CLAUDE_PROJECT_DIR/scripts/emit_skill_event.sh" "awaken" 2>/dev/null || true
```

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

The session model is **per-instance** (see `session_protocol.md`): every instance owns one `session/instances/<instance_id>.md` file, keyed by its `instance_id`. There is no shared `CURRENT_SESSION.md`. `/awaken` does NOT read a single fixed file — it *gathers*: it enumerates the project's session files + the live instance registry, classifies each file, and picks THE handoff.

At gather time the current harness has NOT yet minted its own `instance_id` (that happens in §3.7). Gather runs as an *observer* against the registry + file list first; §3.7 mints the id afterward.

**Step G1 — enumerate.** If the `igris-brain` MCP server is available:
- Call `igris_session_file_list` with `project=<slug>` and NO `state` filter (we want all files). Returns `filename` / `instance_id` / `state` / `content_hash` / `updated_at` per file — metadata only, no content.
- Call `igris_instance_list` with `status='active'` and `project=<slug>`. Returns the live registry rows (`instance_id`, `current_brief`, `last_active`, staleness).

If brain MCP is unavailable, skip gather and treat this as a fresh start (no resume) — do NOT block session start.

**Step G2 — classify each session file row.** For each row from `igris_session_file_list`, classify it against the live registry:

| `state` | Owning `instance_id` is in the active registry, non-stale, and NOT self | Owning instance is absent OR stale |
|---------|------------------------------------------------------------------------|------------------------------------|
| `live`  | **LIVE SIBLING** — belongs to a running sibling. Do NOT read as a handoff. Display "instance X is on BR-Y, last active T." | **ABANDONED LIVE** — instance crashed before `/rest`. Surface it ("instance X crashed mid-session — scratchpad at <path>"). NEVER consume as a handoff. NEVER auto-archive. NEVER auto-clear ownership. |
| `rested`| A still-live instance with a rested file is unusual — treat as a completed handoff its author has not yet re-awakened over. Eligible as a handoff. | **GENUINE HANDOFF** — eligible to be read as the resume context. |
| `archived`| ignore — already consumed and superseded | ignore |

> *Legacy adoption (FR-133): a `session_files` row with `filename='CURRENT_SESSION.md'` and `instance_id IS NULL` is a pre-FR-126 project. FR-133's adoption path classifies it as a genuine handoff and converts it on first read. Until FR-133 lands, such a row is still classified as a genuine handoff by the rule above (a `rested`-or-legacy file with no live owner), so a pre-migration project still resumes correctly — FR-133 only adds the explicit one-time conversion-and-archive of the legacy file.*

**Step G3 — pick the handoff.** Among rows classified GENUINE HANDOFF, select the one with the most-recent `updated_at` — that is THE handoff. Call `igris_session_file_get` on it (only now do we fetch content). If zero genuine-handoff rows → this is a fresh start (no resume). If exactly one → this is the sequential-degeneration common case, byte-equivalent to today's "read CURRENT_SESSION.md."

**Step G4 — recover or mint the instance_id (the chicken-and-egg).** If the current harness can locate its own prior per-instance file (an `instance_id` persisted in the harness's working dir / `$CLAUDE_PROJECT_DIR` heuristics), recover that id and read `session/instances/<that-id>.md` as its own LIVE scratchpad — this is a resume of an existing instance. Otherwise — the common case — leave the id pending: §3.7 will let `igris_instance_heartbeat` mint a fresh one. Gather does not depend on knowing self's id: G2 classifies by "is this row's instance in the live registry," and self is not yet registered, so every row is correctly a sibling/handoff/abandoned relative to a not-yet-registered self.

**Step G5 — display.** Render:
- the chosen handoff's resume point (feeds §5);
- a one-line-per-sibling "Active siblings" list;
- a one-line-per-abandoned-LIVE "Crashed scratchpads" list (if any).

All G5 output is display-only. Nothing destructive happens in gather.

**Gather output:** (a) the handoff file's content for §5's resume display, (b) the sibling/abandoned lists for display, (c) the recovered-or-pending `instance_id` decision for §3.7. If the gather found a genuine handoff with `Mode: REST MODE` → this is a resume. If zero handoffs → fresh start.

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

### 3.6. Pull from Remote Brain (Mandatory)

You MUST call `igris_brain_pull` when remote brain is configured. This is NOT optional — the VPS brain depends on receiving data.

If the `igris-brain` MCP server is available AND a remote brain URL is configured:
- Read `~/.igris/config.json` to check for `remote_brain.url` and `remote_brain.api_key`
- If both are present, call `igris_brain_pull` with:
  - remote_url = the configured URL
  - api_key = the configured API key
- Display sync result summary (e.g., "Pulled 5 learnings, 2 errors from remote brain")

If remote brain is not configured or pull fails, skip with one-line notice: "Brain pull skipped ([reason])." Do NOT block session start.

### 3.6.1. Drain Sync Queue (Mandatory)

You MUST drain the sync queue when remote brain is configured. This is NOT optional.

If the `igris-brain` MCP server is available:
1. Call `igris_sync_queue_drain` to process any queued operations from previous failed pushes
2. Display count of drained operations if any were processed

If brain MCP is NOT available or drain fails, skip silently. Do NOT block session start.

### 3.6.1.1. Drain Local Sync Queue (Mandatory)

You MUST drain the local sync queue file when brain MCP is available. This is NOT optional — briefs queued during previous MCP outages depend on this.

If the `igris-brain` MCP server is available:
1. Check if `~/.igris/projects/{project}/sync_queue.jsonl` exists
2. If it exists and has entries:
   a. Read each JSON line
   b. For each entry, call the appropriate MCP tool based on the `operation` field:
      - `"brief_sync"` -> call `igris_brief_sync` with the stored parameters
      - `"brief_create"` -> call `igris_brief_create` with the stored parameters (read content from `cache_path` if present)
   c. On success: remove the processed line from the file
   d. On failure: leave the line in the file for next attempt
   e. Display summary: `Drained X of Y local sync queue entries`
3. If all entries processed successfully, delete the queue file
4. If some entries failed, display: `WARNING: {N} sync queue entries could not be processed — will retry on next /awaken or /sync data`

If brain MCP is NOT available:
- Check if `~/.igris/projects/{project}/sync_queue.jsonl` exists and has entries
- If yes, display: `WARNING: {N} brief sync(s) are queued locally — brain MCP unavailable. Will retry on next /awaken or /sync data.`
- Do NOT block session start.

### 3.6.2. Pull Session Files (Mandatory)

You MUST pull session files when remote brain is configured. This is NOT optional.

If the `igris-brain` MCP server is available:
1. Call `igris_session_file_pull` to restore session files from VPS if local is empty or stale
2. Compare local file hashes with remote — only pull if remote is newer
3. Session files to sync: `session/instances/*.md` (per-instance session files), LEARNINGS.md, DECISIONS.md, BLOCKERS.md
4. Display summary of files pulled (e.g., "Pulled 2 session files from remote brain")

> **`_pull` vs `_list`:** `igris_session_file_pull` is the **sync-component** tool — a VPS→local bulk restore that returns file *content*, used here when local is empty or stale. It is NOT the per-instance, state-aware gather tool. The §2 gather step uses `igris_session_file_list` — a local, state-aware enumeration that returns *metadata only* and classifies files by `state`. They are complementary: `_pull` restores, `_list` classifies. Do not conflate them.

If brain MCP is NOT available or pull fails, skip silently. Do NOT block session start.

### 3.6.3. Pull Latest Definitions (Mandatory)

You MUST pull latest definitions when remote brain is configured. This is NOT optional.

If the `igris-brain` MCP server is available:
1. Call `igris_definition_pull` to check for newer agent, skill, rule, and prompt definitions
2. Only update local files if remote content hash differs
3. Display summary of definitions updated (e.g., "Updated 1 agent, 2 rules from remote brain")

If brain MCP is NOT available or pull fails, skip silently. Do NOT block session start.

### 3.6.4. Surface Stale Previous Instances (Mandatory)

Per Lock 1, heartbeat is **display-only** and NOTHING auto-destroys a stale instance. This section is a *display* of genuine crashes — it does NOT remove anything.

A clean `/rest` → `/awaken` cycle leaves nothing stale: `/rest` already calls `igris_instance_remove` in its §2.5 "Close Instance Ownership" step, so the prior instance is gone from the registry by the time `/awaken` runs. What this section surfaces is the *genuine crash* case — an instance that exited without `/rest`.

If the `igris-brain` MCP server is available:
1. From the §2 gather step, you already have the `igris_instance_list` rows and the classified session-file rows.
2. For any prior instance owned by *this* harness (or any instance classified ABANDONED LIVE in G2), surface it: "stale, unconfirmed — instance {short_id}, last active {last_active}; scratchpad at session/instances/{instance_id}.md".
3. Do NOT call `igris_instance_remove`. Do NOT auto-archive its file. Do NOT clear its `current_brief`. Reclaim is an explicit operator action — never automatic.

If brain MCP is NOT available, skip silently. Do NOT block session start.

This is a registry-visible read of genuine crashes, not a destructive sweep. Multi-instance is valid; a live sibling is left alone (it shows in the §2 "Active siblings" list, not here).

### 3.7. Register Instance (Mandatory)

You MUST call `igris_instance_heartbeat` to register this session as a live instance. This is NOT optional — the VPS dashboard depends on it.

If the `igris-brain` MCP server is available:
1. If gather (§2 step G4) recovered an existing `instance_id` for this harness, reuse it — pass it as `instance_id` to `igris_instance_heartbeat` to refresh the existing row. Otherwise call `igris_instance_heartbeat` WITHOUT an `instance_id` to mint a fresh one. In both cases pass:
   - machine_hostname = system hostname
   - machine_os = platform (e.g., "darwin", "linux")
   - project_slug = current project slug
   - project_path = absolute path to project directory
2. Take the resulting `instance_id` (recovered or freshly minted). Write the new LIVE per-instance session file `~/.igris/projects/{project}/session/instances/<instance_id>.md` at `state='live'`:
   a. Create the file on disk with the Status section carrying `**Instance ID:** {instance_id}` and `**Mode:** Active` (or `HUNT MODE` once a hunt starts — see §7).
   b. Call `igris_session_file_update` with `project` = current project slug, `filename` = `instances/<instance_id>.md`, `content` = the file content, `instance_id` = `<instance_id>`, `state` = `'live'`.
   c. If gather selected a genuine handoff (§2 G3), seed this LIVE file's "Next Steps" / context from that handoff's content so the resume context carries forward.
3. Display: "Instance registered: {instance_id}"
4. This ID is used for subsequent heartbeats (`/hunt`) and the ownership-close on `/rest`.

If brain MCP is NOT available (tool call fails or MCP server not registered), skip gracefully with a one-line notice: "Instance registration skipped (brain MCP unavailable)." Do NOT block session start.

### 3.8. Housekeeping Sweep (Mandatory)

A crash-robust, idempotent archive sweep folded into `/awaken` — NOT a daemon, NOT scheduled. It runs once per `/awaken`, after gather (§2) and after registration (§3.7), before the assessment surfaces (§4). Running it twice is harmless; a crash mid-sweep leaves a consistent state. (Lock 4 — `session_protocol.md` §5.)

If the `igris-brain` MCP server is unavailable, skip this section silently. Do NOT block session start.

**Step H1 — RESTED → ARCHIVED supersession.** This is the ONLY place archiving happens. Per Lock 2, a RESTED file is archived by *whoever superseded it*, after the superseding instance has produced its own RESTED file. Using the `igris_session_file_list` rows from §2 gather:
- For each `state='rested'` file R, check whether a *newer* `state='rested'` file exists from a *different* `instance_id`. If so, R has been provably consumed (a newer RESTED file only exists because some instance awoke — read R — and then rested).
- For each such superseded R: call `igris_session_file_update` with R's `filename`, `instance_id`, and `state='archived'`; then move the on-disk file from `session/instances/<instance_id>.md` to `session/archive/<instance_id>-<rested_at>.md` (where `<rested_at>` is R's rest timestamp, from `updated_at`).
- This guarantees the Lock-2 invariant "a file is ALWAYS read before it is archived."
- An ABANDONED LIVE file is NEVER archived by this step — it has no superseding RESTED file. It is compacted only by the H2 30-day roll.

**Step H2 — 30-day digest roll.** Enumerate the *individual* files in `session/archive/*.md` (NOT the `YYYY-MM.md` digests). For any individual file whose timestamp (`<rested_at>` from the filename suffix, or `updated_at`) is older than 30 days:
- Append its content — preceded by a `\n\n## <filename>\n` separator header — to `session/archive/<YYYY-MM>.md`, where `<YYYY-MM>` is the calendar month of that file's timestamp.
- **Guard (idempotency):** before appending, check whether the digest already contains a `## <filename>` header line; if it does, skip the append (the file was rolled by an earlier crashed sweep — do not duplicate it).
- After a successful append, delete the now-rolled individual file.
- The digest file itself is never re-rolled. Concatenation, never content deletion.
- The 30-day window is a tunable knob, not a hard constant.

**Step H3 — 150-file ceiling (burst safety valve).** After H2, if `session/archive/` still holds more than ~150 individual files (a burst that out-paced the 30-day window), roll the OLDEST individual files into their month digests — same concatenation + header-guard mechanism as H2 — until the individual-file count is at or below 150. 150 is a tunable knob.

**Crash-robustness:** each file's roll is per-file (append-then-delete); a crash between two files leaves earlier files rolled, later files untouched — a re-run completes the rest. The header-presence guard makes the append idempotent: a crash before the delete means the next sweep finds the header already present and skips, so no duplicate section.

**Cost guard:** H1–H3 touch only `session/archive/` and the RESTED set — never LIVE files, never the brief DB. On a fresh install with an empty archive dir the whole sweep is one `igris_session_file_list` call (already made in §2) plus a dir read that returns nothing. Zero cost in the common single-instance case.

### 4. Perform System Assessment

Call `igris_brief_dashboard` with `project` and `summary_only=true`, fallback to cache glob at `~/.igris/projects/{project}/briefs/` for inventory:
- The dashboard returns aggregate counts by status and priority — no need to fetch individual briefs
- Use the counts to identify if there are Ready briefs to work on

Check `~/.igris/projects/{project}/session/BLOCKERS.md` for active blockers.

Check git status.

If brain is connected (from step 3.5), include brain stats in assessment:
- Brain: Connected (X learnings, Y errors cataloged) | Not available
- Active Instances: X (from `igris_instance_list` with status="active")
- Cross-project insights if relevant

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

If `igris-brain` MCP is available, call `igris_goal_list` with:
- `project` = current project slug
- `status` = `'active'`
- `upcoming_days` = `14`
- `limit` = `3`

Token budget: this surface is bounded to ≤3 rows by the `limit` parameter. Render at most ~120 tokens.

If results are returned, render:

```
## Goals approaching deadline
- GL-003 "Ship v6.1" — due 2026-05-01 (3 days), 4/7 briefs done
- GL-001 "Compliance audit" — due 2026-05-12 (14 days), 1/5 briefs done
```

The "X/Y briefs done" comes from each goal's `serving_briefs_count` field plus a per-goal call (only if the count is non-zero) — but for the awaken surface, prefer using just `serving_briefs_count` from the list response and rendering "N briefs serving" rather than calling `igris_goal_progress` per goal (token budget).

If zero results, render nothing — no "No goals" line. Do NOT call any further goal tools when zero rows are returned.

If `>3` active goals exist beyond the 14-day window, append a single trailing line: `(+N other active goals — run /scan for full list)`. Only display this trailing line if you happen to have called `igris_goal_list` without `upcoming_days` separately; if you only called the bounded version, omit the trailing line.

If the goal tools are unavailable (older brain), skip silently.

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

If the §2 gather selected a genuine handoff with `Mode: REST MODE`, display its resume point — read the `Resume Point` / `Next Session Instructions` fields from the classified RESTED handoff file (the content fetched in §2 step G3), NOT from any fixed `CURRENT_SESSION.md`:
```
## Resuming Session

**Last Active:** [brief ID]
**Phase:** [phase]
**Next Steps:** [from the gathered handoff file]
```

If gather found zero genuine handoffs, this is a fresh start — skip the resume display.

### 6. Display Recommendations

```
## Recommended Actions

1. [Primary - resume current or start highest priority]
2. [Secondary - show status or review briefs]
3. [Tertiary - other relevant action]
```

### 7. Update Session

Write this instance's LIVE per-instance file `~/.igris/projects/{project}/session/instances/<instance_id>.md` at `state='live'` — `<instance_id>` is the id from §3.7. Set `**Mode:** Active` (or `HUNT MODE` once a hunt starts). Call `igris_session_file_update` with `project`, `filename=instances/<instance_id>.md`, `content`, `instance_id=<instance_id>`, `state='live'`.

This is the §3.7 file's LIVE state confirmed/refreshed — the per-instance file replaces the old single `CURRENT_SESSION.md`. There is no Mode flip on a shared file; each instance owns and writes its own file freely.

Display: "Igris AI initialized. System ready."
