# MG-004-P2: Workflow Orchestration

**ID:** MG-004-P2
**Type:** Migration
**Status:** In Progress
**Priority:** P0-Critical
**Created:** 2025-12-03
**Updated:** 2025-12-03
**Effort:** M-Medium (1-2 days)
**Parent:** MG-004 (IGRIS v3.1 Migration)
**Phase:** 2 of 8

---

## Summary

Implement the main agent orchestration logic that chains subagents together for autonomous implementation workflows. This is the "brain" that decides when to invoke which agent and handles the flow between them.

---

## Problem

After P1, we have 4 individual agents but:
- No orchestration logic to chain them together
- No state machine for workflow phases
- No retry/error handling between agents
- No approval gate for L/XL complexity
- Main agent doesn't know how to delegate

---

## Goal

Create the complete workflow orchestration system:
1. State machine for implementation workflow
2. Agent delegation logic in CLAUDE.md
3. Retry handling between phases
4. Approval gate for complex changes
5. Git branch strategy for safe implementation

---

## Deliverables

### 1. Workflow State Machine

```
STATES:
┌──────────┐
│   INIT   │ ─── Read brief, create branch
└────┬─────┘
     │
     ▼
┌──────────┐
│ PLANNING │ ─── planner agent creates plan
└────┬─────┘
     │
     ▼
┌──────────┐      ┌──────────┐
│ APPROVAL │ ────►│ REJECTED │ ─── User rejects plan
└────┬─────┘      └──────────┘
     │ approved
     ▼
┌──────────┐      ┌──────────┐
│ BUILDING │◄────►│  FIXING  │ ─── Loop on failure
└────┬─────┘      └──────────┘
     │ complete
     ▼
┌──────────┐      ┌──────────┐
│ TESTING  │◄────►│ TEST_FIX │ ─── Loop on failure (max 3)
└────┬─────┘      └──────────┘
     │ pass
     ▼
┌──────────┐      ┌──────────┐
│ REVIEWING│◄────►│ REV_FIX  │ ─── Loop on reject (max 2)
└────┬─────┘      └──────────┘
     │ approve
     ▼
┌──────────┐
│COMMITTING│ ─── Git commit, merge, cleanup
└────┬─────┘
     │
     ▼
┌──────────┐
│ COMPLETE │
└──────────┘

ERROR STATES:
┌──────────┐
│ BLOCKED  │ ─── Max retries exceeded
└──────────┘
     │
     ▼
┌──────────┐
│  HUMAN   │ ─── Requires human intervention
└──────────┘
```

### 2. CLAUDE.md Orchestration Section

```markdown
## 🔄 WORKFLOW ORCHESTRATION

### Autonomous Implementation Trigger

When user says:
- "HUNT {brief_id}"
- "Implement {brief_id} autonomously"
- "Fix {brief_id}"

Execute the full autonomous workflow.

### Phase Execution

#### PHASE 0: INIT (Main Agent)
```python
1. Read brief: igris_brief_read(brief_id)
2. Validate: Check required fields exist
3. Branch: git checkout -b implement/{brief_id}
4. Update: igris_brief_update(status="In Progress")
5. Assess: Determine if approval required
   - L/XL complexity → require approval
   - P0/P1 priority → require approval
   - Security-related → require approval
   - Otherwise → auto-approve
```

#### PHASE 1: PLANNING (planner agent)
```python
1. Prepare context:
   - Brief content
   - Coding guidelines
   - Project structure (file list)
   - Recent git history

2. Invoke: Task(subagent_type="planner", prompt=context)

3. Receive: Plan markdown

4. Save: ai/plans/{brief_id}-plan.md

5. Check complexity from plan output
```

#### PHASE 1.5: APPROVAL GATE (Main Agent)
```python
if requires_approval:
    Display plan summary to user
    Wait for: "approve" | "reject" | "modify"

    if rejected:
        Enter REJECTED state
        Ask for feedback
        Return to PLANNING or ABORT
else:
    Log: "Auto-approved (S/M complexity)"
    Continue to BUILDING
```

#### PHASE 2: BUILDING (coder agent)
```python
1. Prepare context:
   - Plan content
   - Coding guidelines
   - Failure feedback (if retry)

2. Invoke: Task(subagent_type="coder", prompt=context)

3. Receive: Implementation summary

4. Verify: git status shows changes
```

#### PHASE 3: TESTING (tester agent)
```python
retry_count = 0
max_retries = 3

while retry_count < max_retries:
    1. Invoke: Task(subagent_type="tester", prompt=context)

    2. Parse verdict: PASS | FAIL

    if PASS:
        break  # Continue to REVIEWING
    else:
        retry_count += 1
        if retry_count < max_retries:
            # Send failure back to coder
            Task(subagent_type="coder", prompt=failure_context)
        else:
            Enter BLOCKED state
            Request human intervention
```

#### PHASE 4: REVIEWING (reviewer agent)
```python
reject_count = 0
max_rejects = 2

while reject_count < max_rejects:
    1. Invoke: Task(subagent_type="reviewer", prompt=context)

    2. Parse verdict: APPROVE | REJECT

    if APPROVE:
        break  # Continue to COMMITTING
    else:
        reject_count += 1
        if reject_count < max_rejects:
            # Send feedback back to coder
            Task(subagent_type="coder", prompt=feedback_context)
        else:
            Enter BLOCKED state
            Request human intervention
