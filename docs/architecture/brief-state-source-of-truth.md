# Brief / Build-State — Source of Truth

**Owner brief:** TD-257
**Status:** shipped (read-side)

## The problem

"Is this brief built?" has at least five places you could look for an answer,
and they drift apart:

| Source | What it actually tells you | Authority |
|---|---|---|
| `brief_status.status` (brain DB) | The recorded lifecycle state (`Draft` / `Ready` / `In Progress` / `Blocked` / `Done` / `Archived`) | **AUTHORITATIVE — the canonical answer** |
| `brief_status.phase` (brain DB) | The hunt state-machine phase (`INIT`…`COMPLETE`, `BLOCKED`) | Supporting — MUST agree with `status` |
| `git log` (a closing commit) | Whether the work physically landed | Physical ground truth — MUST agree |
| Plan docs (`~/.igris/projects/{project}/plans/*.md`) | What was INTENDED to be built | **Intent, NOT state** |
| Brief content / goal | The objective the brief set out to achieve | Goal, NOT state |

The recurring failure (#811) is treating a **plan doc** as build-state. A plan
describes pre-build intent; it reads as "unbuilt" forever, even after the work
ships. An audit that infers build-state from plan docs will perpetually report
completed work as missing.

## The declaration

**`brief_status.status` (in the brain DB) is the canonical source of truth for
brief / build-state.** Every consumer reads it — via `igris_brief_dashboard`,
`igris_brief_list`, or a direct `brief_status` query — and NEVER infers
build-state from plan docs or brief content.

Scope: this governs only the SOURCE OF TRUTH for build-state. It does NOT
discourage reading plan docs — plans remain a valid input for design, intent,
approach, and rationale; read them freely for their content. The rule forbids
only inferring *whether* a brief is built from a plan (since a plan describes
pre-build intent).

`phase` is a supporting field and `git log` is physical ground truth; both must
agree with `status`. When they disagree, that is a contradiction the
reconciliation validator surfaces (see below) — and `status` is what the
consumers trust.

## The validity invariant

```
status IN ('Done','Archived')  ⇔  phase = 'COMPLETE'  ⇔  a closing commit
referencing the brief exists in git log.
```

A brief is "done" only when all three agree. The terminal phase is `COMPLETE`
(the last phase in the hunt state machine `INIT → PLANNING → APPROVAL →
BUILDING → TESTING → REVIEWING → DOCUMENTING → COMMITTING → COMPLETE`, plus
`BLOCKED`). The canonical phase enum is defined once, for *reading*, as the
shared bash constant `CANONICAL_PHASES` in
`scripts/validate_brief_state_reconciliation.sh` — TD-238 sources it for
*write-time* validation at the `igris_brief_sync` boundary.

In-flight briefs satisfy the invariant **vacuously** and are not contradictions:
a brief mid-hunt is correctly `In Progress` / `phase='BUILDING'` with no commit
yet, and a `Ready` brief with no commit is simply unbuilt. The invariant only
fires for terminal states.

## The three contradiction classes

The reconciliation validator
(`scripts/validate_brief_state_reconciliation.sh`) reads `brief_status` from the
brain DB and cross-checks `git log`, flagging:

- **C1 Done-but-not-COMPLETE** — `status='Done'`/`'Archived'` AND
  `phase != 'COMPLETE'`. This is the bug the FR-195/196/197/200 rows exhibited:
  they were `Done` but stuck at `phase='COMMITTING'`. Root cause: the hunt skill
  Phase 8 (COMPLETE) flipped the brief to `phase=COMPLETE` locally but never
  called `igris_brief_sync`, so the terminal flip never reached the brain DB.
  TD-257 fixes that producer (an explicit `igris_brief_sync` with
  `phase="COMPLETE"` in Phase 8).
- **C2 Done-but-no-commit** — `status='Done'`/`'Archived'` AND no commit in
  `git log` references the brief id. Either the brief is not actually done, or
  the closing commit was never made / never referenced the brief.
- **C3 committed-but-open** — a closing commit exists AND
  `status IN ('Ready','Draft')`. The #811 inverse: committed work the store
  still calls unbuilt.

### Closing-commit detection

A commit "closes" a brief when its message references the brief id — via the
`closes #<ID>` footer convention (`core/rules/00-igris-universal.md`) OR a bare
`<ID>` token anywhere in the subject or body. `git log --grep` searches the
whole message, so both conventions are matched. A missed match produces a noisy
C2 line, not a blocked commit (the gate is WARN), so the false-positive cost is
bounded.

## Enforcement — read-side, WARN posture

The reconciliation validator is wired into `scripts/git-hooks/pre-commit` and
registered in the FR-199 enforcement registry
(`core/enforcement/brief-state-reconciliation.md`). It is a **read-only**
check — it never writes to the brain, never mutates a brief, and never reads
plan docs.

It ships as **WARN, not hard-fail**: the pre-commit block prints the report and
does not veto the commit. This matches `check_contract_consumers.sh` — a
brain-DB lag (the same lag the phase guard fail-opens on) or an un-synced
`COMPLETE` flip must not block a legitimate commit. The validator returns
non-zero internally so the bats trio can assert detection; the hook downgrades
it. Flipping to hard-fail once the data is proven clean is a one-line change in
the hook.

The validator fails open (exit 0, silent) when `sqlite3` is absent, the brain
DB is missing, or there are no rows — so it never breaks commits in projects
that don't use the hunt workflow.

## The consumption rule (#811)

Audits, the seeker, and the audit/scan skills MUST read the canonical
`brief_status.status`, NEVER infer build-state from plan docs. This rule is
encoded into:

- `core/agents/seeker.md` (CONSTRAINTS) — build-state/gap audits verify against
  git log + on-disk artifacts + `brief_status.status`.
- `core/agents/warden.md` (AUDIT MODE) — the ARCHITECTURE_REVIEW / gap-review
  path.
- `core/skills/audit/SKILL.md` (Constraints) — build-state findings consult the
  canonical status.
- `core/skills/scan/SKILL.md` (§2 Scan Briefs) — build-state is read from
  `igris_brief_dashboard` / `brief_status`.
- `coding_guidelines.md` (§13 + §17 checklist) — the consumption-discipline
  surface.

## Boundary with TD-238

TD-257 is **read-side only**: it declares the canonical source, ships the
read-only reconciliation validator, and encodes the consumption rule. It adds
NO write-time validation to `briefs.ts` and NO `db.ts` schema/migration change.
TD-238 owns the WRITE-BOUNDARY — validating/normalizing `phase`/`brief_type`/
`priority` at `igris_brief_sync` write time, plus the one-time normalization
migration of existing rows. The shared phase enum lives in the TD-257 validator
for TD-238 to source.

## See also

- `scripts/validate_brief_state_reconciliation.sh` — the validator.
- `core/enforcement/brief-state-reconciliation.md` — the FR-199 obligation def.
- `MAINTAINING.md` — the `brief_status.status` (canonical build-state) contract
  row + the `brief_status.phase / .status / .claimed_by` consumer row.
- `core/skills/hunt/SKILL.md` Phase 8 — the producer fix (terminal-COMPLETE
  sync).
