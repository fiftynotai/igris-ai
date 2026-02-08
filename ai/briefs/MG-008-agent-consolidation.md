# MG-008: Agent Consolidation — 18 Agents to 7 Agents + 7 Skills

**Type:** Migration
**Priority:** P2-Medium
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-06
**Completed:** 2026-02-08

---

## Current State

**What's the problem with the current implementation?**

Igris AI has 18 agents defined in `.claude/agents/*.md`. Many are unnecessary overhead:

- **Tier 6 meta agents (4)** duplicate what the orchestrator already does — HUNT manages orchestration, session hooks manage context, the orchestrator distributes tasks
- **Tier 2-4 agents (5)** are procedural workflows that work better as skills — they follow fixed step-by-step templates rather than needing autonomous isolated execution
- **2 agents overlap** with existing agents — artisan duplicates forger for UI, inquisitor duplicates warden for quality analysis

Every agent invocation costs an isolated context spin-up. For simple template-driven procedures (documentation, release prep, standards generation), this overhead is wasted.

**Why does it need to change?**

- Fewer agents = faster execution (no unnecessary context isolation)
- Skills run in main context where project state is already loaded
- Skills can be **preloaded into agents** via `skills` frontmatter — e.g., forger loads `ui-design` skill only for UI briefs, keeping it lean for non-UI work
- Meta agents solve problems Igris doesn't have (load balancing, team assembly)
- Agent memory is concentrated in the 7 agents that matter instead of diluted across 18
- Simpler system = easier to maintain and reason about

---

## Target State

**What should it look like after migration?**

### 7 Agents (autonomous work requiring isolation)

```
.claude/agents/
├── architect.md     # Planning (Tier 1)
├── forger.md        # Coding (Tier 1)
├── sentinel.md      # Testing (Tier 1)
├── warden.md        # Review + Auditing (Tier 1, absorbs inquisitor review)
├── mender.md        # Self-heal / debugging (Tier 3)
├── seeker.md        # Fast exploration on haiku (Tier 4)
└── sage.md          # Flutter domain expert (Tier 5)
```

### 7 New Skills (procedure-driven, run in main context)

```
.claude/skills/
├── ui-design/SKILL.md        # UI design guidelines (from artisan, preloadable by forger)
├── document/SKILL.md         # Documentation workflow (from chronicler)
├── release/SKILL.md          # Release preparation (from herald)
├── standardize/SKILL.md      # Standards generation (from lawkeeper)
├── ideate/SKILL.md           # Feature brainstorming (from oracle)
├── migrate-analyze/SKILL.md  # Migration analysis (from pathfinder)
└── audit/SKILL.md            # Codebase audit (from inquisitor audit ops)
```

**Forger + UI skill integration:** When a brief involves UI work, forger's `skills` frontmatter can preload `ui-design` to inject accessibility, component states, and responsive design constraints into its context. Non-UI briefs skip it entirely.

### Content Preservation Map

| Deleted Agent | Valuable Content | Preserved In |
|---------------|-----------------|-------------|
| **conductor** | Orchestration patterns (sequential, parallel, iterative) | Already in HUNT workflow |
| **tactician** | Agent capability matrix table | `/digivolve` status display |
| **archivist** | Context types table, recovery scenarios | `session_protocol.md` |
| **dispatcher** | Nothing unique | N/A (deleted) |
| **chronicler** | 4-step doc workflow (scope, read, write, validate) | `/document` skill template |
| **herald** | Semver decision tree (breaking=MAJOR, feature=MINOR, fix=PATCH) | `/release` skill template |
| **lawkeeper** | 4 modes (base repo, project analysis, merge, best practices) | `/standardize` skill template |
| **oracle** | Value/Effort matrix (DO NOW, QUICK WIN, PLAN, SKIP) | `/ideate` skill template |
| **pathfinder** | Gap analysis workflow + migration roadmap output format | `/migrate-analyze` skill template |
| **artisan** | Accessibility (WCAG 2.1), component states, responsive design, dark mode | `/ui-design` skill (preloadable by forger via `skills` field) |
| **inquisitor** | 7 audit operation types + output format; code review overlap | Audit ops → `/audit` skill; Review → warden "Audit Mode" |

---

## Migration Steps

