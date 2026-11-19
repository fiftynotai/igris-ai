---
obligation: "Phase discipline — no commit while the active brief is in BUILDING or TESTING"
mechanism: gate
status: shipped
lives_in: "scripts/git-hooks/pre-commit"
summary: "Pre-commit phase guard identifies the committing session (IGRIS_INSTANCE_ID, then its owner process, then the one live instance at the worktree root) and blocks the commit when that session's own brief is in BUILDING or TESTING; an unidentified commit is allowed with a one-line notice; one-shot escape via IGRIS_BYPASS_PHASE_GUARD."
---

# Phase guard (PI-004)

The commit-time phase guard identifies the committing session in the brain
`instances` registry (this machine, this project) and blocks `git commit` while
that session's own `current_brief` is in `BUILDING` or `TESTING` (TD-494). It
tries `IGRIS_INSTANCE_ID`, then the instance whose owner process is an ancestor
of the commit, then the one live instance registered at the commit's worktree
root. It never picks the most recently active instance and never reads a
session file, so one session's build phase no longer blocks another session's
commit. An unidentified commit is allowed with a one-line notice; `''`, NULL
and `none` mean no brief. Fail-open escape: `IGRIS_BYPASS_PHASE_GUARD=1`.
