# FR-056: Brain v5.0 Phase 5 — Autonomous Coordination

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-17
**Parent Brief:** FR-051
**Blocked By:** FR-055

---

## Feature Description

**What is the proposed feature?**

Enable agents to self-assign and coordinate work without human intervention. Enhances `igris_task_next` with role-based filtering (agent capabilities), adds automatic task priority adjustment based on due dates and dependencies, implements self-healing (failed tasks auto-retry via mender agent), and integrates with Claude Code hooks for automated task flow (TaskCompleted validation, TeammateIdle assignment).

**Why is this valuable?**

Even with task management (FR-053) and scheduling (FR-055), agents still need human orchestration to pick tasks. Autonomous coordination closes the loop: agent wakes up, asks the brain for work, executes it, and picks the next task — a full autonomous work session without human input.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved

**Current situation:**
- Agents must be told what to do (human assigns work)
- Failed tasks require manual intervention
- No role-based task matching (any agent gets any task)
- `/awaken` doesn't auto-assign work
- No continuous work loop (single brief per human command)

**With this feature:**
- `igris_task_next` filters by agent capabilities (forger gets code tasks, sentinel gets test tasks)
- Priority auto-adjustment: overdue tasks bubble up, deferred tasks sink
- Self-healing: failed tasks → mender diagnoses → auto-retry
- Claude Code hooks: TaskCompleted triggers next assignment, TeammateIdle triggers work pickup
- `/awaken` shows all available work and auto-assigns highest priority

---

## Technical Approach

### High-Level Design

Extends the tasks component (FR-053) with intelligent assignment, extends the scheduler (FR-055) with self-healing, and integrates with Claude Code hooks for event-driven automation.

### Role-Based Task Assignment

```typescript
igris_task_next({
  agent: "forger",           // Agent requesting work
  capabilities: ["code", "test"],  // What this agent can do
  project_slug: "igris-ai"  // Optional project filter
})
```

Task matching considers:
1. Priority (highest first)
2. Dependencies (only unblocked)
3. `defer_until` (skip deferred)
4. Agent capabilities vs task requirements
5. Due date urgency

### Priority Auto-Adjustment

Runs periodically (via scheduler) or on query:
- Tasks past `due_at` → priority += 2
- Tasks blocked for >24h → check if blocker is stale
- Tasks with all deps completed → priority += 1 (ready to go)
- Deferred tasks past `defer_until` → status → 'pending'

### Self-Healing Protocol

On task failure:
1. Task status → 'failed'
2. Event `task.failed` fires
3. Scheduler listens, creates mender diagnostic task
4. Mender agent runs, produces fix instructions
5. Original task retried with fix context (up to max_retries)

### Claude Code Hooks Integration

```json
{
  "hooks": {
    "TaskCompleted": [{
      "command": "claude -p 'Call igris_task_next and start the returned task'"
    }],
    "TeammateIdle": [{
      "command": "claude -p 'Assign available work to idle teammate'"
    }]
  }
}
```

### Components Affected
- Modified: `engine/components/tasks/` — role-based assignment, priority adjustment
- Modified: `engine/components/scheduler/` — self-healing triggers
- New: Hook configuration for autonomous flow
- Modified: Skills (`/awaken`) — auto-assign available work

---

## Context & Inputs

### Dependencies
- [x] FR-052 (Engine Foundation) — engine architecture
- [x] FR-053 (Task Management) — task system
- [x] FR-055 (Scheduling) — scheduler for self-healing and periodic adjustment

### Files to Create
- Hook configuration files for autonomous flow
- Agent capability definitions (JSON)

### Files to Modify
- `brain-mcp-server/src/engine/components/tasks/handlers.ts` — enhanced task_next
- `brain-mcp-server/src/engine/components/scheduler/daemon.ts` — self-healing triggers
- Skills: `/awaken` — auto-assign work display

---

## Constraints

### Technical Constraints
- Must not create infinite loops (max_retries cap on self-healing)
- Role-based matching must be configurable (not hardcoded agent capabilities)
- Priority adjustment must be bounded (can't escalate infinitely)
- Claude Code hooks must be compatible with current hook system

### UX Constraints
- Agent self-assignment must be opt-in (config flag)
- Developer can always override and manually assign
- Autonomous sessions must be reviewable (full audit trail)

### Out of Scope
- Multi-user access control
- Lane queue for per-project concurrency (future)
- Heartbeat daemon (future, beyond v5.0)
- A2A protocol (future)

---

## Tasks

### Pending
- [ ] Task 1: Implement role-based `igris_task_next` with capability matching
- [ ] Task 2: Implement priority auto-adjustment algorithm
- [ ] Task 3: Implement self-healing protocol (fail → mender → retry)
- [ ] Task 4: Create agent capability definitions
- [ ] Task 5: Integrate Claude Code hooks (TaskCompleted, TeammateIdle)
- [ ] Task 6: Update `/awaken` to show and auto-assign available work
- [ ] Task 7: Add autonomous mode config flag
- [ ] Task 8: End-to-end test: agent picks task → executes → picks next

### In Progress

### Completed

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Blocked on FR-055 (Scheduling System).

### Next Steps
Complete FR-052 through FR-055 first, then HUNT FR-056.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 | orchestrator | Brief registration from FR-051 Phase 5 | SUCCESS |

### Blockers
- FR-055 must complete first (provides scheduler for self-healing and periodic priority adjustment)

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] `igris_task_next` respects agent capabilities
2. [ ] Priority auto-adjusts based on due dates and dependency state
3. [ ] Failed tasks auto-retry via mender (up to max_retries)
4. [ ] Claude Code hooks trigger task assignment on idle/complete events
5. [ ] `/awaken` displays all available work with auto-assign option
6. [ ] Autonomous mode toggleable via config
7. [ ] Agent can execute 3+ tasks in sequence without human input
8. [ ] Full audit trail of autonomous decisions
9. [ ] All existing MCP tools unchanged

---

## Test Plan

### Functional Tests

**Test Case 1: Autonomous Work Session**
**Steps:**
1. Create 3 tasks with sequential dependencies
2. Enable autonomous mode
3. Agent calls `igris_task_next` — gets task 1
4. Agent completes task 1 — hook triggers next assignment
5. Agent gets task 2, completes, gets task 3, completes

**Expected Result:** 3 tasks executed without human input
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Self-Healing**
**Steps:**
1. Create a task that will fail
2. Agent attempts, fails
3. Verify mender diagnostic task auto-created
4. Mender provides fix
5. Original task retried with fix context

**Expected Result:** Task recovers after failure via mender
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] Manual task assignment still works
- [ ] `/hunt` workflow unchanged
- [ ] All existing MCP tools unchanged

---

## Notes

**Parent brief:** FR-051 (Brain v5.0 Modular Architecture)
**Phase:** 5 of 5 (final phase)
**Depends on:** FR-052, FR-053, FR-055

**Key design insight from FR-051:** "The hardest part of autonomous agents is not the AI — it is the runtime: queuing, channel normalization, memory, scheduling, and concurrency safety." Phases 1-4 build that runtime. Phase 5 unleashes agents on top of it.

**BabyAGI pattern inspiration:** execute → create new tasks → reprioritize → loop. But with proper concurrency safety, dependency tracking, and self-healing.

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Igris AI)
