# TD-020: Documentation Overhaul for v4.0

**Type:** Technical Debt
**Priority:** P1-High
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-20
**Source:** v4.0 Documentation + Standards Compliance Audit

---

## Problem

**What's broken or missing?**

Multiple documentation files are severely outdated, referencing v2/v3 patterns that no longer exist in v4.0:

1. **`coding_guidelines.md`** (v2.0.0, dated 2025-10-26) — Only covers bash scripts. Missing: TypeScript, Python, Flutter/Dart, hooks conventions, brain/MCP standards, v4 directory structure. References ancient briefs.

2. **`docs/SETUP_GUIDE.md`** — References v3 install flow (`igris_init.sh`), lists dead directories (`ai/checks/`, `ai/plugins/`), doesn't mention brain or `igris_install.sh`.

3. **`docs/MIGRATION_GUIDE.md`** — Has NO v3→v4 migration content despite README claiming it does. Missing `igris_migrate_to_v4.sh` documentation.

4. **`docs/UPDATE_GUIDE.md`** — References `.igris_version` file (v3 artifact), old plugin registry at `ai/plugins/installed.json`.

5. **`CONTRIBUTING.md`** — Broken relative links, outdated project structure, references `bats` but tests use `.test.bash`, version says 2.0.0.

6. **`ai/templates/pr_description.md`** — Flutter-specific (references flutter analyze, MVVM, ApiResponse). Should be generic.

7. **`ai/templates/commit_message.md`** — Flutter module scopes (auth, venue, kds). Should use Igris AI scopes.

8. **`docs/PLUGIN_DEVELOPMENT.md`** — References v1.0.5 hook model, old plugin registry.

**Why does it matter?**

First-time users following outdated guides will fail. Contributors see broken links and stale references. Unprofessional for a published v4.0.

---

## Goal

All documentation accurate for v4.0. Guides lead to successful installation. Templates are generic (not Flutter-specific). No broken links. Plugin system fully removed. Persona system simplified to SOUL.md + USER.md (single persona: Igris with Crimson energy).

---

## Tasks

### Pending — Documentation Updates
- [ ] Update `coding_guidelines.md` to v4.0.0 (add TS, Python, Flutter sections, v4 directory structure, hook conventions, brain standards)
- [ ] Rewrite `docs/SETUP_GUIDE.md` for v4.0 install flow (brain init, symlink install, MCP registration)
- [ ] Add v3→v4 migration section to `docs/MIGRATION_GUIDE.md` (brain migration, symlink conversion, `igris_migrate_to_v4.sh`)
- [ ] Rewrite `docs/UPDATE_GUIDE.md` for v4.0 update model (brain-based, symlinks)
- [ ] Fix `CONTRIBUTING.md` broken links, update project structure, fix version refs
- [ ] Make `ai/templates/pr_description.md` generic (not Flutter-specific)
- [ ] Make `ai/templates/commit_message.md` use Igris AI scopes

### Pending — Plugin System Removal
- [ ] Delete `scripts/plugin_install.sh`, `plugin_uninstall.sh`, `plugin_update.sh`, `plugin_list.sh`
- [ ] Delete `ai/plugins/` directory
- [ ] Delete `docs/PLUGIN_DEVELOPMENT.md`
- [ ] Delete `docs/PLUGIN_ECOSYSTEM.md`
- [ ] Remove plugin references from `igris_init.sh`, `igris_os.md`, README, SETUP_GUIDE

### Pending — Persona Simplification (SOUL.md + USER.md)
- [ ] Create `SOUL.md` at project root (Igris identity with Crimson energy: personality, agent aliases, commands, mask behavior)
- [ ] Create `USER.md` at project root (user name, addressing, preferences)
- [ ] Move mask files to `ai/masks/{none|light|half|full}.md`
- [ ] Delete `ai/persona.json`
- [ ] Delete `ai/personas/` directory (both igris + cyber-monkey)
- [ ] Delete `scripts/persona_mask.sh`
- [ ] Update `.claude/rules/05-igris-persona.md` to use SOUL.md + USER.md
- [ ] Update `.claude/rules/01-igris-init.md` to load SOUL.md + USER.md
- [ ] Update `CLAUDE.md` to `@import SOUL.md` + `@import USER.md`
- [ ] Update `/awaken` and `/rest` skills for new persona files

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-22 | architect | Plan documentation overhaul (4 phases, 8 files) | SUCCESS |
| 2026-02-22 | architect | Re-plan with expanded scope (plugin removal + persona simplification) | SUCCESS |
| 2026-02-22 | forger (x3) | Parallel build: plugin removal (12 del, 5 mod) + persona simplification (6 create, 6 mod) + docs (5 mod) | SUCCESS |
| 2026-02-22 | sentinel | Comprehensive testing — 2 blocking, 5 non-blocking issues found | FAIL |
| 2026-02-22 | orchestrator | Fixed all blocking + non-blocking issues (brain_init, brief_gate, skill counts, script counts, gitignore) | SUCCESS |
| 2026-02-22 | warden | Code review — REJECT: skill count 20→21, test suite stale, CONTRIBUTING stale refs | REJECT |
| 2026-02-22 | orchestrator | Fixed all warden findings: skill=21, deleted 4 test files+fixtures, updated 8 files, added fifty-kit to tables | SUCCESS |
| 2026-02-22 | warden (pass 2) | All findings resolved, ready to commit | APPROVE |

---

## Acceptance Criteria

1. [ ] `coding_guidelines.md` version says 4.0.0 and covers all v4 tech (bash, TS, Python, Dart, hooks)
2. [ ] New user can follow SETUP_GUIDE.md and successfully install v4.0
3. [ ] MIGRATION_GUIDE.md documents v3→v4 migration path
4. [ ] No broken relative links in CONTRIBUTING.md
5. [ ] PR/commit templates are project-agnostic
6. [ ] Skill count consistent across all docs (21 skills)
7. [ ] Plugin system fully removed (zero plugin_*.sh scripts, no ai/plugins/)
8. [ ] SOUL.md exists at project root with Igris identity
9. [ ] USER.md exists at project root with user config
10. [ ] No references to ai/persona.json or ai/personas/ in active code/docs

---

**Created:** 2026-02-20
**Last Updated:** 2026-02-20
**Brief Owner:** Crimson
