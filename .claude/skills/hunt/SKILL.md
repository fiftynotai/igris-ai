---
name: hunt
description: Implement a brief with full workflow - usage: /hunt BR-008
disable-model-invocation: true
context: fork
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Task
triggers:
  - "HUNT"
  - "implement brief"
  - "fix brief"
  - "build brief"
  - "start working on"
  - "implement"
  - "ENGAGE"
---

# HUNT - Implement Brief with Full Workflow

Execute the complete implementation workflow for a brief, from planning through commit.

## Usage

```
/hunt BR-008
/hunt MG-004
```

## Arguments

`$ARGUMENTS` should be a brief ID (e.g., BR-008, MG-004).

## Workflow State Machine

```
[INIT] --> [PLANNING] --> [APPROVAL?] --> [BUILDING] --> [TESTING] --> [REVIEWING] --> [COMMITTING] --> [COMPLETE]
              |               |               |              |              |
              v               v               v              v              v
          planner      (L/XL: user)       coder         tester        reviewer
```

## State Transitions

| From | Condition | To |
|------|-----------|-----|
| INIT | Brief loaded | PLANNING |
| PLANNING | Plan created | APPROVAL (L/XL) or BUILDING (S/M) |
| APPROVAL | User approves | BUILDING |
| BUILDING | Code complete | TESTING |
| TESTING | Tests pass | REVIEWING |
| TESTING | Tests fail (retry < 3) | BUILDING (self-heal via debugger) |
| TESTING | Tests fail (retry >= 3) | BLOCKED |
| REVIEWING | APPROVE | COMMITTING |
| REVIEWING | REJECT (retry < 2) | BUILDING (fix issues) |
| REVIEWING | REJECT (retry >= 2) | BLOCKED |
| COMMITTING | Commit success | COMPLETE |

## Execution

### Phase 1: INIT

1. Find brief file in `ai/briefs/` matching `$ARGUMENTS`
2. Read brief content
3. Verify Status is "Ready" or "In Progress"
4. If Status is "Done" or "Draft", refuse with message
5. Update Status: "Ready" -> "In Progress" if needed
6. Update `ai/session/CURRENT_SESSION.md`:
   - Set Active Brief
   - Set Mode: HUNT MODE

**Update brief Workflow State:**
```markdown
## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Loading brief and preparing for implementation.

### Next Steps
Proceed to PLANNING phase.
```

### Phase 2: PLANNING

1. Update brief: Phase = PLANNING, Active Agent = planner
2. Add Agent Log entry: "Starting planner..."
3. **Delegate to planner agent** using Task tool:

```
Task tool parameters:
- subagent_type: "planner"
- description: "Plan implementation for {BRIEF_ID}"
- prompt: "Create implementation plan for brief {BRIEF_ID}.
  Brief content: [include brief content]

  Output a structured plan with:
  1. Files to modify
  2. Implementation steps
  3. Test scenarios
  4. Risk assessment

  Write plan to ai/plans/{BRIEF_ID}-plan.md"
```

4. After planner returns:
   - Update brief: Active Agent = none
   - Update Agent Log with result
   - Check brief Effort field

5. **If Effort is L or XL:**
   - Set Phase: APPROVAL
   - Display plan summary to user
   - Ask: "Approve this plan?"
   - Wait for user approval before continuing

6. **If Effort is S or M:**
   - Proceed directly to BUILDING

### Phase 3: BUILDING

1. Update brief: Phase = BUILDING, Active Agent = coder
2. Add Agent Log entry: "Starting coder..."
3. **Delegate to coder agent** using Task tool:

```
Task tool parameters:
- subagent_type: "coder"
- description: "Implement {BRIEF_ID}"
- prompt: "Implement the following brief according to the plan.

  Brief: [brief content]
  Plan: [plan content if exists]
  Coding Guidelines: Read ai/context/coding_guidelines.md

  Follow the plan and implement all required changes.
  Ensure code follows architecture standards.
  Add documentation comments to public APIs."
```

