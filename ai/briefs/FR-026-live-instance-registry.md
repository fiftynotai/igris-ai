# FR-026: Live Instance Registry

**Type:** Feature Request
**Priority:** P1-High
**Effort:** M-Medium (2-4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-16

---

## Feature Description

**What is the proposed feature?**

A live instance registry that tracks all active Igris sessions across machines. Each Igris instance heartbeats to the remote brain with its machine hostname, project, current brief/task, and status. The brain provides tools to query all active instances — giving a real-time view of "where is Igris running and what is it doing?"

**Why is this valuable?**

With the brain now remote (FR-025), multiple machines can connect. But there's no visibility into which machines are active, what projects they're working on, or what tasks are in progress. This feature turns the brain into a command center — see all Igris instances at a glance.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:** No way to know which machines are running Igris or what they're working on. Each session is invisible to others.

**With this feature:** Query the brain to see all active instances: machine, project, task, last heartbeat. Dead instances auto-expire.

---

## Use Cases

### Use Case 1: Check Active Instances
**Actor:** Developer
**Goal:** See all running Igris instances
**Steps:**
1. Run `igris_instance_list` (or `/instances`)
2. See table: machine, project, brief, phase, last seen
**Expected Outcome:** Real-time view of all active Igris sessions.

### Use Case 2: Heartbeat on Session Activity
**Actor:** Igris AI (automatic)
**Goal:** Keep instance registry up to date
**Steps:**
1. On `/awaken` — register instance with machine + project
2. During work — heartbeat on brief/phase changes
3. On `/rest` — deregister instance
**Expected Outcome:** Brain always knows who's alive.

### Use Case 3: Detect Stale Instances
**Actor:** Developer or system
**Goal:** Clean up dead instances
**Steps:**
1. Instance crashes or disconnects without `/rest`
2. Heartbeat expires (e.g., 30 min without update)
3. Instance auto-marked as `stale`
**Expected Outcome:** No ghost entries in the registry.

---

## Technical Approach

### High-Level Design

1. **New DB table:** `instances` — tracks active Igris sessions
2. **New brain tools:** `igris_instance_heartbeat`, `igris_instance_list`, `igris_instance_remove`
3. **Integration with /awaken and /rest:** Auto-register/deregister
4. **TTL expiry:** Instances not updated in 30 min marked stale

### Schema

```sql
CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY,              -- UUID per session
    machine_hostname TEXT NOT NULL,   -- e.g., "m.elamin-macbook"
    machine_os TEXT,                  -- e.g., "darwin", "linux"
    project_slug TEXT,                -- e.g., "igris-ai"
    project_path TEXT,                -- e.g., "/Users/m.elamin/StudioProjects/igris-ai"
    current_brief TEXT,               -- e.g., "FR-025"
    current_phase TEXT,               -- e.g., "BUILDING"
    current_task TEXT,                -- e.g., "Deploying brain to VPS"
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'idle', 'stale')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
    metadata TEXT DEFAULT '{}'        -- JSON blob for extensibility
);

CREATE INDEX IF NOT EXISTS idx_instances_status ON instances(status);
CREATE INDEX IF NOT EXISTS idx_instances_project ON instances(project_slug);
```

### Brain Tools

**`igris_instance_heartbeat`** — Register or update an instance
- Input: `machine_hostname`, `machine_os`, `project_slug`, `project_path`, `current_brief?`, `current_phase?`, `current_task?`
- Generates UUID on first call, upserts on subsequent calls
- Returns instance ID

**`igris_instance_list`** — List all instances
- Input: `status?` (active/idle/stale/all), `project?`
- Returns table of all matching instances
- Auto-marks instances with `last_heartbeat_at` > 30 min ago as `stale`

**`igris_instance_remove`** — Deregister an instance
- Input: `instance_id`
- Deletes the row (called on /rest)

### Integration Points

- **`/awaken` skill:** Call `igris_instance_heartbeat` with machine + project info
- **`/rest` skill:** Call `igris_instance_remove` to deregister
- **`/hunt` workflow:** Update `current_brief` and `current_phase` on phase transitions
- **`/scan` skill:** Show active instances count in system assessment

### Components Affected
- `brain-mcp-server/src/tools/instances.ts` — New file (tools)
- `brain-mcp-server/src/db.ts` — Schema migration v4
- `brain-mcp-server/src/index.ts` — Register new tools
- `.claude/skills/awaken/SKILL.md` — Add heartbeat call
- `.claude/skills/rest/SKILL.md` — Add deregister call
- `.claude/skills/hunt/SKILL.md` — Add phase heartbeat

---

## Context & Inputs

### Dependencies
- [x] FR-025: Deploy Brain MCP Server to VPS (DONE)
- [x] FR-022: HTTP Transport (DONE)

---

## Constraints

### Technical Constraints
- Heartbeat must be lightweight (single INSERT OR REPLACE)
- Stale detection via TTL, not background job (check on query)
- Instance ID generated client-side (UUID) to avoid collisions
- Machine hostname from `os.hostname()` or `$HOSTNAME`

### Out of Scope
- Real-time push notifications between instances
- Instance-to-instance messaging
- Web dashboard UI (future feature)

---

## Tasks

### Pending
- [ ] Add `instances` table to schema (migration v4)
- [ ] Create `brain-mcp-server/src/tools/instances.ts` with 3 tools
- [ ] Register tools in `index.ts`
- [ ] Update `/awaken` skill to call `igris_instance_heartbeat`
- [ ] Update `/rest` skill to call `igris_instance_remove`
- [ ] Update `/hunt` skill to heartbeat on phase transitions
- [ ] Apply schema migration on VPS
- [ ] Test end-to-end: awaken → heartbeat → list → rest → removed

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
Done. Committed as `3f77b30`.

### Next Steps
None — brief complete.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-16 | architect | PLANNING phase | Plan complete — 1 new file, 7 modified, 6 phases, M-effort |
| 2026-02-16 | forger | BUILDING phase | Complete — 1 new file, 6 modified, build passes |
| 2026-02-16 | sentinel | TESTING phase | PASS — 7/7 checks, 0 issues, 3 minor suggestions |
| 2026-02-16 | warden | REVIEWING phase | APPROVE — 0 critical, 0 major, clean merge |

### Blockers
None

---

## Acceptance Criteria

1. [ ] `instances` table exists in brain DB (schema v4)
2. [ ] `igris_instance_heartbeat` registers/updates instance
3. [ ] `igris_instance_list` shows all active instances with machine, project, task
4. [ ] `igris_instance_remove` deregisters on /rest
5. [ ] Stale instances auto-detected (>30 min without heartbeat)
6. [ ] `/awaken` auto-registers instance
7. [ ] `/rest` auto-deregisters instance

---

## Test Plan

### Functional Tests
**Test Case 1: Register Instance**
1. Call `igris_instance_heartbeat` with machine + project
**Expected Result:** Instance appears in `igris_instance_list`

**Test Case 2: Update Heartbeat**
1. Call `igris_instance_heartbeat` again with new brief/phase
**Expected Result:** Same instance ID, updated fields

**Test Case 3: List Instances**
1. Call `igris_instance_list`
**Expected Result:** Table showing machine, project, brief, phase, last heartbeat

**Test Case 4: Deregister on Rest**
1. Call `igris_instance_remove`
**Expected Result:** Instance no longer in list

**Test Case 5: Stale Detection**
1. Insert instance with `last_heartbeat_at` 31+ minutes ago
2. Call `igris_instance_list`
**Expected Result:** Instance marked as `stale`

---

## Delivery

- [ ] New `instances.ts` tools file
- [ ] Schema migration v4
- [ ] Updated /awaken, /rest, /hunt skills
- [ ] VPS schema updated

---

## Notes

**Depends on:** FR-025 (Done)
**Enables:** Future web dashboard, instance-to-instance awareness

---

**Created:** 2026-02-16
**Last Updated:** 2026-02-16
**Brief Owner:** Crimson (Fifty.ai)