```

#### PHASE 5: COMMITTING (Main Agent)
```python
1. Stage: git add -A
2. Commit: git commit -m "feat({brief_id}): {title}"
3. Checkout: git checkout main
4. Merge: git merge implement/{brief_id}
5. Cleanup: git branch -d implement/{brief_id}
6. Update: igris_brief_update(status="Done")
7. Log: Save metrics to ai/session/metrics/

8. Display completion summary
```

### Error Handling

#### BLOCKED State
When max retries exceeded:
```python
1. Save state: ai/session/blocked/{brief_id}.json
   {
     "brief_id": "...",
     "phase": "TESTING",
     "retry_count": 3,
     "last_error": "...",
     "timestamp": "..."
   }

2. Update brief: status = "Blocked"

3. Display options:
   - "debug {brief_id}" - Investigate more
   - "retry {brief_id}" - Try current phase again
   - "restart {brief_id}" - Start from planning
   - "abort {brief_id}" - Rollback and abandon
```

#### ABORT Flow
```python
1. Stash: git stash (if needed)
2. Checkout: git checkout main
3. Delete branch: git branch -D implement/{brief_id}
4. Update brief: status = "Ready"
5. Display: "Aborted. Rolled back to clean state."
```
```

### 3. Workflow Checkpoint Files

```
ai/session/
├── workflow/
│   └── {brief_id}-state.json    # Current workflow state
├── blocked/
│   └── {brief_id}-blocked.json  # Blocked state snapshot
└── metrics/
    └── {brief_id}-metrics.json  # Execution metrics
```

**State file format:**
```json
{
  "brief_id": "BR-042",
  "phase": "TESTING",
  "started": "2025-12-03T10:00:00Z",
  "last_updated": "2025-12-03T10:05:00Z",
  "retry_counts": {
    "planning": 0,
    "building": 1,
    "testing": 2,
    "reviewing": 0
  },
  "approval": {
    "required": false,
    "status": "auto-approved"
  },
  "git_branch": "implement/BR-042"
}
```

---

## Technical Specifications

### Delegation Patterns

**Pattern 1: Simple Delegation**
```
Main Agent → Task(subagent_type="planner", prompt="...") → Result
```

**Pattern 2: Retry Loop**
```
Main Agent → Task(coder) → Task(tester)
                              ↓ FAIL
                          Task(coder, failure_context)
                              ↓
                          Task(tester) → PASS
```

**Pattern 3: Approval Gate**
```
Main Agent → Task(planner) → Display to User
                                  ↓
                          Wait for approval
                                  ↓
                          Task(coder)
```

### Context Preparation

For each agent, main agent prepares context:

**planner context:**
```
Brief: {full brief content}
Guidelines: {coding_guidelines.md}
Structure: {file tree}
Recent: {git log --oneline -10}
```

**coder context:**
```
Plan: {plan content}
Guidelines: {coding_guidelines.md}
Failure: {previous failure details, if retry}
```

**tester context:**
```
Project: {type from package.json/pubspec.yaml}
Changed: {git diff --name-only}
Commands: {test commands for project type}
```

**reviewer context:**
```
Diff: {git diff}
Guidelines: {coding_guidelines.md}
Brief: {acceptance criteria}
```

---

## Tasks

### Core Implementation
- [x] Add workflow orchestration section to CLAUDE.md
- [x] Define state machine states and transitions
- [x] Create ai/session/workflow/ directory structure
- [x] Implement state persistence format
- [x] Define context preparation for each agent

### Retry Logic
- [x] Implement test failure → coder retry loop
- [x] Implement review reject → coder retry loop
- [x] Define max retry limits (3 test, 2 review)
- [x] Implement BLOCKED state entry

### Approval Gate
- [x] Define approval criteria (L/XL, P0/P1, security)
- [x] Implement approval display format
- [x] Handle approve/reject/modify responses

### Git Integration
- [x] Implement feature branch creation
- [x] Implement merge on success
- [x] Implement rollback on abort

### Error Handling
- [x] Implement BLOCKED state handler
- [x] Implement ABORT flow
- [x] Create blocked state file format

---

## Acceptance Criteria

- [ ] "HUNT BR-XXX" triggers full autonomous workflow
- [ ] planner → coder → tester → reviewer → commit chain works
- [ ] Test failures loop back to coder (max 3 times)
- [ ] Review rejects loop back to coder (max 2 times)
- [ ] L/XL complexity triggers approval gate
- [ ] Approval gate pauses for user input
- [ ] BLOCKED state entered after max retries
- [ ] ABORT rolls back cleanly
- [ ] State persisted in ai/session/workflow/
- [ ] Metrics logged in ai/session/metrics/

---

## Session State

**Current Status:** Not Started
**Current Task:** None
**Blockers:** None
**Next Step:** Wait for P1 completion

---

## Dependencies

- **Depends on:** MG-004-P1 (Core agents must exist)
- **Blocks:** P3, P4, P6, P7, P8

---

## History

- 2025-12-03: Brief created

---

🔥 **THE BRAIN THAT ORCHESTRATES** 🔥
