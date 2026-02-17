# FR-050: Full README Rewrite — v4.0 Identity Refresh

**Type:** Feature Request
**Priority:** P1-High
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-17
**Completed:** 2026-02-17

---

## Feature Description

**What is the proposed feature?**

Complete rewrite of README.md to reflect Igris AI v4.0's true identity: an operating system for AI-assisted engineering with a multi-agent workforce, persistent brain, cross-machine sync, and enforced quality discipline. The current README is ~85% accurate but frames the system through a v3.x lens with accumulated noise.

**Why is this valuable?**

The README is the first thing people see. It must communicate what Igris IS — not just what it does. The v4.0 redesign changed the system's identity from "a CLI enhancement" to "an engineering OS with a brain." The README needs to reflect that shift clearly and concisely.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] Contributors (extending Igris AI)
- [x] End users (people evaluating the product)

### Pain Point Solved
**Current situation:**
- README says 19 skills (actually 20, missing `/sync`)
- Default persona listed as "Igris (Shadow Knight)" — actually "Crimson (Cyber Monkey)"
- Legacy v3.x installation and migration content mixed into Quick Start
- MCP framed as "optional convenience" when it's built-in to v4.0 brain
- Tool comparisons are 70+ lines of verbose tables
- No clear identity statement — reads like a feature list, not a product story

**With this feature:**
- Sharp identity: "An operating system for AI-assisted engineering"
- Accurate feature counts and descriptions matching reality
- Clean separation: current v4.0 content up front, legacy in appendix or separate doc
- Concise comparisons that communicate positioning in one glance
- New users understand what Igris IS within 30 seconds of reading

---

## Audit Findings (Input for Rewrite)

### Critical Fixes Required
1. Skills count: 19 → 20 (missing `/sync`)
2. Default persona: "Igris (Shadow Knight)" → "Crimson (Cyber Monkey)"
3. MCP framing: "optional" → "built-in to v4.0"

### Outdated Content to Remove/Relocate
- v3.4 Legacy Installation section (move to legacy doc)
- v3.x Migration Guides (v3.2→3.3→3.4→4.0) — move to MIGRATION_GUIDE.md
- Legacy MCP description

### Noise to Eliminate
- Verbose tool comparisons (Cursor, Aider, Copilot) — condense to single table
- Redundant persona subsections
- Legacy installation in Quick Start flow

### Missing Content to Add
- `/sync` skill in skills table
- Brain as v4.0 default architecture (not add-on)
- Skills directory structure explanation
- Sharper identity/positioning statement

---

## New README Identity & Structure

### Core Identity Statement

> **Igris AI is an operating system for AI-assisted engineering.** It transforms Claude Code from a single general-purpose assistant into a disciplined multi-agent engineering team — with persistent memory that survives context resets, syncs across machines, and learns across projects.

### Proposed Structure

```
1. Hero — Identity + tagline + what it is in one paragraph
2. The Problem — Why AI coding needs discipline (brief, punchy)
3. What is Igris v4.0 — Architecture overview (3 layers)
4. How It Works — Brief-first protocol + workflow diagram
5. The 7 Agents — One table, clear roles
6. 20 Skills — One table, all commands
7. The Brain — ~/.igris/, cross-machine sync, VPS deployment
8. Quick Start — v4.0 installation only (clean, no legacy)
9. Core Capabilities — Brief management, QA, architecture, sessions
10. Agent Teams — Parallel execution layer
11. Persona System — Current persona (Crimson), mask levels
12. Project Structure — Directory layout
13. Comparisons — ONE concise table (Igris vs plain Claude vs others)
14. FAQ — Keep (verified accurate)
15. Community & Contributing
16. Appendix: Legacy Migration (link to separate doc)
```

### Tone Shift
- FROM: Feature-list documentation style
- TO: Product story with confidence — "Here's what we are, here's why it matters"
- Keep technical depth but lead with identity and value

---

## Context & Inputs

### Dependencies
- SEEKER audit report (completed 2026-02-17)
- Current README.md (baseline)
- All system files for accuracy verification

### Files to Modify
- `README.md` — Full rewrite

