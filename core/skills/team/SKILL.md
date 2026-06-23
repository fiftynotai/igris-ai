---
name: team
description: Parallel execution with Agent Teams - spawn teammates for parallel briefs, reviews, investigations
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
  - mcp__igris-brain__igris_brief_get
  - mcp__igris-brain__igris_brief_list
  - mcp__igris-brain__igris_brief_update
triggers:
  - "TEAM"
  - "team hunt"
  - "team review"
  - "team investigate"
  - "team refactor"
  - "team status"
  - "team shutdown"
  - "spawn teammates"
  - "parallel"
---

# TEAM - Parallel Execution with Agent Teams

Spawn multiple independent Claude Code instances (teammates) that work in parallel on distinct tasks. This sits above the standard subagent system -- each teammate is a full Claude Code session with its own context, tools, and autonomy, coordinated by the Igris Lead (you).

## Usage

```
/team hunt FR-022 FR-023 FR-024
/team review
/team review PR-42
/team investigate BR-015
/team refactor module-a module-b module-c
/team status
/team message teammate-1 "focus on auth"
/team broadcast "use new API endpoint"
/team shutdown
```

## Arguments

`$ARGUMENTS` is the subcommand followed by its parameters.

Subcommands: `hunt`, `review`, `investigate`, `refactor`, `status`, `message`, `broadcast`, `shutdown`.

## Prerequisites

1. **Experimental flag required:** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 1` must be set in `~/.claude/settings.json`
   - This is already configured for this project in `~/.claude/settings.json` under the `env` key:
     ```json
     {
       "env": {
         "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
       }
     }
     ```
   - If the flag is missing or disabled, add the `env` block to `~/.claude/settings.json`
2. **One team per session:** Only one active team is allowed at a time
3. **No nested teams:** Teammates cannot spawn their own teams
4. **Display mode (optional):** Set `"teammateMode": "tmux"` in `~/.claude/settings.json` for split-pane view (requires tmux or iTerm2). Default is `"in-process"` which works without extra dependencies.

## Pre-Flight Check

Before every team spawn, execute these checks in order:

1. **Verify experimental flag:**
   - Check that Agent Teams is enabled in the environment
   - If not enabled, display error and stop:
     ```
     Agent Teams requires CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 1
     Set this in ~/.claude/settings.json to enable parallel execution.
     ```

2. **Check for active team:**
   - Read `~/.igris/projects/{project}/session/CURRENT_SESSION.md`
   - If Mode contains "TEAM", display error:
     ```
     A team is already active. Run /team shutdown first.
     ```

3. **Validate arguments:**
   - For `hunt`: Verify each brief ID via `igris_brief_get` (MCP) or cache at `~/.igris/projects/{project}/briefs/` and has Status: Ready
   - For `review`: Verify PR number exists (if provided) or staged changes exist
   - For `investigate`: Verify brief ID exists
   - For `refactor`: Verify each module name maps to a valid directory or file

4. **Check for file conflicts (hunt/refactor):**
   - Cross-reference files that each teammate would modify
   - If overlap found, warn the lead and suggest reassignment or serialization

---

## Subcommand: `/team hunt <brief-ids...>`

Parallel implementation of multiple briefs. Each brief is assigned to one teammate that runs the full HUNT workflow independently.

### Step 1: Validate Briefs

For each brief ID in arguments:
1. Load brief via `igris_brief_get` (MCP) or cache at `~/.igris/projects/{project}/briefs/` matching the ID
2. Read brief content
3. Verify Status is "Ready"
4. If any brief is not Ready, report and exclude it

### Step 2: Check File Overlap

1. Read each brief's Context/Inputs section to identify affected files
2. Cross-reference file lists between briefs
3. If overlap found, display warning:
   ```
   File conflict detected:
   - {FILE_PATH} is referenced by both {BRIEF_A} and {BRIEF_B}

   Options:
   1. Proceed with caution (teammates must coordinate via messaging)
   2. Remove conflicting brief from this team run
   3. Cancel and restructure briefs
   ```
4. Wait for lead decision before proceeding

### Step 3: Plan Teammate Assignments

For each validated brief, create an assignment:
- Teammate name: `teammate-{brief-id}` (lowercase, e.g., `teammate-fr-022`)
- Brief: Full brief content
- File ownership: Files listed in the brief's Context/Inputs section
- Workflow: Full HUNT pipeline (plan -> build -> test -> review -> commit)

### Step 4: Spawn Teammates

Instruct Claude Code to create the team using natural language. For each teammate, provide the self-contained instruction prompt (see Teammate Instruction Template below).

### Step 5: Teammate Execution

Each teammate executes independently:
1. Read assigned brief
2. Read coding guidelines
3. Plan implementation
4. Implement changes within file ownership boundary
5. Run linter and tests
6. Self-review for quality
7. Commit with conventional format
8. Message the lead with completion summary

### Step 6: Update Session State

Update `~/.igris/projects/{project}/session/CURRENT_SESSION.md`:
```markdown
## Team State

