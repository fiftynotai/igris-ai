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

## The status vocabulary (TD-333)

The six values in the table above are **the canonical status set**, and TD-333
did **not** widen them. They are mirrored in exactly three places, which move
together:

| Copy | Where |
|---|---|
| TypeScript (the SINGLE SOURCE) | `CANONICAL_STATUSES` in `brain-mcp-server/src/tools/brief-normalize.ts` |
| bash | `CANONICAL_STATUSES` in `scripts/validate_brief_status_vocabulary.sh` |
| dashboard display | `KNOWN_BRIEF_STATUSES` in `cli/dashboard/src/layers/board.ts` |

Before TD-333 `status` was the only one of the four brief metadata fields with
**no normalizer and no observer**, which is how the live corpus reached
**fifteen distinct values for six documented states** (measured read-only,
all projects, 2026-08-04): three spellings of *finished* (`Done` 1212,
`Completed` 24, `Complete` 1), two of *in flight* (`In Progress` 26,
`InProgress` 4), a status with a commit sha welded onto it, and two whole
sentences recording a brief's split lineage.

### The defining rule

> A live value is a **SPELLING** if it is a morphological variant of a
> documented member AND the documented set has no separate slot for what it
> means. A live value is a **MISSING STATE** if it names an outcome the
> documented set has no member for at all.

Spellings fold. Missing states do not — they are reported until a human
decides. This is what makes the fold table mechanical rather than a taste
argument, and it is the same shape TD-328 used for `brief_type` (whose anchor
was the `/register` prefix map).

### What folds (schema v25), and why it is not a state edit

| From | To | Rows | Argument |
|---|---|---|---|
| `Completed` | `Done` | 24 | Past participle of the same verb. `brain-mcp-server/src/tools/projects.ts` already counts `status IN ('Done','Completed','Closed')` as ONE terminal bucket — evidence from the code, not from taste. |
| `Complete` | `Done` | 1 | Adjectival form of the same word; no consumer names it anywhere in the tree. |
| `InProgress` | `In Progress` | 4 | A whitespace difference. `board.ts` already normalises the pair to one sort key and its test pins `statusRank('InProgress') === statusRank('In Progress')`. |

**TD-311 says a brief-state contradiction must never be resolved by editing
brief data, and `status` IS brief state.** The fold survives that rule because
a brief's STATE is what the operator recorded and a predicate's VERDICT is what
a consumer computes. The operator who typed `Completed` recorded *"this work is
finished"*; `Done` is the documented member that means *"this work is
finished"*. **No brief ends up in a state the operator did not record.** The
invariant a reviewer can check in one pass: every fold target's documented
meaning is IDENTICAL to its source's, not merely ADJACENT. Adjacency is a state
edit.

### What does NOT fold — every absence is a decision

- **`Cancelled` (23) / `Superseded` (18) / `Deferred` (7) — MISSING STATES.**
  Each names an outcome the six cannot express. `Cancelled` → `Archived` would
  move *"we decided not to do this"* to *"we finished it and shelved it"*;
  `Superseded` → `Done` would claim work happened that another brief carries;
  `Deferred` → `Blocked` confuses postponed with externally prevented. Promoting
  them changes the lifecycle declared here and sweeps `board.ts`, the bash
  validator and the reconciler's terminal-set reasoning — that is *changing the
  state machine*, and it belongs to a follow-up brief. Until then they are a
  standing, deliberate WARN in the vocabulary validator's **DOCUMENTED GAP**
  class.
- **`Done(Resolvedbydec8d1f)` (1) — a WELDED PAYLOAD.** The trailing token is a
  commit sha with no other copy, so a mechanical fold would destroy operator
  data. Its correct home is the brief's own content as a `## Resolution` line:
  the sha is closing-commit evidence, which is exactly what C2 checks. Migrated
  by hand, payload first, then retyped.
- **The two `Split (see FR-...)` rows — SENTENCES.** A parent brief's split
  lineage crammed into the state field. `Done`, `Archived` and `Superseded` are
  all defensible readings and the operator chose none of them, so picking one
  would be the planner deciding a brief's state. The lineage belongs in the edge
  graph as `derived_from` edges (additive, destroys nothing); the status is left
  byte-for-byte alone.
- **The empty string.** `brief_status.status` is `TEXT NOT NULL` and has no
  unset member, so there is nothing to fold it to. `normalizeStatus` passes it
  through for the same reason — folding it to NULL would turn a meaningless
  write into a hard reject at the write boundary and a silently dropped row at
  sync ingress.

### The C1/C2 rise this caused, pre-declared

`scripts/validate_brief_state_reconciliation.sh` matched three literal
spellings and let everything else fall to a default arm commented *"other
in-flight states"* — which was **false for 26 terminal rows**. Those rows were
exempt from the invariant above for their entire lifetime. TD-333 widened the
arm (notation fold + the retained `completed`/`complete` synonyms), so:

- **C1 rises** by the count of newly-uniform terminal rows whose phase is not
  `COMPLETE` — measured before the fold as **24** (23 in `lifeOS`, 1 in
  `fifty-agent-sdk`).
