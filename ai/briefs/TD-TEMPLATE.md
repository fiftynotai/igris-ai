# TD-XXX: [Technical Debt Title]

**Type:** Technical Debt
**Priority:** [P0-Critical | P1-High | P2-Medium | P3-Low]
**Effort:** [S-Small (< 4h) | M-Medium (1-2d) | L-Large (3-5d) | XL-Extra Large (>1w)]
**Assignee:** [AI Assistant | Human Developer]
**Status:** [Draft | Ready | In Progress | In Review | Done]

---

## What is the Technical Debt?

**Current situation:**

[Describe what exists now that works but needs improvement]

**Why is it technical debt?**

[Explain why this is debt - e.g., works but hard to maintain, violates best practices, etc.]

**Examples:**
```[language]
// Current code showing the debt
[code snippet]
```

---

## Why It Matters

**Consequences of not fixing:**

- [ ] **Maintainability:** [How it makes code harder to maintain]
- [ ] **Readability:** [How it makes code harder to understand]
- [ ] **Performance:** [Any performance implications]
- [ ] **Security:** [Any security implications]
- [ ] **Scalability:** [How it limits future growth]
- [ ] **Developer Experience:** [How it slows down development]

**Impact:** [High/Medium/Low]

---

## Cleanup Steps

**How to pay off this debt:**

1. [ ] [Step 1 - e.g., Extract magic numbers to constants]
2. [ ] [Step 2 - e.g., Create constants file]
3. [ ] [Step 3 - e.g., Replace all occurrences]
4. [ ] [Step 4 - e.g., Update documentation]
5. [ ] [Step 5 - e.g., Run tests]

---

## Benefits of Fixing

**What improves after cleanup:**

- ✅ [Benefit 1 - e.g., Easier to update values in one place]
- ✅ [Benefit 2 - e.g., Self-documenting code]
- ✅ [Benefit 3 - e.g., Reduces duplication]
- ✅ [Benefit 4 - e.g., Follows best practices]

**Return on Investment:** [High/Medium/Low]

---

## Affected Areas

### Files
- `path/to/file1.dart` - [what needs cleanup]
- `path/to/file2.dart` - [what needs cleanup]
- [... list all affected files]

### Modules
- `module_name` - [impact description]

### Count
**Total files affected:** [number]
**Total lines to change:** [approximate]

---

## Testing

### Regression Testing
- [ ] Existing tests still pass
- [ ] No functionality changes
- [ ] Only code quality improvements

### Verification
**How to verify cleanup is successful:**

1. [Verification step 1]
2. [Verification step 2]
3. [Verification step 3]

---

## Acceptance Criteria

**The debt is paid off when:**

1. [ ] Code follows best practices
2. [ ] All affected files updated
3. [ ] No hardcoded values / magic numbers / duplication (whatever the debt was)
4. [ ] `flutter analyze` passes (zero issues)
5. [ ] All existing tests pass
6. [ ] No functionality changes (refactoring only)
7. [ ] Code is more maintainable/readable

---

## References

**Coding Guidelines:**
- [Link to coding_guidelines.md section]

**Best Practices:**
- [Link to external best practice guide if applicable]

**Related Briefs:**
- [TD-XXX if related cleanup tasks]

---

## Notes

[Any additional context, before/after examples, or considerations]

---

**Created:** [Date]
**Last Updated:** [Date]
**Brief Owner:** [Name]
