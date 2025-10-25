# BR-004: Dogfood Igris Persona in Blueprint AI Repo

**Type:** Spike
**Priority:** P1-High
**Effort:** S-Small (< 4h)
**Assignee:** AI Assistant
**Status:** Done
**Completed:** 2025-10-25

---

## Problem

We built the Igris persona plugin but haven't installed it in the actual Blueprint AI repository. We need to dogfood our own persona system.

## Goal

Install Igris persona plugin in this Blueprint AI repository and test all mask levels.

## Acceptance Criteria

1. [x] Igris persona installed in this repo
2. [x] Can wear all 4 mask levels
3. [x] CLAUDE.md regenerates correctly
4. [x] Persona files added to .gitignore

## Implementation

Install from `/tmp/persona-plugin-test` and test all masks.
