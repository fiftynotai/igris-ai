---
name: scan
description: Show system status report - briefs, session, blockers, git status
disable-model-invocation: false
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - mcp__igris-brain__igris_project_status
  - mcp__igris-brain__igris_brief_dashboard
  - mcp__igris-brain__igris_goal_list
  - mcp__igris-brain__igris_goal_progress
  - mcp__igris-brain__igris_suggestion_list
  - mcp__igris-brain__igris_event_log
  - mcp__igris-brain__igris_session_file_get
  - mcp__igris-brain__igris_session_file_list
  - mcp__igris-brain__igris_instance_list
triggers:
  - "SCAN"
  - "REPORT"
  - "show status"
  - "show brief status"
  - "show bug status report"
  - "show feature status report"
  - "brief overview"
---

# SCAN - System Status Report

Display comprehensive status of the Igris AI system.

## Arguments

`$ARGUMENTS` can optionally filter results:
- Empty: Full status report
- `P0` or `P1`: Filter by priority
- `bugs` or `features`: Filter by type
- `--suggestions`: Append a "Subconscious Suggestions" section (FR-106) below the regular report

## Execution

### 0. Track Invocation
Silently emit a skill invocation event (never blocks execution):
```bash
bash "$CLAUDE_PROJECT_DIR/scripts/emit_skill_event.sh" "scan" 2>/dev/null || true
```

### 1. Load Session State

Read the per-instance session file for:
- Current session mode (Active/REST MODE)
- Active briefs
- Resume point

`/scan` may run *before* this harness's `/awaken` (the operator just opens a terminal and types `SCAN`), so resolve the file gracefully:

1. If a `**Instance ID:**` is discoverable for this harness, read `~/.igris/projects/{project}/session/instances/<instance_id>.md`.
2. Otherwise, call `igris_session_file_list` with `project=<slug>` (no `state` filter) to enumerate all session files, and read the one with the most-recent `updated_at`.
3. If no session file exists at all, treat the session as "no session" and render the `### Session` block with `Mode: None` / `Active Brief: None` — do NOT error.

`/scan` is read-only and must NEVER error if no session file exists. Degrade gracefully in every branch.

### 1.5. Active Instances

Call `igris_instance_list` with `status='active'` to surface the live instance registry (Lock 1: the registry is the source of liveness). Render a compact table — this feeds the `### Active Instances` block in §6:

```
### Active Instances
| Instance | Project | Current Brief | Last Active |
|----------|---------|---------------|-------------|
| a1b2c3d4 | igris-ai | FR-132 | 2026-05-18 14:22 |
| e5f6g7h8 | other-app | BR-009 | 2026-05-18 13:50 |
```

Show the short form of each `instance_id` (first 8 chars). If `igris_instance_list` is unavailable (older brain) or returns no rows, omit the section entirely. Do NOT block `/scan`.

### 2. Scan Briefs

Call `igris_brief_dashboard` with `project` and `summary_only=true`, fallback to cache glob at `~/.igris/projects/{project}/briefs/` (exclude templates):
- The dashboard returns aggregate counts by status and priority — no need to fetch individual briefs
- Apply filter if `$ARGUMENTS` provided (e.g., pass `status` parameter for status filter)

### 2.5. Scan Goals (FR-110)

Call `igris_goal_list` with `project` and `status='active'` to list active goals for the current project. Then for each returned goal, call `igris_goal_progress` to compute completion. Render a compact table with text-progress bars:

```
### Goals (Active)
| Goal | Outcome | Deadline | Progress |
|------|---------|----------|----------|
| GL-003 "Ship v6.1" | shipped | 2026-05-01 | [########--] 7/8 |
| GL-001 "Compliance audit" | audited | 2026-05-12 | [##--------] 1/5 |
```

Progress bar conventions:
- 10 cells; fill ratio = round(completion_pct * 10)
- When `completion_pct` is `null` (no serving briefs), render `[----------] 0/0` with a faded/dimmed style
- Cap rendered table at 10 active goals; if more exist, append `(+N more — use /portfolio for full view)`

If no active goals exist, omit the section entirely.

If the goal tools are unavailable (older brain), skip the section silently.

### 3. Check Blockers

Read `~/.igris/projects/{project}/session/BLOCKERS.md`:
- Count active blockers (not in Resolved section)
- Flag critical blockers

### 4. Agent Count

