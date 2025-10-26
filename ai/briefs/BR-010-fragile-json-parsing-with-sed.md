# BR-010: Fragile JSON Parsing with grep+sed Instead of Python3

**Type:** Technical Debt
**Priority:** P2-Medium
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2025-10-26

---

## Problem

**What's broken?**

Multiple scripts use fragile `grep | sed` patterns to extract values from JSON instead of reliable python3 parsing:

**plugin_install.sh lines 103-104:**
```bash
PLUGIN_NAME=$(cat "$TEMP_DIR/plugin.json" | grep '"name"' | head -1 | sed 's/.*"name": "\(.*\)".*/\1/')
PLUGIN_VERSION=$(cat "$TEMP_DIR/plugin.json" | grep '"version"' | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
```

**plugin_update.sh lines 106-107:**
```bash
PLUGIN_REPO=$(cat ai/plugins/installed.json | grep -A 5 "\"name\": \"$PLUGIN_NAME\"" | grep '"repo"' | sed 's/.*"repo": "\([^"]*\)".*/\1/')
CURRENT_VERSION=$(cat ai/plugins/installed.json | grep -A 5 "\"name\": \"$PLUGIN_NAME\"" | grep '"version"' | sed 's/.*"version": "\([^"]*\)".*/\1/')
```

**igris_update.sh line 65:**
```bash
CURRENT_VERSION=$(cat .igris_version | grep '"igris_ai_version"' | sed 's/.*"igris_ai_version": "\([^"]*\)".*/\1/')
```

**Why is this a problem?**

- ❌ **Fragile**: Breaks with whitespace differences, formatting changes
- ❌ **Unreliable**: Could match JSON in comments or strings
- ❌ **Inconsistent**: Other parts use python3 correctly (validate_json, registry updates)
- ❌ **Violates coding_guidelines.md**: "Use Python3 for JSON operations"

**Impact:**
- Extraction fails on valid JSON with different formatting
- Bugs hard to debug (sed regex failures are silent)
- Maintenance burden (regex is cryptic)

---

## Goal

**What should happen after this fix?**

1. ✅ All JSON parsing uses python3 (consistent, reliable)
2. ✅ No grep+sed for JSON extraction
3. ✅ Follows coding_guidelines.md standard
4. ✅ More maintainable (clear python code vs cryptic regex)

**Acceptance criteria:**
- plugin_install.sh uses python3 for name/version extraction
- plugin_update.sh uses python3 for repo/version extraction
- igris_update.sh uses python3 for version extraction
- Tests pass with various JSON formatting (spaces, newlines)

---

## Context & Inputs

### Affected Files
- `scripts/plugin_install.sh` (lines 103-104)
- `scripts/plugin_update.sh` (lines 106-107)
- `scripts/igris_update.sh` (line 65)

### Why Python3 is Better

**From coding_guidelines.md Section 5:**

> **Primary Method: Python3**
> Use Python3 for JSON operations (Python3 is a required dependency)

**Example:**
```bash
# ❌ BAD (fragile sed)
NAME=$(cat file.json | grep '"name"' | sed 's/.*"name": "\(.*\)".*/\1/')

# ✅ GOOD (reliable python3)
NAME=$(python3 -c "
import json
with open('file.json', 'r') as f:
    data = json.load(f)
    print(data.get('name', ''))
")
```

### Solution Approach

Replace all grep+sed JSON extraction with python3.

**Example fix for plugin_install.sh:**

**Before:**
```bash
PLUGIN_NAME=$(cat "$TEMP_DIR/plugin.json" | grep '"name"' | head -1 | sed 's/.*"name": "\(.*\)".*/\1/')
PLUGIN_VERSION=$(cat "$TEMP_DIR/plugin.json" | grep '"version"' | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
```

**After:**
```bash
# Extract name and version using python3
PLUGIN_METADATA=$(python3 -c "
import json
with open('$TEMP_DIR/plugin.json', 'r') as f:
    data = json.load(f)
    print(data.get('name', ''))
    print(data.get('version', ''))
")
PLUGIN_NAME=$(echo "$PLUGIN_METADATA" | sed -n '1p')
PLUGIN_VERSION=$(echo "$PLUGIN_METADATA" | sed -n '2p')

# Validate not empty
if [ -z "$PLUGIN_NAME" ]; then
    echo "❌ Error: Plugin name cannot be empty"
    exit 1
fi
```

---

## Constraints

### Architecture Rules
- Must follow coding_guidelines.md
- Python3 is mandatory dependency (already validated)
- Must validate extracted values not empty

### Technical Constraints
- Must handle missing fields gracefully
- Must be as fast or faster than grep+sed
- Must work with all valid JSON formatting

---

## Test Plan

### Test 1: Standard formatting
```bash
# JSON with standard formatting
{"name": "test-plugin", "version": "1.0.0"}
# Expected: Extracts correctly
```

### Test 2: Extra whitespace
```bash
# JSON with extra whitespace
{
  "name":    "test-plugin"  ,
  "version":   "1.0.0"
}
# Expected: Extracts correctly (sed would fail)
```

### Test 3: Missing field
```bash
# JSON without version field
{"name": "test-plugin"}
# Expected: Clear error for missing version
```

---

## Tasks

### Pending
- [ ] Task 4: Test with various JSON formats
  - Standard, whitespace, minified
  - Verify all extractions work

- [ ] Task 5: Performance check
  - Ensure no regression in script execution time

### In Progress
_(None)_

### Completed
- [x] Task 1: Replace plugin_install.sh JSON extraction (completed: 2025-10-26 19:05)
  - Lines 103-112
  - Used python3 for name/version
  - Existing validation for empty values

- [x] Task 2: Replace plugin_update.sh JSON extraction (completed: 2025-10-26 19:06)
  - Lines 105-117
  - Used python3 for repo/version
  - Searches through plugins array

- [x] Task 3: Replace igris_update.sh JSON extraction (completed: 2025-10-26 19:07)
  - Lines 64-70
  - Used python3 for version
  - Uses .get() for safe extraction

---

## Session State (Tactical - This Brief)

**Current State:** Brief registered, ready for implementation
**Next Steps When Resuming:** Start with Task 1 - plugin_install.sh
**Last Updated:** 2025-10-26 18:55
**Blockers:** None

---

## Acceptance Criteria

**The technical debt is paid off when:**

1. [ ] All JSON parsing uses python3 (no grep+sed)
2. [ ] Validation added for empty extracted values
3. [ ] Tests pass with various JSON formatting
4. [ ] Follows coding_guidelines.md standard
5. [ ] No performance regression

---

## Notes

### Why This is Technical Debt

**Debt accrued:**
- Scripts written quickly using grep+sed (faster to write)
- Worked for current use cases (standard formatting)
- Not following established guidelines

**Interest paid:**
- Fragility: Breaks on valid but differently-formatted JSON
- Maintenance: Regex hard to understand and modify
- Inconsistency: Other parts use python3

**Return on fixing:**
- Reliability: Works with all valid JSON
- Maintainability: Python code is clear
- Consistency: Follows project standards

### Related Issues

- BR-007: plugin_update.sh version extraction (needs python3)
- TD-007: Coding guidelines created (documents python3 requirement)

---

**Created:** 2025-10-26
**Last Updated:** 2025-10-26
**Brief Owner:** Igris AI Bug Hunt
