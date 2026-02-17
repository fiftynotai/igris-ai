# FR-047: Dashboard Security & Reliability — Pre-Release Fixes

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

Fix 6 critical and high-priority security and reliability issues in the Crimson Arena dashboard identified during the v4.0 pre-release audit. Covers CORS, input validation, error handling, and sensitive data exposure.

**Why is this valuable?**

The dashboard is publicly accessible on VPS port 8001. Without CORS, any website can make requests to it. Brain API keys are logged in plaintext. WebSocket errors are silently swallowed. These issues must be fixed before production use.

---

## Issues to Fix

### CRITICAL (1)

#### CR-001: No CORS Configuration
**File:** `dashboard/server.py`
**Problem:** No CORSMiddleware configured. If exposed to internet, any origin can make requests to all endpoints.
**Fix:** Add CORS middleware restricting to `127.0.0.1:8001` and `localhost:8001`.

### HIGH (5)

#### H-001: Unvalidated Paths in Brain Proxy
**File:** `dashboard/server.py:113-136` (brain_request function)
**Problem:** `path` parameter passed to brain_request() without validation. Future routes could enable path traversal.
**Fix:** Validate path starts with `/` and doesn't contain `..`.

#### H-002: Silent Exception in WebSocket Init
**File:** `dashboard/server.py:1760`
**Problem:** `except Exception` catches and silently discards all errors during WebSocket initialization. No logging.
**Fix:** Add `logger.error()` with exc_info before disconnect.

#### H-003: Race Condition in context_window Updates
**File:** `dashboard/server.py:567-579`
**Problem:** `INSERT OR REPLACE` with hardcoded `id = 1` can lose updates under concurrent agent stop events.
**Fix:** Use `BEGIN IMMEDIATE` transaction for atomic read-then-write.

#### H-004: Missing Query Parameter Validation
**File:** `dashboard/server.py:1593, 1610`
**Problem:** `/api/brain/briefs` accepts `status` and `project` without validation.
**Fix:** Use `Literal` types for status enum, `Query(min_length=1, max_length=100)` for project.

#### H-005: Brain API Key Logged in Plaintext
**File:** `dashboard/server.py:1415`
**Problem:** Brain config URL (which may contain API key) logged at INFO level on startup.
**Fix:** Log `"Brain proxy enabled: [configured]"` without the actual URL/key.

---

## Tasks

### Pending
_(none)_

### Completed
- [x] Task 1: Add CORS middleware (CR-001)
- [x] Task 2: Add path validation to brain_request() (H-001)
- [x] Task 3: Fix WebSocket exception handling with logging (H-002)
- [x] Task 4: Add transaction to context_window update (H-003)
- [x] Task 5: Add query parameter validation to brain endpoints (H-004)
- [x] Task 6: Redact sensitive data from logs (H-005)

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
All 6 security and reliability fixes implemented in dashboard/server.py.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
None

---

## Acceptance Criteria

1. [x] CORS middleware active — only localhost origins allowed
2. [x] brain_request() rejects paths with `..` or not starting with `/`
3. [x] WebSocket init errors logged with full traceback
4. [x] context_window writes use BEGIN IMMEDIATE transaction
5. [x] Brain endpoints validate query parameters with types and limits
6. [x] No API keys or sensitive URLs in server logs

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Fifty.ai)
