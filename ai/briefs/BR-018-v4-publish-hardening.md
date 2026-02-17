# BR-018: v4.0 Publish Hardening — Final Audit Fixes

**Type:** Bug Fix / Tech Debt
**Priority:** P0-Critical
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-17

---

## Feature Description

**What is the proposed feature?**

Fix all 12 remaining findings from the v4.0 pre-release audit. These block public publishing of Igris AI v4.0.

**Why is this valuable?**

The v4.0 codebase has 12 verified issues ranging from data-loss bugs (INSERT OR REPLACE) to stale documentation (wrong project name in LICENSE, wrong version in version.txt). These must be resolved before the first public release.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] Contributors (extending Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved

**Current situation:**
- INSERT OR REPLACE in projects.ts and briefs.ts can silently destroy data
- Schema version mismatch between push (v4) and drain (v8) functions
- LICENSE says "Blueprint AI" instead of "Igris AI"
- version.txt says 3.3.1 instead of 4.0.0
- Ghost "documenter" agent referenced in 5+ files (agent doesn't exist)
- igris_os.md documents only 15 of 27 MCP tools
- SETUP_GUIDE.md has placeholder URLs

**With this fix:**
- All data operations use safe upsert patterns
- Schema versions consistent across all sync operations
- All documentation reflects correct project identity and version
- Agent references match actual v4.0 agent registry
- MCP tool documentation complete

---

## Technical Approach

### Fix List (12 items)

**Brain MCP Server (4 fixes):**
1. `brain-mcp-server/src/tools/projects.ts` — Replace `INSERT OR REPLACE` with `INSERT INTO ... ON CONFLICT(slug) DO UPDATE SET`
2. `brain-mcp-server/src/tools/briefs.ts` — Replace `INSERT OR REPLACE` with `INSERT INTO ... ON CONFLICT(project, brief_id) DO UPDATE SET`
3. `brain-mcp-server/src/tools/sync.ts` — Update push function schema_version from 4 to 8
4. `brain-mcp-server/package.json` — Move `express` from devDependencies to dependencies (it's imported at runtime)

**Scripts (2 fixes):**
5. `scripts/persona_mask.sh:15` — Fix ANSI color: `\033[0:31m` → `\033[0;31m`
6. `scripts/persona_mask.sh` cmd_adjust — Add mask validation (must be none|light|half|full)

**Skills/Agents/Rules (3 fixes):**
7. Replace "documenter" with "/document skill" across: `.claude/rules/04-igris-agents.md`, `ai/prompts/igris_os.md`
8. Update `ai/prompts/igris_os.md` MCP tools table — add all 12 missing tools
9. Update old brief templates in `ai/briefs/` — replace v3.x agent names with v4.0 names

**Documentation (3 fixes):**
10. `LICENSE` — Replace "Blueprint AI" with "Igris AI"
11. `version.txt` — Update from 3.3.1 to 4.0.0
12. `docs/SETUP_GUIDE.md` — Replace `yourorg` with `fiftynotai` (6 occurrences)

---

## Constraints

### Technical Constraints
- All fixes must be backward compatible
- Brain MCP server must still start and pass health check
- No new dependencies
- All existing MCP tools must work identically

### Out of Scope
- Dashboard fixes (tracked separately)
- Brain MCP test suite (v5.0 scope)
- FTS5 empty query handling (cosmetic, v5.0)
- Duplicate sanitizeFts5Query refactoring (v5.0)

---

## Tasks

### Pending
- [ ] Task 1: Fix INSERT OR REPLACE in projects.ts (ON CONFLICT DO UPDATE)
- [ ] Task 2: Fix INSERT OR REPLACE in briefs.ts (ON CONFLICT DO UPDATE)
- [ ] Task 3: Fix schema_version mismatch in sync.ts push function (4 → 8)
- [ ] Task 4: Move express to dependencies in package.json
- [ ] Task 5: Fix persona_mask.sh ANSI color code
- [ ] Task 6: Add mask validation to persona_mask.sh cmd_adjust
- [ ] Task 7: Replace ghost "documenter" references with "/document skill"
- [ ] Task 8: Update igris_os.md MCP tools table (add 12 missing tools)
- [ ] Task 9: Update old brief templates with v4.0 agent names
- [ ] Task 10: Fix LICENSE — "Blueprint AI" → "Igris AI"
- [ ] Task 11: Fix version.txt — 3.3.1 → 4.0.0
- [ ] Task 12: Fix SETUP_GUIDE.md — yourorg → fiftynotai

### In Progress

### Completed

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Starting HUNT workflow.

### Next Steps
Proceed to PLANNING phase.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
None

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] `projects.ts` uses ON CONFLICT DO UPDATE (not INSERT OR REPLACE)
2. [ ] `briefs.ts` uses ON CONFLICT DO UPDATE (not INSERT OR REPLACE)
3. [ ] `sync.ts` push function sends schema_version=8
4. [ ] `express` is in package.json dependencies
5. [ ] `persona_mask.sh` RED color code uses semicolon not colon
6. [ ] `persona_mask.sh` cmd_adjust validates mask is none|light|half|full
7. [ ] Zero "documenter" references in active rule/prompt files
8. [ ] `igris_os.md` documents all 27 MCP tools
9. [ ] Brief templates use v4.0 agent names
10. [ ] LICENSE says "Igris AI"
11. [ ] version.txt says 4.0.0
12. [ ] SETUP_GUIDE.md has no yourorg placeholders
13. [ ] Brain MCP server compiles and starts successfully
14. [ ] TypeScript compilation clean (zero errors)

---

## Test Plan

### Functional Tests

**Test Case 1: Brain MCP Compilation**
**Steps:** Run `npm run build` in brain-mcp-server/
**Expected Result:** Zero errors, zero warnings
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Upsert Safety**
**Steps:** Verify projects.ts and briefs.ts SQL uses ON CONFLICT pattern
**Expected Result:** No INSERT OR REPLACE in tool handlers
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Documentation Consistency**
**Steps:** Grep for "Blueprint AI", "3.3.1", "yourorg", "documenter" across codebase
**Expected Result:** Zero matches in active files
**Status:** [ ] Pass / [ ] Fail

---

## Notes

Follows from v4.0 pre-release audit (5 parallel WARDEN agents).
Previous hardening: BR-017 fixed 3 critical findings (trusted_schema, countTable whitelist, eval injection).
This brief fixes the remaining 12 findings.

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Igris AI)
