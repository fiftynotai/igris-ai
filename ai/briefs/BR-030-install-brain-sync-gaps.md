# BR-030: Install Script — Brain Sync & Stale Skills Gaps

**Type:** Bug Fix
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Completed:** 2026-02-24
**Created:** 2026-02-24

---

## Problem

**What's broken or missing?**

Three related gaps discovered when installing Igris v4 in `attendance_app`:

### Gap 1: No VPS Brain Push After Install
`igris_install.sh` registers the project in the **local** brain (`~/.igris/memory/knowledge.db`) but never pushes to the **remote** brain. Projects installed locally don't appear on the VPS dashboard until the user manually runs `/sync data`.

**Reproduction:** Install Igris in a new project → check VPS dashboard → project missing.

### Gap 2: Stale Brain Core Skills
`igris_brain_init.sh` copies skills from the igris-ai repo to `~/.igris/core/skills/` at init time. When skills are updated in the repo (e.g., BR-024 fixed `disable-model-invocation` on Feb 18), the brain copies are **never refreshed**. All future installs symlink to the stale copies.

**Timeline:**
- Feb 16: `igris_brain_init.sh` → copies skills with `disable-model-invocation: true`
- Feb 18: BR-024 fix → changed to `false` in igris-ai repo only
- Feb 24: `igris_install.sh` in attendance_app → symlinks to stale brain copies → `/standardize` fails

**Error:** `Skill standardize cannot be used with Skill tool due to disable-model-invocation`

### Gap 3: Incomplete Project Registration
`igris_install.sh` only populates 3 of 9 fields in the `projects` table: `slug`, `name`, `path`. Missing: `tech_stack`, `igris_version`, `metadata`.

**Why does it matter?**

- Gap 1: New projects are invisible on the VPS dashboard, breaking cross-project visibility
- Gap 2: Any skill fix or update in the repo won't propagate to installed projects, causing silent breakage
- Gap 3: Brain analytics and cross-project intelligence lack project metadata

---

## Goal

**What should happen after this brief is completed?**

1. `igris_install.sh` pushes project registration to remote brain (if configured)
2. A mechanism exists to refresh `~/.igris/core/skills/` from the repo after updates
3. `igris_install.sh` populates `tech_stack` and `igris_version` fields during registration
4. All existing symlinked skills across installed projects get the fix automatically when brain is refreshed

---

## Context & Inputs

### Affected Modules
- [x] `scripts/igris_install.sh` — Project installer
- [x] `scripts/igris_brain_init.sh` — Brain bootstrap (skill copy logic)
- [x] `~/.igris/core/skills/` — Brain core skills (stale copies)

### Layers Touched
- [x] Scripts/Infrastructure
- [x] Brain/MCP (project registration)

### API Changes
- [x] No API changes

### Dependencies
- [x] `python3` — For SQLite operations
- [x] `sqlite3` — Brain database
- [x] `igris-brain` MCP server — For remote push (optional, graceful fallback)

### Related Files
- `scripts/igris_install.sh` — Main install script (lines 330-346: registration)
- `scripts/igris_brain_init.sh` — Brain init (skill copy logic)
- `scripts/igris_brain_schema.sql` — Database schema (projects table)
- `~/.igris/core/skills/*/SKILL.md` — Stale skill definitions
- `~/.igris/config.json` — Remote brain config (url + api_key)

### Related Briefs
- BR-024 (archived): `disable-model-invocation` fix — applied to repo but not propagated to brain
- MG-012: Crimson Arena extraction — similar pattern of stale VPS state

---

## Constraints

### Architecture Rules
- Brain operations are fire-and-forget (never block install workflow)
- Remote push failure must NOT fail the install (graceful degradation)
- Follow bash standards: `set -e`, quoted variables, Python3 for JSON/SQLite

### Technical Constraints
- Remote brain may not be configured (check `~/.igris/config.json` for `remote_brain` section)
- MCP server may not be running during install (use direct HTTP or SQLite, not MCP tools)
- Must be backwards-compatible (existing installs should not break)

