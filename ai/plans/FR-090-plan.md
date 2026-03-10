# FR-090 Implementation Plan

## Summary

Integrate `TeammateIdle` and `TaskCompleted` Claude Code hooks into the Igris `/team` skill for quality gate enforcement on Agent Teams parallel execution.

## Files to Create

1. `.claude/hooks/task_completed_gate.sh` — TaskCompleted hook: verifies tests passed before allowing completion
2. `.claude/hooks/teammate_idle_assign.sh` — TeammateIdle hook: assigns next brain task to idle teammate

## Files to Modify

1. `.claude/settings.json` — Add TeammateIdle and TaskCompleted hook entries
2. `.claude/skills/team/SKILL.md` — Document quality gate behavior and hook integration
3. `brain-mcp-server/src/index.ts` — Add TeammateIdle/TaskCompleted handlers to `/api/hooks/event`

## Implementation Steps

### Step 1: TaskCompleted Hook (`task_completed_gate.sh`)

- Read JSON from stdin: `hook_event_name`, `task_id`, `last_assistant_message`
- Parse `last_assistant_message` for test pass/fail indicators
- If tests failed or no test evidence found: exit 2 with feedback JSON
- If tests passed: exit 0 (allow completion)
- Edge cases: no last_assistant_message, teammate with no test tasks

### Step 2: TeammateIdle Hook (`teammate_idle_assign.sh`)

- Read JSON from stdin: `hook_event_name`, `teammate_id` or context
- POST to brain API `POST /api/tasks/next` with project_slug from env
- If task returned: exit 2 with description JSON (keeps teammate working)
- If no tasks: exit 0 (teammate goes idle)
- Edge cases: brain API unreachable, all tasks blocked

### Step 3: settings.json Update

- Add `TeammateIdle` hook entry pointing to `teammate_idle_assign.sh`
- Add `TaskCompleted` hook entry pointing to `task_completed_gate.sh`
- Both as HTTP hooks to brain API + command hooks for local processing

### Step 4: Brain API Enhancement

- Add `TeammateIdle` and `TaskCompleted` case handlers in `/api/hooks/event`
- Log events for dashboard visibility

### Step 5: Team Skill Documentation

- Update SKILL.md with quality gate behavior section
- Document the distinction between Agent Teams quality gates vs brain-level gates

## Risk Assessment

- Low risk: hooks follow established patterns from FR-088
- TeammateIdle hook needs to handle brain API being unavailable gracefully
- TaskCompleted gate needs clear false-positive/false-negative mitigation