**Mode:** TEAM HUNT
**Team Started:** {timestamp}
**Active Teammates:**
| Teammate | Brief | Status | Branch |
|----------|-------|--------|--------|
| teammate-{id-1} | {BRIEF_ID_1} | Working | develop |
| teammate-{id-2} | {BRIEF_ID_2} | Working | develop |
| teammate-{id-3} | {BRIEF_ID_3} | Working | develop |
```

### Step 7: Monitor and Collect Results

- Use `/team status` to check progress
- Teammates message the lead upon completion
- When all teammates finish, display summary and suggest `/team shutdown`

### Teammate Instruction Template

```
You are a Teammate working on {BRIEF_ID} as part of a parallel team.
Assignment: {brief content summary}
Files you own: {file list}
DO NOT modify files outside your ownership boundary.

Workflow:
1. Read the brief via igris_brief_get (MCP) or cache at ~/.igris/projects/{project}/briefs/{BRIEF_ID}-*.md
2. Read ~/.igris/projects/{project}/context/coding_guidelines.md
3. Plan implementation
4. Implement changes
5. Run linter and tests
6. Self-review for quality
7. Commit with conventional format: <type>(<scope>): <summary> -- closes #{BRIEF_ID}
8. Message the lead with completion summary

Rules:
- Stay within your file ownership boundary
- If you need files outside your boundary, message the lead FIRST
- Follow coding_guidelines.md strictly
- Do NOT add AI signatures to commits
- Run linter before committing -- zero issues required
```

---

## Subcommand: `/team review [PR-number]`

Multi-angle code review by spawning three WARDEN-themed teammates, each with a distinct review focus.

### Step 1: Identify Review Target

- If PR number provided: Fetch PR diff using `gh pr diff {PR-number}`
- If no PR number: Use staged/unstaged changes from `git diff`

### Step 2: Spawn Review Teammates

Spawn 3 specialized reviewers:

| Teammate | Focus | Checklist |
|----------|-------|-----------|
| `warden-security` | Security | Secrets in code, injection vectors, auth bypasses, data exposure, input validation |
| `warden-performance` | Performance | N+1 queries, memory leaks, algorithmic complexity, missing caching, unnecessary allocations |
| `warden-standards` | Standards | coding_guidelines.md compliance, naming conventions, layer boundaries, documentation, test coverage |

### Step 3: Reviewer Execution

Each reviewer independently:
1. Read the diff or changed files
2. Apply their specialized checklist
3. Output verdict: APPROVE or REJECT
4. List findings with severity (Critical, Major, Minor, Suggestion)
5. Message the lead with their report

### Reviewer Instruction Template

```
You are {REVIEWER_NAME}, a specialized code reviewer on a parallel review team.
Your focus: {FOCUS_AREA}

Review target: {PR description or diff summary}
Changed files: {file list}

Review checklist:
{CHECKLIST_ITEMS}

