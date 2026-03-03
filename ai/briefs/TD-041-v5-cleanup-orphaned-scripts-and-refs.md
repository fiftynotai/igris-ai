# TD-041: v5 Cleanup — Orphaned Scripts, Dead Refs, Minor Fixes

**Type:** Tech Debt
**Priority:** P1-High
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-03-03

---

## Problem

**What's broken or missing?**

Multiple cleanup items identified during v5 release audit:

1. **`scripts/igris-sync.sh`** — reads v4 `ai/session/` paths, not wired as a hook, superseded by `post_session_sync.sh`. Orphaned dead code.
2. **`CLAUDE.md` references `/init` skill** — no `init/` skill directory exists under `.claude/skills/`
3. **`igris_update.sh` doesn't call `igris_brain_refresh.sh`** — global `~/.igris/core/` not refreshed after update
4. **`igris_init.sh` has no deprecation notice** — v4 legacy installer should point users to `igris_install.sh`
5. **`.claude/skills/task-handlers/` has no `SKILL.md`** — it's reference material, not a skill; confuses skill count
6. **`coordination.adjustment` event never emitted** — declared in emits but handler doesn't fire it
7. **`engine/index.ts` doc says "12 components"** — should be 13
8. **Dead `engine/storage/adapter.ts`** — zero imports, stale abstraction
9. **Unused `USER_INJECTION` var in `igris_init.sh:188`**
10. **3x `ls | xargs` in `igris_update.sh`** — unsafe with special filenames

**Why does it matter?**

Shipping with dead code, wrong docs, and broken references undermines system integrity. Clean release = clean codebase.

---

## Goal

All orphaned scripts removed or updated. All stale references fixed. All minor code quality issues resolved.

---

## Tasks

### Pending
- [ ] Remove `scripts/igris-sync.sh` (dead code)
- [ ] Remove `/init` reference from CLAUDE.md or create a stub skill
- [ ] Add `igris_brain_refresh.sh` call to `igris_update.sh`
- [ ] Add deprecation banner to `igris_init.sh`
- [ ] Move `task-handlers/` from `.claude/skills/` to `ai/reference/task-handlers/`
- [ ] Emit `coordination.adjustment` event in `handleAdjustPriorities`
- [ ] Fix "12 components" → "13 components" in `engine/index.ts`
- [ ] Remove dead `engine/storage/adapter.ts`
- [ ] Remove unused `USER_INJECTION` var
- [ ] Replace `ls | xargs` with `find -print0 | xargs -0` in `igris_update.sh`

---

## Acceptance Criteria

1. [ ] `scripts/igris-sync.sh` removed
2. [ ] No broken skill references in CLAUDE.md
3. [ ] `igris_update.sh` calls brain refresh
4. [ ] `igris_init.sh` has deprecation banner
5. [ ] `task-handlers/` moved out of skills directory
6. [ ] `coordination.adjustment` event emitted when priorities adjusted
7. [ ] Component count doc is correct (13)
8. [ ] No dead files (`adapter.ts` removed)
9. [ ] Shellcheck warnings resolved

---

**Created:** 2026-03-03
**Brief Owner:** Igris AI
