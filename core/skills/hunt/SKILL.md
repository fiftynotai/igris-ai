---
name: hunt
tier: essential
description: "Implement a brief with full workflow - usage: /hunt BR-008"
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
  - mcp__igris-brain__igris_error_lookup
  - mcp__igris-brain__igris_brief_sync
  - mcp__igris-brain__igris_brief_get
  - mcp__igris-brain__igris_brief_update
  - mcp__igris-brain__igris_brief_claim
  - mcp__igris-brain__igris_brief_release
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

### Phase 1: INIT

0. **Ceremony start (FR-268):** run `igris ceremony start --name hunt-init --project {project} --brief {BRIEF_ID} --instance-id {instance_id} 2>/dev/null || true` — the brain-timed start of INIT; never blocks. The matching stop follows the Instance State line below.
1. Load brief via `igris_brief_get` with `project` (the current project slug) and
   `brief_id` (`$ARGUMENTS`) — both are REQUIRED — falling back to cache at
   `~/.igris/projects/{project}/briefs/` matching `$ARGUMENTS`
2. Read brief content
2.5. **Detect resume + capture recorded phase (FR-189):**
   Read the brief's `## Workflow State` → `**Phase:**` field into RECORDED_PHASE.
   - Fresh hunt: Status was "Ready", OR there is no Workflow State block, OR
     RECORDED_PHASE is empty/INIT → set RECORDED_PHASE = INIT, RESUMED = false.
   - Resumed hunt: Status is already "In Progress" AND RECORDED_PHASE is a phase
     beyond INIT (PLANNING/APPROVAL/BUILDING/TESTING/REVIEWING/DOCUMENTING/
     COMMITTING) → keep RECORDED_PHASE as-is, RESUMED = true.
   - Catch-all: Any RECORDED_PHASE not in the resume set (including `BLOCKED` and
     a contradictory `COMPLETE` while Status is In Progress) → set RESUMED = false,
     RECORDED_PHASE = INIT, enter Phase 2: PLANNING. (Manual intervention is
     already required for BLOCKED; a clean restart is the safe deterministic
     default. A smarter resume-at-block-point, if ever wanted, is a separate
     follow-up.)
   Corroborate with step 6.5's `reentrant: true` result; if they disagree,
   trust the recorded `**Phase:**` value (the brief file / brain is the phase
   source of truth). RECORDED_PHASE is used by step 8, the Workflow State
   block, the Instance State line, and the post-INIT entry-branch below.
3. Verify Status is "Ready" or "In Progress"
4. If Status is "Done" or "Draft", refuse with message
5. Update Status: "Ready" -> "In Progress" if needed
6. **Surface the instance registry (Lock 1 — display-only):**
   Run `igris instance list --project {project}`. For every *other* live or remote-uncertain instance returned (any instance that is not this harness's own), surface a one-line advisory: "instance {short_id} ({harness}, {liveness_status}) is on {current_brief}, last activity {last_active}". This warns the operator before they claim a brief a sibling is already working. Same-machine `dead` / `dead_pid_reused` instances may be surfaced as reclaim candidates, but this step remains display-only.

   **This step is display-only — it does NOT block the hunt.** If a sibling already owns the brief being hunted, the hunt still proceeds; the operator is merely informed. FR-127 owns the atomic claim gate — its enforced claim-and-lock sits immediately after this surfacing step and turns this advisory display into a gate. This step is FR-127's merge base.

   If `igris instance list` is unavailable (older CLI), skip silently. Do NOT block the hunt.

6.5. **Atomically claim the brief (FR-127 — the hard gate):**
   If the `igris-brain` MCP server is available, call `igris_brief_claim` with
   `project` = current project slug, `brief_id` = `$ARGUMENTS`, and
   `instance_id` = the Instance ID from the per-instance session file.

   Branch on the result:

   - **`claimed: true`** — proceed. (If `reentrant: true`, this instance already
     held the brief — a resumed hunt; display "Re-claimed FR-XXX (already
     yours)." and continue. Otherwise display nothing and continue to step 7.)

   - **`claimed: false`** — the brief is claimed by `held_by`. Determine if that
     claim is LIVE or RECLAIMABLE: run `igris instance list --project {project}`
     and inspect the held instance's liveness result.
       - **`held_by` is `alive` or `unknown_remote` / `unknown_no_metadata` with an unexpired lease** (live/uncertain claim) → **HARD STOP.** Display:
         "BR-XXX is being hunted by instance {held_by} ({harness}, active {T}
         ago). Two instances cannot hunt the same brief. Aborting /hunt."
         Do NOT proceed to step 7. Do NOT mutate brief status. End the skill.
       - **`held_by` is `dead` / `dead_pid_reused`, OR the remote/unknown lease expired, OR `held_since` is older than 24h**
         (reclaimable claim) → display: "BR-XXX's claim by {held_by} looks reclaimable
         ({reason}). Reclaim? [y/N]" — WAIT for
         explicit operator input. On **N / anything but y** → HARD STOP, end the
         skill. On **y** → call `igris_brief_release` with `project`, `brief_id`
         and the STALE `held_by` instance_id, then call `igris_brief_claim` again
         with the same `project` / `brief_id` and THIS instance's
         `instance_id`; if that second claim returns `claimed: true`, proceed to
         step 7. (If it returns `claimed: false` again — a race where another
         instance grabbed it in the gap — HARD STOP with the live-claim message.)

   If brain MCP is NOT available or `igris_brief_claim` is unavailable (older
   brain), skip this step silently and proceed — the gate degrades to the
   FR-132 display-only advisory. Do NOT block the hunt on MCP absence.

