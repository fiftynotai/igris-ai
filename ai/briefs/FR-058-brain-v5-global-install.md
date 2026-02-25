# FR-058: Brain v5.0 Phase 0 — Global Agent/Skill/Rule Installation

**Type:** Feature Request
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-24
**Parent Brief:** FR-051

---

## Feature Description

**What is the proposed feature?**

Move Igris AI agents, skills, and rules from per-project symlinks to Claude Code's native global directories (`~/.claude/agents/`, `~/.claude/skills/`, `~/.claude/rules/`). This eliminates the need for symlink creation during project installation and migration, making the brain init script the single point of configuration for all shared definitions.

**Why is this valuable?**

Currently, every project installation creates 30-40 symlinks pointing from the project's `.claude/` directory to `~/.igris/core/`. This is repeated for every project on the machine. Claude Code natively supports global directories at `~/.claude/` that apply to all projects automatically. Using these eliminates per-project symlink management entirely, simplifying install, migration, and brain refresh workflows.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] Contributors (extending Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved

**Current situation:**
1. `igris_install.sh` creates 30-40 symlinks per project (agents, rules, skills, prompts, templates)
2. `igris_migrate_to_v4.sh` does the same with backup/replace logic
3. New projects require running install script to get Igris definitions
4. Stale symlinks accumulate if brain core changes (skills added/removed)
5. `igris_brain_refresh.sh` updates `~/.igris/core/` but projects must be re-symlinked

**With this feature:**
1. Brain init creates one set of global symlinks: `~/.igris/core/` → `~/.claude/`
2. Install script only creates project-local files (CLAUDE.md, ai/context/) and registers in brain
3. Migration script only backs up old files, removes stale symlinks, and registers
4. All projects immediately see updates when brain core is refreshed
5. Zero symlink management per project

---

## Technical Approach

### Claude Code Resolution Order (Researched 2026-02-24)

| Asset | Global Path | Project Path | Priority |
|-------|------------|--------------|----------|
| Agents | `~/.claude/agents/*.md` | `.claude/agents/*.md` | Project > User |
| Skills | `~/.claude/skills/*/SKILL.md` | `.claude/skills/*/SKILL.md` | User > Project |
| Rules | `~/.claude/rules/*.md` | `.claude/rules/*.md` | Project > User |

**Key behaviors:**
- **Agents/Rules:** Project overrides global. Projects CAN place a local agent/rule to override.
- **Skills:** Global overrides project. Igris system skills are global; project-specific skills can't shadow them (which is correct — system skills should be authoritative).

### Architecture Change

**Before (v4.0):**
```
~/.igris/core/agents/  →  symlink  →  project-A/.claude/agents/
~/.igris/core/agents/  →  symlink  →  project-B/.claude/agents/
~/.igris/core/agents/  →  symlink  →  project-C/.claude/agents/
(×5 categories per project: agents, rules, skills, prompts, templates)
```

**After (v5.0 Phase 0):**
```
~/.igris/core/agents/  →  symlink  →  ~/.claude/agents/     (once, global)
~/.igris/core/skills/  →  symlink  →  ~/.claude/skills/     (once, global)
~/.igris/core/rules/   →  symlink  →  ~/.claude/rules/      (once, global)
```

**Prompts and templates** remain brain-internal (`~/.igris/core/prompts/`, `~/.igris/core/templates/`). They're read by Igris skills/agents at runtime via file paths, not by Claude Code's directory discovery.

### What Stays Project-Level

| Asset | Location | Reason |
|-------|----------|--------|
| `CLAUDE.md` | Project root | Project-specific instructions, `@import` paths |
| `SOUL.md` | Project root (optional) | Per-project persona override |
| `ai/context/` | Project root | Project-specific architecture docs |
| `ai/briefs/` | Project root (until FR-054) | Brief files (migrates to DB in Phase 3) |
| `ai/session/` | Project root (until FR-054) | Session files (migrates to DB in Phase 3) |
| `ai/masks/` | Project root | Mask greeting files |
| `.claude/settings.json` | Project root | Project-specific Claude Code settings |

