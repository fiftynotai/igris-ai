# FR-040: /sync Predefined Skill — VPS Brain Deployment Command

**Type:** Feature Request
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-17
**Completed:**

---

## Feature Description

**What is the proposed feature?**

Create a `/sync` predefined Claude Code skill that automates the full VPS brain deployment workflow: push local changes to git, SSH into VPS, pull and rebuild, restart the brain server, and verify health. Currently this is a manual multi-step process.

**Why is this valuable?**

Every time brain-mcp-server code changes (new tools, schema migrations, bug fixes), the developer must manually: git push, SSH into VPS, run update script, check PM2, verify health endpoint. This is error-prone and tedious. A single `/sync` command eliminates friction and ensures consistent deployment.

---

## User Value

### Who Benefits?
- [ ] End users (people using the product)
- [x] Developers (building with Igris AI)
- [ ] Contributors (extending Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
After making changes to brain-mcp-server or any synced content, the developer must manually:
1. `git push origin develop`
2. SSH into VPS
3. Run `igris_vps_update.sh --branch develop`
4. Verify PM2 process restarted
5. Check health endpoint
6. Optionally push brain data via `igris_brain_push`

**With this feature:**
A single `/sync` command handles the entire workflow with status feedback, error handling, and verification. Supports modes: `code` (git + VPS deploy), `data` (brain push/pull), `all` (both).

---

## Use Cases

### Use Case 1: Code Deployment After Feature Work
**Actor:** Developer using Igris AI
**Goal:** Deploy brain-mcp-server changes to VPS after implementing features
**Steps:**
1. Complete code changes and commit
2. Run `/sync code` or just `/sync`
3. Skill pushes to git, SSHs into VPS, rebuilds, restarts, verifies

**Expected Outcome:** VPS brain server is running the latest code. Health check passes. Developer sees summary.

### Use Case 2: Brain Data Synchronization
**Actor:** Developer ending a session
**Goal:** Push local brain data (learnings, sessions, briefs) to remote brain
**Steps:**
1. Run `/sync data`
2. Skill calls `igris_brain_push` with configured remote URL
3. Displays sync summary (rows pushed per table)

**Expected Outcome:** Remote brain has latest local data.

### Use Case 3: Full Sync (Code + Data)
**Actor:** Developer finishing a major session
**Goal:** Deploy code AND sync data in one command
**Steps:**
1. Run `/sync all`
2. Skill runs code deployment first, then data push

**Expected Outcome:** VPS has latest code AND latest data.

---

## Technical Approach

### High-Level Design
Create a new skill at `.claude/skills/sync/SKILL.md` that:
1. Reads VPS config from `~/.igris/config.json` (host, user, path, remote_brain URL/key)
2. Determines sync mode from argument (code|data|all, default: all)
3. For code sync: git push, SSH deploy, health check
4. For data sync: call brain MCP push tool
5. Reports results with clear status per step

### Components Affected
- `.claude/skills/sync/SKILL.md` — new skill definition
- `CLAUDE.md` — add `/sync` to skills table
- `ai/prompts/igris_os.md` — add `/sync` to command reference
- `.claude/rules/04-igris-agents.md` — add `/sync` to skill-based operations table

### API/Interface Design
```
/sync              — Full sync (code + data), default
/sync code         — Git push + VPS deploy only
/sync data         — Brain data push only
/sync all          — Explicit full sync
/sync status       — Show last sync timestamps and VPS health
```

**Example usage:**
```
User: /sync
Igris: Syncing code and data to VPS...
       [1/5] Pushing to origin/develop... done (3 commits)
       [2/5] SSH deploy to VPS... done (build OK)
       [3/5] PM2 restart... done (uptime: 2s)
       [4/5] Health check... passed (v4.0.0)
       [5/5] Brain data push... done (12 rows synced)

       Sync complete. VPS brain is up-to-date.
```

---

## Context & Inputs

### Dependencies
- [ ] Existing system: `~/.igris/config.json` for VPS SSH config and remote brain URL
- [ ] Existing system: `igris_vps_update.sh` install script on VPS
- [ ] Existing system: `igris_brain_push` MCP tool for data sync
- [ ] Existing system: PM2 on VPS for process management

### Files to Create
- `.claude/skills/sync/SKILL.md` — skill definition

### Files to Modify
- `CLAUDE.md` — add `/sync` to skills table
- `ai/prompts/igris_os.md` — add `/sync` to command reference (if needed)
- `.claude/rules/04-igris-agents.md` — add `/sync` to skill-based operations table

### Configuration Changes
- [ ] VPS config in `~/.igris/config.json` must have: `vps.host`, `vps.user`, `vps.brain_path`
- [ ] Remote brain config: `remote_brain.url`, `remote_brain.api_key`

---

## Alternatives Considered

### Alternative 1: Shell Script Only
**Pros:**
- Simpler implementation
- Can run outside Claude Code

**Cons:**
- No integration with Igris session tracking
- No brain MCP tool access for data sync
- No persona-themed output

**Why not chosen:** Loses the benefit of Igris AI orchestration and MCP tool integration.

### Alternative 2: Hook-Based Auto-Deploy
**Pros:**
- Fully automatic on commit

**Cons:**
- Too aggressive — not every commit should deploy
- Hard to control timing
- SSH failures could block commits

**Why not chosen:** Deployment should be intentional, not automatic.

---

## Constraints

### Technical Constraints
- Must read VPS config from `~/.igris/config.json` (no hardcoded hosts)
- Must handle SSH failures gracefully (VPS unreachable)
- Must handle brain MCP unavailability gracefully
- Must work with current PM2 + igris_vps_update.sh setup

### UX Constraints
- Must provide clear step-by-step progress feedback
- Must not block on non-critical failures (e.g., data sync fails but code deployed)
- Must warn before pushing uncommitted changes

### Timeline
- **Deadline:** N/A
- **Milestones:** None

### Out of Scope
- CI/CD pipeline integration (future)
- Multi-VPS deployment (future)
- Rollback capability (future)

---

## Tasks

### Pending
- [ ] Task 1: Create `.claude/skills/sync/SKILL.md` with full skill definition
- [ ] Task 2: Update `CLAUDE.md` skills table with `/sync` entry
- [ ] Task 3: Update `.claude/rules/04-igris-agents.md` skill-based operations table
- [ ] Task 4: Test `/sync code` flow end-to-end
- [ ] Task 5: Test `/sync data` flow end-to-end
- [ ] Task 6: Test `/sync status` flow

### In Progress

### Completed

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Current Work
Building the /sync skill definition and updating documentation.

### Next Steps
1. Create `.claude/skills/sync/SKILL.md`
2. Update `~/.igris/config.json` with VPS section
3. Update CLAUDE.md, rules, igris_os.md with /sync references

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 07:22 | architect | Create implementation plan | SUCCESS |
| 2026-02-17 07:25 | forger | Implement /sync skill + docs | SUCCESS |
| 2026-02-17 07:29 | sentinel | Validate implementation | PASS (17/17 checks) |
| 2026-02-17 07:32 | warden | Code review | APPROVE |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] `/sync` command is available as a Claude Code skill
2. [ ] `/sync code` pushes git and deploys to VPS via SSH
3. [ ] `/sync data` pushes brain data via MCP tool
4. [ ] `/sync all` does both code and data sync
5. [ ] `/sync status` shows last sync info and VPS health
6. [ ] Graceful handling when VPS is unreachable
7. [ ] Graceful handling when brain MCP is unavailable
8. [ ] Config read from `~/.igris/config.json` (no hardcoded values)
9. [ ] Step-by-step progress output during sync
10. [ ] CLAUDE.md and rules updated with new skill

