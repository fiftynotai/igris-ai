# BR-008: plugin_uninstall.sh Doesn't Remove Plugin Files

**Type:** Bug Fix
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2025-10-26

---

## Problem

**What's broken?**

`scripts/plugin_uninstall.sh` only removes the plugin from the registry (`ai/plugins/installed.json`) but **does not remove any plugin files** from the project.

```bash
# Line 149-150 in plugin_uninstall.sh
echo "⚠️  Note: Plugin files may still exist in scripts/, templates/, etc."
echo "   Manual cleanup may be required for complete removal."
```

**Impact:**
- ❌ Plugin files remain after uninstall (scripts, templates, hooks)
- ❌ User thinks plugin is gone, but files still present
- ❌ Reinstalling same plugin may cause conflicts
- ❌ Disk space wasted on "uninstalled" plugins
- ❌ Confusion: "I uninstalled it, why are these files here?"

**Why does it matter?**

- **User expectations violated**: Uninstall should remove files
- **Incomplete feature**: Half-implemented uninstall
- **Potential conflicts**: Stale files from old plugin versions
- **Professional quality**: Leaving files after uninstall is unprofessional

---

## Goal

**What should happen after this fix?**

1. ✅ Plugin uninstall removes plugin-installed files
2. ✅ Plugin-specific cleanup handled by plugin's `uninstall.sh` (if exists)
3. ✅ Safe removal: Only remove files plugin explicitly owns
4. ✅ Clear user feedback about what was removed

**Acceptance criteria:**
- Uninstall calls plugin's `uninstall.sh` script (if exists)
- Removes plugin hooks from project
- Updates CLAUDE.md if hooks were removed
- Clear success message showing what was removed
- Backup created before removal (safety)

---

## Context & Inputs

### Affected Files
- `scripts/plugin_uninstall.sh` (add cleanup logic)
- Plugin repositories need `uninstall.sh` script (optional)

### Solution Approach

**Two-phase uninstall:**

**Phase 1: Plugin-specific cleanup (if plugin provides uninstall.sh)**
```bash
# Check if plugin provides uninstall script
if [ -f "$PLUGIN_LOCATION/uninstall.sh" ]; then
  echo "🔧 Running plugin cleanup..."
  bash "$PLUGIN_LOCATION/uninstall.sh" "$PROJECT_DIR"
fi
```

**Phase 2: Core cleanup (hooks, registry)**
- Remove hooks from CLAUDE.md if plugin had persona_injection
- Regenerate CLAUDE.md without plugin hooks
- Remove from installed.json (already done)
- Create backup before removal

### Design Decisions

**Where are plugin files?**

Problem: Plugins can install files anywhere. Solution:
1. Plugin's `uninstall.sh` knows where it installed files → plugin handles cleanup
2. Core uninstaller handles: hooks, CLAUDE.md regeneration, registry

**What if plugin doesn't have uninstall.sh?**

- Warn user that files may remain
- List potential locations to check manually
- Still remove from registry and hooks

---

## Constraints

### Safety Requirements
- Must create backup before removal
- Must not fail if uninstall.sh missing (optional cleanup)
- Must not remove user's custom files
- Must only touch plugin-owned files

### Technical Constraints
- Cannot know all files plugin installed (unless plugin tracks this)
- Plugin location may not be accessible (if cloned temporarily during install)
- Must handle persona hooks separately (in CLAUDE.md)

---

## Test Plan

### Test 1: Plugin with uninstall.sh
```bash
# Setup: Install mock plugin with uninstall.sh
# Execute: ./scripts/plugin_uninstall.sh -y mock-plugin
# Expected:
#   - Plugin's uninstall.sh runs
#   - Plugin files removed
#   - Registry updated
#   - Hooks removed from CLAUDE.md
```

### Test 2: Plugin without uninstall.sh
```bash
# Setup: Install mock plugin without uninstall.sh
# Execute: ./scripts/plugin_uninstall.sh -y mock-plugin
# Expected:
#   - Warning shown about manual cleanup
#   - Registry updated
#   - Hooks removed from CLAUDE.md
#   - No errors
```

