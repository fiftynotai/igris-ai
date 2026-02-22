# TD-021: Brain Integration Cleanup

**Type:** Technical Debt
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-20
**Source:** v4.0 Process Audit

---

## Problem

**What's broken or missing?**

The brain integration layer has configuration and documentation mismatches:

1. **Staging pipeline disabled but files accumulating** — `config.json` has `staging_pipeline: false` but hooks (`post_brief_sync.sh`, `post_session_sync.sh`) write to `~/.igris/staging/`. Result: 30+ stale JSON files accumulating with no processing.

2. **MCP server disabled but advertised** — `config.json` has `mcp_server: false` but CLAUDE.md rule 01 step 6.5 says "Query `igris_project_status`" and docs reference 27 MCP tools. Documentation promises capabilities that are non-functional in local mode.

3. **`startup.sh` brief counting broken** — Uses `grep "^Status: Ready"` but brief files use `**Status:** Ready` (markdown bold). Status counts in terminal greeting are always 0.

4. **`startup.sh` not registered in settings.json** — Exists in `.claude/hooks/` but is not registered as a hook event. Either dead code or loaded via shell profile.

5. **`startup.sh` missing `set -e`** — Only script in the project without it.

**Why does it matter?**

Disabled-but-advertised features confuse users. Stale staging files waste disk. Broken status counts make the greeting unreliable.

---

## Goal

Brain config accurately reflects enabled features. Documentation matches reality. Staging files either processed or cleaned up. startup.sh either works correctly or is removed.

---

## Tasks

### Completed
- [x] Clean up accumulated staging files in `~/.igris/staging/` (43 files removed)
- [x] Guard staging hooks behind `staging_pipeline` config flag (jq/python3 fallback)
- [x] Remove `startup.sh` (dead code: unregistered, broken grep, duplicated by session_start.sh)
- [x] Remove `startup.sh.template` (same bugs)
- [x] Update `igris_init.sh` to stop copying deleted template
- [x] Update tests to remove startup.sh assertions
- [x] Update `01-igris-init.md` step 6.5 to conditionally query MCP
- [x] Update `igris_os.md` brain docs: MCP optional, staging guarded, feature flags table
- [x] Verify no remaining `^Status:` / `^Priority:` grep bugs in active scripts
- [x] Confirm config.json feature flags match actual state

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-22 | architect | Plan implementation (5 phases, 6 files) | SUCCESS |
| 2026-02-22 | forger | Implement all 5 phases (8 files changed, 2 deleted) | SUCCESS |
| 2026-02-22 | sentinel | Testing implementation | PASS (2 warnings fixed) |
| 2026-02-22 | orchestrator | Fix stale startup.sh refs in 6 docs | SUCCESS |
| 2026-02-22 | warden | Code review | APPROVE (4 minor findings, all fixed) |

---

## Acceptance Criteria

1. [x] No stale staging files accumulating without processing (hooks guarded by config flag)
2. [x] Documentation accurately describes which brain features require MCP server
3. [x] `startup.sh` removed (dead code; session_start.sh handles greeting)
4. [x] N/A (startup.sh removed)
5. [x] Config feature flags match actual enabled state

---

**Created:** 2026-02-20
**Last Updated:** 2026-02-22
**Brief Owner:** Crimson
