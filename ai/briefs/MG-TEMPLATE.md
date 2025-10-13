# MG-XXX: [Migration Task Title]

**Type:** Migration
**Priority:** [P0-Critical | P1-High | P2-Medium | P3-Low]
**Effort:** [S-Small (< 4h) | M-Medium (1-2d) | L-Large (3-5d) | XL-Extra Large (>1w)]
**Assignee:** [AI Assistant | Human Developer]
**Status:** [Draft | Ready | In Progress | In Review | Done]

---

## Current State

**What's the problem with the current implementation?**

[Describe how the code currently works and why it doesn't meet architecture standards]

**Why does it need to change?**

[Explain the architectural principle being violated and the impact]

**Example of current code:**
```[language]
// Current implementation
[code snippet showing the violation]
```

---

## Target State

**What should it look like after migration?**

[Describe the desired state that follows architecture standards]

**Example of target code:**
```[language]
// Target implementation
[code snippet showing correct pattern]
```

---

## Migration Steps

**Step-by-step plan to migrate:**

1. [ ] [Step 1 - e.g., Create new Actions file]
2. [ ] [Step 2 - e.g., Move UI logic from ViewModel to Actions]
3. [ ] [Step 3 - e.g., Update View to call Actions instead of ViewModel]
4. [ ] [Step 4 - e.g., Remove old UI logic from ViewModel]
5. [ ] [Step 5 - e.g., Update tests]
6. [ ] [Step 6 - e.g., Run full test suite]

---

## Impact Assessment

### Affected Files
- [ ] `path/to/file1.dart` - [what changes]
- [ ] `path/to/file2.dart` - [what changes]
- [ ] `path/to/file3.dart` - [what changes]

### Affected Modules
- [ ] `module_name` - [impact description]

### Breaking Changes
- [ ] **Yes** - [describe breaking changes]
- [x] **No** - Internal refactoring only

### Dependencies
- [ ] Depends on: [MG-XXX, BR-XXX if any]
- [ ] Blocks: [MG-XXX, BR-XXX if any]

---

## Testing Strategy

### Existing Tests
- [ ] Update existing unit tests: [list which tests]
- [ ] Update existing widget tests: [list which tests]
- [ ] Existing tests still pass: Yes/No

### New Tests Required
- [ ] New unit tests: [describe what to test]
- [ ] New widget tests: [describe what to test]
- [ ] Integration tests: [describe what to test]

### Manual Testing
**Test Cases:**

#### Test Case 1: [Scenario Name]
**Steps:**
1. [Action 1]
2. [Action 2]
3. [Action 3]

**Expected:** [What should happen]
**Status:** [ ] Pass / [ ] Fail

---

## Rollback Plan

**If migration causes issues:**

1. [Step 1 to rollback - e.g., Revert commit]
2. [Step 2 to rollback - e.g., Restore old files]
3. [Step 3 to rollback - e.g., Run old tests]

**Rollback safe until:** [e.g., "Safe until merged to main" or "Safe until deployed"]

---

## Acceptance Criteria

**The migration is complete when:**

1. [ ] Code follows architecture pattern (layers respected)
2. [ ] All affected tests pass
3. [ ] `flutter analyze` passes (zero issues)
4. [ ] Manual smoke test performed
5. [ ] Code reviewed and approved
6. [ ] Documentation updated (if needed)
7. [ ] No regressions in existing functionality

---

## References

**Architecture Documentation:**
- [Link to architecture_map.md section]
- [Link to coding_guidelines.md section]

**Related Briefs:**
- [MG-XXX, BR-XXX if related]

**External References:**
- [Link to base architecture repo if applicable]
- [Link to style guide if applicable]

---

## Notes

[Any additional context, screenshots, diagrams, or open questions]

---

**Created:** [Date]
**Last Updated:** [Date]
**Brief Owner:** [Name]
