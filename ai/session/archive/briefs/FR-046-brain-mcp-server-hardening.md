# FR-046: Brain MCP Server Hardening — Pre-Release Fixes

**Type:** Feature Request
**Priority:** P0-Critical
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-17
**Completed:** _(pending)_

---

## Feature Description

**What is the proposed feature?**

Fix 8 critical and high-priority issues in the brain MCP server identified during the v4.0 pre-release audit. These issues affect fresh installations, data integrity, search functionality, and input validation.

**Why is this valuable?**

The brain MCP server is the backbone of Igris AI's persistent memory. Fresh installs are currently broken (missing v1 schema), FTS search returns stale results, staging files can lose data, and there's no input validation. These must be fixed before any release.

---

## Issues to Fix

### CRITICAL (3)

#### CR-001: Missing Base Schema Tables in Migration
**File:** `brain-mcp-server/src/db.ts:34-224`
**Problem:** `migrateSchema()` starts at version 2, skipping version 1. Base tables (projects, learnings, errors, agent_metrics, schema_version) are never created on fresh install.
**Fix:** Add version 1 migration block with all base tables from `scripts/igris_brain_schema.sql`.

#### CR-002: SQL String Interpolation in DELETE Query
**File:** `brain-mcp-server/src/tools/instances.ts:135`
**Problem:** `STALE_PURGE_HOURS * 60` interpolated into SQL string. Violates parameterized query practice.
**Fix:** Hardcode the computed constant: `'-120 minutes'`

#### CR-003: Race Condition in Instance Heartbeat
**File:** `brain-mcp-server/src/tools/instances.ts:62-111`
**Problem:** Check-then-act pattern (UPDATE then INSERT) causes duplicates under concurrent load.
**Fix:** Use `INSERT ... ON CONFLICT(id) DO UPDATE SET ...` (upsert pattern).

### HIGH (5)

#### H-001: No Response Validation in Push/Pull
**File:** `brain-mcp-server/src/tools/sync.ts:370-414, 468-546`
**Problem:** Remote response not validated before marking sync_state as pushed. Data loss if remote returns error.
**Fix:** Validate response has `ok` and `results` fields before updating sync_state.

#### H-002: Unhandled Promise Rejections in HTTP Sessions
**File:** `brain-mcp-server/src/index.ts:1338, 1389`
**Problem:** `server.connect()` / `transport.handleRequest()` failures leave orphan sessions in transport map, eventually hitting 100 session limit.
**Fix:** Wrap in try-catch with explicit cleanup on failure.

#### H-003: Staging Files Deleted Before DB Insert
**File:** `brain-mcp-server/src/staging.ts:60-72`
**Problem:** `fs.unlinkSync(filePath)` runs even if `processStagingEntry()` throws. Data is lost.
**Fix:** Move `unlinkSync` inside the success path, after `processStagingEntry()` completes.

#### H-004: Missing FTS5 Triggers
**File:** `brain-mcp-server/src/db.ts` (migration)
**Problem:** FTS5 virtual tables exist but triggers to keep them in sync are never created. All full-text searches return stale/missing results.
**Fix:** Add FTS5 triggers for learnings and errors tables in version 1 migration.

#### H-005: No Input Validation on Memory/Error Tools
**File:** `brain-mcp-server/src/tools/memory.ts:70-99`, `errors.ts:89-127`
**Problem:** No length limits or enum validation on inputs. A 1GB content value could exhaust memory.
**Fix:** Add validation: project (max 255), title (max 500), content (max 1MB), category (enum check).

---

## Tasks

### Pending
_(none)_

### Completed
- [x] Task 1: Add version 1 migration with base schema tables + FTS triggers (CR-001 + H-004)
- [x] Task 2: Fix SQL interpolation in instances.ts (CR-002)
- [x] Task 3: Replace check-then-act with upsert in heartbeat (CR-003)
- [x] Task 4: Add response validation to push/pull in sync.ts (H-001)
- [x] Task 5: Add try-catch + cleanup in HTTP session setup (H-002)
- [x] Task 6: Fix staging file deletion order (H-003)
- [x] Task 7: Add input validation to memory and error tools (H-005)

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
All 7 tasks implemented and type-checked.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 | FORGER | Implement all 7 tasks | Success |

### Blockers
None

---

## Acceptance Criteria

1. [x] Fresh brain DB initializes with all tables (learnings, errors, projects, etc.)
2. [x] FTS5 triggers created — search returns newly inserted learnings
3. [x] No SQL string interpolation — all queries parameterized
4. [x] Instance heartbeat uses upsert — no duplicates under concurrent calls
5. [x] Push/pull validates remote response before marking sync complete
6. [x] HTTP session failures don't leak into transport map
7. [x] Staging files only deleted after successful DB insert
8. [x] Input validation rejects oversized or invalid values

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Fifty.ai)