Read the agent roster from `~/.igris/core/igris_tree.json` (`agents` map) — or, as a fallback, count the canonical agent definitions in `~/.igris/core/agents/*.md`. The roster is discovered from these harness-agnostic sources; the per-harness agent directory is adapter-owned, so never count it directly.

### 5. Git Status

Run: `git status --short`

### 5.5. Query Brain Stats (Optional)

If the `igris-brain` MCP server is available:
- Call `igris_project_status` for the current project slug
- Get learning count, error count, recent metrics

If brain MCP is not available, skip this step silently. No errors, no warnings.

### 6. Display Report

Format as:

```
## System Status Report

### Session
- Mode: [Active | REST MODE | None]
- Active Brief: [ID or None]
- Resume Point: [description]

### Active Instances
[The §1.5 table — or omit if no active instances / tool unavailable]

### Briefs Inventory
| Status | Count |
|--------|-------|
| Ready | X |
| In Progress | X |
| Done | X |
| Draft | X |

[If filtered: "Showing: P0 only" or "Showing: bugs only"]

### Priority Distribution
- P0 (Critical): X briefs
- P1 (High): X briefs
- P2 (Medium): X briefs
- P3 (Low): X briefs

### Agents
X agents registered (Y skills available)

### Blockers
[None | X active (Y critical)]

### Git Status
[Clean | X uncommitted files]

### Brain (if connected)
- Learnings: X (Y global)
- Errors cataloged: Z
- Cross-project patterns: N available
- Last brain sync: [timestamp]

### Harness Drift
[The §6.7 line — or omit if the guard / manifest is absent]

### Recommendations
1. [Primary recommendation]
2. [Secondary recommendation]
```

### 6.5. Subconscious Suggestions (FR-106)

> **TD-102 (V7):** This entire section is gated behind the `subconscious.enabled`
> config flag (default `false` for V7). FR-118 will replace the rule-based
> engine in V7.1 with an LLM-driven design; until then the section is silent
> regardless of the `--suggestions` flag.

This section is rendered ONLY when ALL of the following are true:
1. `subconscious.enabled` is `true` in `~/.igris/config.json` (key absent = `false`).
2. `$ARGUMENTS` contains the literal token `--suggestions`.

If either gate fails, skip this section silently — render nothing, do not
call any suggestion MCP tools.

If both gates pass and the `igris-brain` MCP is available:

1. Call `igris_suggestion_list` with:
   - `status` = `'pending'`
   - `project_slug` = current project slug
   - `limit` = `1000` (handler caps at this value; >1000 pending is a degenerate state)
2. Group the returned suggestions by `source_module` in the order:
   `stalled`, `gap`, `conflict`, `pattern`. Within each group, the
   handler already returns rows ordered by `priority` (high > medium > low)
   then `created_at` DESC, so client-side iteration preserves that order.
3. Render each non-empty group as its own subsection. Empty groups are
   omitted entirely. If the global `total` is `0`, render the single line
   `No pending suggestions.` and skip every subsection.

#### Render template

```
## Subconscious Suggestions ({total} pending)

### Stalled (N)
| ID | Priority | Title | Project |
|----|----------|-------|---------|
| 12 | high     | TD-005 stalled in In Progress for 35 days | igris-ai |

### Gap (N)
| ID | Priority | Title | Project |
|----|----------|-------|---------|
| 19 | medium   | Project "old-app" has been quiet for 95 days | old-app |

### Conflict (N)
| ID | Priority | Title |
|----|----------|-------|
| 47 | medium   | Possible contradiction: Learning #112 vs #389 |

### Pattern (N)
| ID | Priority | Title |
|----|----------|-------|
| 51 | medium   | Pattern: brief activity skews toward Monday in igris-ai (60% of last 50) |
```

If `total` exceeds 1000 (the handler ceiling), append the trailing line:
`(+N more — use igris_suggestion_list for full pagination)`.

End the section with the action hint:
`Use igris_suggestion_dismiss <id> --reason "..." to silence noisy suggestions.`

If `igris-brain` MCP is unavailable, render this single line instead:
`Subconscious suggestions unavailable (brain MCP offline).`

### 6.6. Perception Engine (TD-074, TD-080)

Surface the latest detached perception extraction run so operators can see
when the LLM extractor last fired, succeeded, failed, or got skipped by the
60s min-window guard. Token budget: ~150 tokens.

#### Query

**TD-080 fix (Gap A):** read directly from the local DB via `sqlite3`. The
local DB is the merged superset (post any prior pull) and includes
local-only perception runs that have not yet propagated to the remote.
`igris_event_log` MCP routes to the remote brain — using it here would miss
this machine's unpushed runs even when the call "succeeds".

