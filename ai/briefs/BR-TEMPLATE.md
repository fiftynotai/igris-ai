# BR-XXX: [Brief Title]

**Type:** [Feature | Bug Fix | Refactor | Spike]
**Priority:** [P0-Critical | P1-High | P2-Medium | P3-Low]
**Effort:** [S-Small (< 4h) | M-Medium (1-2d) | L-Large (3-5d) | XL-Extra Large (>1w)]
**Assignee:** [AI Assistant | Human Developer]
**Status:** [Draft | Ready | In Progress | In Review | Done]

---

## Problem

**What's broken or missing?**

[Describe the current state. Be specific. Include error messages, screenshots, or user complaints if applicable.]

**Why does it matter?**

[Impact on users, business, or system. Justify priority.]

---

## Goal

**What should happen after this brief is completed?**

[Describe the desired end state. Be clear and measurable.]

---

## Context & Inputs

### Affected Modules
- [ ] `auth`
- [ ] `event`
- [ ] `venue`
- [ ] `details`
- [ ] `kds`
- [ ] `settings`
- [ ] `history`
- [ ] `home`
- [ ] `app_version`
- [ ] `connections`
- [ ] Other: [specify]

### Layers Touched
- [ ] View (UI widgets)
- [ ] Actions (UX orchestration)
- [ ] ViewModel (business logic)
- [ ] Service (data layer)
- [ ] Model (domain objects)

### API Changes
- [ ] New endpoint: [URL, method, payload]
- [ ] Modified endpoint: [changes]
- [ ] No API changes

### Dependencies
- [ ] New package: [name, version, reason]
- [ ] Existing service: [which one, how used]
- [ ] External API: [third-party service]

### Related Files
- [List key files that will be modified]

---

## Constraints

### Architecture Rules
- Must follow MVVM + Actions pattern (View → Actions → ViewModel → Service → Model)
- No skipping layers
- Use `ApiResponse<T>` for async operations
- Use `actionHandler()` for user-triggered actions

### Technical Constraints
- [e.g., Must support offline mode, Max 2s response time, etc.]

### Timeline
- **Deadline:** [Date or N/A]
- **Milestones:** [Optional checkpoints]

### Out of Scope
- [What this brief explicitly does NOT include]

---

## Acceptance Criteria

**The feature/fix is complete when:**

1. [ ] [Testable outcome 1]
2. [ ] [Testable outcome 2]
3. [ ] [Testable outcome 3]
4. [ ] `flutter analyze` passes (zero issues)
5. [ ] `flutter test` passes (all existing + new tests green)
6. [ ] Manual smoke test performed (if UI changes)
7. [ ] Documentation updated (README, API docs, etc.)

---

## Test Plan

### Automated Tests
- [ ] Unit test: [ViewModel method X with mock service]
- [ ] Widget test: [UI component Y renders correctly]
- [ ] Integration test: [End-to-end flow Z]

### Manual Test Cases

#### Test Case 1: [Scenario Name]
**Preconditions:** [e.g., User is logged in, has venue selected]
**Steps:**
1. [Action 1]
2. [Action 2]
3. [Action 3]

**Expected Result:** [What should happen]
**Actual Result:** [Fill during testing]
**Status:** [ ] Pass / [ ] Fail

### Regression Checklist
- [ ] Login flow still works
- [ ] Events refresh correctly
- [ ] Printer connections not broken
- [ ] [Other critical flows]

---

## Delivery

### Code Changes
- [ ] New files created: [list]
- [ ] Modified files: [list]
- [ ] Deleted files: [list if any]

### Database Migrations
- [ ] Migration script: [path or N/A]
- [ ] Seed data: [needed or N/A]

### Configuration Changes
- [ ] Environment variables: [new or modified]
- [ ] Feature flags: [new flag or N/A]
- [ ] API config: [new endpoints in `api_config.dart`]

### Documentation Updates
- [ ] README: [section to update]
- [ ] API Reference: [new endpoints documented]
- [ ] Module Catalog: [if new module]
- [ ] i18n Keys: [new translation keys added]

### Deployment Notes
- [ ] Requires app restart: [Yes/No]
- [ ] Backend changes needed first: [Yes/No]
- [ ] Rollback plan: [describe or N/A]

---

## QA Handoff

**QA can test this by:**
1. [Step 1]
2. [Step 2]
3. [Expected outcome]

**Test Build:** [Firebase App Distribution link or local build]
**Test Account:** [Credentials if needed]
**Test Venue:** [Specific venue/zone for testing]

---

## Notes

[Any additional context, screenshots, diagrams, or open questions]

---

**Created:** [Date]
**Last Updated:** [Date]
**Brief Owner:** [Name]
