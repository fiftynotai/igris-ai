# FR-048: Script Hardening & DB Backup — Pre-Release Fixes

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

Harden all 17 bash scripts with `set -u`, improve VPS deploy rollback, add database backup/restore scripts, and add input validation for URLs and SSH parameters.

**Why is this valuable?**

Scripts operate on VPS infrastructure with destructive capabilities (file copies, PM2 restarts, git operations). Undefined variable bugs could cause catastrophic path operations. No DB backup means brain corruption has no recovery path.

---

## Issues to Fix

### CRITICAL (3)

#### CR-001: No `set -u` in Any Script
**Files:** All 17 scripts in `scripts/`
**Problem:** 0/17 scripts use `set -u`. Undefined variables silently expand to empty strings.
**Fix:** Add `set -euo pipefail` to all scripts.

#### CR-002: No VPS Deploy Rollback on PM2
**File:** `scripts/igris_vps_update.sh`
**Problem:** If build fails and backup restored, PM2 process isn't restarted with old code.
**Fix:** Add PM2 restart after backup restoration.

#### CR-003: Missing Database Backup/Restore Script
**Problem:** No script exists for brain DB backup. If `knowledge.db` corrupts, all learnings, sessions, and project data are lost.
**Fix:** Create `scripts/igris_brain_backup.sh` and `scripts/igris_brain_restore.sh`.

### HIGH (5)

#### H-001: No Input Validation for SSH Hosts/URLs
**File:** `scripts/igris_brain_init.sh:36-64`
**Problem:** SSH host and URL parameters accepted without validation. SSRF risk if attacker-controlled.
**Fix:** Add URL scheme validation, port range checks.

#### H-002: Hardcoded Paths With No Config Override
**Files:** `igris_vps_update.sh:16-21`, `igris_brain_deploy.sh:16-20`
**Problem:** `BRAIN_DIR`, `DEFAULT_PORT` etc. hardcoded. Can't adapt to different VPS setups.
**Fix:** Support env vars: `IGRIS_BRAIN_DIR`, `IGRIS_BRAIN_PORT`.

#### H-003: Dashboard venv Health Check Only Checks Hash
**File:** `scripts/dashboard.sh:126-147`
**Problem:** If packages deleted from venv, script won't reinstall because requirements.txt hash unchanged.
**Fix:** Add `check_venv_health()` that verifies critical imports work.

#### H-004: SQL Injection Risk in /sync Data Merge
**File:** `/sync` skill implementation
**Problem:** Local DB merge generates SQL via string concatenation (even with quote()). Transaction wrapping missing.
**Fix:** Wrap merge in BEGIN TRANSACTION / COMMIT on VPS side.

#### H-005: No Permission/Disk Space Checks
**File:** `scripts/igris_vps_update.sh:215-224`
**Problem:** File copies without checking write permissions or available disk space.
**Fix:** Add permission and disk space checks before operations.

---

## Tasks

### Pending
- [ ] Task 8: Wrap /sync data merge in transaction (H-004) -- **out of scope** (not in scripts/)

### Completed
- [x] Task 1: Add `set -euo pipefail` to all 17 scripts + 2 new scripts (CR-001)
- [x] Task 2: Fix VPS deploy rollback — restart PM2 with old build on failure (CR-002)
- [x] Task 3: Create `igris_brain_backup.sh` (CR-003)
- [x] Task 4: Create `igris_brain_restore.sh` (CR-003)
- [x] Task 5: Add URL/host input validation to brain_init.sh (H-001)
- [x] Task 6: Support env var overrides for paths and ports (H-002)
- [x] Task 7: Add venv health check to dashboard.sh (H-003)
- [x] Task 9: Add permission/disk space checks (H-005)

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** FORGER
**Retry Count:** 0

### Current Work
Implementation complete for scripts/** scope. H-004 (/sync data merge transaction) is out of scope (not in scripts/).

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 | FORGER | CR-001: set -euo pipefail on all 19 scripts | DONE |
| 2026-02-17 | FORGER | CR-002: PM2 restart on rollback | DONE |
| 2026-02-17 | FORGER | CR-003: backup/restore scripts | DONE |
| 2026-02-17 | FORGER | H-001: URL/host validation | DONE |
| 2026-02-17 | FORGER | H-002: env var overrides | DONE |
| 2026-02-17 | FORGER | H-003: venv health check | DONE |
| 2026-02-17 | FORGER | H-005: disk/permission checks | DONE |

### Blockers
None

---

## Acceptance Criteria

1. [x] All 19 scripts use `set -euo pipefail` (17 existing + 2 new)
2. [x] VPS deploy restores PM2 process on build failure
3. [x] `igris_brain_backup.sh` creates timestamped DB backup
4. [x] `igris_brain_restore.sh` restores from backup file
5. [x] URL/host inputs validated before SSH/curl
6. [x] Env vars override hardcoded paths
7. [x] Dashboard venv verifies package imports, not just hash
8. [ ] /sync data merge wrapped in SQL transaction (out of scope - not in scripts/)
9. [x] File operations check permissions and disk space

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Fifty.ai)
