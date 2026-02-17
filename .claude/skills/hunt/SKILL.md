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
[INIT] --> [PLANNING] --> [APPROVAL?] --> [BUILDING] --> [TESTING] --> [REVIEWING] --> [DOCUMENTING?] --> [COMMITTING] --> [COMPLETE]
              |               |               |              |              |              |
              v               v               v              v              v              v
          architect    (L/XL: user)       forger        sentinel       warden       /document skill
```

## State Transitions

| From | Condition | To |
|------|-----------|-----|
| INIT | Brief loaded | PLANNING |
| PLANNING | Plan created | APPROVAL (L/XL) or BUILDING (S/M) |
| APPROVAL | User approves | BUILDING |
| BUILDING | Code complete | TESTING |
| TESTING | Tests pass | REVIEWING |
| TESTING | Tests fail (retry < 3) | BUILDING (self-heal via mender) |
| TESTING | Tests fail (retry >= 3) | BLOCKED |
| REVIEWING | APPROVE (docs needed) | DOCUMENTING |
| REVIEWING | APPROVE (no docs needed) | COMMITTING |
| REVIEWING | REJECT (retry < 2) | BUILDING (fix issues) |
| REVIEWING | REJECT (retry >= 2) | BLOCKED |
| DOCUMENTING | Docs updated | COMMITTING |
| DOCUMENTING | Skipped (no docs needed) | COMMITTING |
| COMMITTING | Commit success | COMPLETE |

## Execution

### 0. Track Invocation
Silently emit a skill invocation event (never blocks execution):
```bash
bash "$CLAUDE_PROJECT_DIR/scripts/emit_skill_event.sh" "hunt" 2>/dev/null || true
```

### Phase 1: INIT

1. Find brief file in `ai/briefs/` matching `$ARGUMENTS`
2. Read brief content
3. Verify Status is "Ready" or "In Progress"
4. If Status is "Done" or "Draft", refuse with message
5. Update Status: "Ready" -> "In Progress" if needed
6. Update `ai/session/CURRENT_SESSION.md`:
   - Set Active Brief
   - Set Mode: HUNT MODE

7. If brain MCP available, call `igris_brief_sync` with:
   - project: current project slug
   - brief_id: the brief ID
   - brief_type: type from the brief
   - title: the brief title
   - status: "In Progress"
   - priority: the brief's priority
   - effort: the brief's effort
   - phase: "INIT"

   If brain MCP is not available, skip silently. No errors.

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

**Heartbeat:** If Instance ID exists in CURRENT_SESSION.md, call `igris_instance_heartbeat` with current_brief and current_phase="INIT". See "Instance Heartbeat" section below.

### Phase 2: PLANNING

1. Update brief: Phase = PLANNING, Active Agent = architect
2. Add Agent Log entry: "Starting architect..."
3. **Delegate to architect agent** using Task tool:

```
Task tool parameters:
- subagent_type: "architect"
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

4. After architect returns:
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

1. Update brief: Phase = BUILDING, Active Agent = forger
2. Add Agent Log entry: "Starting forger..."
3. **Delegate to forger agent** using Task tool:

```
Task tool parameters:
- subagent_type: "forger"
- description: "Implement {BRIEF_ID}"
- prompt: "Implement the following brief according to the plan.

  Brief: [brief content]
  Plan: [plan content if exists]
  Coding Guidelines: Read ai/context/coding_guidelines.md

  Follow the plan and implement all required changes.
  Ensure code follows architecture standards.
  Add documentation comments to public APIs."
```

4. After forger returns:
   - Update brief: Active Agent = none
   - Update Agent Log with result
   - Proceed to TESTING

### Phase 4: TESTING

1. Update brief: Phase = TESTING, Active Agent = sentinel
2. Add Agent Log entry: "Starting sentinel..."
3. **Delegate to sentinel agent** using Task tool:

```
Task tool parameters:
- subagent_type: "sentinel"
- description: "Test {BRIEF_ID} implementation"
- prompt: "Run tests for the implementation.

  Run:
  1. Linter/analyzer (if applicable)
  2. Unit tests
  3. Integration tests (if applicable)

  Report PASS or FAIL with details."
```

4. After sentinel returns:
   - Update brief: Active Agent = none
   - Update Agent Log with result

5. **If PASS:**
   - Proceed to REVIEWING

6. **If FAIL and Retry Count < 3:**
   - Increment Retry Count
   - Delegate to mender agent for diagnosis
   - Return to BUILDING with fix instructions