### Test 3: Persona plugin with hooks
```bash
# Setup: Install persona plugin with hooks
# Execute: ./scripts/plugin_uninstall.sh -y igris-persona
# Expected:
#   - CLAUDE.md regenerated without persona hooks
#   - Persona content removed
#   - Registry updated
```

---

## Tasks

### Pending
- [ ] Task 1: Design plugin uninstall.sh convention
  - Document in PLUGIN_DEVELOPMENT.md
  - Signature: uninstall.sh <project_dir>
  - Plugin must clean up own files

- [ ] Task 2: Add plugin cleanup logic to plugin_uninstall.sh
  - Check if plugin location has uninstall.sh
  - Run it if exists
  - Handle errors gracefully

- [ ] Task 3: Add hook removal logic
  - If plugin had persona_injection hook
  - Regenerate CLAUDE.md without it
  - Use same logic as plugin_install.sh regeneration

- [ ] Task 4: Add backup creation
  - Backup affected files before removal
  - Save to .igris_backup/uninstall/<timestamp>_<plugin_name>/

- [ ] Task 5: Improve user feedback
  - Show what was removed
  - Show what wasn't (if no uninstall.sh)
  - Suggest manual cleanup locations

- [ ] Task 6: Update plugin template/docs
  - Add uninstall.sh template
  - Document cleanup best practices

- [ ] Task 7: Test with mock plugins
  - Test with and without uninstall.sh
  - Test persona plugin (hooks)
  - Verify cleanup works

### In Progress
_(None yet)_

### Completed
_(Tasks tracked during implementation)_

---

## Session State (Tactical - This Brief)

**Current State:** Brief registered, ready for implementation
**Next Steps When Resuming:** Start with Task 1 - Design uninstall convention
**Last Updated:** 2025-10-26 18:50
**Blockers:** None

---

## Acceptance Criteria

**The bug is fixed when:**

1. [ ] plugin_uninstall.sh calls plugin's uninstall.sh (if exists)
2. [ ] Removes persona hooks from CLAUDE.md (if plugin had hooks)
3. [ ] Creates backup before removal
4. [ ] Clear user feedback about removed files
5. [ ] Graceful handling if uninstall.sh missing
6. [ ] Tests pass for both scenarios (with/without uninstall.sh)
7. [ ] Documentation updated (PLUGIN_DEVELOPMENT.md)

---

## Notes

### Plugin Cleanup Responsibility

**Philosophy:** Plugin knows what it installed, so plugin should clean it up.

**Implementation:**
- Core installer: Calls plugin's `install.sh`
- Core uninstaller: Calls plugin's `uninstall.sh`

**Plugin uninstall.sh template:**
```bash
#!/bin/bash
# Plugin uninstall script
# Called by: scripts/plugin_uninstall.sh "$PROJECT_DIR"

PROJECT_DIR=$1

# Remove plugin files
rm -f "$PROJECT_DIR/scripts/my_plugin_script.sh"
rm -rf "$PROJECT_DIR/ai/plugins/my_plugin_data"

echo "✅ Plugin files removed"
```

### Current vs Fixed Behavior

**Current:**
```
$ ./scripts/plugin_uninstall.sh igris-persona
✅ Plugin uninstalled successfully!
⚠️  Note: Plugin files may still exist...

$ ls ai/personas/igris/
# Still there! Not actually uninstalled.
```

**After Fix:**
```
$ ./scripts/plugin_uninstall.sh igris-persona
🔧 Running plugin cleanup...
✅ Removed: ai/personas/igris/
🔄 Regenerating CLAUDE.md (removed hooks)
✅ Plugin uninstalled successfully!

$ ls ai/personas/igris/
ls: no such file or directory
# Actually gone!
```

---

**Created:** 2025-10-26
**Last Updated:** 2025-10-26
**Brief Owner:** Igris AI Bug Hunt