7. Update `~/.igris/projects/{project}/session/instances/<instance_id>.md`:
   - Set Active Brief
   - Set Mode: HUNT MODE
   - `<instance_id>` is read from the `**Instance ID:**` field in the per-instance session file. `/hunt` always runs after `/boot` registered the instance, so the per-instance file and its `**Instance ID:**` field always exist here.

8. Call `igris_brief_sync` with:
   - project: current project slug
   - brief_id: the brief ID
   - brief_type: type from the brief
   - title: the brief title
   - status: "In Progress"
   - priority: the brief's priority
   - effort: the brief's effort
   - phase: RECORDED_PHASE (INIT on a fresh hunt; the preserved recorded phase on a resume — never reset a resumed hunt to INIT)

   **If brain MCP is NOT available or the call fails:**
   - Display: `WARNING: Brain sync skipped for {BRIEF_ID} — MCP unavailable. Queued locally for next /boot or /sync data.`
   - Append a JSON line to `~/.igris/projects/{project}/sync_queue.jsonl`:
     ```json
     {"timestamp":"{ISO-8601 now}","operation":"brief_sync","project":"{project}","brief_id":"{BRIEF_ID}","title":"{title}","status":"In Progress","priority":"{priority}","effort":"{effort}","brief_type":"{type}","phase":"{RECORDED_PHASE}"}
     ```
   - Do NOT block the hunt workflow — continue to next step after warning.

**Update brief Workflow State:** On a resumed hunt (RESUMED = true) do NOT
overwrite `**Phase:**` with INIT — write the preserved RECORDED_PHASE.
```markdown
## Workflow State

**Phase:** {RECORDED_PHASE}
**Active Agent:** none
**Retry Count:** 0

### Current Work
Loading brief and preparing for implementation.

### Next Steps
Enter the state machine at {RECORDED_PHASE}.
```

