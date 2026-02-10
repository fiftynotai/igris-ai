# FR-021: Agent Teams Integration — Parallel Execution Layer

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-10

---

## Feature Description

**What is the proposed feature?**

Integrate Claude Code's experimental Agent Teams feature into Igris AI as a parallel execution layer on top of the existing subagent system. Add a `/team` skill that spawns multiple independent Claude Code instances (teammates) to work on briefs, reviews, or investigations in parallel — coordinated by the Igris orchestrator as Team Lead.

**Why is this valuable?**

Our current HUNT workflow is sequential: architect -> forger -> sentinel -> warden. Agent Teams enables true parallelism — multiple briefs implemented simultaneously, parallel code reviews from different angles, and competitive investigation workflows where teammates debate hypotheses. This dramatically reduces wall-clock time for large workloads.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
Briefs are implemented one at a time. If 3 briefs are Ready, they execute sequentially. A bulk refactor across 5 modules runs one module at a time. Code review is single-perspective (WARDEN alone).

**With this feature:**
Multiple briefs execute in parallel. Bulk refactors split across teammates by module boundary. Code review gets 3 simultaneous perspectives (security, performance, standards). Investigation spawns competing hypotheses that debate each other.

---

## Use Cases

### Use Case 1: Parallel Brief Implementation
**Actor:** Developer (Partner)
**Goal:** Implement multiple ready briefs simultaneously
**Steps:**
1. User runs `/team hunt FR-022 FR-023 FR-024`
2. Igris spawns 3 teammates, each assigned one brief
3. Each teammate runs the full HUNT workflow independently (plan -> build -> test -> review -> commit)
4. Lead monitors progress, resolves file conflicts if any
5. Teammates report back as they complete

**Expected Outcome:** 3 briefs implemented in parallel, each with full quality gates

### Use Case 2: Multi-Angle Code Review
**Actor:** Developer (Partner)
**Goal:** Get comprehensive review from multiple perspectives
**Steps:**
1. User runs `/team review` (or `/team review PR-42`)
2. Igris spawns 3 WARDEN teammates: security reviewer, performance reviewer, standards reviewer
3. Each reviews independently and reports findings
4. Lead synthesizes findings into unified review

**Expected Outcome:** Comprehensive review covering security, performance, and standards in one pass

### Use Case 3: Competitive Bug Investigation
**Actor:** Developer (Partner)
**Goal:** Find root cause of a complex bug through parallel hypothesis testing
**Steps:**
1. User runs `/team investigate BR-XXX`
2. Igris spawns 3-5 SEEKER teammates, each with a different hypothesis
3. Teammates investigate, message each other to share findings and disprove theories
4. Converge on root cause through debate

**Expected Outcome:** Root cause identified faster through parallel investigation and peer challenge

### Use Case 4: Bulk Module Refactoring
**Actor:** Developer (Partner)
**Goal:** Refactor multiple modules in parallel without conflicts
**Steps:**
1. User runs `/team refactor module-a module-b module-c module-d`
2. Igris spawns 4 FORGER teammates, each owns one module
3. Each teammate refactors their module following coding_guidelines.md
4. Lead coordinates integration and resolves cross-module dependencies

**Expected Outcome:** 4 modules refactored simultaneously with no file conflicts

---

## Technical Approach

### High-Level Design

Agent Teams sits as a **layer above** the existing subagent system:

```
Layer 3: Agent Teams (parallel execution)
  └── Multiple independent Claude Code sessions
  └── Shared task list, inter-agent messaging
  └── Coordinated by Igris Lead

Layer 2: Subagents (sequential workflow)
  └── architect, forger, sentinel, warden, mender, seeker, sage
  └── Run within a single session
  └── Stateless, report back to orchestrator

Layer 1: Igris OS (orchestration)
  └── Brief management, session tracking
  └── Quality gates, commit standards
  └── Persona system
```

Each teammate spawned by Agent Teams is a full Igris-aware Claude Code instance that can use subagents internally.

### Components Affected
- `.claude/skills/team/SKILL.md` — New `/team` skill definition
- `ai/prompts/igris_os.md` — Add Agent Teams section to OS documentation
- `.claude/rules/04-igris-agents.md` — Add Agent Teams rules alongside subagent rules
- `ai/session/CURRENT_SESSION.md` — Track active team sessions
- `~/.claude/settings.json` — Enable `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 1`

### API/Interface Design

