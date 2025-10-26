# BR-007: plugin_update.sh Uses version.txt But Plugins Use plugin.json

**Type:** Bug Fix
**Priority:** P0-Critical
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2025-10-26

---

## Problem

**What's broken?**

`scripts/plugin_update.sh` attempts to read plugin version from `version.txt` in the plugin repository:

```bash
# Line 128-133 in plugin_update.sh
if [ ! -f "$TEMP_DIR/version.txt" ]; then
  echo "❌ Error: Could not fetch remote version"
  echo "   Plugin repository may not have version.txt file"
  rm -rf "$TEMP_DIR"
  exit 1
fi
REMOTE_VERSION=$(cat "$TEMP_DIR/version.txt")
```

**However**, `scripts/plugin_install.sh` reads version from `plugin.json`:

```bash
# Line 104 in plugin_install.sh
PLUGIN_VERSION=$(cat "$TEMP_DIR/plugin.json" | grep '"version"' | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
```

**Impact:**
- ❌ **plugin_update.sh ALWAYS FAILS** for any plugin that follows the documented format (plugin.json only)
- ❌ Users cannot update plugins
- ❌ Inconsistency between install and update scripts
- ❌ No plugins in the ecosystem have version.txt (only plugin.json)

**Why does it matter?**

- **Severity**: CRITICAL - Core functionality broken
- **User impact**: Users cannot update plugins, must manually reinstall
- **Ecosystem impact**: Plugin developers confused about version file requirements

**Evidence from code:**
1. Plugin install reads from plugin.json (line 104)
2. Plugin update reads from version.txt (line 128)
3. No plugin template or documentation mentions version.txt
4. Test fixtures use plugin.json for version

---

## Goal

**What should happen after this fix?**

1. ✅ `plugin_update.sh` reads version from `plugin.json` (consistent with install)
2. ✅ Plugin updates work successfully
3. ✅ Both install and update use the same version source
4. ✅ Tests pass (plugin_update.test.bash currently failing due to this bug)

**Acceptance criteria:**
- `plugin_update.sh` extracts version from `plugin.json` using python3
- No references to `version.txt` in plugin update logic
- plugin_update.test.bash tests pass (currently 19/19 failing)
- Update works for test fixtures (which have plugin.json only)

---

## Context & Inputs

### Affected Files
- `scripts/plugin_update.sh` (line 128-136) - Change version extraction
- `test/plugin_update.test.bash` (all tests) - Currently failing due to this bug

### Root Cause Analysis

**How did this happen?**

Likely copy-paste from `igris_update.sh` (which correctly uses version.txt for Igris AI core). Plugin update was modeled after core update, but plugins use different version file.

**Igris AI core:**
- Has `version.txt` in repository root
- `igris_update.sh` correctly reads from `version.txt`

**Plugins:**
- Have `plugin.json` with version field
- `plugin_install.sh` correctly reads from `plugin.json`
- `plugin_update.sh` incorrectly tries to read from `version.txt`

### Solution Approach

Replace version.txt logic with plugin.json parsing using python3:

**Before:**
```bash
if [ ! -f "$TEMP_DIR/version.txt" ]; then
  echo "❌ Error: Could not fetch remote version"
  exit 1
fi
REMOTE_VERSION=$(cat "$TEMP_DIR/version.txt")
```

**After:**
```bash
if [ ! -f "$TEMP_DIR/plugin.json" ]; then
  echo "❌ Error: Could not fetch plugin.json"
  exit 1
fi
# Use python3 for reliable JSON parsing
REMOTE_VERSION=$(python3 -c "
import json
with open('$TEMP_DIR/plugin.json', 'r') as f:
    data = json.load(f)
    print(data.get('version', ''))
")
if [ -z "$REMOTE_VERSION" ]; then
  echo "❌ Error: Could not extract version from plugin.json"
  exit 1
fi
```

---

## Constraints

### Architecture Rules
- Must follow coding_guidelines.md (use python3 for JSON, not sed)
- Must have error handling for missing/corrupted JSON

### Technical Constraints
- Python3 is already a required dependency (validated at script start)
- Must be consistent with plugin_install.sh approach
- Must validate JSON exists before parsing

