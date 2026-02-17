# BR-012: plugin_update.sh Doesn't Regenerate CLAUDE.md When Hooks Change

**Type:** BR
**Priority:** P2
**Effort:** TBD
**Status:** Done
**Created:** 2025-12-04
**Completed:** 2025-12-08

---

## Problem

When updating a plugin that adds, removes, or modifies hooks, plugin_update.sh does not regenerate CLAUDE.md to reflect the hook changes. This causes stale hook references in CLAUDE.md after plugin updates.\n\nFailing tests (3):\n- test 11: plugin_update regenerates CLAUDE.md when hooks change\n- test 12: plugin_update handles adding hooks to hookless plugin\n- test 13: plugin_update handles removing hooks from plugin\n\nThe script updates the plugin files and registry but doesn't call the CLAUDE.md regeneration logic when hooks are modified.

---

## Goal

1. plugin_update.sh detects when plugin hooks have changed\n2. Regenerates CLAUDE.md when hooks are added, removed, or modified\n3. All 3 failing tests pass (tests 11-13 in plugin_update.test.bash)\n4. CLAUDE.md accurately reflects current hook state after plugin updates

---

## Tasks

### Pending
- [ ] TBD

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** Brief created
**Next Steps When Resuming:** Define tasks and acceptance criteria
**Last Updated:** 2025-12-04
**Blockers:** None

---

## Acceptance Criteria

1. [ ] TBD

---

**Created:** 2025-12-04
**Last Updated:** 2025-12-04