```
/team hunt <brief-ids...>        — Parallel brief implementation
/team review [PR-number]         — Multi-angle code review
/team investigate <brief-id>     — Competitive hypothesis investigation
/team refactor <module-names...> — Parallel module refactoring
/team status                     — Show active team and teammate progress
/team message <teammate> <msg>   — Direct message a teammate
/team broadcast <msg>            — Message all teammates
/team shutdown                   — Clean up team and collect results
```

**Example usage:**
```
/team hunt FR-022 FR-023
  > Spawning 2 teammates...
  > Teammate 1: FORGER-A assigned FR-022
  > Teammate 2: FORGER-B assigned FR-023
  > Team active. Use `/team status` to monitor.

/team review
  > Spawning 3 reviewers...
  > Teammate 1: WARDEN-SECURITY reviewing security implications
  > Teammate 2: WARDEN-PERF reviewing performance impact
  > Teammate 3: WARDEN-STANDARDS reviewing standards compliance
  > Reviews in progress. Results will be synthesized when complete.
```

---

## Context & Inputs

### Dependencies
- [x] Existing system: Claude Code Agent Teams (experimental, requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 1`)
- [x] Existing system: Igris AI subagent architecture (7 agents in `.claude/agents/`)
- [x] Existing system: Brief management system (`ai/briefs/`)
- [ ] Environment: tmux or iTerm2 required for split-pane display mode

### Files to Create
- `.claude/skills/team/SKILL.md` — `/team` skill definition
- `ai/templates/team_config.md` — Team session tracking template (optional)

### Files to Modify
- `ai/prompts/igris_os.md` — Add Agent Teams protocol section
- `.claude/rules/04-igris-agents.md` — Add team delegation rules
- `~/.claude/settings.json` — Enable experimental flag

### Configuration Changes
- [x] New settings: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 1` in settings.json
- [x] New settings: `teammateMode: "in-process"` or `"tmux"` in settings.json

---

## Alternatives Considered

### Alternative 1: Replace Subagents with Teams Entirely
**Pros:**
- Simpler mental model (one system instead of two)
- True parallelism for everything

**Cons:**
- Massive token cost (every agent call becomes a full session)
- Overkill for simple sequential workflows (plan -> build -> test -> review)
- Agent Teams is experimental with known limitations
- Loses the tight orchestrator control of subagent workflow

**Why not chosen:** Subagents are cheaper and better for structured sequential workflows. Teams complement, not replace.

### Alternative 2: Wait Until Agent Teams Is Stable
**Pros:**
- No risk from experimental bugs
- Feature may evolve significantly

**Cons:**
- Miss out on parallel execution benefits now
- May need to redesign if we wait too long

**Why not chosen:** We can integrate incrementally — start with `/team hunt` and `/team review`, expand as the feature stabilizes.

---

## Constraints

### Technical Constraints
- Agent Teams is experimental — expect rough edges (orphaned sessions, shutdown issues)
- No session resume with in-process teammates (`/resume` doesn't restore them)
- One team per session (must clean up before starting another)
- No nested teams (teammates can't spawn their own teams)
- Teammates must own different files to avoid conflicts
- Lead is fixed for the team's lifetime
- Higher token cost than subagents (each teammate is a full session)

### UX Constraints
- `/team` commands must feel natural alongside existing Igris commands
- Team status must integrate with `/scan` output
- Must not disrupt existing HUNT workflow for single briefs

### Timeline
- **Deadline:** N/A
- **Milestones:** Phase 1 (skill + hunt), Phase 2 (review + investigate), Phase 3 (refactor + advanced)

### Out of Scope
- Custom teammate personas (all teammates use Igris identity)
- Teammate-to-teammate delegation (no nested teams)
- Automatic team spawning (always user-initiated via `/team`)
- Mobile/remote team coordination
- Cost tracking per teammate (future enhancement)

---

## Tasks

### Pending
- [ ] Task 1: Enable Agent Teams experimental flag in settings.json
- [ ] Task 2: Create `/team` skill definition (SKILL.md) with command parsing
- [ ] Task 3: Implement `/team hunt` — spawn teammates per brief, assign work, monitor
- [ ] Task 4: Implement `/team review` — spawn multi-angle WARDEN teammates
- [ ] Task 5: Implement `/team investigate` — spawn competing SEEKER teammates
- [ ] Task 6: Implement `/team refactor` — spawn FORGER teammates per module
- [ ] Task 7: Implement `/team status` — show active team progress
- [ ] Task 8: Implement `/team shutdown` — clean up team, collect results
- [ ] Task 9: Add Agent Teams section to igris_os.md
- [ ] Task 10: Update 04-igris-agents.md with team delegation rules
- [ ] Task 11: Integrate team status into `/scan` output
- [ ] Task 12: Test parallel HUNT with 2-3 briefs simultaneously
- [ ] Task 13: Test multi-angle review workflow
- [ ] Task 14: Document limitations and best practices

### In Progress

### Completed

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
COMPLETE. All files committed.

### Next Steps
1. HUNT FR-021 to begin implementation
2. ARCHITECT plans skill structure and OS integration
3. FORGER implements `/team` skill and OS updates

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-10 | ARCHITECT | Planning phase complete | 4-phase plan: SKILL.md creation, OS integration, rules update, CLAUDE.md update. 4 files, ~562 lines. |
| 2026-02-10 | — | Plan approved by Partner | Proceeding to BUILDING |
| 2026-02-10 | FORGER | Build complete | 1 created, 3 modified. SKILL.md 695 lines, OS +90 lines, rules +65 lines, CLAUDE.md +2 lines |
| 2026-02-10 | SENTINEL | Test phase complete | PASS — 7/7 checks, all cross-references consistent, no regressions |
| 2026-02-10 | WARDEN | Code review complete | APPROVE — 0 blockers, 5 minor suggestions (skill count, tmux clarity, brief tasks, teammateMode, conflict fallback) |

### Blockers
- Agent Teams is experimental — may have breaking changes
- Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 1` flag enabled

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] `/team hunt <brief-ids>` spawns teammates that independently HUNT briefs in parallel
2. [ ] `/team review` spawns 3 WARDEN teammates with different review angles
3. [ ] `/team investigate <brief-id>` spawns competing SEEKER teammates
4. [ ] `/team refactor <modules>` spawns FORGER teammates per module
5. [ ] `/team status` shows active team members and their progress
6. [ ] `/team shutdown` cleanly terminates all teammates and collects results
7. [ ] Team progress visible in `/scan` output
8. [ ] igris_os.md documents Agent Teams protocol
9. [ ] 04-igris-agents.md includes team delegation rules
10. [ ] No regressions to existing subagent HUNT workflow
11. [ ] Successfully tested parallel HUNT with 2+ briefs

---

## Test Plan

### Functional Tests

**Test Case 1: Parallel HUNT**
**Steps:**
1. Register 2 small test briefs (S-effort)
2. Run `/team hunt <brief-1> <brief-2>`
3. Observe both teammates spawn and begin work
4. Wait for completion

**Expected Result:** Both briefs implemented in parallel, each with proper commits
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Multi-Angle Review**
**Steps:**
1. Make some code changes
2. Run `/team review`
3. Observe 3 reviewer teammates spawn
4. Wait for findings

**Expected Result:** 3 independent review reports synthesized by lead
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Team Shutdown**
**Steps:**
1. Start a team with `/team hunt`
2. Run `/team shutdown` before completion
3. Verify all teammates terminated cleanly

**Expected Result:** No orphaned sessions, clean shutdown
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] Single-brief `/hunt` workflow unaffected
- [ ] Subagent delegation (architect, forger, etc.) still works
- [ ] `/scan` output not broken
- [ ] Session tracking (CURRENT_SESSION.md) not corrupted

---

## Delivery

### Documentation
- [ ] igris_os.md: Add Agent Teams protocol section
- [ ] 04-igris-agents.md: Add team rules
- [ ] README: Mention `/team` capability

### Code Changes
- [ ] Created: `.claude/skills/team/SKILL.md`
- [ ] Modified: `ai/prompts/igris_os.md`
- [ ] Modified: `.claude/rules/04-igris-agents.md`

---

## Success Metrics

**How will we know this feature is valuable?**

- Parallel HUNT reduces wall-clock time by 50%+ vs sequential for 2+ briefs
- Multi-angle review catches issues single WARDEN review missed
- Competitive investigation converges on root cause faster than single SEEKER

---

## Notes

**Inspiration:**
- Claude Code Agent Teams (experimental, Feb 2026)
- Existing Igris subagent architecture
- Military unit coordination (squad-level parallel ops)

**Key Insight:** Agent Teams = parallel execution layer. Subagents = sequential workflow within a session. They complement each other.

**Future Enhancements:**
- Auto-team: Igris detects when parallel execution would help and suggests `/team`
- Cost tracking: Token usage per teammate for budget awareness
- Team templates: Pre-configured team compositions for common workflows
- Cross-project teams: Teammates working on different repos

---

**Created:** 2026-02-10
**Last Updated:** 2026-02-10
**Brief Owner:** Crimson (Igris AI)