Primary query (substitute `$PROJECT_SLUG`):
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
  "SELECT event_name, payload, created_at FROM event_log
   WHERE component = 'perception' AND project_slug = '$PROJECT_SLUG'
   ORDER BY created_at DESC LIMIT 1;"
```

Fallback (only when `sqlite3` is absent on this machine — older / minimal
installs): call `igris_event_log` with:
- `component` = `'perception'`
- `project_slug` = current project slug
- `limit` = `1`

The MCP handler returns rows ordered `created_at DESC`, matching the sqlite3
query shape. Note the fallback inherits the original blind spot: it shows
remote-only state. That's an acceptable degradation when the local read is
unavailable.

Also stat the inbox for staleness:
```bash
INBOX="$HOME/.igris/projects/$PROJECT/session/perception_inbox.jsonl"
[ -f "$INBOX" ] && wc -c < "$INBOX" || echo 0
```

#### Render

When the latest event exists, render two lines under a `### Perception Engine`
heading. Format the timestamp as `YYYY-MM-DD HH:MM` (local), parsed from the
ISO `created_at` field. The status word is uppercase, mapped from the event
suffix:
- `perception.run_succeeded` → `SUCCEEDED`
- `perception.run_failed` → `FAILED`
- `perception.run_skipped` → `SKIPPED`
- `perception.run_started` → `RUNNING` (no terminal event has followed)

Detail clause depends on the status:
- SUCCEEDED → `· N candidates` (from `payload.candidates_count`; default 0 if missing)
- FAILED → `· (reason)` (parenthesized; from `payload.reason`; fallback `(unknown reason)` if blank)
- SKIPPED → `· (reason, Ns elapsed)` when `reason='min_window_guard'`, else `· (reason)`
- RUNNING → `· started Nm ago (may be stuck)` if `>5 min` elapsed since the
  `run_started` row; otherwise omit the detail clause.

Inbox clause: `· inbox NKB` always (round to nearest KB; show `0KB` for an
empty file). Append ` stale` when the file is non-empty AND its mtime is
more than 1 hour old.

```
### Perception Engine
Last run: 2026-05-01 04:22 — SUCCEEDED · 3 candidates · inbox 0KB
```

```
### Perception Engine
Last run: 2026-05-01 04:22 — FAILED (epipe_on_llm_stdin) · inbox 3.4MB stale
```

```
### Perception Engine
Last run: 2026-05-01 04:22 — SKIPPED (min_window_guard, 12s elapsed) · inbox 0KB
```

When no event_log rows exist for the project (older brain or never run):
```
### Perception Engine
No perception runs yet for this project.
```

If `sqlite3` is absent AND the `igris_event_log` MCP fallback also fails,
omit the section entirely. Do NOT block /scan.

### 6.7. Harness Drift (FR-135, TD-021)

Surface whether the generated agent-prompt harnesses are in sync with their
canonical `core/agents/*.md` prompts. Read-only — this NEVER blocks /scan and
NEVER regenerates anything. Token budget: ~80 tokens.

#### Query

Run the drift guard wrapper read-only and capture its exit code + summary:
```bash
GUARD="$REPO_ROOT/core/scripts/cli-adapters/check_harness_drift.sh"
MANIFEST="$REPO_ROOT/core/scripts/cli-adapters/harness-manifest.json"

# Silent-degradation posture (matches §5.5 / §6.6): if the adapter layer or
# manifest is absent, render NOTHING for this section. The guard's verdict is
# only meaningful when the guard itself is present.
if [ -f "$GUARD" ] && [ -f "$MANIFEST" ]; then
  bash "$REPO_ROOT/scripts/validate_harness_drift.sh" 2>&1 | tail -1
fi
```

The wrapper checks the 7 Igris-core agents (content-pipeline agents are
excluded — they have no canonical in this repo until FR-136). The guard's
per-agent summary line reads `N targets — M in sync, K drifted/missing`.

#### Render

When the guard ran, render a single line under a `### Harness Drift` heading
summing the per-agent results into one MATCH/DRIFTED count:

```
### Harness Drift
7 agent targets — 7 in sync
```

When any target is out of sync (DRIFTED or MISSING), name the count and the
remedy:
```
### Harness Drift
7 agent targets — 4 in sync, 3 drifted/missing — run `compile_harnesses.sh` to resync
```

If the guard script or the manifest is absent, omit the section entirely.
Do NOT block /scan, do NOT print an error.
