# TD-017: v4.0 Release Documentation

**Type:** Technical Debt
**Priority:** P0-Critical
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-20
**Source:** v4.0 Documentation + Dependency Audit

---

## Problem

**What's broken or missing?**

Three critical documentation gaps block v4.0 publication:

1. **Missing LICENSE file** — README references `[MIT License](LICENSE)` but no LICENSE file exists at repo root. GitHub won't display license badge. Legal clarity missing for contributors.

2. **CHANGELOG stops at v3.3.1** — Last entry dated 2025-12-25. No entries for v3.4, v3.5, or v4.0. The massive v4.0 release (brain, agent teams, 27 MCP tools, dashboard, hooks) has zero changelog documentation.

3. **README missing prerequisites** — Installation section does not list: python3 (critical, used by ALL scripts), sqlite3 with FTS5 (critical, brain init), perl (critical, CLAUDE.md generation), jq (preferred for hooks).

**Why does it matter?**

No LICENSE = legal blocker. No CHANGELOG = users can't understand what changed. Missing prerequisites = users fail on first install.

---

## Goal

Complete LICENSE, CHANGELOG, and README prerequisites sections ready for v4.0 publication.

---

## Tasks

### Pending
- [ ] Create root `LICENSE` file with MIT license text
- [ ] Add CHANGELOG entries for v3.4, v3.5, v4.0.0 (comprehensive — brain, agents, teams, hooks, dashboard, MCP tools)
- [ ] Update README Prerequisites section to include: python3, sqlite3 (with FTS5), perl, jq (optional), Flutter 3.9.2+ (dashboard), Python 3 + pip (dashboard server)
- [ ] Verify LICENSE link in README works
- [ ] Verify all prerequisite install commands are correct per platform

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

---

## Acceptance Criteria

1. [ ] Root LICENSE file exists with MIT license text
2. [ ] CHANGELOG.md has comprehensive v4.0.0 entry
3. [ ] README Prerequisites lists all required tools with install commands
4. [ ] `git diff` shows no broken links

---

## Notes

Audit findings: Docs C-1 (LICENSE), C-2 (CHANGELOG), Deps DU-013 (README prerequisites), DU-011 (perl).

---

**Created:** 2026-02-20
**Last Updated:** 2026-02-20
**Brief Owner:** Crimson