4. After coder returns:
   - Update brief: Active Agent = none
   - Update Agent Log with result
   - Proceed to TESTING

### Phase 4: TESTING

1. Update brief: Phase = TESTING, Active Agent = tester
2. Add Agent Log entry: "Starting tester..."
3. **Delegate to tester agent** using Task tool:

```
Task tool parameters:
- subagent_type: "tester"
- description: "Test {BRIEF_ID} implementation"
- prompt: "Run tests for the implementation.

  Run:
  1. Linter/analyzer (if applicable)
  2. Unit tests
  3. Integration tests (if applicable)

  Report PASS or FAIL with details."
```

4. After tester returns:
   - Update brief: Active Agent = none
   - Update Agent Log with result

5. **If PASS:**
   - Proceed to REVIEWING

6. **If FAIL and Retry Count < 3:**
   - Increment Retry Count
   - Delegate to debugger agent for diagnosis
   - Return to BUILDING with fix instructions

7. **If FAIL and Retry Count >= 3:**
   - Set Phase: BLOCKED
   - Display: "Tests failing after 3 attempts. Manual intervention required."
   - Add blocker to BLOCKERS.md
   - Stop workflow

### Phase 5: REVIEWING

1. Update brief: Phase = REVIEWING, Active Agent = reviewer
2. Add Agent Log entry: "Starting reviewer..."
3. **Delegate to reviewer agent** using Task tool:

```
Task tool parameters:
- subagent_type: "reviewer"
- description: "Review {BRIEF_ID} implementation"
- prompt: "Review the implementation for quality.

  Check:
  1. Code follows coding_guidelines.md
  2. No security vulnerabilities
  3. Tests are adequate
  4. Documentation is present

  Output: APPROVE or REJECT with feedback."
```

4. After reviewer returns:
   - Update brief: Active Agent = none
   - Update Agent Log with result

5. **If APPROVE:**
   - Proceed to COMMITTING

6. **If REJECT and Retry Count < 2:**
   - Increment Retry Count
   - Return to BUILDING with reviewer feedback

7. **If REJECT and Retry Count >= 2:**
   - Set Phase: BLOCKED
   - Display: "Review failed after 2 attempts. Manual intervention required."
   - Stop workflow

### Phase 6: COMMITTING

1. Update brief: Phase = COMMITTING, Active Agent = none
2. Run git commands:

```bash
git add -A
git status
git commit -m "$(cat <<'EOF'
<type>(<scope>): <summary from brief>

<body from brief goal/problem>

closes #{BRIEF_ID}
EOF
)"
```

3. Verify commit succeeded
4. Update brief: Status = "Done", Completed = today
5. Proceed to COMPLETE

### Phase 7: COMPLETE

1. Update brief: Phase = COMPLETE
2. Update `ai/session/CURRENT_SESSION.md`:
   - Add to Last Session Summary
   - Clear Active Brief (or set to next)

3. Display completion message:
```
HUNT Complete: {BRIEF_ID}

Summary:
- Files changed: X
- Tests: Passed
- Commit: {hash}

Next actions:
1. Archive brief: /archive {BRIEF_ID}
2. Continue with next brief: /hunt {NEXT_ID}
3. View status: /scan
```

## Error Handling

- If brief not found: Display error with available briefs
- If Status is Done: "Brief already complete. Use /archive to archive."
- If subagent fails: Log error, attempt recovery or block
- If git commit fails: Display error, do not update status

## Agent Log Format

Maintain in brief file under Workflow State:

```markdown
### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-06 10:00 | planner | Create implementation plan | SUCCESS |
| 2026-02-06 10:15 | coder | Implement changes | SUCCESS |
| 2026-02-06 10:30 | tester | Run test suite | PASS |
| 2026-02-06 10:35 | reviewer | Code review | APPROVE |
```
