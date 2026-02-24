# TD-025: Clean Dead .gitignore Entry for Metrics

**Type:** Technical Debt
**Priority:** P3-Low
**Effort:** S-Small
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-02-24
**Source:** FR-063 warden review (Minor note #3)

---

## Problem

`.gitignore` still references `ai/session/metrics/events.jsonl` which now lives at `~/.igris/cache/{project}/metrics/events.jsonl` (outside the git repo entirely). The entry is dead/irrelevant.

## Goal

Remove or update the dead gitignore entry.

## Acceptance Criteria

1. [ ] Dead gitignore entry removed or updated

---

**Created:** 2026-02-24
**Brief Owner:** Crimson (Igris AI)
