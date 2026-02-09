# MG-004: Memory Architecture Migration

**Type:** Migration
**Priority:** P1-High
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-05
**Completed:** 2026-02-06

---

## Current State

**What's the problem with the current implementation?**

Igris AI uses a monolithic CLAUDE.md (900+ lines) that duplicates content from `ai/prompts/igris_os.md` and contains all initialization logic, persona config, workflow definitions, and agent manifests in a single file. On every session start, Claude must manually read multiple files (igris_os.md, persona.json, CURRENT_SESSION.md, coding_guidelines.md) through explicit instructions in CLAUDE.md.

**Why does it need to change?**

Claude Code 2026 introduces native features that solve these problems:
1. **`@import` syntax** - CLAUDE.md can import files directly, eliminating duplication
2. **`.claude/rules/*.md`** - Modular, path-specific rules replace monolithic instructions
3. **Native session memory** - Auto-saves/recalls session context across sessions (v2.1.30+)
4. **`SessionStart` hooks** - Can auto-inject session state without manual file reading

The current approach wastes context window on duplicated instructions and relies on Claude following manual "read this file first" steps that can fail on context resets.

---

## Target State

**What should it look like after migration?**

1. **Slim CLAUDE.md** (~100 lines) that uses `@import` to reference:
   - `@ai/prompts/igris_os.md` (operating system)
   - `@ai/persona.json` (identity)
   - `@ai/context/coding_guidelines.md` (standards)

2. **`.claude/rules/` directory** with modular protocol files:
   - `igris-init.md` - Initialization sequence
   - `igris-briefs.md` - Brief-first protocol enforcement
   - `igris-commits.md` - Commit message standards
   - `igris-agents.md` - Agent delegation rules
   - `igris-persona.md` - Persona configuration

3. **Native memory integration** leveraging Claude Code's auto session memory alongside CURRENT_SESSION.md for brief-level tracking

---

## Migration Steps

1. [ ] Audit current CLAUDE.md - identify all sections and their sources
2. [ ] Create `.claude/rules/` directory structure
3. [ ] Extract modular rules from CLAUDE.md into separate rule files
4. [ ] Rewrite CLAUDE.md as slim import hub using `@import` syntax
5. [ ] Test `@import` resolution with igris_os.md and persona.json
6. [ ] Verify rules auto-load behavior matches current initialization
7. [ ] Add `CLAUDE.local.md` template for dev-specific overrides
8. [ ] Update igris_os.md to reference new memory architecture
9. [ ] Test full initialization flow with new structure
10. [ ] Document new memory architecture in README/docs

---

## Tasks

### Pending
- [ ] Task 4: Test and validate new initialization flow
- [ ] Task 5: Update documentation

### In Progress
_(none)_

### Completed
- [x] Task 1: Audit CLAUDE.md sections and map to target locations
- [x] Task 2: Create .claude/rules/ directory with modular rule files
- [x] Task 3: Rewrite CLAUDE.md as import hub (769→96 lines)

---

## Workflow State

**Phase:** TESTING
**Active Agent:** tester
**Retry Count:** 0

### Current Work
ALL PHASES COMPLETE. Ready for commit.

### Next Steps
Commit migration and mark brief as Done.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-06 | planner | Starting implementation planning | Pending... |
| 2026-02-06 | planner | Implementation plan created | SUCCESS - ai/plans/MG-004-plan.md |
| 2026-02-06 | - | Plan approved by Partner | APPROVED |
| 2026-02-06 | coder | Phase 1: Create rules directory | Starting... |
| 2026-02-06 | coder | Phase 1: Create 5 modular rule files | SUCCESS - 855 lines total |
| 2026-02-06 | coder | Phase 2: Rewrite CLAUDE.md as import hub | SUCCESS - 769→96 lines (87.5% reduction) |
| 2026-02-06 | coder | Created CLAUDE.local.md template | SUCCESS |
| 2026-02-06 | tester | Phase 3: Fresh session init test | **PASSED** - @import + rules auto-load verified |
| 2026-02-06 | tester | Phase 4: Context reset recovery | **PASSED** - Session state recovered correctly |
| 2026-02-06 | documenter | Phase 5: Documentation & cleanup | **COMPLETE** - igris_os.md updated |

### Blockers
None

---

## Impact Assessment

### Affected Files
- [ ] `CLAUDE.md` - Complete rewrite as import hub
- [ ] `.claude/rules/*.md` - New modular rule files (5-6 files)
- [ ] `ai/prompts/igris_os.md` - Updates for new memory architecture references
- [ ] `CLAUDE.local.md` - New file for local overrides

### Affected Modules
- [ ] `Initialization system` - How Igris loads on session start
- [ ] `Memory management` - How context persists across sessions

### Breaking Changes
- [ ] **Yes** - CLAUDE.md structure completely changes; requires Claude Code version with `@import` support
- [ ] **No**

### Dependencies
- [ ] Depends on: None
- [ ] Blocks: MG-005, MG-006, MG-007 (foundation for other migrations)

---

## Testing Strategy

### Manual Testing

#### Test Case 1: Fresh Session Init
**Steps:**
1. Start new Claude Code session in igris-ai project
2. Verify CLAUDE.md imports resolve correctly
3. Verify .claude/rules/ files auto-load
4. Verify Igris initialization sequence completes

**Expected:** Full Igris initialization with persona greeting, session status, and recommendations
**Status:** [x] Pass / [ ] Fail
**Notes:** 2026-02-06 - @import resolved igris_os.md, persona.json, coding_guidelines.md. Rules auto-loaded via system-reminder. Full Crimson persona greeting displayed.

#### Test Case 2: Context Reset Recovery
**Steps:**
1. Start session with active brief
2. Simulate context reset
3. Verify session state recovery

**Expected:** Session recovers with correct brief context
**Status:** [x] Pass / [ ] Fail
**Notes:** 2026-02-06 - Fresh session correctly identified MG-004 as active, resumed at Phase 3 testing. Recovery chain: rules → CURRENT_SESSION.md → brief file.

---

## Rollback Plan

1. Restore original CLAUDE.md from git
2. Remove .claude/rules/ directory
3. Remove CLAUDE.local.md

**Rollback safe until:** Merged to main

---

## Acceptance Criteria

1. [x] CLAUDE.md is under 150 lines using @import syntax (96 lines - 87.5% reduction)
2. [x] All modular rules in .claude/rules/ auto-load correctly (5 files verified)
3. [x] Initialization sequence completes identically to current behavior (Phase 3 PASSED)
4. [x] Context resets recover session state correctly (Phase 4 PASSED)
5. [x] No regression in brief workflow operations (session resume worked correctly)
6. [x] Documentation updated (igris_os.md - added Modular Rules Architecture section)

---

## References

**External References:**
- Claude Code Memory Docs: https://code.claude.com/docs/en/memory
- @import syntax documentation
- .claude/rules/ path-specific rules

**Related Briefs:**
- Blocks: MG-005 (Skills Migration), MG-006 (Hooks Integration), MG-007 (Native Agents)

---

## Notes

This is the foundation migration. The new memory architecture must be stable before migrating commands to skills (MG-005), adding hooks (MG-006), or porting agents (MG-007).

---

**Created:** 2026-02-05
**Last Updated:** 2026-02-05
**Brief Owner:** Crimson (Fifty.ai)