---

## Test Plan

### Functional Tests
**Test Case 1: Code Sync (Happy Path)**
**Steps:**
1. Make a change and commit
2. Run `/sync code`
3. Verify git push succeeds
4. Verify VPS deploy succeeds
5. Verify health check passes

**Expected Result:** VPS running latest code, health endpoint returns OK
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: VPS Unreachable**
**Steps:**
1. Disconnect VPS or use invalid host
2. Run `/sync code`

**Expected Result:** Clear error message, no crash, data sync still offered
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Data Sync Only**
**Steps:**
1. Run `/sync data`
2. Check remote brain for synced rows

**Expected Result:** Brain data pushed successfully, summary displayed
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] Existing `/awaken` and `/rest` brain sync not affected
- [ ] Existing hook-based staging not affected
- [ ] Other skills unaffected

---

## Delivery

### Documentation
- [ ] CLAUDE.md: Add `/sync` to skills table
- [ ] Rules: Add to skill-based operations reference
- [ ] igris_os.md: Add to command reference if needed

### Announcement
- [ ] Changelog entry: "New /sync skill for one-command VPS deployment"

---

## Notes

**Inspiration:**
- Manual workflow performed during FR-033–FR-039 deployment session
- Similar to `vercel deploy` or `fly deploy` one-command patterns

**Future Enhancements:**
- Multi-VPS support (deploy to staging then production)
- Rollback command (`/sync rollback`)
- Auto-sync on `/rest` (optional config flag)
- Sync health dashboard integration with Crimson Arena

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Fifty.ai
