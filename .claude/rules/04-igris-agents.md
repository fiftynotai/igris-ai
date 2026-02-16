# Igris AI Agent Delegation Rules

These rules define when and how to delegate work to specialized subagents in the Igris AI multi-agent system.

---

## Core Principle

**Orchestrator Delegates, Subagents Execute**

The main agent (orchestrator) is NOT a do-everything agent. It is a workflow coordinator that MUST delegate work to specialized subagents.

**Violation = Architecture Failure.** If the orchestrator does work that should be delegated, it breaks the multi-agent system.

---

## Agent Registry (v3.4 - 7 Agents)

### Tier 1: Core Workflow

| Agent | Alias | Role | Key Capabilities |
|-------|-------|------|------------------|
| architect | ARCHITECT | Strategic planning | Plans + Brief Analysis |
| forger | FORGER | Code implementation | Write clean code |
| sentinel | SENTINEL | Test execution | Tests + Coverage Analysis |
| warden | WARDEN | Code review + auditing | Quality inspection, audit operations |

### Tier 3: Maintenance

| Agent | Alias | Role | Key Capabilities |
|-------|-------|------|------------------|
| mender | MENDER | Error recovery | Diagnose & fix |

### Tier 4: Research

| Agent | Alias | Role | Key Capabilities |
|-------|-------|------|------------------|
| seeker | SEEKER | Codebase research | Investigate code (haiku model) |

### Tier 5: Custom

| Agent | Alias | Role | Key Capabilities |
|-------|-------|------|------------------|
| sage | SAGE | Flutter architecture | Kalvad MVVM + Actions patterns |

---

## Mandatory Delegation Rules

| Task Type | Agent | Trigger Phrases |
|-----------|-------|-----------------|
| Implementation planning | **architect** | "plan", "implement X", "fix X" |
| Code writing/editing | **forger** | After plan approved, code changes needed |
| Test execution | **sentinel** | "test", "run tests", after code changes |
| Code review | **warden** | Before commit, "review this" |
| Code auditing | **warden** (audit mode) | "AUDIT", "check quality", "find issues" |
| Codebase research | **seeker** | "how does X work?", "find where X is" |
| Error diagnosis | **mender** | Test failures, "debug this", "why is X failing" |

---

## Skill-Based Operations (No Delegation Needed)

These tasks are handled by skills instead of subagents. The orchestrator invokes the skill directly.

| Task Type | Skill | Trigger Phrases |
|-----------|-------|-----------------|
| Documentation | `/document` | "document", "update README", "write docs" |
| Standards generation | `/standardize` | "STANDARDIZE", "generate guidelines" |
| Migration analysis | `/migrate-analyze` | "MIGRATE analyze", "migration roadmap" |
| Audit operations | `/audit` | "AUDIT", "run audit", "code quality audit" |
| Feature brainstorming | `/ideate` | "suggest features", "what could we add" |
| Release preparation | `/release` | "prepare release", "generate changelog" |
| UI design guidelines | `/ui-design` | "design system", "accessibility review" |

**Note:** The `/ui-design` skill can be preloaded by the forger agent when implementing UI-related code.

---

## Team-Based Operations (Parallel Execution)

Agent Teams provides a parallel execution layer using Claude Code's experimental Agent Teams feature. Teams spawn independent Claude Code instances (teammates) instead of Task-tool subagents.

### When to Use Teams vs Subagents

| Scenario | Use Subagent | Use Team |
|----------|-------------|----------|
| Single brief, sequential workflow | `/hunt BR-XXX` | -- |
| 2+ briefs in parallel | -- | `/team hunt BR-XXX BR-YYY` |
| Single-angle code review | warden | -- |
| Multi-angle code review | -- | `/team review` |
| Simple codebase search | seeker | -- |
| Competitive investigation | -- | `/team investigate BR-XXX` |
| Single module refactor | forger | -- |
| Multi-module parallel refactor | -- | `/team refactor mod-a mod-b` |

