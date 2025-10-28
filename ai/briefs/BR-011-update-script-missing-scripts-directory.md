# BR-011: Update Script Fails When scripts/ Directory Missing

**Type:** Bug Fix
**Priority:** P2-Medium
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2025-10-27
**Completed:** 2025-10-27

---

## Problem

**What's broken?**

The `igris_update.sh` script fails when updating old projects that don't have a `scripts/` directory:

```bash
# Error seen during moca_app update:
  - Updating plugin management scripts...
cp: directory scripts does not exist
```

**Root cause:**
- Old Blueprint AI (pre-v1.0.5) didn't include a `scripts/` directory
- Update script assumes `scripts/` exists when copying plugin scripts
- Script tries: `cp plugin_*.sh scripts/` → fails if directory missing

**Why does it matter?**

- **Blocks upgrades**: Users with old Blueprint/Igris installations can't update
- **Discovered in production**: Hit this bug during moca_app update (Blueprint v1.0.4 → Igris v2.4.0)
- **Incomplete updates**: Update partially succeeds but leaves system in broken state
- **No plugin management**: Users can't install/update/uninstall plugins without scripts

**Impact:** Medium - affects old installations, workaround exists (manual directory creation)

---

## Goal

**After this brief is completed:**

✅ `igris_update.sh` works on all projects (with or without `scripts/` directory)
✅ Update script creates missing `scripts/` directory automatically
✅ Plugin scripts copied successfully even on old installations
✅ No user intervention required

---

## Context & Inputs

### Discovery

**User request:**
> "okay can you update igris in another project StudioProject/moca-app?"

During moca_app update (Blueprint v1.0.4 → Igris v2.4.0), update script failed at plugin scripts copy step.

### Affected Files
- `scripts/igris_update.sh` (lines 298-305)

### Current Code (Broken)

```bash
# Update plugin management scripts
if [ -f "$TEMP_DIR/scripts/plugin_install.sh" ]; then
  echo "  - Updating plugin management scripts..."
  cp "$TEMP_DIR/scripts/plugin_install.sh" scripts/    # ← FAILS if scripts/ doesn't exist
  cp "$TEMP_DIR/scripts/plugin_uninstall.sh" scripts/
  cp "$TEMP_DIR/scripts/plugin_list.sh" scripts/
  chmod +x scripts/plugin_*.sh
fi
```

### No API Changes
- Internal script fix only

---

## Reproduction Steps

1. Create test project with old Blueprint AI structure (no `scripts/` directory)
2. Run `igris_update.sh`
3. Observe error: `cp: directory scripts does not exist`
4. Update fails, plugin scripts not installed

**Test case:**
- moca_app (Blueprint v1.0.4) - had this bug
- Any pre-v1.0.5 Blueprint AI installation

---

## Solution Design

**Simple fix:** Create `scripts/` directory before copying

```bash
# Update plugin management scripts
if [ -f "$TEMP_DIR/scripts/plugin_install.sh" ]; then
  echo "  - Updating plugin management scripts..."

  # Create scripts directory if it doesn't exist
  mkdir -p scripts

  cp "$TEMP_DIR/scripts/plugin_install.sh" scripts/
  cp "$TEMP_DIR/scripts/plugin_uninstall.sh" scripts/
  cp "$TEMP_DIR/scripts/plugin_list.sh" scripts/
  chmod +x scripts/plugin_*.sh
fi
```

**Changes:**
- Add `mkdir -p scripts` before cp operations
- `-p` flag: creates parent directories, no error if exists
- Idempotent: safe to run multiple times

---

## Tasks

### Pending
_(No pending tasks - all complete)_

### In Progress
_(No tasks in progress - brief complete)_

### Completed
- [x] Task 1: Add `mkdir -p scripts` to igris_update.sh (completed: 2025-10-27 19:51)
  - Added line 312: `mkdir -p scripts`
  - Creates directory if missing, no error if exists
- [x] Task 2: Test with project missing scripts/ directory (completed: 2025-10-27 19:53)
  - Test project: /tmp/test_update_no_scripts
  - Result: ✅ scripts/ created, plugin scripts copied successfully
- [x] Task 3: Test with project that has scripts/ directory (completed: 2025-10-27 19:55)
  - Test project: /tmp/test_update_with_scripts
  - Result: ✅ No errors, scripts updated normally, no regression

---

## Session State (Tactical - This Brief)

**Current State:** ✅ ALL TASKS COMPLETE - Ready to commit
**Next Steps When Resuming:** N/A - Brief complete
**Last Updated:** 2025-10-27 19:56
**Blockers:** None

**Implementation Summary:**
- Added `mkdir -p scripts` to igris_update.sh (line 312)
- Tested both cases: missing scripts/ and existing scripts/
- Both tests passed with no errors
- Fix is simple, safe, and idempotent

---

## Testing

### Test Cases

**1. Missing scripts/ directory (bug scenario)**
- Setup: Project with no `scripts/` directory
- Expected: Directory created, plugin scripts copied successfully
- Result: [to be tested]

**2. Existing scripts/ directory (regression check)**
- Setup: Project with existing `scripts/` directory
- Expected: No errors, scripts updated normally
- Result: [to be tested]

**3. Fresh Igris AI project**
- Setup: Newly initialized project (has scripts/)
- Expected: Update works normally
- Result: [to be tested]

---

## Acceptance Criteria

**The bug is fixed when:**

1. [ ] `mkdir -p scripts` added to igris_update.sh
2. [ ] Update script works on projects without scripts/ directory
3. [ ] Update script still works on projects with scripts/ directory (no regression)
4. [ ] Plugin scripts copied successfully in both cases
5. [ ] No manual user intervention required
6. [ ] Tested on real old project (moca_app or similar)

---

## Related Issues

**Related commits:**
- TD-011 (5b1270f): Blueprint→Igris migration (didn't catch this edge case)
- 4e88562: CLAUDE.md fix (also should have caught missing scripts/)

**Similar bugs:**
- BR-007: plugin_update.sh reading wrong file (fixed)
- BR-009: plugin_list.sh missing error handling (fixed)

**Prevention:**
- Add to testing checklist: Test updates on pre-v1.0.5 installations

---

## Notes

**Manual workaround (used for moca_app):**
```bash
cd /Users/m.elamin/StudioProjects/moca_app
mkdir -p scripts
cp /path/to/igris-ai/scripts/plugin_*.sh scripts/
chmod +x scripts/plugin_*.sh
```

**Why this wasn't caught:**
- Testing focused on v2.0.0+ migrations
- Didn't test very old Blueprint AI installations
- scripts/ directory assumed to exist

---

**Created:** 2025-10-27
**Last Updated:** 2025-10-27
**Brief Owner:** Igris AI (Commanded by: Fifty.ai)
