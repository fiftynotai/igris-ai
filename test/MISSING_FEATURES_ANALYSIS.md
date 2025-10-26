# Missing Features & Failing Tests Analysis

**Date:** 2025-10-26
**Test Suite Status:** 136 total | 55 passing (40%) | 20 failing | 12 skipped

---

## Executive Summary

After fixing 6 critical bugs, the test suite improved from 39% to 40% pass rate. However, **20 tests are still failing** and **12 tests are intentionally skipped** due to missing features or unclear implementation requirements.

This document categorizes both the **failing tests** (need fixes) and **skipped tests** (need features or decisions).

---

## Part 1: Missing Features (Skipped Tests)

### Found 17 `skip` Directives in Test Suite

**Category 1: Dependency Mocking (5 tests)**

**Missing Feature:** Test infrastructure to mock missing dependencies (Python3, jq)

**Location:** `test/error_handling.test.bash`
- Line 19: `skip "Requires ability to mock missing Python3"`
- Line 27: `skip "Requires ability to mock missing Python3"`
- Line 33: `skip "Requires ability to mock missing Python3"`
- Line 39: `skip "Requires ability to mock missing Python3"`
- Line 46: `skip "Requires ability to mock missing jq"`

**Decision Needed:**
- ✅ **Option A:** Implement mock dependency infrastructure (PATH manipulation, fake binaries)
- ✅ **Option B:** Remove these tests (low priority - users will see real errors anyway)
- ✅ **Option C:** Mark as "requires manual testing" and skip permanently

**Recommendation:** Option B - Remove tests. These are edge cases covered by real-world usage.

---

**Category 2: Plugin Directory Structure (4 tests)**

**Missing Feature:** Clarification of plugin installation directory structure and naming rules

**Location:**
- `test/plugin_uninstall.test.bash:112` - `skip "Test depends on plugin installation directory structure"`
- `test/plugin_uninstall.test.bash:119` - `skip "Test depends on plugin installation directory structure"`
- `test/plugin_uninstall.test.bash:376` - `skip "Test depends on plugin naming validation rules"`
- `test/plugin_update.test.bash:151` - `skip "Test depends on plugin installation directory structure"`

**Decision Needed:**
- ✅ **Option A:** Define plugin installation directory structure clearly
  - Where do plugin files go? (.claude/plugins/ or ai/plugins/ or both?)
  - How are they organized? (by plugin name?)
- ✅ **Option B:** Remove tests - structure is implementation detail
- ✅ **Option C:** Document current behavior and update tests to match

**Recommendation:** Option C - Document current behavior. Plugins don't install files separately; they inject content into CLAUDE.md via hooks.

**Action:** Document in `docs/PLUGIN_ARCHITECTURE.md`:
```markdown
## Plugin Installation Model

Igris AI plugins do NOT install files to a plugin directory. Instead:
1. Plugin metadata stored in `ai/plugins/installed.json`
2. Plugin hooks inject content into `CLAUDE.md` at runtime
3. No persistent plugin files in project (except registry)
```

Then update/remove these 4 tests accordingly.

---

**Category 3: Complex Testing Scenarios (3 tests)**

**Missing Feature:** Advanced testing infrastructure

**Location:**
- `test/error_handling.test.bash:329` - `skip "Concurrent test requires parallel execution support"`
- `test/error_handling.test.bash:340` - `skip "Requires manual corruption of plugin state"`
- `test/error_handling.test.bash:363` - `skip "Security test - may not be applicable"`

**Decision Needed:**
- ✅ **Option A:** Implement concurrent test infrastructure (complex, low ROI)
- ✅ **Option B:** Remove tests - not critical for v2.x
- ✅ **Option C:** Keep skipped as future enhancements

**Recommendation:** Option C - Keep skipped. Label as "future enhancement" tests.

---

**Category 4: Permission Testing (2 tests)**

**Missing Feature:** Reliable permission testing infrastructure

**Location:**
- `test/error_handling.test.bash:187` - `skip "Requires permission manipulation which may fail in CI"`
- `test/error_handling.test.bash:198` - `skip "Requires permission manipulation which may fail in CI"`

**Decision Needed:**
- ✅ **Option A:** Implement CI-safe permission testing (platform-specific)
- ✅ **Option B:** Remove tests - permission errors are OS-level
- ✅ **Option C:** Keep skipped with note "manual testing only"

**Recommendation:** Option C - Keep skipped. Add manual test checklist to docs.

---

**Category 5: Implementation Unclear (2 tests)**