Read the changed files and evaluate against your checklist.
For each finding, provide:
- Severity: Critical | Major | Minor | Suggestion
- File and line (if applicable)
- Description of the issue
- Recommended fix

Output format:
VERDICT: APPROVE | REJECT
FINDINGS: {count} ({critical} critical, {major} major, {minor} minor)

[Detailed findings list]

Message the lead with your complete review report.
```

### Step 4: Synthesize Unified Report

After all reviewers complete:
1. Collect all three reports
2. Merge findings, deduplicate overlaps
3. Determine overall verdict:
   - If ANY reviewer has Critical finding: REJECT
   - If 2+ reviewers REJECT: REJECT
   - Otherwise: APPROVE with conditions
4. Display unified report:
   ```
   TEAM REVIEW COMPLETE

   Overall: {APPROVE | REJECT}

   Security ({VERDICT}): {summary}
   Performance ({VERDICT}): {summary}
   Standards ({VERDICT}): {summary}

   Critical findings: {count}
   Major findings: {count}
   Minor findings: {count}
   Suggestions: {count}

   [Detailed merged findings]
   ```

### Step 5: Update Session State

Update `~/.igris/projects/{project}/session/CURRENT_SESSION.md`:
```markdown
## Team State

**Mode:** TEAM REVIEW
**Team Started:** {timestamp}
**Review Target:** {PR number or "working changes"}
**Active Teammates:**
| Teammate | Focus | Status |
|----------|-------|--------|
| warden-security | Security | Working |
| warden-performance | Performance | Working |
| warden-standards | Standards | Working |
```

---

## Subcommand: `/team investigate <brief-id>`

Competitive hypothesis investigation. Multiple teammates each investigate a different hypothesis about a bug or issue, working to confirm or disprove their theory.

### Step 1: Read the Brief

1. Find and read the brief (typically a bug report)
2. Extract the problem description, symptoms, and any error messages

### Step 2: Form Hypotheses

The lead analyzes the brief and forms 3-5 hypotheses about the root cause:

```
Hypotheses for {BRIEF_ID}:
1. {hypothesis-1}: {description}
2. {hypothesis-2}: {description}
3. {hypothesis-3}: {description}
[optional 4-5]
```

Display hypotheses and confirm with user before spawning.

### Step 3: Spawn Investigation Teammates

One teammate per hypothesis:

| Teammate | Hypothesis | Investigation Area |
|----------|-----------|-------------------|
| `investigator-1` | {hypothesis-1} | {relevant files/modules} |
| `investigator-2` | {hypothesis-2} | {relevant files/modules} |
| `investigator-3` | {hypothesis-3} | {relevant files/modules} |

### Step 4: Investigator Execution

Each investigator independently:
1. Read the brief for full context
2. Focus on their assigned hypothesis
3. Search relevant code, logs, and configurations
4. Gather evidence for or against their hypothesis
5. Share findings via messaging (other investigators may see these)
6. Output conclusion: CONFIRMED, DISPROVEN, or INCONCLUSIVE

### Investigator Instruction Template

```
You are Investigator-{N}, part of a parallel investigation team for {BRIEF_ID}.

Problem: {brief problem description}
Your hypothesis: {hypothesis description}
Investigation area: {relevant files and modules}

Instructions:
1. Read the brief via igris_brief_get (MCP) or cache at ~/.igris/projects/{project}/briefs/{BRIEF_ID}-*.md
2. Investigate your hypothesis by reading relevant code
3. Search for evidence that confirms or disproves your theory
4. Check related modules for contributing factors
5. Document your findings with file paths and line numbers

Output your conclusion:
- CONFIRMED: Evidence strongly supports this hypothesis (explain why)
- DISPROVEN: Evidence contradicts this hypothesis (explain why)
- INCONCLUSIVE: Not enough evidence either way (explain what is missing)

