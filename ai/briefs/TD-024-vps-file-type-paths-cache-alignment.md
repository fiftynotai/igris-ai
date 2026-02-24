# TD-024: Verify VPS FILE_TYPE_PATHS Cache Alignment

**Type:** Technical Debt
**Priority:** P2-Medium
**Effort:** S-Small
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-24
**Source:** FR-063 warden review (Major note #2)

---

## Problem

`brain-mcp-server/src/index.ts` FILE_TYPE_PATHS (lines 917-921) maps file types to `ai/session/metrics/` paths. With hooks now writing metrics to `~/.igris/cache/{project}/metrics/`, there may be a semantic mismatch between local and VPS paths.

## Goal

Verify whether VPS file-push targets should also use cache-based paths, or if they are intentionally different (VPS brain stores under its own BRAIN_DIR). Add clarifying comments if intentional, or update paths if needed.

## Acceptance Criteria

1. [x] FILE_TYPE_PATHS verified or updated for cache alignment
2. [x] Comment added clarifying VPS vs local path distinction

---

**Created:** 2026-02-24
**Brief Owner:** Crimson (Igris AI)