**Missing Feature:** Plugin data persistence implementation

**Location:**
- `test/plugin_update.test.bash:129` - `skip "Implementation depends on plugin data storage pattern"`
- `test/error_handling.test.bash:208` - `skip "Requires modifying Igris AI installation"`

**Decision Needed:**
- ✅ **Clarify:** How do plugins store persistent data?
- ✅ **Clarify:** Can tests modify Igris AI installation directory?

**Recommendation:** Document plugin data model, then update/remove tests.

---

**Category 6: Platform-Specific (1 test)**

**Missing Feature:** Platform-specific test handling

**Location:**
- `test/edge_cases.test.bash:455` - `skip "Backslash handling is platform-specific"`

**Decision Needed:**
- ✅ **Option A:** Implement platform detection in tests
- ✅ **Option B:** Remove test - edge case
- ✅ **Option C:** Document platform differences

**Recommendation:** Option B - Remove test. Backslash edge case is minor.

---

## Part 2: Failing Tests (Need Fixes)

### 20 Tests Currently Failing

**Category 1: Persona Content Handling (7 tests) 🔥 HIGH PRIORITY**

**Root Cause:** plugin_install.sh likely not preserving multi-line, whitespace, or special characters in persona content when injecting into CLAUDE.md.

**Failing Tests:**
1. `plugin_install preserves multi-line persona content`
2. `plugin_install handles persona with blank lines`
3. `plugin_install handles persona with markdown formatting`
4. `plugin_install handles unicode in persona content`
5. `plugin_install handles leading whitespace in persona`
6. `plugin_install handles multi-line persona content correctly`
7. `plugin_install preserves line breaks in persona injection`

**Investigation Needed:**
- Read: `scripts/plugin_install.sh` (persona injection logic)
- Identify: How is persona content read and written to CLAUDE.md?
- Fix: Ensure proper quoting, escaping, and newline preservation

**Likely Bug Location:** `scripts/plugin_install.sh` lines 150-200 (persona injection)

---

**Category 2: Corrupted JSON Handling (4 tests) 🟡 MEDIUM PRIORITY**

**Root Cause:** Scripts may not gracefully handle corrupted or missing JSON files.

**Failing Tests:**
1. `plugin_install handles corrupted plugin.json`
2. `plugin_update handles corrupted installed.json`
3. `plugin_uninstall handles corrupted installed.json`
4. `plugin_uninstall handles missing installed.json`

**Investigation Needed:**
- Check: Do scripts validate JSON before parsing?
- Fix: Add JSON validation with clear error messages

**Likely Fix:** Add Python JSON validation before operations:
```bash
# Validate JSON before processing
if ! python3 -c "import json; json.load(open('file.json'))" 2>/dev/null; then
  echo "❌ Error: Corrupted JSON file"
  exit 1
fi
```

---

**Category 3: Registry Issues (2 tests) 🟡 MEDIUM PRIORITY**

**Failing Tests:**
1. `plugin_install creates installed.json if missing`
2. `plugin_install stores plugin location in registry`

**Investigation Needed:**
- Test: Does plugin_install.sh create `ai/plugins/installed.json` if missing?
- Test: Does registry store plugin source location?

**Likely Fix:** Add registry initialization logic if file doesn't exist.

---

**Category 4: Validation Issues (4 tests) 🟡 MEDIUM PRIORITY**

**Failing Tests:**
1. `plugin_install rejects non-directory path`
2. `plugin_install handles missing plugin.json`
3. `plugin_install handles plugin with empty name`
4. `plugin_install handles version with build metadata`

**Investigation Needed:**
- Check: Does plugin_install.sh validate inputs properly?
- Fix: Add validation for directory paths, required files, non-empty names

---

**Category 5: Initialization Issues (2 tests) 🟢 LOW PRIORITY**

**Failing Tests:**
1. `igris_init detects existing installation`
2. `igris_init creates persona.json.default with correct structure`

**Investigation Needed:**
- Test: Does igris_init.sh check for existing installations?
- Test: Is persona.json.default structured correctly?

**Note:** We already fixed persona.json.default copying in previous session. May just need assertion adjustment.

---

**Category 6: Complex Scenarios (1 test) 🟢 LOW PRIORITY**

**Failing Test:**
1. `plugin_install handles complex real-world scenario`

**Investigation Needed:**
- Read test to understand what "complex real-world scenario" means
- Fix or remove if test is overly complex

---

## Prioritized Action Plan

