# BR-027: Script & Hook Injection Fixes

**Type:** Bug Fix
**Priority:** P0-Critical
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-20
**Source:** v4.0 Standards Compliance + Code Quality Audit

---

## Problem

**What's broken or missing?**

Multiple scripts and hooks have injection vulnerabilities and platform compatibility issues:

1. **`persona_mask.sh` jq-only dependency** — Uses jq in 15+ places with NO python3 fallback. Script hard-fails if jq is not installed, violating the core coding guideline that jq must always have a python3 fallback.

2. **Shell variable injection in Python heredocs** (`plugin_install.sh:169-198`, `plugin_uninstall.sh`, `plugin_update.sh`) — Shell variables like `$PLUGIN_NAME` are interpolated directly into Python heredoc strings. Crafted plugin names with `'` chars can break/inject Python code.

3. **Triple-quote injection in Python fallbacks** (`post_edit_lint.sh:117-120`, `pre_compact.sh`, `session_start.sh`) — Shell variable `${context}` injected into Python triple-quoted strings. If content contains `'''`, it breaks out and can inject code.

4. **macOS-specific `stat -f %m`** in `brief_gate.sh:86` — Breaks on Linux (should use `stat -c %Y`).

5. **macOS-specific `sed -i.bak`** in `persona_mask.sh:99` — Cross-platform compatibility issue.

**Why does it matter?**

persona_mask.sh is the #1 critical violation (jq-only). The injection vectors are security risks. Cross-platform issues prevent Linux users from using Igris AI.

---

## Goal

All scripts use python3 fallback for jq operations. No shell variable injection into Python strings. Cross-platform compatible across macOS and Linux.

---

## Context & Inputs

### Related Files
- `scripts/persona_mask.sh` — jq fallback + sed replacement
- `scripts/plugin_install.sh` — Python heredoc injection
- `scripts/plugin_uninstall.sh` — Python heredoc injection
- `scripts/plugin_update.sh` — Python heredoc injection
- `.claude/hooks/brief_gate.sh` — macOS stat
- `.claude/hooks/post_edit_lint.sh` — triple-quote injection
- `.claude/hooks/pre_compact.sh` — triple-quote injection
- `.claude/hooks/session_start.sh` — triple-quote injection

---

## Tasks

### Completed
- [x] Add python3 fallback to ALL jq calls in `persona_mask.sh` (15+ locations)
- [x] Replace shell interpolation in Python heredocs with `os.environ.get()` pattern
- [x] Fix triple-quote injection by passing content via env vars or base64
- [x] Add platform detection for `stat` in `brief_gate.sh`
- [x] Replace `sed -i.bak` with portable pattern in `persona_mask.sh`

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

---

## Acceptance Criteria

1. [x] `persona_mask.sh` works without jq (python3 fallback for all JSON operations)
2. [x] Plugin scripts safe against crafted plugin names with special characters
3. [x] Hook Python fallbacks safe against content with triple-quotes
4. [x] `brief_gate.sh` works on both macOS and Linux
5. [x] `persona_mask.sh` sed operations work on both platforms

---

## Notes

Audit findings: Standards P0 (jq), Code Quality P1-003, P1-004, P1-005, P2-004.

---

**Created:** 2026-02-20
**Last Updated:** 2026-02-20
**Brief Owner:** Crimson
