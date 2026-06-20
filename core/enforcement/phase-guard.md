---
obligation: "Phase discipline — no commit while the active brief is in BUILDING or TESTING"
mechanism: gate
status: shipped
lives_in: "scripts/git-hooks/pre-commit"
summary: "Pre-commit phase guard discovers the active brief and blocks the commit when phase IN (BUILDING, TESTING); one-shot escape via IGRIS_BYPASS_PHASE_GUARD."
---

# Phase guard (PI-004)

The commit-time phase guard reads the active brief from the `instances` registry
(per-instance session file → legacy fallback) and blocks `git commit` while the
brief's phase is `BUILDING` or `TESTING` — the orchestrator advances to
`COMMITTING` before committing. Fail-open escape: `IGRIS_BYPASS_PHASE_GUARD=1`.