### Backward Compatibility
- N/A - plugin updates are currently broken, so no compatibility to maintain
- This is a bug fix, not a breaking change

---

## Test Plan

### Unit Tests

**Test 1: Update plugin successfully**
```bash
# Setup: Create mock plugin with plugin.json (no version.txt)
# Execute: ./scripts/plugin_update.sh mock-plugin
# Expected: Reads version from plugin.json, update succeeds
```

**Test 2: Missing plugin.json**
```bash
# Setup: Create mock plugin without plugin.json
# Execute: ./scripts/plugin_update.sh mock-plugin
# Expected: Clear error "Could not fetch plugin.json"
```

**Test 3: Corrupted plugin.json**
```bash
# Setup: Create mock plugin with invalid JSON
# Execute: ./scripts/plugin_update.sh mock-plugin
# Expected: Clear error "Could not extract version"
```

### Regression Tests

Run existing test suite:
```bash
bats test/plugin_update.test.bash
```

**Expected:** All 19 tests should pass (currently 19/19 failing)

### Manual Test

1. Install a real plugin (e.g., igris-ai-persona-igris)
2. Run: `./scripts/plugin_update.sh igris-ai-persona-igris`
3. Verify: Update completes successfully
4. Verify: Version updated in `ai/plugins/installed.json`

---

## Tasks

### Pending
- [ ] Task 3: Test with mock fixtures
  - Run plugin_update.test.bash
  - Verify all 19 tests pass
  - Check error handling paths

- [ ] Task 4: Manual verification
  - Test with real plugin repository
  - Verify version extraction works
  - Verify update completes successfully

- [ ] Task 5: Update documentation if needed
  - Check if any docs reference version.txt for plugins
  - Ensure consistency

### In Progress
_(None)_

### Completed
- [x] Task 1: Replace version.txt logic with plugin.json parsing (completed: 2025-10-26 19:00)
  - Changed line 128-148 in plugin_update.sh
  - Used python3 for JSON parsing (consistent with install)
  - Added error handling for missing/corrupted JSON
  - Validates extracted version is not empty

- [x] Task 2: Update error messages (completed: 2025-10-26 19:00)
  - Changed "version.txt" references to "plugin.json"
  - Improved error clarity with actionable messages

---

## Session State (Tactical - This Brief)

**Current State:** Brief registered, ready for implementation
**Next Steps When Resuming:** Start with Task 1 - Replace version.txt logic
**Last Updated:** 2025-10-26 18:45
**Blockers:** None

---

## Acceptance Criteria

**The bug is fixed when:**

1. [ ] plugin_update.sh reads version from plugin.json (not version.txt)
2. [ ] Uses python3 for JSON parsing (not grep+sed)
3. [ ] Error handling for missing plugin.json
4. [ ] Error handling for corrupted JSON
5. [ ] Error handling for missing version field
6. [ ] All 19 tests in plugin_update.test.bash pass
7. [ ] Manual test: Real plugin update succeeds
8. [ ] Consistent with plugin_install.sh approach

---

## Delivery

### Code Changes
- `scripts/plugin_update.sh` - Version extraction logic
- No test changes needed (tests are correct, code was wrong)

### Documentation
- Check PLUGIN_DEVELOPMENT.md (if mentions version.txt)
- Update if necessary

### Testing
- Run full test suite: `bats test/`
- Verify plugin_update tests pass

---

## Notes

### Why This Wasn't Caught Earlier

- TD-005 (Automated Testing) was just completed
- Tests exist but were FAILING (57/136 tests failing overall)
- This bug was one of the root causes of test failures
- Bug hunt found it during script analysis

### Impact on Test Failures

This bug is responsible for:
- 19/19 plugin_update.test.bash failures
- Would have been caught if tests ran in CI/CD

**This validates the importance of TD-005 (Automated Testing).**

### Related Issues

- BR-010: Fragile JSON parsing with grep+sed (plugin_install.sh should also use python3)
- TD-005: Test failures include this bug

---

**Created:** 2025-10-26
**Last Updated:** 2025-10-26
**Brief Owner:** Igris AI Bug Hunt (Self-Maintenance Operation #2)
