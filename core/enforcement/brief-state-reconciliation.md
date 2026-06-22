---
obligation: "Build-state must be consistent across the canonical status, the phase field, and git"
mechanism: gate
status: shipped
lives_in: "scripts/validate_brief_state_reconciliation.sh"
summary: "Pre-commit reconciliation validator flags status<->phase<->git contradictions against the canonical brief_status.status source — C1 (Done-but-not-COMPLETE), C2 (Done-but-no-commit), C3 (committed-but-open) — and surfaces them as WARN (does not block); plan docs are intent, never build-state."
---

# Brief-state reconciliation (TD-257)

`brief_status.status` (the brain DB) is the **canonical source of truth** for
brief/build-state. The validity invariant is:

```
status IN ('Done','Archived')  <=>  phase = 'COMPLETE'  <=>  a closing commit
referencing the brief exists in git log.
```

The reconciliation validator reads `brief_status.status`/`phase` from the brain
DB and cross-checks `git log` for closing commits, flagging three contradiction
classes:

- **C1 Done-but-not-COMPLETE** — `status='Done'`/`'Archived'` AND
  `phase != 'COMPLETE'` (the terminal-COMPLETE-flip drop the producer fix
  addresses in `core/skills/hunt/SKILL.md` Phase 8).
- **C2 Done-but-no-commit** — `status='Done'`/`'Archived'` AND no commit in
  `git log` references the brief id.
- **C3 committed-but-open** — a closing commit exists AND
  `status IN ('Ready','Draft')` (the #811 inverse — committed work the store
  still calls unbuilt).

In-flight briefs (`In Progress` / `Blocked`, or a `Ready` brief with no commit
yet) satisfy the invariant vacuously and are NOT flagged — the invariant only
fires for terminal states.

## Posture: WARN, not hard-fail

The validator returns non-zero internally so the bats trio can assert detection,
but the pre-commit block **downgrades the verdict to WARN**: it prints the
report and does not veto the commit. This matches `check_contract_consumers.sh`
— a brain-DB lag or an un-synced COMPLETE flip must not block a legitimate
commit. Flipping to hard-fail later is a one-line change in the hook once the
data is proven clean.

## Consumption rule (#811)

Audits, the seeker, and the audit/scan skills MUST read this canonical status,
NEVER infer build-state from plan docs. Plan docs describe pre-build intent and
read as "unbuilt" forever; treating them as state is the #811 failure. See
`docs/architecture/brief-state-source-of-truth.md`.