Share key findings via messaging so other investigators can cross-reference.
Message the lead with your full investigation report.
```

### Step 5: Synthesize Root Cause Analysis

After all investigators complete:
1. Collect all reports
2. Cross-reference findings
3. Determine most likely root cause
4. Display analysis:
   ```
   INVESTIGATION COMPLETE: {BRIEF_ID}

   Root Cause: {most likely cause}
   Confidence: {High | Medium | Low}

   Hypothesis Results:
   1. {hypothesis-1}: {CONFIRMED | DISPROVEN | INCONCLUSIVE}
      Evidence: {summary}
   2. {hypothesis-2}: {CONFIRMED | DISPROVEN | INCONCLUSIVE}
      Evidence: {summary}
   3. {hypothesis-3}: {CONFIRMED | DISPROVEN | INCONCLUSIVE}
      Evidence: {summary}

   Recommended Fix: {description}
   Affected Files: {list}

   Next: Implement fix with /hunt {BRIEF_ID}
   ```

### Step 6: Update Session State

Update `~/.igris/projects/{project}/session/CURRENT_SESSION.md`:
```markdown
## Team State

**Mode:** TEAM INVESTIGATE
**Team Started:** {timestamp}
**Target Brief:** {BRIEF_ID}
**Active Teammates:**
| Teammate | Hypothesis | Status |
|----------|-----------|--------|
| investigator-1 | {hypothesis-1} | Working |
| investigator-2 | {hypothesis-2} | Working |
| investigator-3 | {hypothesis-3} | Working |
```

---

## Subcommand: `/team refactor <module-names...>`

Parallel module refactoring. Each module is assigned to one FORGER-themed teammate with exclusive file ownership.

### Step 1: Validate Modules

For each module name in arguments:
1. Verify it maps to a valid directory or file path in the project
2. List all files within the module
3. If module not found, report and exclude it

### Step 2: Verify No File Overlap

1. Cross-reference all files across all modules
2. If ANY file appears in more than one module, STOP:
   ```
   File overlap detected between modules:
   - {FILE_PATH} exists in both {MODULE_A} and {MODULE_B}

   Parallel refactoring requires zero file overlap.
   Resolve overlap before proceeding.
   ```
3. This is a hard stop -- no override allowed for refactoring

### Step 3: Spawn Refactor Teammates

One FORGER teammate per module:

| Teammate | Module | File Ownership |
|----------|--------|---------------|
| `forger-{module-a}` | {module-a} | {all files in module-a} |
| `forger-{module-b}` | {module-b} | {all files in module-b} |
| `forger-{module-c}` | {module-c} | {all files in module-c} |

### Step 4: Refactor Teammate Execution

Each teammate independently:
1. Read all files in their assigned module
2. Read coding_guidelines.md for standards
3. Identify refactoring opportunities
4. Implement refactoring within their module ONLY
5. Run linter and tests
6. Commit with conventional format
7. Message the lead with summary of changes

### Refactor Teammate Instruction Template

```
You are Forger-{MODULE}, a refactoring specialist for the {MODULE} module.
You have EXCLUSIVE ownership of all files in: {module path}

File inventory: {list of all files in module}
DO NOT modify any file outside your module boundary.

Instructions:
1. Read all files in your module
2. Read ~/.igris/projects/{project}/context/coding_guidelines.md
3. Identify refactoring opportunities:
   - Naming convention violations
   - Layer boundary violations
   - Code duplication
   - Missing documentation
   - Complexity reduction
4. Implement refactoring changes
5. Run linter and tests
6. Commit: refactor({module}): <summary of changes>
7. Message the lead with changes summary

Cross-boundary changes (imports, shared interfaces) require lead approval.
Message the lead BEFORE modifying any shared contract.
```

### Step 5: Update Session State

Update `~/.igris/projects/{project}/session/CURRENT_SESSION.md`:
```markdown
## Team State

