# TD-032: Cap authFailures map size in HTTP mode

**Type:** TD
**Priority:** P2
**Effort:** TBD
**Status:** Done
**Created:** 2026-02-25
**Completed:** 2026-02-25

---

## Problem

The `authFailures` rate limit map in `src/index.ts` grows with each unique IP that fails authentication. The cleanup interval clears expired entries every 5 minutes, but a DDoS with thousands of unique IPs could cause memory growth between cleanup cycles.

---

## Goal

Add a maximum size check (e.g., 10,000 entries) with an early eviction policy. If the map exceeds max size, evict oldest entries before adding new ones.

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
**Last Updated:** 2026-02-25
**Blockers:** None

---

## Acceptance Criteria

1. [ ] TBD

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
