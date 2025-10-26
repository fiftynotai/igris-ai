# AC-XXX: [Architecture Cleanup Title]

**Type:** Architecture Cleanup
**Priority:** [P0-Critical | P1-High | P2-Medium | P3-Low]
**Effort:** [S-Small (< 4h) | M-Medium (1-2d) | L-Large (3-5d) | XL-Extra Large (>1w)]
**Assignee:** Igris AI
**Commanded By:** [User name from persona.json if available, otherwise "Not specified"]
**Status:** [Draft | Ready | In Progress | Done]
**Created:** [YYYY-MM-DD]
**Completed:** [YYYY-MM-DD] _(if Status: Done)_

---

## Architecture Issue

**What's the problem?**

- [ ] Duplicate/redundant code (same logic in multiple places)
- [ ] Conflicting implementations (two features doing the same thing differently)
- [ ] Unused/dead code (files/functions not referenced)
- [ ] Logical inconsistency (feature A and feature B contradict)
- [ ] Poor separation of concerns (mixed responsibilities)
- [ ] Other: [specify]

**Where is it?**

[Describe the specific files/modules/components affected]

---

## Current State

**Redundancies Found:**
1. [Duplicate 1: e.g., Validation logic in 3 different files]
   - Files: `[file1.dart]`, `[file2.dart]`, `[file3.dart]`
   - Lines: [approximate locations]

2. [Duplicate 2: e.g., Two authentication methods]
   - Implementation A: [location and approach]
   - Implementation B: [location and approach]

**Conflicts Found:**
1. [Conflict 1: e.g., Feature X uses approach A, Feature Y uses approach B]
   - Why it's a problem: [explain inconsistency]

**Unused Code Found:**
1. [Unused 1: e.g., old_auth.dart - legacy authentication]
   - Last modified: [date]
   - References: 0 (grep result)
   - Safe to delete: [Yes/No - verification needed]