**Mode:** TEAM REFACTOR
**Team Started:** {timestamp}
**Active Teammates:**
| Teammate | Module | Files Owned | Status |
|----------|--------|-------------|--------|
| forger-{module-a} | {module-a} | {count} files | Working |
| forger-{module-b} | {module-b} | {count} files | Working |
| forger-{module-c} | {module-c} | {count} files | Working |
```

---

## Subcommand: `/team status`

Display the current state of the active team.

### Execution

1. Read `~/.igris/projects/{project}/session/CURRENT_SESSION.md`
2. If no Team State section exists, display: "No active team."
3. If Team State exists, display formatted table:

```
TEAM STATUS

Mode: {TEAM HUNT | TEAM REVIEW | TEAM INVESTIGATE | TEAM REFACTOR}
Started: {timestamp}
Duration: {elapsed time}

Teammates:
| Name | Assignment | Status | Last Update |
|------|-----------|--------|-------------|
| {name-1} | {assignment} | {Working | Done | Failed} | {time} |
| {name-2} | {assignment} | {Working | Done | Failed} | {time} |
| {name-3} | {assignment} | {Working | Done | Failed} | {time} |

Progress: {completed}/{total} teammates finished
```

---

## Subcommand: `/team message <teammate> <msg>`

Send a message to a specific teammate.

### Execution

1. Verify the named teammate exists in the active team
2. Send the message content to that teammate
3. Confirm delivery:
   ```
   Message sent to {teammate}: "{msg}"
   ```

---

## Subcommand: `/team broadcast <msg>`

Send a message to all active teammates.

### Execution

1. Verify a team is active
2. Send the message to all teammates
3. Confirm delivery:
   ```
   Broadcast sent to {count} teammates: "{msg}"
   ```

---

## Subcommand: `/team shutdown`

Clean shutdown of the active team. Collects results, terminates teammates, and updates session state.

### Step 1: Broadcast Shutdown Warning

Send to all teammates:
```
Shutdown imminent. Complete current task and report final status.
```

### Step 2: Collect Final Status

For each teammate:
1. Read their final status message
2. Record: Name, Assignment, Result (Done/Incomplete/Failed), Summary

### Step 3: Terminate All Teammates

End all teammate sessions.

### Step 4: Display Results Summary

```
TEAM SHUTDOWN COMPLETE

Mode: {mode}
Duration: {total time}

Results:
| Teammate | Assignment | Result | Summary |
|----------|-----------|--------|---------|
| {name-1} | {assignment} | Done | {commit hash or summary} |
| {name-2} | {assignment} | Done | {commit hash or summary} |
| {name-3} | {assignment} | Incomplete | {what remains} |

Completed: {count}/{total}
Commits: {list of commit hashes}
```

### Step 5: Update Session State

Update `~/.igris/projects/{project}/session/CURRENT_SESSION.md`:
- Remove Team State section
- Add to Last Session Summary: "Team {mode} completed: {results summary}"

### Step 6: Update Brief Statuses

For `hunt` mode:
- Briefs with completed teammates: Update Status to "Done"
- Briefs with incomplete teammates: Keep Status as "In Progress"
- Briefs with failed teammates: Add note to brief with failure reason

---

## Session Tracking

When a team is active, `~/.igris/projects/{project}/session/CURRENT_SESSION.md` includes a Team State section:

```markdown
## Team State

**Mode:** TEAM HUNT | TEAM REVIEW | TEAM INVESTIGATE | TEAM REFACTOR
**Team Started:** YYYY-MM-DD HH:MM
**Active Teammates:**
| Teammate | Assignment | Status |
|----------|-----------|--------|
| {name} | {task} | {Working | Done | Failed} |
```

This section is:
- **Added** when a team spawns (`/team hunt`, `/team review`, etc.)
- **Updated** when teammate status changes
- **Removed** when team shuts down (`/team shutdown`)
- **NOT recoverable** after context reset (team state is ephemeral)

---

## Error Handling

### Flag Not Enabled

```
Agent Teams is not enabled.

To enable, add to ~/.claude/settings.json:
  "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" }

