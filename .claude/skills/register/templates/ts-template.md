# TS-XXX: [Testing Task Title]

**Type:** Testing
**Priority:** [P0-Critical | P1-High | P2-Medium | P3-Low]
**Effort:** [S-Small (< 4h) | M-Medium (1-2d) | L-Large (3-5d) | XL-Extra Large (>1w)]
**Assignee:** [Igris AI | Human Developer]
**Commanded By:** [User name from persona.json if available, otherwise "Not specified"]
**Status:** [Draft | Ready | In Progress | In Review | Done]
**Created:** [YYYY-MM-DD]
**Completed:** [YYYY-MM-DD] _(if Status: Done)_

---

## What Needs Testing?

**Component/Module:** [Name of component, module, or feature]

**Current Test Coverage:** [X%] (or "None")

**Target Test Coverage:** [Y%]

**Why is testing needed?**

[Explain why this needs tests - critical feature, complex logic, frequently breaks, etc.]

---

## Testing Gaps

### Current Coverage
- [ ] **Unit Tests:** [X%] - [What's covered]
- [ ] **Widget Tests:** [X%] - [What's covered]
- [ ] **Integration Tests:** [X%] - [What's covered]

### Missing Coverage
- [ ] **Unit Tests:** [List what's missing]
- [ ] **Widget Tests:** [List what's missing]
- [ ] **Integration Tests:** [List what's missing]

---

## Test Scenarios

### Unit Tests

#### Scenario 1: [Test Name]
**What to test:** [Function/method name]
**Given:** [Initial state]
**When:** [Action performed]
**Then:** [Expected outcome]

**Example:**
```
// Example unit test (syntax varies by language/framework)
test('fetchData updates state to success when API succeeds', () {
  // Given: Service initialized with mock dependencies
  // When: fetchData called
  // Then: State is success with expected data
});
```

#### Scenario 2: [Test Name]
[Repeat structure above]

### UI/Component Tests

#### Scenario 1: [Test Name]
**Component:** [Component name]
**Given:** [Initial conditions]
**When:** [User interaction]
**Then:** [Expected UI state]

**Example:**
```
// Example UI test (syntax varies by framework)
test('Submit button disabled when form invalid', () {
  // Given: Form component rendered
  // When: Required fields are empty
  // Then: Submit button is disabled
});
```

### Integration Tests

#### Scenario 1: [Test Name - End-to-End Flow]
**User Flow:** [Describe complete flow]
**Steps:**
1. [Step 1]
2. [Step 2]
3. [Step 3]

**Expected:** [End result]

---

## Test Implementation Plan

### Phase 1: Unit Tests (Priority)
1. [ ] Test [Function 1]
2. [ ] Test [Function 2]
3. [ ] Test [Function 3]
4. [ ] Test error cases
5. [ ] Test edge cases

**Effort:** [X hours/days]

### Phase 2: UI/Component Tests
1. [ ] Test [Component 1] renders correctly
2. [ ] Test [Component 2] user interactions
3. [ ] Test [Component 3] state changes

**Effort:** [X hours/days]

### Phase 3: Integration Tests (If Needed)
1. [ ] Test [Flow 1] end-to-end
2. [ ] Test [Flow 2] end-to-end

**Effort:** [X hours/days]

---

## Tasks

### Pending
- [ ] Task 1: [Description of test implementation work]
- [ ] Task 2: [Description of test implementation work]
- [ ] Task 3: [Description of test implementation work]

### In Progress
_(Tasks currently being worked on)_
- [x] Task X: [Description] (started: YYYY-MM-DD HH:MM)

### Completed
_(Finished tasks)_
- [x] Task Y: [Description] (completed: YYYY-MM-DD HH:MM)

**Note:** Update this section as you work. Mark tasks in_progress when starting, completed when done. Add timestamps.

---

## Workflow State

**Phase:** INIT | PLANNING | APPROVAL | BUILDING | TESTING | REVIEWING | COMMITTING | COMPLETE | BLOCKED
**Active Agent:** none | architect | forger | sentinel | warden | mender | chronicler | herald
**Retry Count:** 0

### Current Work
[What's happening right now in this brief]

### Next Steps
[Exact continuation point if interrupted]

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| YYYY-MM-DD HH:MM | agent | action | result |

### Blockers
[Any blockers for this brief, or "None"]

---

## Test Data & Mocks

### Mocks Required
- [ ] `Mock[ServiceName]` - [What it mocks]
- [ ] `Mock[RepositoryName]` - [What it mocks]
- [ ] `Mock[ApiClient]` - [What it mocks]

### Test Data Fixtures
- [ ] `testEvent.json` - [Sample event data]
- [ ] `testUser.json` - [Sample user data]
- [ ] [Other fixtures needed]

---

## Dependencies

### Testing Libraries
- [ ] [Test framework] - [Version] (built-in or needs install)
- [ ] [Mocking library] - [Version] (if needed)
- [ ] [Additional test utilities] - [Version] (if needed)

### Setup Required
- [ ] Add test dependencies to project configuration
- [ ] Generate mocks (if using mock generation)
- [ ] Create test fixtures directory

---

## Acceptance Criteria

**Tests are complete when:**

1. [ ] All identified test scenarios implemented
2. [ ] Test coverage >= [target %]
3. [ ] All tests pass (run test command)
4. [ ] Tests are maintainable (clear, not flaky)
5. [ ] Tests follow project conventions
6. [ ] Edge cases covered
7. [ ] Error cases covered
8. [ ] Mock setup documented

---

## Success Metrics

**Before:**
- Test Coverage: [X%]
- Test Count: [N tests]
- Critical Bugs: [Number found in production]

**After (Target):**
- Test Coverage: [Y%]
- Test Count: [M tests]
- Critical Bugs: [Reduction expected]

---

## References

**Testing Guidelines:**
- [Link to testing section in coding_guidelines.md]

**Test Examples:**
- [Link to example test files in the codebase]

**External Resources:**
- [Link to testing library documentation]

---

## Notes

[Any additional context, testing challenges, or special considerations]

---

**Created:** [Date]
**Last Updated:** [Date]
**Brief Owner:** [Name]