- **C2 rises** by however many of those have no closing commit in their repo
  (git-dependent; measured per repo, not predicted).
- **C3 must not move at all.** No fold source or target touches `Ready` or
  `Draft`. If C3 moves, something folded that must not have — it is the cheapest
  tripwire this change has.

#### CONFIRMED after the fold, 2026-08-04

A prediction that is never checked is not a measurement. Measured read-only
against the live brain and the migration's own verified snapshot
(`~/.igris/memory/knowledge.db.pre-v25.bak`):

| quantity | predicted | observed |
|---|---|---|
| C1 under the WIDENED arm, pre-fold | — | **77** |
| C1 under the WIDENED arm, post-fold | unchanged | **77** ✓ |
| C1 under the NARROW (pre-TD-333) arm, pre-fold | — | **53** |
| the rise the widening exposes | +24 | **77 − 53 = +24** ✓ |
| newly visible, by project | `lifeOS` 23, `fifty-agent-sdk` 1 | **`lifeOS` 23 (`Completed`), `fifty-agent-sdk` 1 (`Complete`)** ✓ |
| C3 (`Ready`+`Draft`) | must not move | **254 → 254** ✓ |

**The widened-arm count is identical either side of the fold.** That is the
whole TD-311 argument as a number: the auditor's reach changed, the data's
meaning did not. Every one of the 24 was already terminal-by-meaning and
already failing the invariant — the spelling was hiding it, and nothing about
those briefs' state was edited to make them visible.

**That rise is the exemption closing, not a regression.** Every contradiction it
surfaces was already true; only the auditor's ability to see it changed. The
rows are handed to a human, which is what TD-311 demands.

### The observers

| Surface | Catches | Posture |
|---|---|---|
| Write-boundary echo (`brain-mcp-server/src/tools/briefs.ts`) | the MINTING of a new spelling, in whichever harness is running | informs, never rejects |
| Sync-ingress report (pull summary / `/sync/push` body / `boot-sync` digest) | a value folded or passed through on ARRIVAL | informs, silent when clean |
| `scripts/validate_brief_status_vocabulary.sh` | ACCUMULATION across the whole corpus, cross-project | WARN only |

The vocabulary validator is **cross-project by default**, and that is
load-bearing rather than a convenience: the reconciliation validator below is
repo-scoped and structurally cannot see a project whose repo is not on this
machine — which is exactly where 25 of the 29 folded rows lived.

### Closing-commit detection

A commit "closes" a brief when its message references the brief id — via the
`closes #<ID>` footer convention (`core/os/standards.md`) OR a bare
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

TD-333 extended that write boundary to the fourth field, `status`, and added the
matching read-side vocabulary validator plus the widened terminal arm in the
reconciler. It changed **no column, no DDL and no CHECK constraint**, and it did
not widen the documented six.

## The disk projection (TD-414)

Three copies of a brief exist, and only one is the record:

| Copy | What it is | Who writes it |
|---|---|---|
| `brief_status` row | build-state METADATA (status, phase, priority, …) | `igris_brief_sync` and its siblings |
| `brief_files.content` | the RECORD — the markdown the AC gate and the commit-msg gate read | `igris_brief_create`, `igris_brief_update`, `igris_brief_file_sync` |
| `~/.igris/projects/{project}/briefs/{ID}.md` | a PROJECTION of `brief_files.content`, written by the cache component on `brief.created` / `brief.synced` | ONE guarded writer (`brain-mcp-server/src/engine/components/cache/handlers.ts`) |

`igris_brief_sync` writes `brief_status` only; the disk write it appears to
cause is the projection listener re-materialising `brief_files.content`.
Before TD-414 that write was unconditional, so a status sync destroyed every
local edit (BR-095 measured 8 ticked criteria → 0, 12324 → 7872 bytes) an
instant after `acGateNote` had ruled FAIL on the stale brain copy.

Since TD-414 the projection is guarded by one classifier (`diskEditState`):
identical content is not rewritten; a local file that is newer than
`brief_files.updated_at` and differs is KEPT and the refusal is logged; only an
absent or older disk copy is overwritten. `igris_cache_rebuild` uses the same
writer and takes the only override, `force`. `acGateNote` consults the same
classifier and DECLINES to rule (`not ruling on acceptance criteria`) when the
local file is newer — it does not reconcile from disk, because the record is
the brain and a verdict on content the brain does not hold is the TD-311 class.

The consumption rule that follows: **an edit made on disk must be pushed with
`igris_brief_update` (`project`, `brief_id`, `content`) before any sync**, or
the gates cannot see it. `core/skills/hunt/SKILL.md` states this at Phase 7
step 5 and under Agent Log Format. Session files are out of this scope
(pinned by the projection-guard test's T8).

## See also

- `scripts/validate_brief_state_reconciliation.sh` — the validator.
- `core/enforcement/brief-state-reconciliation.md` — the FR-199 obligation def.
- `MAINTAINING.md` — the `brief_status.status` (canonical build-state) contract
  row + the `brief_status.phase / .status / .claimed_by` consumer row.
- `core/skills/hunt/SKILL.md` Phase 8 — the producer fix (terminal-COMPLETE
  sync).