**Instance State:** If Instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`, run `igris instance state --project {project} --instance-id {instance_id} --current-brief {brief_id} --current-phase {RECORDED_PHASE} --current-task "loading brief" (on a resumed hunt, `--current-task "resuming at {RECORDED_PHASE}"`) --lease-minutes 120`. See "Instance State and Work Lease" below.

**Ceremony stop (FR-268):** run `igris ceremony stop --name hunt-init --project {project} --brief {BRIEF_ID} --instance-id {instance_id} 2>/dev/null || true` — the brain-timed end of INIT (the brain computes the duration from the step-0 start it pairs with); never blocks. This closes the INIT bracket before the phase machine is entered.

**Phase-machine entry (FR-189 — resume-aware):**
INIT above always ran (re-claim, session update, status sync, heartbeat). Now
enter the state machine at RECORDED_PHASE instead of always falling through to
PLANNING:

- RECORDED_PHASE == INIT (fresh hunt) → proceed to Phase 2: PLANNING as normal.
- RECORDED_PHASE beyond INIT (resumed hunt) → emit ONE ≤1-line light confirm of
  the already-completed phases, e.g.
  "Resuming FR-XXX at {RECORDED_PHASE} (INIT..{prior phases} already complete)."
  then jump directly to the matching Phase section below. Do NOT re-run the
  skipped phases or their agent delegations.

Recorded phase → entry section:
| RECORDED_PHASE | Enter at |
|----------------|----------|
| INIT           | Phase 2: PLANNING (fresh) |
| PLANNING / APPROVAL | Phase 2: PLANNING |
| BUILDING       | Phase 3: BUILDING |
| TESTING        | Phase 4: TESTING |
| REVIEWING      | Phase 5: REVIEWING |
| DOCUMENTING    | Phase 6: DOCUMENTING |
| COMMITTING     | Phase 7: COMMITTING |

(COMPLETE is not an entry target — INIT step 4 already refuses a Done brief.)
Any RECORDED_PHASE not in the resume set above (including `BLOCKED` and a
contradictory `COMPLETE` while Status is In Progress) → set RESUMED = false,
RECORDED_PHASE = INIT, enter Phase 2: PLANNING. (Manual intervention is already
required for BLOCKED; a clean restart is the safe deterministic default. A
smarter resume-at-block-point, if ever wanted, is a separate follow-up.)
The recorded phase is treated as in-progress and re-runs from the top of its
section; only strictly-earlier phases are the "completed" ones that get the
light confirm.

### Phase 2: PLANNING

1. Update brief: Phase = PLANNING, Active Agent = architect
2. Add Agent Log entry: "Starting architect..."
3. **Emit agent event (start):** If brain MCP is available AND Instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`, call `igris_agent_event` with:
   - instance_id: {Instance ID from `~/.igris/projects/{project}/session/instances/<instance_id>.md`}
   - agent: "architect"
   - event_type: "start"
   - model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}
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
3.8. **Catalog-driven context-doc plan (FR-213):**
   The architect MUST read `~/.igris/core/context-doc-types/INDEX.md` and use
   the catalog's `consult_when` / `maintain_when` fields to add a `Context Docs`
   section to the plan when any project-context doc is relevant. This is a
   lightweight LLM judgment step, not a task classifier. Do NOT reimplement
   `applies_when`; project-level presence stays owned by
   `igris context-docs inventory`.

   Before invoking architect, run:

   ```bash
   igris context-docs inventory --project {project} --json 2>/dev/null || true
   ```

   Pass the raw JSON output into the architect prompt as
   `Context-doc inventory (applies_when source of truth)`. If the command fails,
   returns degraded output, or emits invalid JSON, continue without blocking and
   tell architect the inventory is unavailable. `/hunt` reads this digest only
   for applicability/presence (`docs[].type`, `docs[].target`, `docs[].exists`,
   `docs[].applies`, `missing_applicable[]`, `remediation[]`). It never
   recreates the predicate logic.

   The plan's `Context Docs` section MUST include:
   - `Consult before build` — target docs the forger should read when present,
     with the matching `consult_when` reason.
   - `Potential maintenance after build` — target docs that may need updates if
     the implementation triggers their `maintain_when` condition.
   - `Missing applicable/relevant docs` — docs absent from
     `~/.igris/projects/{project}/context/`, grounded in the inventory digest
     when available, with `/ground <type>` remediation instead of invented
     placeholder docs.