### Team Delegation Rules

| Task Type | Skill | Trigger Phrases |
|-----------|-------|-----------------|
| Parallel brief implementation | `/team hunt` | "implement these in parallel", "team hunt" |
| Multi-angle review | `/team review` | "review from multiple angles", "team review" |
| Competitive investigation | `/team investigate` | "investigate in parallel", "team investigate" |
| Parallel refactoring | `/team refactor` | "refactor these modules in parallel", "team refactor" |
| Team management | `/team status/shutdown` | "team status", "shutdown team" |

### Teams Do NOT Replace Subagents

- Subagents remain the **primary** execution model for all single-brief workflows
- Teams are used **only** when true parallelism provides clear value
- Single-brief workflows **always** use the standard `/hunt` pipeline
- Teams have **higher token cost** -- use judiciously
- The `/team` skill requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 1`

---

## Orchestrator-Only Tasks (Exceptions)

The orchestrator MAY handle these directly:

**Brief Management:**
- Reading/listing briefs
- Updating brief status/priority
- Creating briefs from templates
- Archiving completed briefs

**Session Management:**
- Reading/updating CURRENT_SESSION.md
- Tracking workflow state
- Recording subagent results

**Git Operations:**
- git status, git add, git commit
- Branch operations

**Context Loading:**
- Reading coding_guidelines.md, architecture docs
- Reading session files

**User Communication:**
- Displaying status reports
- Asking clarifying questions
- Showing recommendations

---

## Correct vs Incorrect Patterns

### CORRECT: Implementing a Brief

```
User: "implement BR-008"

Orchestrator:
1. Read brief -> Update status to "In Progress"
2. DELEGATE to architect -> Receive plan
3. DELEGATE to forger -> Receive implementation
4. DELEGATE to sentinel -> Receive PASS/FAIL
5. DELEGATE to warden -> Receive APPROVE/REJECT
6. IF (docs needed): DELEGATE to documenter -> Update docs
7. Commit changes (orchestrator handles git)
8. Update brief status to "Done"
```

### INCORRECT: Orchestrator Doing Work

```
User: "implement BR-008"

Orchestrator:
1. Read brief
2. [X] Write code directly (MUST delegate to forger!)
3. [X] Run tests directly (MUST delegate to sentinel!)
4. Commit changes
```

---

## Agent Management Commands

| Command | Action | Description |
|---------|--------|-------------|
| `DIGIVOLVE status` | List agents | Show all agents with stats |
| `DIGIVOLVE add` | Create agent | Interactive agent creation |
| `DIGIVOLVE upgrade {name}` | Upgrade agent | Enhance agent capabilities |
| `DIGIVOLVE disable {name}` | Disable agent | Temporarily disable |
| `DIGIVOLVE enable {name}` | Enable agent | Re-enable disabled agent |
| `DIGIVOLVE remove {name}` | Remove agent | Delete custom agent (Tier 5 only) |
| `DIGIVOLVE reset {name}` | Reset agent | Reset to default |

---

## Workflow State Machine

When implementing a brief:

```
[INIT] --> [PLANNING] --> [APPROVAL?] --> [BUILDING] --> [TESTING] --> [REVIEWING] --> [DOCUMENTING?] --> [COMMITTING] --> [COMPLETE]
              |               |               |              |              |              |
              v               v               v              v              v              v
          architect    (L/XL: user)       forger        sentinel       warden       documenter
```

**State Transitions:**

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

---

## Subagent Invocation Pattern

**Before invoking any subagent:**
1. Update brief: Phase = X, Active Agent = Y
2. Add Agent Log entry: "Starting [agent]..."

**After subagent returns:**
1. Update brief: Active Agent = none
2. Update Agent Log entry with result
3. Update Phase based on result (advance or retry)
4. Update Next Steps

---

**Rule Purpose:** Ensure proper delegation to 7 specialized agents and 16 skills for consistent, high-quality work.