### Phase 1: Fix Persona Handling (7 tests) 🔥
**Impact:** HIGH - Core plugin functionality broken
**Effort:** MEDIUM - Likely 1-2 hour fix

**Tasks:**
1. Investigate persona injection in `scripts/plugin_install.sh`
2. Fix multi-line, whitespace, and special character handling
3. Ensure proper quoting and escaping
4. Re-run persona tests to verify fix

**Expected Result:** +7 passing tests (55 → 62, ~46% pass rate)

---

### Phase 2: Add JSON Validation (4 tests) 🟡
**Impact:** MEDIUM - Better error handling
**Effort:** LOW - 30 minutes

**Tasks:**
1. Add JSON validation function to scripts
2. Call validation before JSON parsing
3. Add clear error messages for corrupted files

**Expected Result:** +4 passing tests (62 → 66, ~49% pass rate)

---

### Phase 3: Fix Registry & Validation (6 tests) 🟡
**Impact:** MEDIUM - Edge cases and validation
**Effort:** MEDIUM - 1 hour

**Tasks:**
1. Add registry initialization if missing
2. Add input validation (paths, names, versions)
3. Test edge cases

**Expected Result:** +6 passing tests (66 → 72, ~53% pass rate)

---

### Phase 4: Fix Initialization (2 tests) 🟢
**Impact:** LOW - Already mostly working
**Effort:** LOW - 15 minutes

**Tasks:**
1. Add existing installation detection
2. Verify persona.json.default structure
3. Adjust assertions if needed

**Expected Result:** +2 passing tests (72 → 74, ~54% pass rate)

---

### Phase 5: Handle Complex Scenario (1 test) 🟢
**Impact:** LOW - Single test
**Effort:** UNKNOWN - Depends on test complexity

**Tasks:**
1. Read test to understand requirements
2. Fix or remove if overly complex

**Expected Result:** +1 passing test (74 → 75, ~55% pass rate)

---

### Phase 6: Decide on Skipped Tests (12 tests)
**Impact:** MEDIUM - Clarity and completeness
**Effort:** LOW - Decisions and documentation

**Tasks:**
1. Review each skipped test category
2. Decide: Implement feature / Remove test / Keep skipped
3. Document decisions
4. Update tests accordingly

**Expected Result:** Clean test suite with clear status for all tests

---

## Summary of Missing Features

### Features to Implement (High Priority):
1. ✅ **Persona multi-line handling** - Fix existing bug (affects 7 tests)
2. ✅ **JSON validation** - Add to existing scripts (affects 4 tests)
3. ✅ **Input validation** - Add to existing scripts (affects 4 tests)

### Features to Document (Medium Priority):
4. 📝 **Plugin directory structure** - Document current model (affects 4 tests)
5. 📝 **Plugin data persistence** - Clarify model (affects 2 tests)

### Features to Decide (Low Priority):
6. 🤔 **Dependency mocking** - Implement or remove? (affects 5 tests)
7. 🤔 **Permission testing** - Keep skipped or remove? (affects 2 tests)
8. 🤔 **Concurrent testing** - Future enhancement? (affects 3 tests)
9. 🤔 **Platform-specific tests** - Remove? (affects 1 test)

---

## Expected Outcomes

### If We Complete Phase 1-5:
- **Pass rate:** 55% → ~55% (75/136 tests passing)
- **Failing tests:** 20 → 0
- **Skipped tests:** 12 (unchanged, awaiting decisions)
- **Status:** All critical bugs fixed

### If We Also Resolve Phase 6:
- **Pass rate:** Variable (depends on decisions)
- **Failing tests:** 0
- **Skipped tests:** 0-12 (depends on decisions)
- **Status:** Test suite 100% actionable (no ambiguity)

---

## Recommended Next Steps

**Immediate (Next 2-4 hours):**
1. **Fix persona handling bug** (Phase 1) - Highest impact
2. **Add JSON validation** (Phase 2) - Quick win
3. **Fix registry & validation** (Phase 3) - Medium effort, good impact

**Short-term (Next session):**
4. **Fix initialization tests** (Phase 4) - Easy cleanup
5. **Document plugin architecture** - Clarify model for future development

**Long-term (After v2.1):**
6. **Decide on skipped tests** (Phase 6) - Strategic decision
7. **Consider test infrastructure enhancements** - If needed for v3.0

---

**Created:** 2025-10-26
**Analysis By:** Igris AI
**Next Action:** Begin Phase 1 (Fix persona handling bug)