4. **Delegate to the architect role** using your Agent tool:

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
  5. Context Docs: read ~/.igris/core/context-doc-types/INDEX.md, use
     consult_when to identify project context docs to read before build, and
     use maintain_when to identify docs that may need updates after build.
     Use the supplied Context-doc inventory JSON for applies/existence/missing
     docs. Do not infer or reimplement applies_when; presence is owned by
     igris context-docs inventory.

  Context-doc inventory (applies_when source of truth):
  [raw JSON from `igris context-docs inventory --project {project} --json`,
  or 'unavailable']

  Write plan to ~/.igris/projects/{project}/plans/{BRIEF_ID}-plan.md"
```

5. After architect returns:
   - **Emit agent event (stop):** Call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "architect"
     - event_type: "stop"
     - model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}
     - model_resolved: {the model the harness reports the agent ran on — omit when unknown}
     - input_tokens, output_tokens, cache_read, cache_create: {only when the harness reports them — omit otherwise, NEVER 0}
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
   - model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}
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
4. **Delegate to the forger role** using your Agent tool:

```
Agent tool parameters:
- subagent_type: "forger"
- description: "Implement {BRIEF_ID}"
- prompt: "Implement the following brief according to the plan.

  Brief: [brief content]
  Plan: [plan content if exists]
  Context Docs: Follow the plan's Context Docs section. Read every existing
  project context doc listed under Consult before build. If the plan has no
  Context Docs section, read ~/.igris/core/context-doc-types/INDEX.md and use
  consult_when to decide which existing docs under
  ~/.igris/projects/{project}/context/ are relevant to this implementation.
  Do not reimplement applies_when.

  Follow the plan and implement all required changes.
  Ensure code follows all consulted project context docs.
  Add documentation comments to public APIs.
  In your final report, include a 'Context doc impact' block. List any durable
  convention, pattern, API shape, architecture boundary, UI standard, or test
  standard changed, and name which maintain_when condition it may trigger. If
  none, say 'None'.

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
     - model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}
     - model_resolved: {the model the harness reports the agent ran on — omit when unknown}
     - input_tokens, output_tokens, cache_read, cache_create: {only when the harness reports them — omit otherwise, NEVER 0}
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
   - model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}
   - brief_id: {current brief ID}
   - phase: "TESTING"
   Skip silently if MCP unavailable.
4. **Delegate to the sentinel role** using your Agent tool:

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
     - model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}
     - model_resolved: {the model the harness reports the agent ran on — omit when unknown}
     - input_tokens, output_tokens, cache_read, cache_create: {only when the harness reports them — omit otherwise, NEVER 0}
     - brief_id: {brief ID}
     - phase: "TESTING"
     - result: "PASS" or "FAIL" with details
     - error_message: {failure details, if FAIL}
     Skip silently if unavailable.
   - Update brief: Active Agent = none
   - Update Agent Log with result

6. **If PASS:**
   - If this PASS follows a mender-guided retry and mender returned an Error
     Memory Handoff, store the verified recovery before leaving TESTING:
     call `igris_error_lookup` with `project={current project slug}`,
     `message={Canonical Error Message from mender}`, and
     `solution={verified Root Cause + fix summary from the applied changes}`.
     This storage step is orchestrator-owned because only the orchestrator sees
     the post-fix sentinel PASS. If brain MCP or `igris_error_lookup` is
     unavailable, skip silently; never block a passing hunt on memory storage.
   - Proceed to REVIEWING

