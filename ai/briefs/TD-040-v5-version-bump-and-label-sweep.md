# TD-040: v5 Version Bump and Label Sweep

**Type:** Tech Debt
**Priority:** P0-Critical
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-03-03

---

## Problem

**What's broken or missing?**

All version labels across the codebase still say `4.0.0` / `v4.0` despite the brain engine being v5.0. Files affected:

1. `version.txt` — `4.0.0`
2. `CLAUDE.md` — references v4.0 in two places
3. `ai/prompts/igris_os.md` — lines 50, 52, 163, 255, 1312
4. `.claude/rules/04-igris-agents.md` — line 17 header
5. `manifest.yaml` — version field
6. `igris_brain_init.sh` — lines 450, 621 (hardcoded `4.0.0` fallback)
7. `~/.igris/config.json` — version field

**Why does it matter?**

Version drift causes confusion. Users, scripts, and dashboards all read these labels. Must be consistent for release.

---

## Goal

All version references updated to `5.0.0`. Single source of truth in `version.txt`, scripts read from it.

---

## Tasks

### Pending
- [ ] Update `version.txt` to `5.0.0`
- [ ] Update `CLAUDE.md` version references
- [ ] Update `ai/prompts/igris_os.md` version strings
- [ ] Update `.claude/rules/04-igris-agents.md` header
- [ ] Update `manifest.yaml` version field
- [ ] Update `igris_brain_init.sh` hardcoded fallbacks to read from `version.txt`
- [ ] Update CHANGELOG.md [Unreleased] section with v5.0.0 header

---

## Acceptance Criteria

1. [ ] `version.txt` reads `5.0.0`
2. [ ] `grep -r "4\.0\.0\|v4\.0" --include="*.md" --include="*.sh" --include="*.yaml"` returns zero false positives
3. [ ] `igris_brain_init.sh` reads version from `version.txt` instead of hardcoding
4. [ ] CHANGELOG.md has `## [5.0.0]` section

---

**Created:** 2026-03-03
**Brief Owner:** Igris AI
