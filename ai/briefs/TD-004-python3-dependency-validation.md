# TD-004: Add Python3 Dependency Validation to All Scripts

**Type:** Technical Debt
**Priority:** P1-High
**Effort:** S-Small (< 4h)
**Assignee:** AI Assistant
**Status:** Done
**Completed:** 2025-10-25

---

## What is the Technical Debt?

**Current situation:**

Multiple Igris AI scripts use Python3 for JSON manipulation (6 scripts, 10+ invocations), but **none of them validate** that Python3 is installed before executing.

**Why is it technical debt?**

- README claims "Requires Python 3" but scripts don't enforce this
- Scripts fail with cryptic errors like "python3: command not found"
- Poor user experience - no clear guidance on fixing the issue
- Violates fail-fast principle (should validate dependencies upfront)

**Examples:**

```bash
# Current code (NO VALIDATION):
python3 <<EOF > "$TEMP_JSON"
import json
# ... JSON manipulation ...
EOF
# If python3 doesn't exist: "bash: python3: command not found"
```

**Affected locations:**
- `plugin_install.sh` (lines 103, 144)
- `plugin_list.sh` (lines 17, 33)
- `plugin_uninstall.sh` (lines 41, 68)
- `plugin_update.sh` (lines 184, 212)
- `igris_update.sh` (line 206)
- `install_shell_integration.sh` (lines 62, 130)

---

## Why It Matters

**Consequences of not fixing:**

- [x] **Maintainability:** Hard to debug - error messages don't indicate the root cause
- [ ] **Readability:** (Not affected)
- [ ] **Performance:** (Not affected)
- [x] **Security:** (Not affected but poor error handling)
- [ ] **Scalability:** (Not affected)
- [x] **Developer Experience:** Users get frustrated with unhelpful errors

**Impact:** High

New users installing Igris AI for the first time may:
1. Run script
2. Get cryptic "python3: command not found" error
3. Not know how to fix it
4. Abandon Igris AI

---

## Cleanup Steps

**How to pay off this debt:**

1. [ ] Create validation function in each script (or shared utility)
2. [ ] Add Python3 check at script start (before any operations)
3. [ ] Provide helpful error message with installation link
4. [ ] Test on system without Python3 (verify error message)
5. [ ] Update CHANGELOG.md

---

## Benefits of Fixing

**What improves after cleanup:**

- ✅ **Clear error messages** - Users immediately know Python3 is missing
- ✅ **Helpful guidance** - Error includes link to download Python3
- ✅ **Fail-fast** - Scripts exit early instead of mysterious failures
- ✅ **Better UX** - Matches README claim ("Requires Python 3")
- ✅ **Consistency** - All scripts validate dependencies the same way

**Return on Investment:** High

Simple fix (< 1 hour) with significant UX improvement.

---

## Affected Areas

### Files
- `scripts/plugin_install.sh` - Add validation function
- `scripts/plugin_list.sh` - Add validation function
- `scripts/plugin_uninstall.sh` - Add validation function
- `scripts/plugin_update.sh` - Add validation function
- `scripts/igris_update.sh` - Add validation function
- `scripts/install_shell_integration.sh` - Add validation function

### Modules
- Plugin system - All plugin operations
- Update system - Version tracking
- Shell integration - Version display

### Count
**Total files affected:** 6
**Total lines to add:** ~60 (10 lines per script: function + call)

---

## Testing

### Regression Testing
- [ ] All scripts still work with Python3 installed
- [ ] JSON manipulation still functions correctly
- [ ] No functionality changes

### Verification
**How to verify cleanup is successful:**

1. Remove Python3 from PATH temporarily
2. Run each affected script
3. Verify clear error message appears
4. Verify script exits gracefully (no cryptic errors)
5. Restore Python3, verify all scripts work normally

---

## Acceptance Criteria

**The debt is paid off when:**

1. [ ] All 6 scripts validate Python3 before use
2. [ ] Clear error message displayed if missing
3. [ ] Error message includes installation link
4. [ ] Scripts exit immediately (fail-fast)
5. [ ] shellcheck passes (zero issues)
6. [ ] All existing functionality works
7. [ ] Tested without Python3 installed

---

## Implementation Design

### Validation Function (add to each script)

```bash
#!/bin/bash

# Check Python3 dependency
check_python3() {
  if ! command -v python3 &> /dev/null; then
    echo "❌ Error: Python 3 is required but not installed"
    echo ""
    echo "Install Python 3:"
    echo "  macOS: brew install python3"
    echo "  Ubuntu: sudo apt install python3"
    echo "  Download: https://www.python.org/downloads/"
    echo ""
    exit 1
  fi
}

# Call at script start (after set -e)
set -e
check_python3

# ... rest of script
```

### Alternative: Shared Utility

Create `scripts/common.sh` with shared validation functions:

```bash
# scripts/common.sh
check_python3() {
  if ! command -v python3 &> /dev/null; then
    echo "❌ Error: Python 3 is required but not installed"
    echo ""
    echo "Install Python 3:"
    echo "  macOS: brew install python3"
    echo "  Ubuntu: sudo apt install python3"
    echo "  Download: https://www.python.org/downloads/"
    echo ""
    exit 1
  fi
}

check_jq() {
  # Future: jq validation
}
```

Then source in each script:
```bash
source "$(dirname "$0")/common.sh"
check_python3
```

**Recommendation:** Start with inline function (simpler), refactor to shared utility later if needed.

---

## References

**Coding Guidelines:**
- N/A (need to create for Igris AI - see TD-007)

**Best Practices:**
- Fail-fast principle
- Helpful error messages
- Dependency validation upfront

**Related Briefs:**
- TD-006 - Inconsistent jq Dependency Handling (similar issue)
- TD-007 - Missing Coding Guidelines (would document this pattern)

---

## Notes

### Current Error Example (Unhelpful)

```bash
$ ./scripts/plugin_install.sh https://github.com/user/plugin
📦 Cloning plugin...
📋 Plugin: my-plugin v1.0.0
🔧 Running plugin installation...
📝 Registering plugin...
./scripts/plugin_install.sh: line 103: python3: command not found
⚠️  Warning: Failed to update plugin registry
```

User doesn't know:
- Python3 is missing
- How to install it
- Whether this is expected

### Improved Error (Helpful)

```bash
$ ./scripts/plugin_install.sh https://github.com/user/plugin
❌ Error: Python 3 is required but not installed

Install Python 3:
  macOS: brew install python3
  Ubuntu: sudo apt install python3
  Download: https://www.python.org/downloads/
```

User immediately knows:
- ✅ What's missing
- ✅ How to fix it
- ✅ Where to get it

---

**Created:** 2025-10-25
**Last Updated:** 2025-10-25
**Brief Owner:** Igris AI Self-Audit
