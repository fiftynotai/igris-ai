# BR-009: plugin_list.sh Missing set -e and Has IndexError Risk

**Type:** Bug Fix
**Priority:** P1-High
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2025-10-26

---

## Problem

**What's broken?**

**Issue 1: Missing `set -e`**

`scripts/plugin_list.sh` is the ONLY script that doesn't have `set -e`:

```bash
#!/bin/bash

# Igris AI Plugin Lister
# (NO set -e here!)
```

**Impact:**
- Errors don't cause script to exit
- Script continues after failures
- Cryptic error messages instead of early termination

**Issue 2: IndexError on empty capabilities**

```python
# Line 59-60 in plugin_list.sh
if isinstance(caps[0], list):
    caps = caps[0]  # Flatten nested list
```

**Bug:** If `capabilities` is an empty list `[]`, accessing `caps[0]` raises `IndexError`.

**Impact:**
- Plugin list crashes if any plugin has empty capabilities
- User gets Python traceback instead of clean output
- Violates coding_guidelines.md (proper error handling)

---

## Goal

**What should happen after this fix?**

1. ✅ Add `set -e` to plugin_list.sh (consistent with all other scripts)
2. ✅ Fix IndexError by checking if list is empty before accessing
3. ✅ Script fails fast on errors
4. ✅ No Python tracebacks on valid (but empty) data

**Acceptance criteria:**
- `set -e` on line 6 (after shebang and comments)
- Empty capabilities handled gracefully
- No IndexError on `caps[0]` access
- Tests pass with empty capabilities fixture

---

## Context & Inputs

### Affected Files
- `scripts/plugin_list.sh` (line 6: add set -e, line 59-60: fix IndexError)

### Root Cause

**Why missing `set -e`?**

Likely copy-paste error or oversight. All other 8 scripts have `set -e`.

**Why IndexError risk?**

Python code assumes capabilities list is non-empty, but schema allows `"capabilities": []`.

---

## Solution

**Fix 1: Add set -e**

```bash
#!/bin/bash

# Igris AI Plugin Lister
# Lists all installed Igris AI plugins

set -e  # ADD THIS LINE

# Check Python3 dependency
check_python3() {
  # ...
}
```

**Fix 2: Check list before accessing**

**Before:**
```python
if isinstance(caps[0], list):
    caps = caps[0]  # Flatten nested list
```

**After:**
```python
if caps and isinstance(caps[0], list):
    caps = caps[0]  # Flatten nested list
```

---

## Constraints

### Architecture Rules
- Must follow coding_guidelines.md
- All scripts MUST have `set -e` (fail-fast principle)
- Proper error handling (no unhandled exceptions)

### Technical Constraints
- Must handle empty capabilities gracefully (valid schema)
- Must handle nested list format (old format compatibility)

---

## Test Plan

### Test 1: Plugin with empty capabilities
```bash
# Setup: Create mock plugin with "capabilities": []
# Execute: ./scripts/plugin_list.sh
# Expected: No IndexError, shows plugin with no capabilities
```

### Test 2: Plugin with nested capabilities (old format)
```bash
# Setup: Plugin with "capabilities": [["feature1", "feature2"]]
# Execute: ./scripts/plugin_list.sh
# Expected: Flattens correctly, shows: feature1, feature2
```

### Test 3: set -e enforcement
```bash
# Setup: Corrupt installed.json
# Execute: ./scripts/plugin_list.sh
# Expected: Exits immediately with python3 error (not cryptic later error)
```

---

## Tasks

### Pending
- [ ] Task 3: Test with empty capabilities fixture
- [ ] Task 4: Test with nested capabilities
- [ ] Task 5: Verify set -e works (test with corrupted input)

### In Progress
_(None)_

### Completed
- [x] Task 1: Add `set -e` on line 6 (completed: 2025-10-26 19:02)
- [x] Task 2: Fix IndexError by adding `caps and` check (completed: 2025-10-26 19:02)

---

## Session State (Tactical - This Brief)

**Current State:** Brief registered, ready for implementation
**Next Steps When Resuming:** Start with Task 1 - Add set -e
**Last Updated:** 2025-10-26 18:52
**Blockers:** None

---

## Acceptance Criteria

**The bug is fixed when:**

1. [ ] `set -e` added on line 6
2. [ ] IndexError fix: `if caps and isinstance(caps[0], list)`
3. [ ] Test with empty capabilities passes
4. [ ] Test with nested capabilities passes
5. [ ] Test with corrupted JSON fails fast (set -e working)

---

## Notes

### Coding Guidelines Violation

From `ai/context/coding_guidelines.md`:

> **Fail-Fast (MANDATORY)**
> Every script MUST start with:
> ```bash
> #!/bin/bash
> set -e  # Exit immediately if a command exits with non-zero status
> ```

**plugin_list.sh violates this rule.**

### Why This Matters

**Without `set -e`:**
```bash
# Python3 check fails (not installed)
# Script continues...
# Later: cryptic error "python3: command not found" buried in output
```

**With `set -e`:**
```bash
# Python3 check fails
# Script exits IMMEDIATELY with clear error
# User sees: "❌ Error: Python 3 is required but not installed"
```

---

**Created:** 2025-10-26
**Last Updated:** 2025-10-26
**Brief Owner:** Igris AI Bug Hunt
