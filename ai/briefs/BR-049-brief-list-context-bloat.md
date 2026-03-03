# BR-049: igris_brief_list returns all briefs with no limit — context bloat

## Metadata
- **Type:** Bug Fix
- **Priority:** P1-High
- **Status:** In Progress
- **Effort:** S-Small
- **Created:** 2026-03-04

## Problem

The `igris_brief_list` brain MCP tool returns ALL briefs for a project with no `limit` or `offset` parameter. With 90+ briefs in igris-ai, a single call produces ~12.3k tokens of JSON, rapidly filling the LLM context window.

This is called on every `/awaken` session start, making it a recurring context tax.

## Goal

Add `limit` and `offset` parameters to `igris_brief_list` so callers can control response size. Default to a sensible limit (25) that covers most use cases without bloating context.

## Context and Inputs

- **Handler location:** `mcp-server/src/handlers/` — brain brief list handler
- **Tool definition:** Registered in the MCP server tool list
- **Current params:** `project`, `status`, `brief_type`, `priority`, `include_content`
- **Missing params:** `limit`, `offset`

## Acceptance Criteria

1. `igris_brief_list` accepts optional `limit` param (default: 25)
2. `igris_brief_list` accepts optional `offset` param (default: 0)
3. Response includes a `total` count field so callers know how many briefs exist
4. Existing filters (`status`, `priority`, `brief_type`) still work correctly with limit/offset
5. Default call returns max 25 briefs sorted by updated_at DESC (most recent first)

## Test Plan

- Call with no limit → returns max 25 briefs + total count
- Call with limit=5 → returns exactly 5
- Call with limit=5, offset=5 → returns next 5
- Call with status filter + limit → filters first, then paginates
- Call with limit=0 → returns all (escape hatch for full list)

## Delivery

- Modify brain MCP handler
- Update tool schema/definition
- No migration needed (query-only change)
