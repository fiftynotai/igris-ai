---
obligation: "Every replication ingress must write through the same normalizers the local write boundary applies"
mechanism: gate
status: shipped
lives_in: "brain-mcp-server/src/tools/sync.ts (mergeRows) + cli/src/lib/brain-db.ts (mergeRows)"
summary: "TD-338 resting contract for replication ingress — a row arriving from a remote brain passes through the write-boundary normalizers before it is stored, in BOTH mergeRows copies. Fold-known / passthrough-unknown / report-both, with the LWW timestamp column deliberately excluded so a fold can never oscillate. The field map is single-sourced in brief-normalize.ts and GENERATED into the CLI mirror. TD-333 added brief_status.status as the fourth mapped column and corrected this doc's undercounted cost for a NEW normalizer id."
---

# Replication ingress is a normalization boundary (TD-338)

A brief's metadata vocabulary is defended at every MCP write boundary:
`igris_brief_create` / `_sync` / `_update` all call `normalizePriority` /
`normalizeBriefType` / `normalizePhase` — and, since TD-333, `normalizeStatus` —
before storing. **Replication did not.**

`mergeRows` — the only row writer for inbound sync, in BOTH packages — copied
every non-`mergeFields` column with `row[col] ?? null`. So a remote brain
running older code could write `P2` into the same column `igris_brief_create`
would have folded to `P2-Medium`, and the local write boundary would never see
it: an inbound row is an LWW **column copy**, not a tool call, so there is no
response to append a NOTE to and no validation to run.

## The resting contract

**Fold known → pass through unknown → REPORT both. Never touch the timestamp.**

1. **Only declared synonyms fold.** `PRIORITY_ALIASES` declares `P1 ≡ P1-High`.
   The fold is the same total function the remote's own write boundary would
   have applied had it been running current code — not a guess.
2. **Unknown values are stored VERBATIM.** `P4-Trivial`, `Spike`, `Bug/Feature`
   pass through untouched. The fold never invents. (This is TD-328's reasoning,
   applied one layer down.)
3. **Every fold and every non-canonical passthrough is NAMED** — in the
   `igris_brain_pull` summary, in the `POST /sync/push` response body (so the
   machine that PUSHED learns its row was folded on arrival), and in the
   `igris boot-sync` JSON digest. Silent when there is nothing to say.
4. **The LWW comparison column is never in the map.** See below — this is the
   property that makes the whole thing safe.

## Why the fold cannot oscillate

The objection to normalizing at ingress is obvious: *two brains rewriting each
other's rows forever.* It does not happen, and the reason is mechanical rather
than a matter of care.

> **No merge path in either package writes a timestamp it did not receive.**

`mergeRows` copies the INBOUND `updated_at` verbatim, and `updated_at` is
deliberately absent from `SYNC_NORMALIZED_FIELDS`. Therefore:

- **The remote does not push the row back.** It serves
  `WHERE updated_at > since`, and our cursor advanced past that value.
- **Our fold does not travel up.** A later push carries EQUAL timestamps, so the
  remote's own `remoteTs > localTs` is false and it skips.
- **The fixed point is reached on the FIRST arrival of each row version**, and
  every normalizer is idempotent, so a genuine remote edit that arrives later is
  folded again to the same value.

This is pinned as a test (`sync-ingress-normalize.test.ts` T3), not left as an
argument.

### The steady state, stated plainly

Local canonical, remote unchanged, both at the same `updated_at`. That is a
**silent content divergence at equal timestamps** — inert for sync, because
nothing compares `brief_status` content across brains. It is the deliberate
price of keeping LWW honest, and it already exists at scale: 339 rows diverge
this way from the v22 `brief_type` fold, measured read-only on 2026-08-03.

### The rejected lever, recorded

Folding **and** bumping `updated_at` WOULD heal an un-migrated remote on the
next push, and still would not oscillate (older remote code never re-writes a
row spontaneously). It is rejected because it manufactures a write no operator
made and mutates a column the dashboard, `briefStatusSummary` and velocity
ordering all read. Pull this lever only on an explicit operator decision to make
sync heal remotes.

## The two doors — both must be closed

| Door | Where | Reached from |
|---|---|---|
| Brain | `brain-mcp-server/src/tools/sync.ts` `mergeRows` | `handleBrainPull` (we pull a remote) AND `processSyncPush`, the body of `POST /sync/push` (a remote pushes to us) |
| CLI | `cli/src/lib/brain-db.ts` `mergeRows` | `mergePulledTables` — the awaken / `igris boot-sync` VPS→local pull |

