# TD-021: Brain Integration Cleanup

**Type:** Technical Debt
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
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

### Pending
- [ ] Decision: Enable staging pipeline OR remove staging writes from hooks
- [ ] Decision: Update docs to clarify local-only vs brain MCP mode
- [ ] Clean up accumulated staging files in `~/.igris/staging/`
- [ ] Fix `startup.sh` brief counting regex to match `**Status:**` format
- [ ] Add `set -e` to `startup.sh`
- [ ] Decision: Register `startup.sh` as a hook or document its loading mechanism
- [ ] Update config.json feature flags to match actual state

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

---

## Acceptance Criteria

1. [ ] No stale staging files accumulating without processing
2. [ ] Documentation accurately describes which brain features require MCP server
3. [ ] `startup.sh` correctly counts brief statuses (if kept)
4. [ ] `startup.sh` has `set -e` (if kept)
5. [ ] Config feature flags match actual enabled state

---

**Created:** 2026-02-20
**Last Updated:** 2026-02-20
**Brief Owner:** Crimson
