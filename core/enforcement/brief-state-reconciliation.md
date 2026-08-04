---
obligation: "Build-state must be consistent across the canonical status, the phase field, and git"
mechanism: gate
status: shipped
lives_in: "scripts/validate_brief_state_reconciliation.sh"
summary: "Pre-commit reconciliation validator flags status<->phase<->git contradictions against the canonical brief_status.status source — C1 (Done-but-not-COMPLETE), C2 (Done-but-no-commit), C3 (committed-but-open) — and surfaces them as WARN (does not block); plan docs are intent, never build-state. TD-333 adds the status VOCABULARY observer beside it and widens the terminal arm, which closes a spelling-based exemption that had hidden 26 terminal rows."
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

## What counts as terminal, and the exemption TD-333 closed

Until TD-333 the validator's `case` matched three bare literals — `Done`,
`Archived`, `Ready|Draft` — and **everything else fell to a silent default arm
commented "other in-flight states."** That comment was false for 26 rows:
`Completed` (24), `Complete` (1) and `Done(Resolvedbydec8d1f)` (1) are terminal
by meaning, and they had therefore been **exempt from the invariant above for
their entire lifetime** purely because of how they were spelled.

The arm now folds **notation** first — case, space, hyphen, underscore, the same
fold TD-340 applied in portable SQL at the five gate sites — and names the two
retained **vocabulary** synonyms:

```
done|archived|completed|complete)   # C1 + C2
ready|draft)                        # C3
*)                                  # genuinely vacuous
```

**The synonyms stay after schema v25 empties them.** TD-289's rule, applied to
`status`: a fold only folds what the fold table DECLARES, and the column is
still reachable by writers outside it — `igris import` (FR-230) is a deliberate
non-consumer of the sync-ingress fold, and the write boundary never
hard-rejects. Deleting `completed|complete` would silently re-open the
exemption. **Do not "clean up" that list.**

**The C3 arm was NOT widened**, and that is a decision: adding a third state
(say `Deferred`) changes what C3 MEANS, which is a lifecycle question rather
than a normalisation one. C3's count must be identical before and after the v25
fold — it is the cheapest tripwire the change has.

### Expect the counts to RISE, and read that correctly

The first run against a corpus still holding those spellings surfaces
contradictions that were **already true**. Pre-declared before v25 ran: C1 +24
(23 `lifeOS`, 1 `fifty-agent-sdk`), C2 git-dependent per repo, C3 unchanged.
TD-333 resolves **zero** contradictions — it removes a spelling-based exemption
that was hiding them, and hands the rows to a human. That is the opposite of
TD-311's forbidden move (resolving brief-state contradictions by editing brief
data), not an instance of it.

## The status VOCABULARY observer (TD-333)

`scripts/validate_brief_status_vocabulary.sh` is the accumulation observer this
obligation gained rather than a fourth enforcement doc. It reports the
`brief_status.status` distribution and **splits** non-canonical values into two
classes, so a permanent expected WARN cannot train the reader to ignore a real
one:

| Class | Values | Why it is there |
|---|---|---|
| **DOCUMENTED GAP** | `Cancelled` / `Superseded` / `Deferred` | MISSING STATES, non-canonical by decision — folding one would be a STATE EDIT, promoting them changes the lifecycle. Carries its follow-up in the report text. |
| **STRAY** | everything else | A new spelling, an empty status, or an operator note in the state field. Wants a human now. |

It is **cross-project by default**, and that is load-bearing: this reconciler is
repo-scoped and structurally cannot see a project whose repo is not on the
machine — which is where 25 of the 29 rows v25 folded actually lived. WARN only,
fail-open on a missing `sqlite3`/DB, wired into `scripts/git-hooks/pre-commit`.

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