> **The CLI door is the one that runs on a workstation.** A brain-only fix
> closes the door nobody walks through. Both copies get the same tests.

`igris import` (FR-230, `cli/src/lib/brain-db.ts`) is a **deliberate
non-consumer**: folding at the import writer would make the stored row differ
from the bundle's `rowContentHash`, so a later re-import would classify the row
as "modified locally" against its own ancestor — a spurious conflict in the
import ledger. That interaction deserves its own decision and is recorded here
as an exclusion, not an omission.

`sessions.phase` is likewise deliberately absent: `sessions` is an
append-strategy table (insert-only, no LWW update) with no observed drift, and
`MAINTAINING.md` scopes the phase vocabulary contract to `brief_status`.

**The `igris import` exclusion now also applies to `status` (TD-333)**, and it
matters more there than for the other three: `status` is the canonical
build-state source, so an imported bundle can reintroduce a spelling that the
release gate, the phase guard and the reconciler each read. The belt for that is
the reconciler's RETAINED SYNONYMS (`completed|complete` stay in its terminal
arm after schema v25 empties them) and the vocabulary validator's cross-project
scan — not a fold at the import writer.

## Adding a normalized field

The field map is the SINGLE extension point:

```
brief-normalize.ts:
  SYNC_NORMALIZED_FIELDS = {
    brief_status: { brief_type: 'brief_type',
                    priority:   'priority',
                    phase:      'phase',
                    status:     'status' },   // TD-333
  }
```

**If the field REUSES an existing normalizer id** (`brief_type` / `phase` /
`priority` / `status`):

1. Add the entry.
2. Regenerate: `npm run gen:brief-normalize-mirror` (in `brain-mcp-server/`).
3. Re-run both `mergeRows` test suites.

That really is the whole cost. **A NEW normalizer id is a different shape, and
this doc used to undercount it.**

### A NEW normalizer id — the MEASURED cost (corrected by TD-333)

Three of these are in `brief-normalize.ts`:

4. its `normalizeX` / `isCanonicalX` pair;
5. its `SYNC_NORMALIZERS` row;
6. its canonical set and/or fold table, exported.

**And six are in `brief-normalize-mirror.ts`** — this is the half the old step
list omitted. The mirror's `SyncNormalizerId` union, its dispatch table and its
emission order ARE derived from the map and do move on their own. **Its DATA
layer is not:** `renderCliModule` hand-lists every canonical set and every fold
map by name, and a function body that references a table the renderer never
emitted produces a mirror that does not compile.

7. the body in `NORMALIZER_BODIES`;
8. the imports of the canonical set / fold map / normalizer / predicate;
9. a `renderStringArray` call for the canonical set, a `renderRecord` call for
   the fold map, and any derived lookup const the body reads
   (`STATUS_CANONICAL`, the twin of `BRIEF_TYPE_CANONICAL`);
10. one more `out.push` in `buildFixtures()`;
11. one more `out.push` in `buildPredicateFixtures()`;
12. seeds in `fixtureInputs()` plus cases in `FIXTURE_EDGE_CASES` and
    `FIXTURE_ROWS` — otherwise the new id gets a corpus made entirely of the
    OTHER fields' edge cases, every row a vacuous passthrough.

What a new id still does NOT touch: either `mergeRows` copy, the generator
script, the reporting shape, or the derived union and dispatch.

> **The generator guard covers step 7 only.** `assertNormalizerBodies` throws at
> generation time when a mapped id has no authored body, naming exactly what to
> add — TD-333 hit it on purpose and it worked. Steps 8-12 surface later and
> less kindly: 8-9 as a CLI typecheck error, 10-12 as a fixture corpus that
> replays green while proving nothing.
>
> *Provenance, recorded because both halves of the contradiction are still
> tempting to write: an early draft said "one line" two paragraphs after
> correctly hedging "and, if it is a new normalizer, its `SYNC_NORMALIZERS`
> pair". The hedge was then made true for the LOGIC layer by deriving the union
> and the dispatch — and the claim quietly generalised to the DATA layer, where
> it was never true. TD-333 paid the difference and corrected it here.*