1. [x] Create `/ui-design` skill from artisan's capabilities (WCAG 2.1, component states, responsive, dark mode)
2. [x] Merge inquisitor review capabilities into warden.md (add Audit Mode section)
3. [x] Create `/audit` skill from inquisitor's 7 audit operations
4. [x] Create `/document` skill from chronicler's workflow
5. [x] Create `/release` skill from herald's workflow
6. [x] Create `/standardize` skill from lawkeeper's 4 modes
7. [x] Create `/ideate` skill from oracle's value/effort matrix
8. [x] Create `/migrate-analyze` skill from pathfinder's gap analysis
9. [x] Move tactician's capability matrix into `/digivolve` status display
10. [x] Move archivist's context types table into `session_protocol.md`
11. [x] Delete 11 agent files (conductor, tactician, archivist, dispatcher, chronicler, herald, lawkeeper, oracle, pathfinder, artisan, inquisitor)
12. [x] Update manifest.yaml (remove deleted agents)
13. [x] Update persona.json agent_aliases (remove deleted aliases)
14. [x] Update agent registry in igris_os.md, CLAUDE.md, 04-igris-agents.md
15. [x] Update HUNT workflow references (remove chronicler from post-commit)
16. [x] Update digivolve skill (new agent list, tier structure)
17. [ ] Update brief templates (Active Agent field)
18. [x] Update README.md
19. [ ] Test HUNT workflow end-to-end with reduced agent set
20. [ ] Test all 7 new skills

---

## Tasks

### Completed
- [x] Task 1: Create `/ui-design` skill from artisan + merge inquisitor into warden
- [x] Task 2: Create 7 new skills from retired agents
- [x] Task 3: Preserve valuable content (capability matrix, context types)
- [x] Task 4: Delete 11 agent files
- [x] Task 5: Update all references across 23+ files

### Pending
- [ ] Task 6: Test HUNT workflow and new skills

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Ready for implementation.

### Next Steps
Begin with Task 1: Merge agent capabilities.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-08 | ARCHITECT | Planning MG-008 consolidation | Complete — 6-phase plan, 41 file ops |

### Blockers
None

---

## Impact Assessment

### Affected Files
- [ ] `.claude/agents/*.md` - Delete 11, modify 1 (warden)
- [ ] `.claude/skills/*/SKILL.md` - 7 new skills created
- [ ] `.claude/skills/digivolve/SKILL.md` - Updated agent list
- [ ] `.claude/skills/hunt/SKILL.md` - Remove chronicler reference
- [ ] `.claude/skills/digivolve/agent-roster.md` - Updated tier structure
- [ ] `ai/prompts/igris_os.md` - Updated agent registry
- [ ] `ai/prompts/session_protocol.md` - Add context types from archivist
- [ ] `.claude/rules/04-igris-agents.md` - Updated delegation rules
- [ ] `CLAUDE.md` - Updated agent registry
- [ ] `ai/persona.json` - Remove deleted aliases
- [ ] `README.md` - Updated architecture docs
- [ ] Brief templates (9 files) - Updated Active Agent field
- [ ] `scripts/templates/CLAUDE.md.template` - Updated agent references

### Affected Modules
- [ ] `Agent system` - Reduced from 18 to 7 agents
- [ ] `Skill system` - Expanded from 7 to 14 skills
- [ ] `HUNT workflow` - Agent pipeline unchanged (architect → forger → sentinel → warden)
- [ ] `Digivolve` - Smaller agent registry to manage

### Breaking Changes
- [x] **Yes** - Agents removed: conductor, tactician, archivist, dispatcher, chronicler, herald, lawkeeper, oracle, pathfinder, artisan, inquisitor. Any direct `subagent_type` references to these will break.
- [ ] HUNT core pipeline unaffected (architect → forger → sentinel → warden → mender)

### Dependencies
- [ ] Depends on: MG-007 (native agent definitions) - Done
- [ ] Blocks: None

---

## Testing Strategy

### Manual Testing

#### Test Case 1: HUNT Workflow (Core Pipeline)
**Steps:**
1. Run `/hunt` on a test brief
2. Verify architect → forger → sentinel → warden pipeline works
3. Verify mender self-heal loop triggers on test failure

**Expected:** Full HUNT workflow completes with 7-agent set
**Status:** [ ] Pass / [ ] Fail

#### Test Case 2: New Skills
**Steps:**
1. Run `/document` — verify documentation workflow
2. Run `/release` — verify changelog generation
3. Run `/standardize` — verify 4-mode selection
4. Run `/ideate` — verify value/effort matrix
5. Run `/migrate-analyze` — verify gap analysis output
6. Run `/audit` — verify 7 audit operation types

**Expected:** Each skill produces structured output matching original agent capability
**Status:** [ ] Pass / [ ] Fail

#### Test Case 3: Forger + UI Skill Preloading
**Steps:**
1. Give forger a UI-focused brief with `skills: [ui-design]` in invocation
2. Verify forger receives accessibility/component state constraints
3. Give forger a non-UI brief without the skill — verify no UI bloat

**Expected:** UI skill injects design constraints only when preloaded; forger stays lean otherwise
**Status:** [ ] Pass / [ ] Fail

#### Test Case 4: Warden Audit Mode
**Steps:**
1. Ask warden to audit code quality
2. Verify audit output format matches inquisitor's structured report

**Expected:** Warden produces audit reports with severity table + file:line findings
**Status:** [ ] Pass / [ ] Fail

