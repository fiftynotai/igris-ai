# BR-017: v4.0 Critical Security Hardening

**Type:** Bug Fix
**Priority:** P0-Critical
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-17
**Completed:** 2026-02-17

---

## Problem

**What's broken or missing?**

The v4.0 readiness report (5 parallel WARDEN audits, 2026-02-17) identified 3 critical security vulnerabilities across Brain MCP Server and Scripts:

1. **`trusted_schema = ON` in Brain MCP** — `brain-mcp-server/src/db.ts:372` enables execution of untrusted SQL functions within schemas. Since the brain database accepts data from remote sync endpoints and staging files, a crafted schema injection could execute arbitrary functions. SQLite docs explicitly warn against this for untrusted sources.

2. **SQL interpolation in `countTable`** — `brain-mcp-server/src/index.ts:1268` uses `\`SELECT COUNT(*) as c FROM ${table}\`` which directly interpolates the table name. While current callers pass hardcoded names, this pattern is inherently unsafe and violates the parameterized-SQL-everywhere standard the codebase otherwise follows.

3. **`eval` command injection in `igris_brain_switch.sh`** — `scripts/igris_brain_switch.sh:122,278` uses `eval "$(detect_current_mode)"` to parse output from a Python function that reads `~/.claude.json` and `config.json`. Both are user-writable files. If either contains malicious JSON values with shell metacharacters, `eval` will execute arbitrary commands. The coding guidelines explicitly state "Never use eval with user input."

**Why does it matter?**

These are the only P0 findings from a comprehensive 5-component audit. All three are exploitable attack surfaces — two via the remote sync pipeline and one via local config file manipulation. Fixing these before starting Brain v5.0 ensures the foundation is secure.

---

## Goal

**What should happen after this brief is completed?**

All 3 critical security vulnerabilities are patched:
- Brain MCP uses `trusted_schema = OFF` (SQLite default)
- `countTable` validates table names against a whitelist before interpolation
- `igris_brain_switch.sh` parses detect_current_mode output without `eval`

---

## Context & Inputs

### Affected Modules
- [x] Brain MCP Server (`brain-mcp-server/src/`)
- [x] Scripts (`scripts/igris_brain_switch.sh`)

### Layers Touched
- [x] Data Layer (SQLite pragmas, SQL queries)
- [x] Business Logic (script mode detection)

### API Changes
- [x] No API changes

### Dependencies
- [x] No new dependencies

### Related Files
- `brain-mcp-server/src/db.ts` — line 372 (`trusted_schema` pragma)
- `brain-mcp-server/src/index.ts` — line 1268 (`countTable` function)
- `scripts/igris_brain_switch.sh` — lines 122, 278 (`eval` usage)

---

## Constraints

### Architecture Rules
- Must follow existing parameterized query pattern used throughout the codebase
- Must follow coding_guidelines.md Section 9 (Security: "Never use eval with user input")
- No behavioral changes — only security hardening

### Technical Constraints
- `countTable` whitelist must include all tables currently used: `projects`, `learnings`, `errors`, `sessions`, `instances`, `brief_status`
- `igris_brain_switch.sh` replacement must produce identical variable assignments as the current `eval` pattern
- All fixes must be backward-compatible (no schema changes, no config changes)

### Out of Scope
- Adding test suites (separate brief)
- Input validation on tool handlers (separate brief)
- Other High/Medium findings from readiness report

---

## Tasks

### Pending

### In Progress

### Completed
- [x] Task 1: Change `trusted_schema = ON` to `trusted_schema = OFF` in `db.ts:372`
- [x] Task 2: Add table name whitelist to `countTable` in `index.ts:1268`
- [x] Task 3: Replace `eval` with safe variable parsing in `igris_brain_switch.sh:122,278`
- [x] Task 4: Verify brain MCP server starts and all 27 tools respond correctly
- [x] Task 5: Verify `igris_brain_switch.sh` works for all 4 modes (local, remote, dual, add-remote)

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Current Work
Committing security fixes. All agents passed.

### Next Steps
Commit, update status to Done, mark COMPLETE.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 | orchestrator | INIT — Brief loaded, status updated | SUCCESS |
| 2026-02-17 | architect | Planning implementation for 3 critical fixes | SUCCESS — 3 phases, Option B chosen for eval replacement |
| 2026-02-17 | forger | Implementing 3 security fixes | SUCCESS — 3 files modified, TS compilation clean, zero eval calls remaining |
| 2026-02-17 | sentinel | Testing implementation | PASS — 6/6 tests passed + live MCP spot-check passed |
| 2026-02-17 | warden | Reviewing code quality | APPROVE — all 3 fixes verified, 0 blocking issues |

### Blockers
None

---

## Acceptance Criteria

**The fix is complete when:**

1. [x] `db.ts` sets `trusted_schema = OFF` (or removes the pragma entirely)
2. [x] `countTable` throws an error if table name is not in the whitelist
3. [x] `igris_brain_switch.sh` contains zero `eval` calls
4. [x] Brain MCP server starts successfully and passes health check
5. [x] All 27 brain tools callable via MCP (spot check: memory_store, brain_push, instance_heartbeat)
6. [x] `igris_brain_switch.sh` correctly detects and switches between local/remote/dual modes
7. [x] No behavioral regressions — all existing functionality preserved

---

## Test Plan

### Manual Test Cases

#### Test Case 1: Brain MCP Server Startup
**Steps:**
1. Restart brain MCP server
2. Call `/health` endpoint
3. Call `igris_memory_search` with a test query
4. Call `igris_instance_heartbeat`

**Expected Result:** All respond correctly, no errors
**Status:** [ ] Pass / [ ] Fail

#### Test Case 2: countTable Whitelist Enforcement
**Steps:**
1. Verify `countTable('projects')` returns a count
2. Verify `countTable('invalid_table')` throws an error

**Expected Result:** Valid tables counted, invalid tables rejected
**Status:** [ ] Pass / [ ] Fail

#### Test Case 3: Brain Switch Without eval
**Steps:**
1. Run `igris_brain_switch.sh` with local brain config
2. Run with remote brain config
3. Run with dual brain config

**Expected Result:** Correct mode detected in all cases, no eval used
**Status:** [ ] Pass / [ ] Fail

### Regression Checklist
- [ ] Brain MCP server starts and stays running
- [ ] /awaken connects to brain successfully
- [ ] /sync data pushes to remote brain
- [ ] Brain switch correctly detects current mode

---

## Delivery

### Code Changes
- [ ] Modified: `brain-mcp-server/src/db.ts` (1 line change)
- [ ] Modified: `brain-mcp-server/src/index.ts` (add whitelist + validation to countTable)
- [ ] Modified: `scripts/igris_brain_switch.sh` (replace eval pattern)

### Deployment Notes
- [ ] Requires brain MCP server restart after deploy
- [ ] VPS deployment via `/sync code` to update remote brain server
- [ ] Rollback: revert commit (no schema changes involved)

---

## Notes

**Source:** v4.0 Readiness Report (2026-02-17), 5 parallel WARDEN audits.

**4th critical finding (archive debt) already resolved:** 41 Done briefs archived in this session. Only 3 security fixes remain.

**Readiness report scores:**
- Brain MCP Server: 7.0/10
- Scripts & Deployment: 7.5/10
- Skills, Agents & Rules: 8.0/10
- Crimson Arena Dashboard: 7.5/10
- Briefs & Session State: 7.0/10
- Overall: 7.4/10 (YELLOW)

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Igris AI)
