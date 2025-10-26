# DU-XXX: [Dependency Update Title]

**Type:** Dependency Update
**Priority:** [P0-Critical | P1-High | P2-Medium | P3-Low]
**Effort:** [S-Small (< 4h) | M-Medium (1-2d) | L-Large (3-5d) | XL-Extra Large (>1w)]
**Assignee:** Igris AI
**Commanded By:** [User name from persona.json if available, otherwise "Not specified"]
**Status:** [Draft | Ready | In Progress | Done]
**Created:** [YYYY-MM-DD]
**Completed:** [YYYY-MM-DD] _(if Status: Done)_

---

## Dependency Details

**Dependency Name:** [Package/library/tool name]
**Current Version:** [x.y.z]
**Target Version:** [x.y.z]
**Type:** [Runtime | Development | Build | System]

---

## Why Update?

### Reason for Update
- [ ] Security vulnerability (CVE: [number])
- [ ] Bug fix needed
- [ ] New feature required
- [ ] Deprecation/EOL (End of Life: [date])
- [ ] Performance improvement
- [ ] Compatibility requirement
- [ ] Other: [specify]

**Details:**
[Explain the specific reason for this update. Link to security advisories, bug reports, or deprecation notices.]

**Urgency:**
[Why this priority? What happens if we don't update?]

---

## Impact Analysis

### Breaking Changes
- [ ] No breaking changes (minor/patch update)
- [ ] Breaking changes present (major update)

**If breaking changes exist, list them:**
1. [Breaking change 1: what changed, what breaks]
2. [Breaking change 2: what changed, what breaks]

### Affected Components
- [Component/module 1: how it uses this dependency]
- [Component/module 2: how it uses this dependency]
- [Component/module 3: how it uses this dependency]

### Compatibility Matrix
| Dependency | Current | Target | Compatible? |
|------------|---------|--------|-------------|
| [Related dep 1] | x.y.z | x.y.z | ✅ Yes / ❌ No |
| [Related dep 2] | x.y.z | x.y.z | ✅ Yes / ❌ No |

---

## Migration Steps

### Pre-Update
1. [ ] Review changelog: [Link to CHANGELOG]
2. [ ] Review migration guide: [Link if available]
3. [ ] Backup current state: [How to rollback]
4. [ ] Run current tests: [Ensure baseline passes]

### Update Process
1. [ ] Update dependency declaration: [file to modify]
2. [ ] Install new version: [command to run]
3. [ ] Update code for breaking changes: [what needs changing]
4. [ ] Update configuration: [config files to modify]
5. [ ] Update documentation: [docs to update]

### Post-Update
1. [ ] Run test suite: [Verify all tests pass]
2. [ ] Run linter/analyzer: [Check for warnings]
3. [ ] Manual smoke test: [Critical paths to verify]
4. [ ] Performance check: [Benchmark if relevant]

---

## Rollback Plan

**If update fails, how to rollback:**
1. [Step 1: e.g., Revert dependency version]
2. [Step 2: e.g., Restore backup config]
3. [Step 3: e.g., Re-run tests to confirm rollback]

**Rollback time estimate:** [e.g., < 15 minutes]

---

## Context & Inputs

### Files to Modify
- `[package.json / pubspec.yaml / requirements.txt / etc.]` - Update version
- [Other files affected by breaking changes]

### Dependencies (Cascading Updates)
- [ ] Must update [related package] first
- [ ] Can update [related package] together
- [ ] Will trigger update of [downstream package]

### References
- **Changelog:** [Link to dependency changelog]
- **Migration Guide:** [Link if available]
- **Security Advisory:** [Link if security update]
- **Release Notes:** [Link to version release notes]

---

## Constraints

### Compatibility Requirements
- Must work with [platform/framework] version [x.y.z]
- Must not break integration with [system X]
- Must maintain support for [platform Y]

### Timeline
- **Deadline:** [Date or N/A - especially urgent for security]
- **Security Patch Date:** [If CVE, when patch released]

### Out of Scope
- [Other updates not included in this brief]
- [Future updates to plan separately]

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

**The update is complete when:**

1. [ ] Dependency updated to target version
2. [ ] All breaking changes addressed
3. [ ] All tests pass (existing + new if needed)
4. [ ] Linter/analyzer passes with zero issues
5. [ ] Manual smoke test passed
6. [ ] Documentation updated (if API changes)
7. [ ] No performance regressions
8. [ ] Rollback plan tested (optional but recommended)

---

## Test Plan

### Automated Tests
- [ ] Existing test suite passes: [command to run]
- [ ] New tests added for new features: [if using new features]
- [ ] Integration tests pass: [if applicable]

### Manual Tests
**Test Case 1: [Critical Path Affected by Update]**
**Steps:**
1. [Action 1]
2. [Action 2]

**Expected Result:** [What should happen]
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] Feature X still works (uses this dependency)
- [ ] Feature Y not affected
- [ ] Performance not degraded

---

## Delivery

### Changes Summary
- Dependency: [name] `[old version]` → `[new version]`
- Breaking changes addressed: [count]
- Files modified: [count]
- Tests updated: [Yes/No]

### Documentation
- [ ] CHANGELOG.md: [Add entry]
- [ ] README.md: [Update if dependency version matters]
- [ ] Setup guide: [Update if installation changed]

### Communication
- [ ] Team notified: [If breaking changes affect workflow]
- [ ] Users notified: [If user-facing changes]

---

## Notes

**Version Comparison:**
- **[Old version]:** [Key characteristics]
- **[New version]:** [What's new, what changed]

**Additional Context:**
[Links to discussions, rationale for timing, related updates planned]

---

**Created:** [Date]
**Last Updated:** [Date]
**Brief Owner:** [Name]
