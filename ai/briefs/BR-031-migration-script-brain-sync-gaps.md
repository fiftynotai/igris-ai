# BR-031: Migration Script Brain Sync & Refresh Gaps

**Type:** Bug Fix
**Priority:** P2-Medium
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-24
**Completed:** 2026-02-24

---

## Problem

**What's broken or missing?**

`igris_migrate_to_v4.sh` is missing 5 enhancements that were added to `igris_install.sh` in BR-030. The migration script creates symlinks to potentially stale brain core files, registers projects with incomplete metadata, doesn't push to the remote brain, and skips health checks.

Specific gaps:

1. **No brain core refresh** — Symlinks may point to stale `~/.igris/core/` files if brain hasn't been refreshed recently
2. **No `manifest.yaml` symlink** — Agent manifest not linked (install script does this)
3. **Incomplete project registration** — Uses `INSERT OR IGNORE` with only `(slug, name, path)`, missing `tech_stack`, `igris_version`, `last_session_at`; also no `ON CONFLICT DO UPDATE`
4. **No remote brain push** — Migrated projects don't appear on VPS dashboard until next `/sync data`
5. **No brain health check** — No local DB integrity check, no remote brain health verification
6. **Hardcoded version** — Uses `'4.0.0'` instead of reading from `version.txt`
7. **No `ai/masks` directory** — v3.4 projects may not have this directory

**Why does it matter?**

Users migrating from v3.4 get an inferior experience compared to fresh installs. Migrated projects are invisible to the remote brain/dashboard and may link to outdated agent/skill/rule definitions.

---

## Goal

**What should happen after this brief is completed?**

`igris_migrate_to_v4.sh` should have feature parity with `igris_install.sh` for brain sync, project registration, remote push, and health checks. A migrated project should be indistinguishable from a fresh install in terms of brain connectivity.

---

## Context & Inputs

### Affected Modules
- [x] `scripts/igris_migrate_to_v4.sh`

### Layers Touched
- [x] Data Layer (brain registration, remote push)

### API Changes
- [x] No API changes

### Dependencies
- [x] Existing service: `igris_brain_refresh.sh` (already implemented)

### Related Files
- `scripts/igris_migrate_to_v4.sh` — primary target
- `scripts/igris_install.sh` — reference implementation (BR-030 enhanced)
- `scripts/igris_brain_refresh.sh` — called for brain refresh

---

## Constraints

### Architecture Rules
- Must follow `coding_guidelines.md` bash standards (`set -euo pipefail`, quoted vars, python3 for JSON)
- Remote brain push must be fire-and-forget (never block migration)

### Technical Constraints
- Must not break existing backup/symlink/migration logic
- Remote brain push failure must not abort migration
- Health check is informational only (warnings, not errors)

### Out of Scope
- CLAUDE.md regeneration (migration intentionally preserves existing CLAUDE.md)
- Changes to igris_install.sh (already done in BR-030)
- New features beyond parity with install script

---

## Tasks

### Pending
- [ ] Task 1: Add brain core refresh call before symlinking (call `igris_brain_refresh.sh`)
- [ ] Task 2: Add `manifest.yaml` symlink in agents section
- [ ] Task 3: Add `ai/masks` directory creation
- [ ] Task 4: Add tech stack auto-detection (reuse python3 snippet from install script)
- [ ] Task 5: Update project registration to use `ON CONFLICT DO UPDATE SET` with all fields
- [ ] Task 6: Read version from `version.txt` instead of hardcoding `'4.0.0'`
- [ ] Task 7: Add remote brain push after registration (fire-and-forget, from install script)
- [ ] Task 8: Add brain health check section (local + remote, from install script)

### In Progress

### Completed

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Ready to hunt.

### Next Steps
Run `/hunt BR-031` to implement.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
None

---

## Acceptance Criteria

**The fix is complete when:**

1. [ ] Migration script calls `igris_brain_refresh.sh` before creating symlinks
2. [ ] Agent `manifest.yaml` is symlinked alongside `*.md` files
3. [ ] `ai/masks` directory is created if missing
4. [ ] Tech stack is auto-detected and included in registration
5. [ ] Project registration uses `ON CONFLICT DO UPDATE SET` with all fields
6. [ ] Version is read from `version.txt` dynamically
7. [ ] Migrated project is pushed to remote brain (fire-and-forget)
8. [ ] Local brain integrity check runs post-migration
9. [ ] Remote brain health check runs post-migration (informational)
10. [ ] Existing backup/symlink/learnings/decisions migration logic unchanged
11. [ ] Script still passes `set -euo pipefail` (no unquoted vars, no unhandled errors)

---

## Test Plan

### Manual Test Cases

#### Test Case 1: Migration with remote brain configured
**Preconditions:** Brain initialized, remote brain configured in config.json
**Steps:**
1. Create a mock v3.4 project with `ai/prompts/` directory
2. Run `igris_migrate_to_v4.sh <project-dir>`
3. Verify brain refresh ran, symlinks created, project registered with full metadata, remote push attempted, health check displayed

**Expected Result:** All 8 tasks reflected in output, project visible on VPS dashboard

#### Test Case 2: Migration without remote brain
**Preconditions:** Brain initialized, no remote_brain in config.json
**Steps:**
1. Run migration on a v3.4 project
2. Verify remote push is skipped gracefully

**Expected Result:** Migration completes, remote push skipped with warning

---

## Delivery

### Code Changes
- [ ] Modified files: `scripts/igris_migrate_to_v4.sh`

### Deployment Notes
- [ ] Run `/sync code` after merge to deploy to VPS

---

## Notes

Pattern established in BR-030 (`igris_install.sh`). This brief brings the migration script to parity. All new code sections can be copied/adapted directly from the install script.

---

**Created:** 2026-02-24
**Last Updated:** 2026-02-24
**Brief Owner:** Igris AI