7. **If FAIL and Retry Count < 3:**
   - Increment Retry Count
   - **Emit agent event (retry):** Call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "sentinel"
     - event_type: "retry"
     - model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}
     - brief_id: {brief ID}
     - phase: "TESTING"
     - metadata: '{"attempt": {retry_count}, "reason": "test failure"}'
     Skip silently if unavailable.
   - **Emit agent event (start):** Call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "mender"
     - event_type: "start"
     - model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}
     - brief_id: {brief ID}
     - phase: "TESTING"
     Skip silently if unavailable. Mender is a role the Agent Log names, so it
     needs its own start/stop pair like every other agent (FR-267).
   - Delegate to mender agent for diagnosis. Include the sentinel failure output
     verbatim and instruct mender that its first diagnostic action MUST be
     `igris_error_lookup` with the canonical error message before parsing,
     grepping, hypothesizing, or inspecting files. Require mender to return an
     `Error Memory Handoff` block containing `Canonical Error Message`, `Root
     Cause`, and `Proposed Solution`.
   - **Emit agent event (stop or error):** After mender returns, call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "mender"
     - event_type: "stop" (if it returned the handoff) or "error" (if it did not)
     - model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}
     - model_resolved: {the model the harness reports the agent ran on — omit when unknown}
     - input_tokens, output_tokens, cache_read, cache_create: {only when the harness reports them — omit otherwise, NEVER 0}
     - brief_id: {brief ID}
     - phase: "TESTING"
     - result: {the handoff's Root Cause + Proposed Solution, one line}
     Skip silently if unavailable.
   - Return to BUILDING with fix instructions

8. **If FAIL and Retry Count >= 3:**
   - Set Phase: BLOCKED
   - Display: "Tests failing after 3 attempts. Manual intervention required."
   - Add blocker to `~/.igris/projects/{project}/session/BLOCKERS.md`
   - Stop workflow

### Phase 5: REVIEWING

0. **Acceptance-criteria reconciliation (TD-325).** Before warden runs, resolve
   the brief's acceptance criteria against what was actually built. Run the
   shared parser on the brief's stored content:

   ```bash
   bash <parser> --brief-id {BRIEF_ID} --guidance <brief-content-file>
   ```

   The parser is `core/scripts/brief_ac_check.sh` in the project checkout, or
   `~/.igris/core/scripts/brief_ac_check.sh` at runtime. If neither exists, skip
   this step silently and continue.

   Read the `VERDICT=` field of its first output line:
   - `PASS` / `NO_AC` / `NO_ITEMS` / `DEGRADED` — nothing to do, continue.
   - `FAIL` — resolve every criterion it names, **one at a time**, before
     REVIEWING proceeds:
     - **Tick it (`- [x]`) ONLY with cited evidence.** The evidence is an
       artifact: a test name, a `file:line`, a measured figure, a commit sha.
       Record it on an `EVIDENCE:` line in the Agent Log beside the tick.
       A tick you cannot evidence invents the record, which is the move TD-311
       forbids — it is worse than leaving the box open.
     - **Otherwise defer it explicitly**, in the brief itself:
       `- [~] **DEFERRED: <why it is unmet>** -> {FOLLOW_UP_BRIEF_ID}`
       The follow-up brief is required. A deferral with nowhere to go is
       indistinguishable from one that was forgotten.
     - **If you can neither evidence nor honestly defer it, stop and ask the
       operator.** Do not guess, and do not tick to make the verdict green.

   Write the resolved criteria back with `igris_brief_update`, passing `project`
   (the current project slug) and `brief_id` (`$ARGUMENTS`) alongside the updated
   content — both are REQUIRED, and a call omitting either is rejected at the
   gateway (BR-080). Doing this here rather than at COMMITTING is deliberate:
   warden then reviews the ticks, and the Phase 7 gate becomes a confirmation
   instead of a surprise. **If this call is rejected, STOP and report it** — the
   ticks stay unwritten, and the TD-325 commit-msg gate reads the brain record,
   not your working notes, so the closing commit would be refused with no
   indication that the resolution work was ever done.

1. Update brief: Phase = REVIEWING, Active Agent = warden
2. Add Agent Log entry: "Starting warden..."
3. **Emit agent event (start):** If brain MCP is available AND Instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`, call `igris_agent_event` with:
   - instance_id: {Instance ID}
   - agent: "warden"
   - event_type: "start"
   - model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}
   - brief_id: {current brief ID}
   - phase: "REVIEWING"
   Skip silently if MCP unavailable.
4. **Delegate to the warden role** using your Agent tool:

```
Agent tool parameters:
- subagent_type: "warden"
- description: "Review {BRIEF_ID} implementation"
- prompt: "Review the implementation for quality.

  Check:
  1. Read ~/.igris/core/context-doc-types/INDEX.md and the plan's Context Docs
     section. Load every existing project context doc relevant by consult_when.
  2. REJECT if the implementation violates any consulted project context doc.
  3. REJECT if an obvious maintain_when trigger was ignored: either the relevant
     context doc must already be updated, Phase 6 context-doc maintenance must
     be explicitly queued, or the deferral/remediation must be explicit. Do NOT
     reject merely because a legitimate Context doc impact is waiting for the
     DOCUMENTING phase to resolve it.
  4. No security vulnerabilities.
  5. Tests are adequate.
  6. Documentation is present where required.
  7. ACCEPTANCE CRITERIA (TD-325). No regex can catch a false tick, so this is
     yours: for every criterion ticked during this hunt, is there a NAMED
     artifact in the diff, the tests or the hunt log that establishes it — a
     test name, a file:line, a measured figure, a commit? REJECT a tick whose
     evidence you cannot locate; an unevidenced tick invents the record, which
     is the move TD-311 forbids, and it is worse than an open box. And for
     every `- [~]`, REJECT if it carries no DEFERRED reason or names no
     follow-up brief.

  Output: APPROVE or REJECT with feedback."
```

5. After warden returns:
   - **Emit agent event (stop or error):** Call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "warden"
     - event_type: "stop" (if APPROVE) or "error" (if REJECT)
     - model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}
     - model_resolved: {the model the harness reports the agent ran on — omit when unknown}
     - input_tokens, output_tokens, cache_read, cache_create: {only when the harness reports them — omit otherwise, NEVER 0}
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
     - model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}
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
- The forger or warden reports a `Context doc impact`
- A catalog `maintain_when` condition is triggered for an existing project
  context doc

**Skip /document skill when (proceed directly to COMMITTING):**
- Internal refactoring only
- Bug fixes with no API changes
- Test-only changes
- Session/config changes
- No `maintain_when` condition is triggered and Warden did not request
  context-doc maintenance

4. **If docs needed:**
   - **Emit agent event (start):** If brain MCP is available AND Instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`, call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "document"
     - event_type: "start"
     - model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}
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
       Context Docs: Read ~/.igris/core/context-doc-types/INDEX.md. Use
       maintain_when to decide whether existing docs under
       ~/.igris/projects/{project}/context/ need updates. Update existing
       context docs when the change clearly modifies a durable standard.
       If the relevant context doc is missing or the standard is not yet clear,
       report /ground <type> or an operator follow-up instead of inventing a
       thin placeholder.
       Check and update as needed:
       1. README.md (if user-facing features)
       2. API documentation (if API changes)
       3. Module catalog (if new modules)
       4. Project context docs (if maintain_when triggers)
       5. Code comments (if public API changes)
       Only update docs that are relevant to the changes made."
     ```

5. After /document skill completes (or if skipped):
   - **Emit agent event (stop):** If /document was invoked, call `igris_agent_event` with:
     - instance_id: {Instance ID}
     - agent: "document"
     - event_type: "stop"
     - model_requested: {the model you chose for this agent, or "inherit:<your own model id>"}
     - model_resolved: {the model the harness reports the agent ran on — omit when unknown}
     - input_tokens, output_tokens, cache_read, cache_create: {only when the harness reports them — omit otherwise, NEVER 0}
     - brief_id: {brief ID}
     - phase: "DOCUMENTING"
     - result: {brief summary of documentation updates, or "Skipped - no docs needed"}
     Skip silently if unavailable.
   - Update brief: Active Agent = none
   - Update Agent Log with result (or "Skipped - no docs needed")
   - Proceed to COMMITTING

### Phase 7: COMMITTING

0. **Acceptance-criteria gate (TD-325) — the confirmation.** Re-run the parser
   from Phase 5 step 0 on the brief's current stored content. On `FAIL`, do NOT
   commit: return to the Phase 5 step 0 resolution loop (tick with cited
   evidence, or defer with a reason and a follow-up brief), then re-run.

   This is a confirmation, not a discovery: Phase 5 step 0 should already have
   resolved everything. If it fires here, something changed the brief between
   REVIEWING and COMMITTING, and that is worth knowing before the close.

   The commit below carries a `closes #{BRIEF_ID}` footer, so the commit-msg
   hook enforces the same verdict mechanically. Reaching that hook by surprise
   means this step was skipped. `IGRIS_BYPASS_AC_GATE=1` exists for a genuine
   emergency and is one-shot — it is never the way to get past an open box.

   The same footer triggers the hook's SECOND check (FR-267, agent-event
   coverage): every role the Agent Log names must have at least one recorded
   agent event (an `agent_events` row for this brief), or the close is refused
   with the missing roles named. Emit the missing event before committing;
   `IGRIS_BYPASS_EVENT_GATE=1` is the one-shot emergency hatch, never the
   routine path.

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
5. Call `igris_brief_sync` with the SAME `project`, `brief_id`, `brief_type`,
   `title`, `priority` and `effort` you passed in Phase 1 step 8, plus
   status="Done", phase="COMMITTING". `project`, `brief_id`, `title` and
   `status` are REQUIRED — a call omitting any of them is rejected at the
   gateway (BR-080). Passing the unchanged fields is not redundant: this is an
   upsert, and a field you omit is written as NULL over the existing value.
   **If brain MCP is NOT available or the call fails:**
   - Display: `WARNING: Brain sync skipped for {BRIEF_ID} (status=Done) — MCP unavailable. Queued locally for next /boot or /sync data.`
   - Append a JSON line to `~/.igris/projects/{project}/sync_queue.jsonl`:
     ```json
     {"timestamp":"{ISO-8601 now}","operation":"brief_sync","project":"{project}","brief_id":"{BRIEF_ID}","title":"{title}","status":"Done","phase":"COMMITTING"}
     ```
   - Do NOT block the hunt workflow — continue to COMPLETE.

   **The brief file on disk is a projection (TD-414).** The file under
   `~/.igris/projects/{project}/briefs/` is the brain's `brief_files` row
   projected to disk. A status sync carries no content and never overwrites a
   local file that is newer than the brain copy — but the acceptance-criteria
   gate above and the commit-msg gate read the BRAIN record, so a disk-only
   edit is invisible to both. If you edited the file on disk, push it FIRST:
   call `igris_brief_update` with `project`, `brief_id` and the file's text as `content`, then sync.
   A sync that answers `not ruling on acceptance criteria` means that push was
   skipped — push, then sync again.
