# Igris AI Agent Delegation Rules

These rules define when and how to delegate work to specialized subagents in the Igris AI multi-agent system.

---

## Core Principle

**Orchestrator Delegates, Subagents Execute**

The main agent (orchestrator) is NOT a do-everything agent. It is a workflow coordinator that MUST delegate work to specialized subagents.

**Violation = Architecture Failure.** If the orchestrator does work that should be delegated, it breaks the multi-agent system.

---

## Agent Registry

### Tier 1: Core Workflow

| Agent | Alias | Role | Key Capabilities |
|-------|-------|------|------------------|
| architect | ARCHITECT | Strategic planning | Plans + Brief Analysis |
| forger | FORGER | Code implementation | Write clean code |
| sentinel | SENTINEL | Test execution | Tests + Coverage Analysis |
| warden | WARDEN | Code review | Quality inspection |
| artisan | ARTISAN | Visual design | Design systems, accessibility |

### Tier 2: Documentation

| Agent | Alias | Role |
|-------|-------|------|
| chronicler | CHRONICLER | Documentation |
| herald | HERALD | Release prep |
| lawkeeper | LAWKEEPER | Standards generation |

### Tier 3: Maintenance

| Agent | Alias | Role |
|-------|-------|------|
| inquisitor | INQUISITOR | Code analysis |
| mender | MENDER | Error recovery |
| pathfinder | PATHFINDER | Migration analysis |

### Tier 4: Innovation

| Agent | Alias | Role |
|-------|-------|------|
| oracle | ORACLE | Feature ideation |
| seeker | SEEKER | Codebase research |

### Tier 5: Custom

| Agent | Alias | Role |
|-------|-------|------|
| sage | SAGE | Flutter MVVM + Actions |

### Tier 6: Meta (Orchestration)

| Agent | Alias | Role |
|-------|-------|------|
| conductor | CONDUCTOR | Complex workflow orchestration |
| tactician | TACTICIAN | Team assembly |
| archivist | ARCHIVIST | State management |
| dispatcher | DISPATCHER | Queue management |

---

## Mandatory Delegation Rules

| Task Type | Agent | Trigger Phrases |
|-----------|-------|-----------------|
| Implementation planning | **architect** | "plan", "implement X", "fix X" |
| Code writing/editing | **forger** | After plan approved, code changes needed |
| Test execution | **sentinel** | "test", "run tests", after code changes |
| Code review | **warden** | Before commit, "review this" |
| Documentation | **chronicler** | "document", "update README", "write docs" |
| Codebase research | **seeker** | "how does X work?", "find where X is" |
| Standards generation | **lawkeeper** | "STANDARDIZE", "generate guidelines" |
| Migration analysis | **pathfinder** | "MIGRATE analyze", "migration roadmap" |
| Audit operations | **inquisitor** | "AUDIT", "check quality", "find issues" |
| Error diagnosis | **mender** | Test failures, "debug this", "why is X failing" |
| Feature brainstorming | **oracle** | "suggest features", "what could we add" |
| Release preparation | **herald** | "prepare release", "generate changelog" |

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
6. Commit changes (orchestrator handles git)
7. Update brief status to "Done"
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
[INIT] --> [PLANNING] --> [APPROVAL?] --> [BUILDING] --> [TESTING] --> [REVIEWING] --> [COMMITTING] --> [COMPLETE]
              |               |               |              |              |
              v               v               v              v              v
          architect    (L/XL: user)       forger        sentinel       warden
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
| REVIEWING | APPROVE | COMMITTING |
| REVIEWING | REJECT (retry < 2) | BUILDING (fix issues) |
| REVIEWING | REJECT (retry >= 2) | BLOCKED |
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

**Rule Purpose:** Ensure proper delegation to specialized agents for consistent, high-quality work.