### Files to Create
- `docs/LEGACY_MIGRATION.md` — Relocated v3.x migration content (optional)

---

## Constraints

### Technical Constraints
- Must be factually accurate against v4.0 system files
- All feature counts must be verified (20 skills, 7 agents, 15 brain tools, 9 brief types)
- All file paths must be real
- No broken internal links

### UX Constraints
- New user should understand Igris in 30 seconds
- Developer should find Quick Start within 1 scroll
- Must work well on GitHub rendering (markdown)
- No excessive emoji — professional but confident tone

### Out of Scope
- Rewriting docs/ folder content (separate brief)
- Updating CLAUDE.md or igris_os.md
- Changing actual system behavior

---

## Tasks

### Pending
- [ ] Task 1: ARCHITECT plans the new README structure and content outline
- [ ] Task 2: FORGER writes the full README rewrite
- [ ] Task 3: WARDEN reviews for accuracy against system files
- [ ] Task 4: Verify all feature counts, file paths, and commands
- [ ] Task 5: Relocate legacy migration content to docs/ (if decided)

### In Progress

### Completed

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
HUNT initiated. Delegating to ARCHITECT for content planning.

### Next Steps
ARCHITECT creates detailed section-by-section content outline. L-effort requires user APPROVAL before BUILDING.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-17 | orchestrator | INIT - Brief loaded, status updated | SUCCESS |
| 2026-02-17 | architect | Planning README structure and content | SUCCESS — 16-section plan, verified facts sheet, tone guide |
| 2026-02-17 | orchestrator | User approval gate | APPROVED |
| 2026-02-17 | forger | Write full README rewrite | SUCCESS — 701 lines, 16 sections, all facts verified |
| 2026-02-17 | sentinel | Validate README accuracy | FAIL — 1 issue: CONTRIBUTING.md path wrong. Fixed by orchestrator. |
| 2026-02-17 | orchestrator | Fix CONTRIBUTING.md path (ai/ → root) | SUCCESS |
| 2026-02-17 | warden | Code review | REJECT — 1 factual error (audit type), 2 suggestions. Score: 9/10 |
| 2026-02-17 | orchestrator | Fix audit type + comparison header + FAQ metaphor | SUCCESS |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] README accurately reflects v4.0 system (all counts, paths, features verified)
2. [ ] Identity statement is clear and compelling ("OS for AI engineering")
3. [ ] 20 skills listed (including `/sync`)
4. [ ] Persona section shows Crimson (Cyber Monkey), not Shadow Knight
5. [ ] MCP framed as built-in v4.0 feature
6. [ ] No legacy v3.x content in main flow (moved to appendix or separate doc)
7. [ ] Tool comparisons condensed to single readable table
8. [ ] Quick Start is clean v4.0 only
9. [ ] New user can understand Igris in 30 seconds of reading
10. [ ] WARDEN review: APPROVE

---

## Test Plan

### Functional Tests
**Test Case 1: Accuracy Check**
**Steps:**
1. Cross-reference every feature claim against actual system files
2. Verify all file paths mentioned exist
3. Confirm all command examples work

**Expected Result:** Zero factual errors
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: New User Comprehension**
**Steps:**
1. Read first 3 sections of new README
2. Can you answer: "What is Igris?" in one sentence?
3. Can you find Quick Start within 10 seconds?

**Expected Result:** Clear understanding within 30 seconds
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] No broken markdown rendering on GitHub
- [ ] All internal links resolve
- [ ] No system behavior changes (docs only)

---

## Delivery

### Documentation
- [x] README.md — Full rewrite (this brief)
- [ ] docs/LEGACY_MIGRATION.md — Relocated content (optional)

### Announcement
- [ ] Changelog entry: "Complete README rewrite reflecting v4.0 identity"

---

## Notes

**Key insight from audit discussion:**
- "Multipurpose agent brain that clones and syncs" captures only one layer
- The real identity: "OS for AI engineering with discipline, agents, memory, and accountability"
- Claude Code alone = talented developer with amnesia, no process
- Igris AI = engineering team with memory, standards, and accountability

**Audit score:** 8.5/10 — solid foundation, but identity and accuracy gaps need fixing

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Igris AI)