5.5. **Release the brief claim (FR-127):** Call `igris_brief_release` with
   `project` = current project slug, `brief_id` = the brief ID, and
   `instance_id` = the stored Instance ID. The brief is Done — its claim must
   be freed so the slot is clean. Idempotent; skip silently if brain MCP is
   unavailable.
6. Proceed to COMPLETE

### Phase 8: COMPLETE

1. Update brief: Phase = COMPLETE
2. Call `igris_brief_sync` with the same full field set as Phase 7 step 5
   (`project`, `brief_id`, `brief_type`, `title`, `priority`, `effort`), with
   status="Done" (unchanged) and phase="COMPLETE".
   This is the terminal-phase flip — Phase 7 synced phase="COMMITTING"; this
   step lands the canonical phase=COMPLETE in the brain DB so the
   status↔phase↔git invariant holds (TD-257: the C1 contradiction the
   reconciliation validator flags exists because this sync was previously
   missing).
   **If brain MCP is NOT available or the call fails:**
   - Display: `WARNING: Brain sync skipped for {BRIEF_ID} (phase=COMPLETE) — MCP unavailable. Queued locally for next /boot or /sync data.`
   - Append a JSON line to `~/.igris/projects/{project}/sync_queue.jsonl`:
     ```json
     {"timestamp":"{ISO-8601 now}","operation":"brief_sync","project":"{project}","brief_id":"{BRIEF_ID}","title":"{title}","status":"Done","phase":"COMPLETE"}
     ```
   - Do NOT block the hunt workflow — continue.
