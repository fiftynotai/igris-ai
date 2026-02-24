# FR-063: Brain v5.0 — Skill & Rule Path Migration

**Type:** Feature Request
**Priority:** P1-High
**Effort:** L-Large (2-3d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-24
**Parent Brief:** FR-054
**Blocked By:** FR-061, FR-062

---

## Feature Description

**What is the proposed feature?**

Update all skills, rules, and prompts that reference `ai/briefs/` or `ai/session/` to use MCP tools (primary) with cache fallback. Update `igris_install.sh` to stop creating project-local brief/session directories. This is the final phase that completes the brief migration.

**Why is this valuable?**

After FR-061 (CRUD tools) and FR-062 (cache + migration), the DB is populated and cache is generated. But skills still read from `ai/briefs/` in project repos. This brief updates all 14 skills, 2 rules, 2 prompts, and the install script to use the new MCP-first approach.

---

## Technical Approach

### Files to Modify (20+)

**Core Skills (4):** hunt, register, scan, archive
**Session Skills (2):** awaken, rest
**Satellite Skills (6):** team, ideate, audit, migrate-analyze, sync, digivolve
**Rules (2):** 01-igris-init.md (6 refs), 02-igris-briefs.md (6 refs)
**Prompts (2):** igris_os.md (24 refs), session_protocol.md (3 refs)
**Scripts (2):** igris_install.sh, hunt/scripts/validate-brief.sh

### Pattern
Skills use MCP-first: call `igris_brief_get`/`igris_brief_list` etc. Fallback to cache at `~/.igris/cache/{project}/briefs/`. Never reference `ai/briefs/` in project repo.

---

## Acceptance Criteria

1. [ ] All 14 skills updated to use MCP/cache paths
2. [ ] Both rules updated with new path references
3. [ ] Both prompts updated (igris_os.md: 24 refs, session_protocol: 3 refs)
4. [ ] Install script stops creating ai/briefs/ and ai/session/archive
5. [ ] validate-brief.sh updated or removed
6. [ ] No skill references ai/briefs/ or ai/session/ directly
7. [ ] All skills work identically post-migration
8. [ ] allowed-tools headers updated for skills using new MCP tools

---

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0
**Completed:** 2026-02-24

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-24 | architect | Create implementation plan | SUCCESS — 17 files (15 modify, 1 delete, 1 no-change), 8 phases |
| 2026-02-24 | - | User approval | APPROVED — expanded scope to include metrics migration (sync + digivolve) |
| 2026-02-24 | forger | Implement changes | SUCCESS — 28 modified, 1 deleted (skills, rules, prompts, hooks, scripts) |
| 2026-02-24 | sentinel | Run test suite | PASS 8/10 (2 legacy hook patterns found) |
| 2026-02-24 | - | Fix legacy hook patterns | Applied — removed 6 legacy lines from 3 hooks |
| 2026-02-24 | warden | Code review | APPROVE — clean migration, 2 follow-up notes (CLAUDE.md.template, VPS paths) |

### Next Steps
Proceeding to commit.

---

**Created:** 2026-02-24
**Brief Owner:** Crimson (Igris AI)
