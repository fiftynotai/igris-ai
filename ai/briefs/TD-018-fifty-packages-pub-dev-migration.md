# TD-018: Switch fifty_* Packages from Local Path to pub.dev

**Type:** Technical Debt
**Priority:** P0-Critical
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-20
**Source:** v4.0 Dependency Audit

---

## Problem

**What's broken or missing?**

The Crimson Arena Flutter dashboard depends on 7 `fifty_*` packages via local path references:

```yaml
fifty_tokens: path: ../../../fifty_eco_system/packages/fifty_tokens
fifty_theme: path: ../../../fifty_eco_system/packages/fifty_theme
fifty_ui: path: ../../../fifty_eco_system/packages/fifty_ui
fifty_cache: path: ../../../fifty_eco_system/packages/fifty_cache
fifty_utils: path: ../../../fifty_eco_system/packages/fifty_utils
fifty_skill_tree: path: ../../../fifty_eco_system/packages/fifty_skill_tree
fifty_achievement_engine: path: ../../../fifty_eco_system/packages/fifty_achievement_engine
```

These are hardcoded to the developer's machine structure. Any user cloning the repo cannot build the dashboard.

**Why does it matter?**

Publication blocker. External users cannot build the Flutter dashboard without the `fifty_eco_system` repo at the exact relative path.

---

## Goal

All `fifty_*` packages consumed from pub.dev. Dashboard buildable by any user with `flutter pub get`.

---

## Blockers

**Blocked on:** fifty_flutter_kit packages being published to pub.dev (happening today per user).

---

## Tasks

### Pending
- [ ] Wait for fifty_* packages to be published on pub.dev
- [ ] Update `pubspec.yaml` to use pub.dev versions instead of local paths
- [ ] Run `flutter pub get` to verify resolution
- [ ] Run `flutter build web --release` to verify build
- [ ] Update any import paths if package structure changed
- [ ] Test dashboard locally

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

1. [ ] All 7 `fifty_*` packages reference pub.dev versions (no local paths)
2. [ ] `flutter pub get` succeeds
3. [ ] `flutter build web --release` succeeds
4. [ ] Dashboard runs correctly with pub.dev packages

---

## Notes

Audit finding: Deps DU-006. User confirmed packages will be published to pub.dev today.

**Resolution:** Resolved as side effect of MG-012 -- dashboard/ removed from igris-ai, eliminating all 7 fifty_* local path dependencies.

---

**Created:** 2026-02-20
**Last Updated:** 2026-02-20
**Brief Owner:** Crimson