### Components Affected

**Modified:**
- `scripts/igris_brain_init.sh` — Add global symlink creation (`~/.igris/core/` → `~/.claude/`)
- `scripts/igris_install.sh` — Remove all agent/rule/skill/prompt/template symlink creation
- `scripts/igris_migrate_to_v4.sh` — Remove symlink creation, add stale symlink cleanup
- `scripts/igris_brain_refresh.sh` — No change needed (already refreshes `~/.igris/core/`)

**Not modified:**
- Brain MCP server — reads from `~/.igris/` directly, unaffected
- Skills — read prompts/templates via file paths, not `.claude/` discovery

---

## Context & Inputs

### Dependencies
- None — this is Phase 0, can be done before FR-052

### Related Briefs
- **FR-051** — Parent brief (Brain v5.0 architecture)
- **FR-052** — Engine Foundation (no dependency, independent)
- **FR-054** — Brief Migration (simplified by this brief — install script has less to change)

### Files to Modify
- `scripts/igris_brain_init.sh` — Add global symlink creation section
- `scripts/igris_install.sh` — Remove symlink sections, keep project-local file creation
- `scripts/igris_migrate_to_v4.sh` — Remove symlink creation, add cleanup of old project symlinks

### Related Files
- `scripts/igris_brain_refresh.sh` — Already correct (refreshes `~/.igris/core/`)
- `~/.igris/core/` — Master copies of agents, skills, rules (source for symlinks)
- `~/.claude/` — Claude Code's global user directory (target for symlinks)

---

## Constraints

### Technical Constraints
- Must handle existing projects with project-level symlinks (graceful cleanup)
- Must not break projects that have local agent/rule overrides in `.claude/`
- `~/.claude/` may already have user content — must not clobber existing files
- Prompts and templates stay in `~/.igris/core/` (not exposed via `~/.claude/`)
- Must work on both macOS and Linux

