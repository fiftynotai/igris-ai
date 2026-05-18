---
name: hunt
description: Implement a brief with full workflow - usage: /hunt BR-008
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
  - mcp__igris-brain__igris_brief_sync
  - mcp__igris-brain__igris_brief_get
  - mcp__igris-brain__igris_brief_update
  - mcp__igris-brain__igris_instance_heartbeat
  - mcp__igris-brain__igris_instance_list
  - mcp__igris-brain__igris_agent_event
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

1. Load brief via `igris_brief_get` (MCP), fallback to cache at `~/.igris/projects/{project}/briefs/` matching `$ARGUMENTS`
2. Read brief content
3. Verify Status is "Ready" or "In Progress"
4. If Status is "Done" or "Draft", refuse with message
5. Update Status: "Ready" -> "In Progress" if needed
6. **Surface the instance registry (Lock 1 — display-only):**
   If the `igris-brain` MCP server is available, call `igris_instance_list` with `status='active'` and `project` = current project slug. For every *other* live instance returned (any instance that is not this harness's own), surface a one-line advisory: "instance {short_id} is on {current_brief}, last active {last_active}". This warns the operator before they claim a brief a sibling is already working.

   **This step is display-only — it does NOT block the hunt.** If a sibling already owns the brief being hunted, the hunt still proceeds; the operator is merely informed. FR-127 owns the atomic claim gate — its enforced claim-and-lock sits immediately after this surfacing step and turns this advisory display into a gate. This step is FR-127's merge base.

   If brain MCP is NOT available or `igris_instance_list` is unavailable (older brain), skip silently. Do NOT block the hunt.

7. Update `~/.igris/projects/{project}/session/instances/<instance_id>.md`:
   - Set Active Brief
   - Set Mode: HUNT MODE
   - `<instance_id>` is read from the `**Instance ID:**` field in the per-instance session file. `/hunt` always runs after `/awaken` registered the instance, so the per-instance file and its `**Instance ID:**` field always exist here.

8. Call `igris_brief_sync` with:
   - project: current project slug
   - brief_id: the brief ID
   - brief_type: type from the brief
   - title: the brief title
   - status: "In Progress"
   - priority: the brief's priority
   - effort: the brief's effort
   - phase: "INIT"

   **If brain MCP is NOT available or the call fails:**
   - Display: `WARNING: Brain sync skipped for {BRIEF_ID} — MCP unavailable. Queued locally for next /awaken or /sync data.`
   - Append a JSON line to `~/.igris/projects/{project}/sync_queue.jsonl`:
     ```json
     {"timestamp":"{ISO-8601 now}","operation":"brief_sync","project":"{project}","brief_id":"{BRIEF_ID}","title":"{title}","status":"In Progress","priority":"{priority}","effort":"{effort}","brief_type":"{type}","phase":"INIT"}
     ```
   - Do NOT block the hunt workflow — continue to next step after warning.

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

**Heartbeat:** If Instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`, call `igris_instance_heartbeat` with current_brief and current_phase="INIT". See "Instance Heartbeat" section below.

### Phase 2: PLANNING

1. Update brief: Phase = PLANNING, Active Agent = architect
2. Add Agent Log entry: "Starting architect..."
3. **Emit agent event (start):** If brain MCP is available AND Instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`, call `igris_agent_event` with:
   - instance_id: {Instance ID from `~/.igris/projects/{project}/session/instances/<instance_id>.md`}
   - agent: "architect"
   - event_type: "start"
   - brief_id: {current brief ID}
   - phase: "PLANNING"
   Skip silently if MCP unavailable. Never block the hunt workflow.
3.5. **Pre-architect brain pull** (fire-and-forget, never blocks):
   - Call `igris_memory_recall` with `project={current_project}`, `context="{brief title} {brief problem statement}"`, `limit=5`
   - Call `igris_brief_similar` with `query="{brief title} {brief problem statement}"`, `project={current_project}`, `threshold=0.85`, `limit=5`
   - Aggregate both results into a single `Prior context:` markdown block (one heading per source: `## Prior learnings`, `## Similar briefs`)
   - Pass that block into the architect prompt as an additional input section (append to the prompt template in step 4 under a `Prior context:` header)
   - If either call fails or returns empty, log warning and continue without the block — do NOT block the hunt
3.6. **Architect plan template constraint (PI-004):**
   Plans must end at the last code-touching step. Do NOT instruct the
   architect to include a final 'Commit' phase. If the architect
   nevertheless emits a Commit phase (e.g., habitually numbering 0-N
   ending in commit), the orchestrator excises it before passing the
   plan to the forger in Phase 3 step 3.6.
3.7. **Architect plan template constraint (TD-096):**
   When the brief implementation will modify any file under repo `core/`
   that has a runtime mirror at `~/.igris/core/`, the architect's plan
   MUST include explicit `cp` steps from repo to runtime AND immediate
   `bash ~/.igris/core/scripts/verify_mirror.sh <repo> <runtime>` sub-steps
   after each `cp`. Forger is contractually required to run the primitive
   and quote verbatim output (see forger.md MIRROR_SYNC). The plan must
   surface this so forger does not skip it. If the architect omits these
   sub-steps and the implementation touches core/ files, the orchestrator
   annotates the prompt with a reminder before passing to forger in step 4.
4. **Delegate to architect agent** using Agent tool:

```
Agent tool parameters:
- subagent_type: "architect"
- description: "Plan implementation for {BRIEF_ID}"
- prompt: "Create implementation plan for brief {BRIEF_ID}.
  Brief content: [include brief content]

  Output a structured plan with:
  1. Files to modify
  2. Implementation steps
  3. Test scenarios
  4. Risk assessment

  Write plan to ~/.igris/projects/{project}/plans/{BRIEF_ID}-plan.md"
```

5. After architect returns:
   - **Emit agent event (stop):** Call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "architect"
     - event_type: "stop"
     - brief_id: {brief ID}
     - phase: "PLANNING"
     - result: {brief summary of architect's output}
     Skip silently if unavailable.
   - Update brief: Active Agent = none
   - Update Agent Log with result
   - Check brief Effort field

6. **If Effort is L or XL:**
   - Set Phase: APPROVAL
   - Display plan summary to user
   - Ask: "Approve this plan?"
   - Wait for user approval before continuing

7. **If Effort is S or M:**
   - Proceed directly to BUILDING

### Phase 3: BUILDING

1. Update brief: Phase = BUILDING, Active Agent = forger
2. Add Agent Log entry: "Starting forger..."
3. **Emit agent event (start):** If brain MCP is available AND Instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`, call `igris_agent_event` with:
   - instance_id: {Instance ID}
   - agent: "forger"
   - event_type: "start"
   - brief_id: {current brief ID}
   - phase: "BUILDING"
   Skip silently if MCP unavailable.
3.5. **Pre-forger mistake recall** (fire-and-forget, never blocks):
   - Call `igris_memory_recall` with `project={current_project}`, `context="{brief title} mistake regression bug"`, `limit=5`
   - Note: `igris_memory_recall` does NOT currently accept a `category=mistake` filter — the FTS5 keyword bias (`"mistake regression bug"`) approximates it. If a `category` arg ships in a future brief, switch to that.
   - Aggregate results into a `Past mistakes to avoid:` markdown block (one bullet per recalled lesson with title + 1-line summary)
   - Pass into forger prompt under a `Past mistakes to avoid:` header (append to the template in step 4)
   - If the call fails or returns empty, log warning and continue without the block
3.6. **Excise commit phase from forger prompt (PI-004 / L-248):**
   The architect's plan may number phases 0-N with the final phase
   being a 'Commit' / 'COMMITTING' / 'git commit' step. The orchestrator
   MUST NOT pass that phase into the forger prompt. The forger's job
   ends at the last code-touching step. The orchestrator owns
   COMMITTING per the state machine (Phase 7 below). When constructing
   the prompt in step 4, omit any commit-related phase from the [plan
   content] inclusion or annotate it with "(orchestrator-owned, not
   forger's responsibility)".
4. **Delegate to forger agent** using Agent tool:

```
Agent tool parameters:
- subagent_type: "forger"
- description: "Implement {BRIEF_ID}"
- prompt: "Implement the following brief according to the plan.

  Brief: [brief content]
  Plan: [plan content if exists]
  Coding Guidelines: Read ~/.igris/projects/{project}/context/coding_guidelines.md

  Follow the plan and implement all required changes.
  Ensure code follows architecture standards.
  Add documentation comments to public APIs.

  CRITICAL — DO NOT COMMIT. The /hunt state machine routes
  BUILDING -> TESTING -> REVIEWING -> COMMITTING; the orchestrator
  owns COMMITTING after sentinel + warden. If the architect's plan
  contains a final 'Commit' phase, treat it as instruction for the
  orchestrator and STOP at the last code-touching step. Do not run
  git commit, git add for the purpose of committing, git tag, or
  git push. Report 'IMPLEMENTATION COMPLETE — UNCOMMITTED'."
```

5. After forger returns:
   - **Emit agent event (stop):** Call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "forger"
     - event_type: "stop"
     - brief_id: {brief ID}
     - phase: "BUILDING"
     - result: {brief summary of forger's output}
     Skip silently if unavailable.
   - Update brief: Active Agent = none
   - Update Agent Log with result
   - Proceed to TESTING

### Phase 4: TESTING

1. Update brief: Phase = TESTING, Active Agent = sentinel
2. Add Agent Log entry: "Starting sentinel..."
3. **Emit agent event (start):** If brain MCP is available AND Instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`, call `igris_agent_event` with:
   - instance_id: {Instance ID}
   - agent: "sentinel"
   - event_type: "start"
   - brief_id: {current brief ID}
   - phase: "TESTING"
   Skip silently if MCP unavailable.
4. **Delegate to sentinel agent** using Agent tool:

```
Agent tool parameters:
- subagent_type: "sentinel"
- description: "Test {BRIEF_ID} implementation"
- prompt: "Run tests for the implementation.

  Run:
  1. Linter/analyzer (if applicable)
  2. Unit tests
  3. Integration tests (if applicable)

  Report PASS or FAIL with details."
```

5. After sentinel returns:
   - **Emit agent event (stop or error):** Call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "sentinel"
     - event_type: "stop" (if PASS) or "error" (if FAIL)
     - brief_id: {brief ID}
     - phase: "TESTING"
     - result: "PASS" or "FAIL" with details
     - error_message: {failure details, if FAIL}
     Skip silently if unavailable.
   - Update brief: Active Agent = none
   - Update Agent Log with result

6. **If PASS:**
   - Proceed to REVIEWING

7. **If FAIL and Retry Count < 3:**
   - Increment Retry Count
   - **Emit agent event (retry):** Call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "sentinel"
     - event_type: "retry"
     - brief_id: {brief ID}
     - phase: "TESTING"
     - metadata: '{"attempt": {retry_count}, "reason": "test failure"}'
     Skip silently if unavailable.
   - Delegate to mender agent for diagnosis
   - Return to BUILDING with fix instructions

8. **If FAIL and Retry Count >= 3:**
   - Set Phase: BLOCKED
   - Display: "Tests failing after 3 attempts. Manual intervention required."
   - Add blocker to `~/.igris/projects/{project}/session/BLOCKERS.md`
   - Stop workflow

### Phase 5: REVIEWING

1. Update brief: Phase = REVIEWING, Active Agent = warden
2. Add Agent Log entry: "Starting warden..."
3. **Emit agent event (start):** If brain MCP is available AND Instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`, call `igris_agent_event` with:
   - instance_id: {Instance ID}
   - agent: "warden"
   - event_type: "start"
   - brief_id: {current brief ID}
   - phase: "REVIEWING"
   Skip silently if MCP unavailable.
4. **Delegate to warden agent** using Agent tool:

```
Agent tool parameters:
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

5. After warden returns:
   - **Emit agent event (stop or error):** Call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "warden"
     - event_type: "stop" (if APPROVE) or "error" (if REJECT)
     - brief_id: {brief ID}
     - phase: "REVIEWING"
     - result: "APPROVE" or "REJECT" with feedback
     Skip silently if unavailable.
   - Update brief: Active Agent = none
   - Update Agent Log with result

6. **If APPROVE:**
   - Evaluate if documentation updates are needed (see Phase 6 conditions)
   - If docs needed: Proceed to DOCUMENTING
   - If no docs needed: Proceed to COMMITTING

7. **If REJECT and Retry Count < 2:**
   - Increment Retry Count
   - **Emit agent event (retry):** Call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "warden"
     - event_type: "retry"
     - brief_id: {brief ID}
     - phase: "REVIEWING"
     - metadata: '{"attempt": {retry_count}, "reason": "review rejection"}'
     Skip silently if unavailable.
   - Return to BUILDING with reviewer feedback

8. **If REJECT and Retry Count >= 2:**
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

4. **If docs needed:**
   - **Emit agent event (start):** If brain MCP is available AND Instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`, call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "document"
     - event_type: "start"
     - brief_id: {current brief ID}
     - phase: "DOCUMENTING"
     Skip silently if MCP unavailable.
   - **Invoke /document skill directly** (orchestrator-level operation):

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
   - **Emit agent event (stop):** If /document was invoked, call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "document"
     - event_type: "stop"
     - brief_id: {brief ID}
     - phase: "DOCUMENTING"
     - result: {brief summary of documentation updates, or "Skipped - no docs needed"}
     Skip silently if unavailable.
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
5. Call `igris_brief_sync` with status="Done", phase="COMMITTING".
   **If brain MCP is NOT available or the call fails:**
   - Display: `WARNING: Brain sync skipped for {BRIEF_ID} (status=Done) — MCP unavailable. Queued locally for next /awaken or /sync data.`
   - Append a JSON line to `~/.igris/projects/{project}/sync_queue.jsonl`:
     ```json
     {"timestamp":"{ISO-8601 now}","operation":"brief_sync","project":"{project}","brief_id":"{BRIEF_ID}","title":"{title}","status":"Done","phase":"COMMITTING"}
     ```
   - Do NOT block the hunt workflow — continue to COMPLETE.
6. Proceed to COMPLETE

### Phase 8: COMPLETE

1. Update brief: Phase = COMPLETE
2. Update `~/.igris/projects/{project}/session/instances/<instance_id>.md`:
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

On each phase transition (PLANNING, BUILDING, TESTING, REVIEWING, DOCUMENTING, COMMITTING, COMPLETE), you MUST refresh the instance heartbeat if an instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`.

If the `igris-brain` MCP server is available AND an instance ID is stored:
1. Read the Instance ID from `~/.igris/projects/{project}/session/instances/<instance_id>.md`
2. Call `igris_instance_heartbeat` with:
   - instance_id = the instance ID from `~/.igris/projects/{project}/session/instances/<instance_id>.md`
   - machine_hostname = system hostname
   - machine_os = platform (e.g., "darwin", "linux")
   - project_slug = current project slug
   - project_path = absolute path to project directory
   - current_brief = the brief ID being implemented
   - current_phase = the new phase name
   - current_task = description of current activity (e.g., "architect planning", "forger implementing")
3. This keeps the instance "active" on the dashboard and shows real-time workflow progress

If brain MCP is not available or no instance ID is stored, skip silently. Do NOT block workflow execution.

### Mid-Phase Heartbeats for Long-Running Phases

During long phases (BUILDING, TESTING), the active subagent may run for extended periods. To prevent the instance from being marked stale mid-workflow:

- When delegating to **forger** (BUILDING phase), include in the Task prompt: "If you have access to `igris_instance_heartbeat` and the instance_id from `~/.igris/projects/{project}/session/instances/<instance_id>.md`, call it periodically during long implementations to keep the instance active."
- When delegating to **sentinel** (TESTING phase), include the same heartbeat reminder in the Task prompt.
- The orchestrator should also call `igris_instance_heartbeat` immediately before each Task delegation (not just on phase transitions) to maximize the heartbeat window for the subagent.

This ensures instances remain visible on the dashboard even during phases that exceed the 45-minute stale threshold.

## Agent Event Emission (Mandatory When Available)

On each agent invocation, you MUST emit `igris_agent_event` calls if brain MCP is available AND Instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`.

**Pattern for every agent:**

1. **Before invoking agent:** Call `igris_agent_event` with event_type="start"
2. **After agent returns successfully:** Call `igris_agent_event` with event_type="stop" and result summary
3. **On agent failure:** Call `igris_agent_event` with event_type="error" and error_message
4. **On retry:** Call `igris_agent_event` with event_type="retry" and metadata with attempt count and reason

All agent event emissions are **fire-and-forget**. If the MCP call fails, skip silently. Agent events must NEVER block or delay the hunt workflow.

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