3. Update `~/.igris/projects/{project}/session/instances/<instance_id>.md`:
   - Add to Last Session Summary
   - Clear Active Brief (or set to next)

4. Display completion message:
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

## Instance State and Work Lease (Mandatory When Available)

On each phase transition (PLANNING, BUILDING, TESTING, REVIEWING, DOCUMENTING, COMMITTING, COMPLETE), you MUST update this instance's state and renew its work lease if an instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`.

If the CLI is available AND an instance ID is stored:
1. Read the Instance ID from `~/.igris/projects/{project}/session/instances/<instance_id>.md`
2. Run:
   ```bash
   igris instance state --project {project} \
     --instance-id {instance_id} \
     --current-brief {brief_id} \
     --current-phase {phase} \
     --current-task "{description}" \
     --lease-minutes 120
   ```
3. This records progress and renews the remote-visible work lease. It is not a liveness proof; same-machine liveness comes from PID/start-time metadata recorded by `/boot`.

If the CLI is unavailable or no instance ID is stored, skip silently. Do NOT block workflow execution.

### Mid-Phase Lease Renewal for Long-Running Phases

During long phases (BUILDING, TESTING), the active subagent may run for extended periods. To keep cross-machine coordination honest:

- The orchestrator should run `igris instance state ... --lease-minutes 120` immediately before each Task delegation.
- If a long phase exceeds the lease window, renew the lease before continuing.
- Do not instruct subagents to emit instance activity calls; activity age is not a liveness signal.