**Never hand-copy the vocabulary into the CLI.** `cli/src/lib/brief-normalize.generated.ts`
is written by `brain-mcp-server/scripts/gen-brief-normalize-mirror.ts` and
byte-locked by a parity test. Hand-copying would make a FOURTH copy of this
vocabulary (after the TS source, the bash validators and the FR-247 dashboard
picker) in a place no pin test can check — the TD-330 defect class.

The guard has two halves, because **a byte-parity test alone cannot see a change
to the normalizer LOGIC** — the function bodies are authored in the builder's
template, not derived from the source, so a brain-side edit to one regenerates a
byte-identical artifact. The generator therefore runs the BRAIN's real code over
a corpus at generation time and bakes the results into the artifact, and the
CLI-side test replays them:

| Table | Covers |
|---|---|
| `NORMALIZE_FIXTURES` | every leaf normalizer (one row per id per input; the id set is DERIVED, so the count moves with the map) |
| `PREDICATE_FIXTURES` | every `isCanonical*` predicate (they decide what gets REPORTED) |
| `SYNC_ROW_FIXTURES` | `normalizeSyncRow` — the function both `mergeRows` copies actually call |

> **The replay DISPATCH is not derived, and that is a live hazard.** Both the
> CLI-side replay and the brain-side fixture-provenance check resolve
> `f.normalizer` to a function. Until TD-333 both did it with a hand-written
> chain whose final `else` was `phase`/`normalizePhase` — so the 99 new `status`
> fixtures would have been replayed through the PHASE normalizer, some agreeing
> by accident. Both are now maps with an explicit completeness assertion against
> `normalizerIdsInUse(SYNC_NORMALIZED_FIELDS)`. **Do not reintroduce a fallback
> arm.**

Together these cover **every authored function in the emitted module**, so logic
drift fails on the CLI side with zero cross-imports. `SYNC_ROW_FIXTURES` carries
a row whose `updated_at` is a foldable-looking string, so a fold that ever
reached the LWW comparison column diverges immediately.

*(The first three of these shipped with only the leaf-normalizer table, while
this doc claimed full coverage. A fold-plus-bump mutation to `normalizeSyncRow`
passed `--check` AND all 16 CLI tests. If you add a fourth authored function to
the builder, add its fixture table in the same commit — the claim above is only
true as long as that holds.)*

## The observers

| Surface | Catches | Where | Posture |
|---|---|---|---|
| Ingress report | A value REWRITTEN or PASSED THROUGH on arrival | pull summary, `/sync/push` response, `boot-sync` digest | Informs; silent when clean |
| `brief_type` validator | Accumulation across the whole corpus | `scripts/validate_brief_type_vocabulary.sh` | WARN only |
| `priority` validator | Accumulation across the whole corpus | `scripts/validate_brief_priority_vocabulary.sh` | WARN only |
| `status` validator (TD-333) | Accumulation across the whole corpus, SPLIT into a documented-gap class and a stray class | `scripts/validate_brief_status_vocabulary.sh` | WARN only |

## What TD-338 did NOT do — the corrected provenance

The brief was filed on the observation that 8 non-canonical `priority` rows
carry `updated_at` values AFTER schema v18 folded the corpus, and inferred that
sync must have re-polluted them. **Read-only forensics refuted that inference**
(recorded here so nobody re-derives the wrong story from the same evidence):

- `sync_state`'s pull cursor for the old remote last advanced more than twelve hours BEFORE
  the earliest dirty row's `updated_at`, and a pull only advances that cursor
  when it delivers rows for the table. No pull delivered them.
- `sync_queue` records a PUSH of one of those rows ten minutes after its own
  `updated_at`. The local row was already dirty, and we EXPORTED it.
- The VPS today holds the CANONICAL spelling for five of them (it folded its own
  copies when it booted a build carrying v18) while we still held the bare form.

So the rows were **born locally** through a writer that did not normalize, and
travelled OUT. That does not weaken this obligation — the ingress gap is a
CODE FACT read directly from both `mergeRows` copies, independent of how these
particular rows arrived — but it changes what the fix is: a **prevention**, not
a cure. The cure for those rows is the v24 data migration. The prevention
matters because the remote is un-migrated and can still deliver a non-canonical
value on any row it legitimately touches, and because cursor resets demonstrably
happen (the 2026-06-24 URL cutover created a fresh cursor and ran a full
re-pull).