### UX Constraints
- Zero disruption — existing `/hunt`, `/scan`, `/awaken` etc. must work identically
- Projects with local overrides continue to work (Claude Code's priority system handles this)
- One-time migration for existing installations

### Out of Scope
- Engine refactoring (FR-052)
- Brief migration to DB (FR-054)
- Any MCP server changes
- Prompts/templates in `~/.claude/` (these aren't Claude Code discovery targets)

---

## Tasks

### Pending
- [ ] Task 1: Update `igris_brain_init.sh` — add global symlink creation (`~/.igris/core/{agents,skills,rules}` → `~/.claude/{agents,skills,rules}`)
- [ ] Task 2: Handle existing `~/.claude/` content — check for conflicts, warn but don't clobber
- [ ] Task 3: Update `igris_install.sh` — remove all symlink creation for agents, rules, skills, prompts, templates; keep project-local file creation (CLAUDE.md, session, context, briefs, masks)
- [ ] Task 4: Update `igris_migrate_to_v4.sh` — remove symlink creation, add cleanup of stale project-level symlinks (remove symlinks pointing to `~/.igris/core/`)
- [ ] Task 5: Create one-time migration helper — scan registered projects, remove stale `.claude/agents/*.md` symlinks that point to brain core
- [ ] Task 6: Update `igris_brain_refresh.sh` — verify global symlinks still point correctly after refresh
- [ ] Task 7: Test on clean install (no prior Igris)
- [ ] Task 8: Test on existing multi-project setup (upgrade path)
- [ ] Task 9: Test project with local agent override (priority resolution)
- [ ] Task 10: Update FR-054 brief to note reduced install script scope

### In Progress

### Completed

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered as v5.0 Phase 0. Ready to hunt with v5 phases.

### Next Steps
Hunt as part of v5.0 phase sequence. Can be done before or in parallel with FR-052 (no dependency).

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-24 | orchestrator | Research — Claude Code global resolution order | Confirmed global support for agents, skills, rules |
| 2026-02-24 | orchestrator | Brief registration as v5.0 Phase 0 | SUCCESS |

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] `igris_brain_init.sh` creates global symlinks: `~/.igris/core/{agents,skills,rules}` → `~/.claude/{agents,skills,rules}`
2. [ ] `igris_install.sh` creates ZERO symlinks for agents, rules, or skills
3. [ ] `igris_migrate_to_v4.sh` removes stale project-level symlinks and creates ZERO new ones
4. [ ] Fresh project install works — agents, skills, rules available via global path
5. [ ] Existing projects work after stale symlink cleanup
6. [ ] Project with local `.claude/agents/custom.md` override still works (priority resolution)
7. [ ] `igris_brain_refresh.sh` updates core and all projects see changes immediately
8. [ ] All skills (`/hunt`, `/scan`, `/awaken`, `/rest`, `/register`) work identically
9. [ ] Works on macOS and Linux
10. [ ] No data loss — existing project files (CLAUDE.md, briefs, sessions) preserved

---

## Test Plan

### Manual Test Cases

#### Test Case 1: Clean Install
**Preconditions:** No `~/.igris/`, no `~/.claude/agents/`
**Steps:**
1. Run `igris_brain_init.sh`
2. Verify `~/.claude/agents/`, `~/.claude/skills/`, `~/.claude/rules/` are symlinks to `~/.igris/core/`
3. Run `igris_install.sh` on a new project
4. Verify NO symlinks in project's `.claude/agents/`, `.claude/rules/`, `.claude/skills/`
5. Open Claude Code in project — verify agents, skills, rules available

**Expected Result:** Global definitions available, zero project-level symlinks

#### Test Case 2: Upgrade Existing Multi-Project Setup
**Preconditions:** 3+ projects with existing per-project symlinks
**Steps:**
1. Run updated `igris_brain_init.sh` (adds global symlinks)
2. Run migration helper on each project (removes stale symlinks)
3. Open Claude Code in each project — verify agents, skills, rules still work
4. Verify project-local overrides still take precedence

**Expected Result:** Seamless upgrade, zero disruption

#### Test Case 3: Local Override Priority
**Preconditions:** Global agents installed, project has custom `.claude/agents/sage.md`
**Steps:**
1. Open Claude Code in project
2. Invoke sage agent
3. Verify project-local sage definition is used (not global)

**Expected Result:** Project override takes precedence for agents/rules

---

## Delivery

### Code Changes
- [ ] Modified: `scripts/igris_brain_init.sh`
- [ ] Modified: `scripts/igris_install.sh`
- [ ] Modified: `scripts/igris_migrate_to_v4.sh`
- [ ] Modified: `scripts/igris_brain_refresh.sh` (if needed)

### Deployment Notes
- [ ] Run `igris_brain_init.sh` once after upgrade to create global symlinks
- [ ] Run migration helper on existing projects to clean stale symlinks
- [ ] `/sync code` to deploy to VPS

---

## Notes

### v5.0 Phase Sequence (Updated)

| Phase | Brief | Scope | Depends On |
|-------|-------|-------|------------|
| **0** | **FR-058** | **Global install (agents/skills/rules)** | **None** |
| 1 | FR-052 | Engine Foundation | None |
| 2 | FR-053 | Task Management | FR-052 |
| 3 | FR-054 | Brief Migration & Cache | FR-053, simplified by FR-058 |
| 4 | FR-055 | Scheduling System | FR-053 |
| 5 | FR-056 | Autonomous Coordination | FR-055 |

FR-058 and FR-052 have no dependency on each other and can be hunted in parallel.

### Research Source
Claude Code official documentation confirms global directory support:
- `~/.claude/agents/` — user-level agents (project overrides)
- `~/.claude/skills/` — user-level skills (overrides project)
- `~/.claude/rules/` — user-level rules (project overrides)

---

**Created:** 2026-02-24
**Last Updated:** 2026-02-24
**Brief Owner:** Crimson (Igris AI)