This ensures other machines can see that the work is still reserved without pretending they can inspect this machine's process liveness.

## Agent Event Emission (Mandatory When Available)

On each agent invocation, you MUST emit `igris_agent_event` calls — each naming `instance_id`, `agent`, `event_type` and `model_requested` — if brain MCP is available AND Instance ID exists in `~/.igris/projects/{project}/session/instances/<instance_id>.md`.

**Pattern for every agent.** Every call below passes `instance_id` (from the
per-instance session file), `agent` (the role being invoked) and
`model_requested` (the model you chose for that role, or
`inherit:<your own model id>` — an opaque string, never a guess about how the
harness resolves it) in addition to the fields named — all FOUR of
`instance_id`, `agent`, `event_type` and `model_requested` are REQUIRED, and a
call omitting any is rejected at the gateway (BR-080, FR-267):

1. **Before invoking agent:** Call `igris_agent_event` with event_type="start"
2. **After agent returns successfully:** Call `igris_agent_event` with event_type="stop" and result summary; add `model_resolved` and the four token counts (`input_tokens`, `output_tokens`, `cache_read`, `cache_create`) only when the harness reports them — omit them otherwise, never pass 0; and `metadata` as `{"tool_calls": N, "total_tokens": T}` only when the harness reports them (omit the key otherwise, never 0 — `igris kpi` reads `metadata.tool_calls` for KPI 6 and stays NULL until rows carry it, FR-268)
3. **On agent failure:** Call `igris_agent_event` with event_type="error" and error_message
4. **On retry:** Call `igris_agent_event` with event_type="retry" and metadata with attempt count and reason

**Every invocation is a row.** A resumed, re-prompted or re-run agent is a NEW
invocation: emit `start` before it and `stop`/`error` after it, every time.
The brain assigns `round` and computes duration from its own clock — never
pass either (`duration_ms` is not a tool argument any more; a call carrying it
is rejected).

**The gate.** Every role you name in the Agent Log must have at least one
recorded event, or the closing commit is refused by the `commit-msg` hook
(`IGRIS_BYPASS_EVENT_GATE=1`, one-shot, is the only way past it). The rule
reads the log you wrote, so a phase you legitimately skipped demands nothing.

All agent event emissions are **fire-and-forget**. If the MCP call fails, skip silently. Agent events must NEVER block or delay the hunt workflow.

## Error Handling

- If brief not found: Display error with available briefs
- If Status is Done: "Brief already complete. Use /archive to archive."
- If subagent fails: Log error, attempt recovery or block
- If git commit fails: Display error, do not update status

## Agent Log Format

Maintain in brief file under Workflow State. The disk file is a projection of
the brain's `brief_files` row (TD-414): a later brain-side content write
replaces a local edit, so write the log back first —
call `igris_brief_update` with `project`, `brief_id` and the whole file as `content` before any brain-side content write.

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
