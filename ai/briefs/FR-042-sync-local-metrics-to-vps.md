# FR-042: Sync Local Metrics & Brain Data to VPS

**Type:** Feature Request
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-17
**Completed:** 2026-02-17

---

## Feature Description

**What is the proposed feature?**

Enhance the `/sync data` skill to upload local agent metrics (token usage, invocation counts, durations) and local brain database content to the VPS. Currently `/sync data` only calls `igris_brain_push` which operates on the VPS database (circular — pushes to itself), leaving local-only data stranded on the developer's machine.

**Why is this valuable?**

The Crimson Arena dashboard on the VPS has no visibility into agent token usage, cost data, or run counts because `agent-metrics.json` and the local brain DB never leave the MacBook. This makes the "all time" dashboard view incomplete and misleading.

---

## User Value

### Who Benefits?
- [ ] End users (people using the product)
- [x] Developers (building with Igris AI)
- [ ] Contributors (extending Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
- `agent-metrics.json` (169 invocations, 316K+ input tokens, 224M cache tokens) lives only on the local machine
- `igris_brain_push`/`igris_brain_pull` MCP tools operate on the VPS database, pushing to themselves (circular)
- Local `~/.igris/memory/knowledge.db` has historical data the VPS has never seen
- Crimson Arena "all time" view is missing agent metrics and token usage data

**With this feature:**
- `/sync data` uploads `agent-metrics.json` to the VPS via SCP
- `/sync data` uploads the local brain DB to the VPS and merges missing rows
- Crimson Arena shows complete all-time agent metrics, token costs, and run counts

---

## Use Cases

### Use Case 1: Sync Agent Metrics to Dashboard
**Actor:** Developer ending a session
**Goal:** See complete agent usage stats on Crimson Arena
**Steps:**
1. Run `/sync data`
2. Skill SCPs `agent-metrics.json` to VPS
3. Skill merges local brain DB rows into VPS brain DB

**Expected Outcome:** Crimson Arena "all time" view shows all 169 invocations, token counts, and per-agent stats.

### Use Case 2: Initial Full Seed
**Actor:** Developer setting up VPS for the first time
**Goal:** Populate VPS brain with all historical local data
**Steps:**
1. Run `/sync data`
2. All local brain data (learnings, sessions, brief_status, agent_metrics) pushed to VPS

**Expected Outcome:** VPS brain has complete copy of local data.

---

## Technical Approach

### High-Level Design

Add two new steps to `/sync data` in the SKILL.md:

1. **Metrics file upload:** SCP `ai/session/metrics/agent-metrics.json` to VPS at a known path (e.g., `{vps.brain_path}/metrics/agent-metrics.json`)
2. **Local DB merge:** Dump local brain DB tables as INSERT OR IGNORE SQL, SCP to VPS, import into VPS brain DB

### Components Affected
- `.claude/skills/sync/SKILL.md` — Add metrics upload and local DB merge steps to data sync flow
- VPS brain — May need a `metrics/` directory created
- Crimson Arena dashboard — May need to read from the new metrics file path

### API/Interface Design
```
/sync data
  [1/4] Draining sync queue...
  [2/4] Pushing brain data... (MCP push — existing, kept for VPS-to-VPS sync)
  [3/4] Uploading agent metrics... (NEW — SCP agent-metrics.json)
  [4/4] Merging local brain data... (NEW — dump + SCP + import local DB)
```

---

## Context & Inputs

### Dependencies
- [ ] Existing system: SSH access to VPS (already configured for /sync code)
- [ ] Existing system: `~/.igris/config.json` with vps.host, vps.user, vps.brain_path
- [ ] Existing system: `agent-metrics.json` at `ai/session/metrics/`

### Files to Modify
- `.claude/skills/sync/SKILL.md` — Add Steps 3 and 4 to data sync flow

### Configuration Changes
- [ ] VPS: Create `~/.igris/metrics/` directory if not exists

---

## Alternatives Considered

### Alternative 1: REST API Endpoint on VPS Brain
**Pros:**
- Clean HTTP-based approach
- No SSH needed for data sync

**Cons:**
- Requires new endpoint development on brain-mcp-server
- More code to maintain

**Why not chosen:** SCP is simpler and reuses existing SSH infrastructure.

### Alternative 2: Git-Based Metrics Sync
**Pros:**
- Metrics tracked in version control
- Natural history

**Cons:**
- `agent-metrics.json` contains sensitive token counts
- Would bloat the git repo with frequent updates

**Why not chosen:** Metrics are operational data, not source code.

---

## Constraints

### Technical Constraints
- Must reuse existing SSH config from `~/.igris/config.json`
- Must not break existing `/sync data` MCP push flow
- Local DB merge must use INSERT OR IGNORE (no overwrites)
- Must handle missing metrics file gracefully

### UX Constraints
- Must show clear progress for each new step
- Must not significantly increase sync time

### Timeline
- **Deadline:** N/A

### Out of Scope
- Crimson Arena dashboard changes (it should already read from the metrics path)
- Bidirectional metrics sync (local → VPS only)
- Real-time streaming of metrics

---

## Tasks

### Pending
- [ ] Task 1: Add metrics upload step to `/sync data` in SKILL.md
- [ ] Task 2: Add local DB merge step to `/sync data` in SKILL.md
- [ ] Task 3: Test metrics appear on Crimson Arena after sync
- [ ] Task 4: Test local brain data merge works correctly

### In Progress

### Completed

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Current Work
All phases passed. Committing changes.

### Next Steps
Commit and mark complete.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 07:50 | forger | Add metrics + DB merge steps to /sync | SUCCESS |
| 2026-02-17 08:10 | sentinel | Validate SKILL.md changes (10 checks) | PASS |
| 2026-02-17 08:15 | warden | Code review | APPROVE (5 minor suggestions, 0 blockers) |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] `/sync data` uploads `agent-metrics.json` to VPS via SCP
2. [ ] `/sync data` merges local brain DB rows into VPS brain DB
3. [ ] Crimson Arena "all time" view shows agent invocation counts and token usage
4. [ ] Graceful handling when metrics file doesn't exist
5. [ ] Graceful handling when local brain DB is empty
6. [ ] Existing MCP push step still works (not removed)
7. [ ] Step-by-step progress output for new steps

