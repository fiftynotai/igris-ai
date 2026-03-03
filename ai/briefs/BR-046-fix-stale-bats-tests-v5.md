# BR-046: Fix Stale Bats Shell Tests for v5

**Type:** Bug Fix
**Priority:** P0-Critical
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-03-03

---

## Problem

**What's broken or missing?**

4 out of 87 bats shell tests are failing due to stale assertions from the v4 era:

1. **Test 3** (`igris_init installs native subagents`): Expects `planner.md` in `.claude/agents/` — this agent was renamed/replaced in v4 (now `architect.md`)
2. **Tests 17, 22, 23**: Expect `SOUL.md` to be copied to project root by `igris_init.sh` — this behavior was removed or changed

**Why does it matter?**

Failing tests block v5 release. Tests must be green or explicitly marked as known-skip for a clean release.

---

## Goal

All 87 bats tests pass (or stale ones are updated to match v5 reality). Zero failing tests.

---

## Context & Inputs

### Affected Modules
- [x] `test/igris_init.test.bash`
- [x] `scripts/igris_init.sh` (reference only — understand what it actually does)

### Related Files
- `test/igris_init.test.bash` — the failing test file
- `.claude/agents/` — current agent set (architect, forger, sentinel, warden, mender, seeker, sage)

---

## Tasks

### Pending
- [ ] Read failing tests and understand expected vs actual behavior
- [ ] Update test 3: replace `planner.md` with current agent names
- [ ] Update tests 17, 22, 23: fix SOUL.md assertions to match actual install behavior
- [ ] Run full bats test suite — confirm 87/87 pass

---

## Acceptance Criteria

1. [ ] All 87 bats tests pass (`bats test/igris_init.test.bash` etc.)
2. [ ] No test assertions reference removed agents (`planner.md`)
3. [ ] Test assertions match actual v5 installer behavior
4. [ ] No regressions in other test files

---

**Created:** 2026-03-03
**Brief Owner:** Igris AI