### Out of Scope
- Brain v5.0 changes (FR-051 through FR-056)
- SOUL.md generation for target projects
- `.claude/settings.json` generation

---

## Tasks

### Pending
- [ ] Task 1: Add brain core skills refresh to `igris_install.sh` — re-copy skills from repo to `~/.igris/core/skills/` before symlinking
- [ ] Task 2: Add remote brain push to `igris_install.sh` — POST project registration to VPS brain API (if configured)
- [ ] Task 3: Populate `tech_stack` and `igris_version` in registration INSERT
- [ ] Task 4: Create `igris_brain_refresh.sh` standalone script for on-demand brain refresh (agents, rules, skills, prompts)
- [ ] Task 5: Verify fix on attendance_app — confirm `/standardize` works after brain refresh
- [ ] Task 6: Verify attendance_app appears on VPS dashboard after push

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Awaiting hunt command.

### Next Steps
1. ARCHITECT plans the fix approach
2. FORGER implements changes to install + refresh scripts
3. SENTINEL verifies on attendance_app
4. WARDEN reviews

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
None

---

## Acceptance Criteria

**The fix is complete when:**

1. [ ] `igris_install.sh` refreshes `~/.igris/core/skills/` from repo before creating symlinks
2. [ ] `igris_install.sh` pushes project registration to remote brain (graceful failure if not configured)
3. [ ] `igris_install.sh` populates `tech_stack` and `igris_version` in the projects table
4. [ ] `igris_brain_refresh.sh` exists as standalone script for on-demand refresh
5. [ ] `/standardize` works in attendance_app after brain refresh
6. [ ] attendance_app appears on VPS dashboard after remote push
7. [ ] Install still succeeds when remote brain is not configured (graceful degradation)
8. [ ] All bash scripts follow `coding_guidelines.md` (set -e, quoted vars, etc.)

---

## Test Plan

### Manual Test Cases

#### Test Case 1: Fresh Install with Remote Brain
**Preconditions:** Remote brain configured in `~/.igris/config.json`
**Steps:**
1. Run `igris_install.sh` on a test project
2. Check VPS dashboard for new project

**Expected Result:** Project appears on dashboard within seconds
**Status:** [ ] Pass / [ ] Fail

#### Test Case 2: Fresh Install without Remote Brain
**Preconditions:** No `remote_brain` section in config
**Steps:**
1. Run `igris_install.sh` on a test project
2. Confirm install completes without errors

**Expected Result:** Install succeeds, skips remote push gracefully
**Status:** [ ] Pass / [ ] Fail

#### Test Case 3: Skill Refresh Fixes Stale Skills
**Preconditions:** Brain has stale skills (old `disable-model-invocation: true`)
**Steps:**
1. Run `igris_brain_refresh.sh`
2. Open a project with symlinked skills
3. Run `/standardize`

**Expected Result:** Skill invokes successfully
**Status:** [ ] Pass / [ ] Fail

---

## Delivery

### Code Changes
- [ ] Modified: `scripts/igris_install.sh` (add skill refresh, remote push, extended registration)
- [ ] New file: `scripts/igris_brain_refresh.sh` (standalone brain refresh)

### Deployment Notes
- [ ] Run `igris_brain_refresh.sh` once after deploying to refresh all brain core files
- [ ] Existing installed projects will auto-fix via symlinks after brain refresh

---

## Notes

- The symlink architecture is a strength here: refreshing `~/.igris/core/skills/` once fixes ALL installed projects simultaneously
- Remote push should use direct HTTP POST to the brain API (not MCP tools) since MCP may not be available during install
- Consider adding a `--skip-remote` flag to install script for offline installs
- The `igris_brain_refresh.sh` script could also be triggered by `/sync code` on the igris-ai project

---

**Created:** 2026-02-24
**Last Updated:** 2026-02-24
**Brief Owner:** Igris AI