7. **If FAIL and Retry Count >= 3:**
   - Set Phase: BLOCKED
   - Display: "Tests failing after 3 attempts. Manual intervention required."
   - Add blocker to BLOCKERS.md
   - Stop workflow

### Phase 5: REVIEWING

1. Update brief: Phase = REVIEWING, Active Agent = warden
2. Add Agent Log entry: "Starting warden..."
3. **Delegate to warden agent** using Task tool:

```
Task tool parameters:
- subagent_type: "warden"
- description: "Review {BRIEF_ID} implementation"
- prompt: "Review the implementation for quality.

  Check:
  1. Code follows coding_guidelines.md
  2. No security vulnerabilities
  3. Tests are adequate
  4. Documentation is present

  Output: APPROVE or REJECT with feedback."
```

4. After warden returns:
   - Update brief: Active Agent = none
   - Update Agent Log with result

5. **If APPROVE:**
   - Evaluate if documentation updates are needed (see Phase 6 conditions)
   - If docs needed: Proceed to DOCUMENTING
   - If no docs needed: Proceed to COMMITTING

6. **If REJECT and Retry Count < 2:**
   - Increment Retry Count
   - Return to BUILDING with reviewer feedback

7. **If REJECT and Retry Count >= 2:**
   - Set Phase: BLOCKED
   - Display: "Review failed after 2 attempts. Manual intervention required."
   - Stop workflow

### Phase 6: DOCUMENTING (Conditional)

1. Update brief: Phase = DOCUMENTING, Active Agent = document skill
2. Add Agent Log entry: "Starting /document skill..."
3. **Evaluate whether documentation updates are needed:**

**Invoke /document skill when:**
- New public APIs added
- Component library changes
- README-worthy features implemented
- API signatures change

**Skip /document skill when (proceed directly to COMMITTING):**
- Internal refactoring only
- Bug fixes with no API changes
- Test-only changes
- Session/config changes

4. **If docs needed, invoke /document skill directly** (orchestrator-level operation):

The orchestrator invokes the `/document` skill using the Skill tool. This is NOT a subagent delegation — it is an orchestrator-level skill invocation, matching the pattern defined in `rules/04-igris-agents.md`.

```
Skill tool parameters:
- skill: "document"
- arguments: "{BRIEF_ID} - Update documentation for changes made.
  Brief: [brief content]
  Changes made: [summary of implementation changes]
  Check and update as needed:
  1. README.md (if user-facing features)
  2. API documentation (if API changes)
  3. Module catalog (if new modules)
  4. Code comments (if public API changes)
  Only update docs that are relevant to the changes made."
```

5. After /document skill completes (or if skipped):
   - Update brief: Active Agent = none
   - Update Agent Log with result (or "Skipped - no docs needed")
   - Proceed to COMMITTING

### Phase 7: COMMITTING

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
5. If brain MCP available, call `igris_brief_sync` with status="Done", phase="COMMITTING". Skip silently if unavailable.
6. Proceed to COMPLETE

### Phase 8: COMPLETE

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

## Instance Heartbeat (Mandatory When Available)

On each phase transition (PLANNING, BUILDING, TESTING, REVIEWING, DOCUMENTING, COMMITTING, COMPLETE), you MUST refresh the instance heartbeat if an instance ID exists in CURRENT_SESSION.md.

If the `igris-brain` MCP server is available AND an instance ID is stored:
1. Read the Instance ID from CURRENT_SESSION.md
2. Call `igris_instance_heartbeat` with:
   - instance_id = the instance ID from CURRENT_SESSION.md
   - machine_hostname = system hostname
   - machine_os = platform (e.g., "darwin", "linux")
   - project_slug = current project slug
   - project_path = absolute path to project directory
   - current_brief = the brief ID being implemented
   - current_phase = the new phase name
3. This keeps the instance "active" on the dashboard and shows real-time workflow progress

If brain MCP is not available or no instance ID is stored, skip silently. Do NOT block workflow execution.

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
| 2026-02-06 10:00 | architect | Create implementation plan | SUCCESS |
| 2026-02-06 10:15 | forger | Implement changes | SUCCESS |
| 2026-02-06 10:30 | sentinel | Run test suite | PASS |
| 2026-02-06 10:35 | warden | Code review | APPROVE |
| 2026-02-06 10:40 | /document skill | Update documentation | SUCCESS (or Skipped) |
```
