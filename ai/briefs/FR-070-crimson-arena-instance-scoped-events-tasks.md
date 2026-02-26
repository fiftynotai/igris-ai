# FR-070: Crimson Arena — Instance-Scoped Events & Tasks Views

**Type:** FR
**Priority:** P1
**Effort:** M-Medium
**Status:** Ready
**Created:** 2026-02-26
**Completed:** _TBD_

---

## Problem

Events and Tasks pages show global data with no instance filtering. Can't drill from Instances page → that instance's events or tasks.

## Goal

Add instance filter parameter to Events and Tasks pages. Link from Instances page → filtered views. Show instance context in breadcrumb.

## Scope

**Repository:** crimson-arena

## Acceptance Criteria

1. [ ] Events page filters by instance ID if provided
2. [ ] Tasks page filters by instance ID if provided
3. [ ] Instances page links work (deep linking to filtered views)
4. [ ] Breadcrumb shows context
5. [ ] `flutter analyze` passes

---

**Created:** 2026-02-26