#### Test Case 5: Digivolve Status
**Steps:**
1. Run `/digivolve status`
2. Verify 7 agents shown (not 18)
3. Verify capability matrix displayed

**Expected:** Clean 7-agent roster with tier structure
**Status:** [ ] Pass / [ ] Fail

---

## Rollback Plan

1. Restore 11 deleted agent files from git history (`git checkout HEAD~1 -- .claude/agents/`)
2. Revert merged content in forger.md and warden.md
3. Remove 6 new skill directories
4. Revert reference file updates

**Rollback safe until:** Merged to main

---

## Acceptance Criteria

1. [ ] Only 7 agents remain in `.claude/agents/`
2. [ ] 6 new skills created and functional
3. [ ] Valuable content preserved (capability matrix, context types, workflows)
4. [ ] `/ui-design` skill exists and is preloadable by forger
5. [ ] Warden handles audits (inquisitor capabilities merged)
6. [ ] HUNT workflow passes end-to-end
7. [ ] All reference files updated (zero stale agent names)
8. [ ] Digivolve shows correct 7-agent roster
9. [ ] README.md updated
10. [ ] No regression in workflow quality

---

## References

**Related Briefs:**
- Depends on: MG-007 (Native Agent Definitions) - Done
- Related: MG-005 (Skills Migration) - established skill format
- Related: MG-004 (Memory Architecture) - modular rules

**Architecture Principle:**
Agents are for autonomous work requiring isolated context, memory, and tool restrictions. Skills are for guided procedures that run in the main conversation context.

---

## Notes

The key insight driving this migration: **agents are expensive, skills are cheap**. An agent spins up a new context, loads its system prompt, and runs in isolation. A skill is just a template that guides the main agent. For procedural work (documentation, release prep, standards), the overhead of agent isolation provides no benefit.

The 7 remaining agents are the ones that genuinely need:
- **Isolated context** (forger writing code shouldn't pollute review context)
- **Different tool access** (seeker is read-only, forger has full write)
- **Different models** (seeker on haiku for speed)
- **Persistent memory** (architect/forger building codebase knowledge)

---

## Future Enhancement: Workflow Engine & Parallel Execution

### Context

HUNT is a **sequential pipeline** (architect → forger → sentinel → warden) — one workflow pattern. But it shouldn't be the only one. Claude Code natively supports parallel agent execution (multiple `Task` calls in a single message, `run_in_background` for async agents). The concepts from the deleted Tier 6 agents (conductor, dispatcher) aren't invalid — they're premature for a single-workflow system but become valuable when Igris supports multiple workflow types.

### Preserved Concepts (from conductor + dispatcher)

**Orchestration patterns** (conductor):
- Sequential pipeline: `A → B → C → Result` (current HUNT)
- Parallel fan-out: `A → [B, C, D] → Aggregator`
- Iterative loop: `A → B → [Check] → (repeat if needed) → Done`

**Scheduling strategies** (dispatcher):
- Priority ordering: P0 briefs always first
- Skill-based routing: Match task type to specialist agent
- Parallel planning: Identify independent tasks that can run concurrently
- Backpressure: Don't overload with too many parallel agents

### Potential Workflow Types

| Workflow | Pattern | Description |
|----------|---------|-------------|
| **HUNT** | Sequential pipeline | Current: architect → forger → sentinel → warden |
| **RAID** | Parallel fan-out | Run multiple HUNTs on independent briefs simultaneously |
| **SWEEP** | Fan-out + aggregate | Audit/analyze multiple modules in parallel, aggregate findings |
| **FORGE** | Build-only | Skip planning, just forger → sentinel → warden (for small fixes) |
| **SCOUT** | Read-only parallel | Multiple seekers exploring different parts of the codebase |
| **BATCH** | Queue processing | Process a prioritized queue of briefs sequentially or in parallel |

### Design Questions (to answer before implementing)

1. **Concurrency limits** — How many parallel agents before context quality degrades? Claude Code can run them but each consumes API tokens.
2. **State coordination** — How do parallel agents share results? File-based (write to shared location) vs aggregator agent?
3. **Error handling** — If one branch of a fan-out fails, do we cancel siblings or let them finish?
4. **Resource awareness** — Should the orchestrator consider token budget / rate limits when deciding parallelism?
5. **Workflow definition format** — Should workflows be defined as skills (`.claude/skills/raid/SKILL.md`) or as a separate workflow config format?
6. **Composability** — Can workflows nest? (e.g., RAID launches multiple HUNTs, each HUNT is a full pipeline)

### Recommendation

Create a dedicated brief (e.g., **FR-XXX: Workflow Engine**) to design the workflow system properly. This consolidation brief (MG-008) removes the premature agents. The workflow engine brief will reintroduce orchestration capabilities with a clear design and real use cases.

---

**Created:** 2026-02-06
**Last Updated:** 2026-02-06
**Brief Owner:** Crimson (Fifty.ai)