**Logical Issues Found:**
1. [Issue 1: e.g., Module A assumes B runs first, but B doesn't guarantee order]
   - Why it matters: [potential bug or confusion]

---

## Impact

**Why does this matter?**

**Maintainability:**
- ❌ [e.g., Bug fixes must be applied in 3 places]
- ❌ [e.g., Developers confused about which implementation to use]
- ❌ [e.g., Dead code increases codebase size and mental overhead]

**Reliability:**
- ❌ [e.g., Inconsistent behavior between features]
- ❌ [e.g., Risk of using deprecated/unmaintained code]

**Developer Experience:**
- ❌ [e.g., New developers don't know which pattern to follow]
- ❌ [e.g., Code reviews require explaining "use this, not that"]

---

## Cleanup Approach

### Strategy
[Describe the consolidation/cleanup strategy]

**Consolidation Plan:**
1. [Step 1: e.g., Create shared validation module]
2. [Step 2: e.g., Migrate all uses to shared module]
3. [Step 3: e.g., Delete duplicate implementations]

**Resolution Plan (for conflicts):**
1. [Decision: Which approach to keep and why]
2. [Migration: How to migrate from deprecated to standard]
3. [Deprecation: How to remove old approach]

**Deletion Plan (for unused code):**
1. [Verification: Confirm zero references]
2. [Backup: Archive or document before deletion]
3. [Delete: Remove files/functions]

---

## Affected Components

### Files to Modify
- `[file1.dart]` - [what changes: e.g., Use shared validation]
- `[file2.dart]` - [what changes: e.g., Remove duplicate logic]
- `[file3.dart]` - [what changes: e.g., Import shared module]

### Files to Create
- `[shared_validation.dart]` - [New consolidated module]

### Files to Delete
- `[old_auth.dart]` - [Unused legacy code]
- `[duplicate_util.dart]` - [Replaced by new shared module]

### Modules Affected
- [Module A: how it changes]
- [Module B: how it changes]

---

## Context & Inputs

### Detection Method
[How was this issue discovered?]
- [ ] ARCHITECTURE_REVIEW operation
- [ ] Code review observation
- [ ] Bug caused by inconsistency
- [ ] Manual audit
- [ ] Other: [specify]

### Dependencies
- [ ] Must consolidate [feature X] first
- [ ] Blocked by [decision on approach]
- [ ] Requires team alignment on standard

### References
- [Link to discussion about approach]
- [Link to original implementation rationale]

---

## Consolidation Details

### Canonical Implementation (What to Keep)
**Location:** `[file path]`
**Approach:** [Describe the approach]
**Why this one?**
- [Reason 1: e.g., Most complete implementation]
- [Reason 2: e.g., Better tested]
- [Reason 3: e.g., Follows current architecture standards]

### Deprecated Implementations (What to Remove)
**Location 1:** `[file path]`
**Why remove:**
- [Reason: e.g., Incomplete, buggy, or outdated]

**Location 2:** `[file path]`
**Why remove:**
- [Reason: e.g., Not maintained, inconsistent with standards]

### Migration Path
1. [Step 1: Create canonical shared module]
2. [Step 2: Update references to use canonical]
3. [Step 3: Test each migration]
4. [Step 4: Delete deprecated code]

---

## Constraints

### Architecture Rules
- Must maintain layer boundaries
- Must not introduce new anti-patterns
- Must follow coding_guidelines.md standards
- Should reduce complexity, not increase it

### Compatibility
- Must not break existing functionality
- Must maintain API compatibility (if public)
- Must not disrupt active development

### Timeline
- **Deadline:** [Date or N/A]
- **Milestones:** [Optional checkpoints]

### Out of Scope
- [Other cleanup not included in this brief]

---

## Tasks

### Pending
- [ ] Task 1: [Description of work to be done]
- [ ] Task 2: [Description of work to be done]
- [ ] Task 3: [Description of work to be done]

### In Progress
_(Tasks currently being worked on)_
- [x] Task X: [Description] (started: YYYY-MM-DD HH:MM)

### Completed
_(Finished tasks)_
- [x] Task Y: [Description] (completed: YYYY-MM-DD HH:MM)

**Note:** Update this section as you work. Mark tasks in_progress when starting, completed when done. Add timestamps.

---

## Session State (Tactical - This Brief)

**Current State:** [What you're working on RIGHT NOW in this brief]
**Next Steps When Resuming:** [Exact continuation point if interrupted]
**Last Updated:** [YYYY-MM-DD HH:MM]
**Blockers:** [Any blockers specific to this brief, or "None"]

**Note:** Strategic session state (overall plan/phase across multiple briefs) managed in `ai/session/CURRENT_SESSION.md`

---

## Acceptance Criteria

**The cleanup is complete when:**

1. [ ] All redundancies consolidated or removed
2. [ ] All conflicts resolved (one canonical approach)
3. [ ] All unused code deleted (verified zero references)
4. [ ] All references updated to use canonical implementation
5. [ ] All tests pass
6. [ ] No regressions introduced
7. [ ] Code structure clearer than before

---

## Test Plan

### Verification Tests
**Test 1: Consolidation Verification**
- [ ] Grep for old implementation: 0 results
- [ ] All uses migrated to canonical: [count] references
- [ ] Canonical implementation works: Tests pass

**Test 2: Deletion Verification**
- [ ] Deleted files not referenced: `grep -r "[filename]"` → 0 results
- [ ] Build succeeds without deleted files
- [ ] No import errors

### Regression Tests
- [ ] Feature X still works (used old implementation)
- [ ] Feature Y still works (used old implementation)
- [ ] No functionality changes (behavior identical)

---

## Delivery

### Cleanup Summary
- Redundancies removed: [count]
- Conflicts resolved: [count]
- Files deleted: [count]
- Lines of code removed: [estimate]

### Before/After

**Before:**
```
[Show messy structure - e.g., validation in 3 files]
```

**After:**
```
[Show clean structure - e.g., single shared validation module]
```

### Documentation
- [ ] Architecture map updated: [if structure changed significantly]
- [ ] Module catalog updated: [if modules added/removed]
- [ ] README updated: [if user-facing changes]
- [ ] Code comments: [Explain why canonical approach chosen]

---

## Notes

**Discovery Details:**
[How and when this issue was found]

**Decision Rationale:**
[Why we chose approach A over approach B]

**Historical Context:**
[Why duplicate/conflicting implementations existed in the first place]

**Future Prevention:**
[How to prevent this type of architecture issue going forward]

---

**Created:** [Date]
**Last Updated:** [Date]
**Brief Owner:** [Name]