Then restart Claude Code.
```

### Team Already Active

```
A team is already active (Mode: {current mode}).
Run /team shutdown to end the current team before starting a new one.
```

### Brief Not Found

```
Brief {BRIEF_ID} not found in brain DB or cache.
Available briefs: {list of brief IDs with Status: Ready}
```

### File Conflicts Detected

```
File conflict detected between teammates:
- {FILE_PATH} would be modified by both {TEAMMATE_A} and {TEAMMATE_B}

Options:
1. Proceed with messaging coordination (risk of conflicts)
2. Remove one brief from this team run
3. Cancel and restructure
```

### Teammate Crash

If a teammate stops responding or errors out:
1. Log the failure in Team State
2. Mark teammate as "Failed"
3. Continue with remaining teammates
4. Report failure in `/team status` and `/team shutdown`

### Orphaned Team Session

If `~/.igris/projects/{project}/session/CURRENT_SESSION.md` shows a Team State but no teammates are active:
1. Display warning: "Orphaned team state detected. No active teammates found."
2. Suggest: "Run /team shutdown to clean up session state."

---

## Quality Gate Hooks (FR-090)

Agent Teams integrates two Claude Code hooks for automated quality enforcement:

### TaskCompleted Hook

**Trigger:** When a teammate attempts to mark a task as complete.

**Behavior:**
- Inspects the teammate's `last_assistant_message` for test pass/fail evidence
- If tests explicitly failed: exit code 2 prevents completion, sends feedback:
  "Tests must pass before completing. Run tests, fix failures, and try again."
- If tests passed or no test evidence (non-test tasks): allows completion
- Events are logged to the brain API as `team.task_completed`

**Gate Logic:**
- Explicit failure indicators (e.g., "tests failed", "lint errors") trigger denial
- Explicit pass indicators (e.g., "all tests passed", "lint passed") allow through
- Ambiguous or missing evidence allows completion (avoids blocking non-test tasks)

### TeammateIdle Hook

**Trigger:** When a teammate is about to go idle (finished all assigned work).

**Behavior:**
- Queries the brain task queue via `POST /api/tasks/next` for the project
- If a task is found: exit code 2 sends the assignment as feedback, keeps teammate working
- If no tasks available: exit code 0 allows the teammate to go idle
- Assignment includes task ID, title, description, priority, and instructions
- Events are logged to the brain API as `team.teammate_idle`

**Task Assignment Flow:**
1. Check local brain (localhost:3001)
2. If no local brain, check remote brain (~/.igris/config.json)
3. If a task is found, auto-assign it to the teammate
4. Teammate receives the task description as feedback and continues working

### Distinction: Agent Teams vs Brain-Level Quality Gates

| Layer | Scope | Mechanism |
|-------|-------|-----------|
| **Agent Teams hooks** (CLI-native) | Intra-CLI parallelism | `TaskCompleted` exit code 2 prevents completion |
| **Brain task verification** (universal) | Inter-CLI orchestration | `igris_task_complete` validates before status change |

Agent Teams hooks are CLI-specific quality gates that work within a single Claude Code session. Brain-level task completion verification (`igris_task_complete`) is the universal gate that works across all CLIs and agents, including non-Claude Code agents in v6 cross-CLI workflows.

Both layers can coexist: the Agent Teams hook provides fast, local quality enforcement, while the brain provides the source of truth for task status across all agents.

---

## Limitations

- **No session resume:** If the lead session ends, all teammates are lost. Committed work persists independently via git, but team coordination state is not recoverable.
- **One team per session:** Only one team can be active at a time. Shut down the current team before starting a new one.
- **No nested teams:** Teammates cannot spawn their own teams or subteams.
- **File conflicts possible:** Even with ownership boundaries, teammates may encounter merge conflicts. The lead manages resolution.
- **Higher token cost:** Each teammate is a full Claude Code session consuming its own token budget. Use teams judiciously.
- **Experimental feature:** Agent Teams is an experimental Claude Code feature. Behavior may change in future releases.
- **No cross-session persistence:** Team state exists only in the current session. Brief statuses and git commits persist, but team coordination metadata does not.