---

## Test Plan

### Functional Tests
**Test Case 1: Metrics Upload (Happy Path)**
**Steps:**
1. Ensure `agent-metrics.json` exists locally with data
2. Run `/sync data`
3. Check VPS for uploaded file

**Expected Result:** File exists on VPS at `{brain_path}/metrics/agent-metrics.json`
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Local DB Merge**
**Steps:**
1. Run `/sync data`
2. Check VPS brain DB row counts before and after

**Expected Result:** VPS has union of local and remote data, no duplicates
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Missing Metrics File**
**Steps:**
1. Temporarily rename `agent-metrics.json`
2. Run `/sync data`

**Expected Result:** Warning displayed, sync continues with other steps
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] Existing `/sync code` still works
- [ ] Existing `/sync status` still works
- [ ] MCP push step unchanged

---

## Delivery

### Documentation
- [ ] SKILL.md updated with new steps

### Announcement
- [ ] Changelog entry: "Enhanced /sync data to upload agent metrics and merge local brain data to VPS"

---

## Notes

**Root cause discovery:**
- `igris_brain_push`/`igris_brain_pull` MCP tools run on the VPS and operate on the VPS database
- When pushing, VPS pushes to itself (circular) — remote_url points to same server
- Local machine's `~/.igris/memory/knowledge.db` is completely disconnected from MCP operations
- `agent-metrics.json` is a local file that was never part of any sync flow

**Future Enhancements:**
- Fix the circular push/pull at the MCP level (detect same-host and skip)
- Add a `/sync metrics` mode for metrics-only sync
- Dashboard auto-refresh when new metrics land

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Fifty.ai
