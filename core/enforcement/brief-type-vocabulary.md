---
obligation: "brief_type must come from the canonical vocabulary, and any value that does not must be reported rather than accumulate silently"
mechanism: gate
status: shipped
lives_in: "scripts/validate_brief_type_vocabulary.sh"
summary: "TD-328 resting contract for brief_status.brief_type — fold-known / passthrough-unknown / REPORT-unknown. The write boundary normalizes known spellings and never hard-rejects; two observers surface anything unfolded (the MCP tool-response echo at mint time, and a pre-commit WARN validator for accumulation). The canonical set is the image of the /register prefix map union {Documentation}, plus Refactor as a measured exception."
---

# brief_type canonical vocabulary (TD-328)

`brief_status.brief_type` was free text. It reached **50 distinct non-NULL
values plus NULL for ~10 concepts** — `Technical Debt` / `Debt` / `TD` /
`TechDebt` / `TechnicalDebt` / `tech_debt` / `Tech-Debt` / `Tech Debt` / `debt`
all naming the same thing, `Feature` / `Feature Request` / `FR` /
`FeatureRequest` splitting one class across four buckets, and ~16 compound
values (`Bug Fix / Compliance`, `Feature / UI Enhancement`) cramming a second
fact into a single-value field.

## The resting contract

**Fold known → pass through unknown → REPORT unknown.**

1. **The write boundary NORMALIZES; it never hard-rejects.** A reject would
   break a legacy caller mid-transition, and a rejected `igris_brief_create` in
   a harness that cannot retry is *lost operator work*. Inbound remote-sync rows
   have no rejection path at all (they are an LWW column copy, not a tool call).
2. **Unknown values are stored as-is.** Nothing is dropped.
3. **Unknown values are REPORTED.** This is the half that was missing, and it is
   the whole point of the brief.

### Why (3) is not optional

The pre-TD-328 code comment said "reads stay tolerant; writes get cleaner over
time" (memory #228, insert-narrow / read-widen). The live data falsified it.
Writes did **not** get cleaner; they produced 50 spellings, because **tolerance
without observation has no gradient**.

> **Read-widen is a TOLERANCE policy, not a SILENCE policy. A widened read
> requires a reporting surface, or the widening is permanent.**

That is TD-328's correction to #228. The no-hard-reject half of #228 survives
unchanged.

## The canonical set — and how it is derived

> `CANONICAL_BRIEF_TYPES` = **the image of the `/register` brief-ID prefix map**
> (`core/skills/register/SKILL.md` §2) **∪ {`Documentation`}**.

| Prefix | Canonical type |
|---|---|
| `BR` | `Bug` **or** `Feature` — ambiguous by design |
| `FR` | `Feature` |
| `MG` | `Migration` |
| `TD` | `Technical Debt` |
| `TS` | `Testing` |
| `PI` | `Process Improvement` |
| `DU` | `Dependency Update` |
| `PF` | `Performance` |
| `AC` | `Architecture` |
| (none) | `Documentation` |

**The decision rule this gives you: a value with a mint prefix is a TYPE; a
value without one is a SPELLING.** That is what makes the fold table mechanical
rather than a taste argument.

It also removes the ORIGINAL CAUSE. `/register` minted `DU-` and `AC-` briefs
while neither `Dependency Update` nor `Architecture` was canonical — so those
briefs had **no legal type to write**, and the operator invented one. Free text
plus a canonical set that does not cover the mint surface is exactly how you get
50 spellings.

**`Acceptance` is retained with 0 live rows.** Removing it would be a narrowing,
which is the dangerous direction.

### The `Refactor` exception — DO NOT "correct" it

**`Refactor` is canonical WITHOUT a mint prefix.** It was promoted on
**measured evidence**, not on the prefix rule:

- 46 live `Refactor`/`Refactoring` rows; only **19 (41%) carry a `TD-` prefix**.
  25 are `BR-`, 2 are `UI-`.
- The plan's stated flip criterion was "<70% `TD-` ⇒ the value carries real
  information the prefix does not ⇒ promote instead of fold". 41% triggers it.
- The `BR-` titles confirm it independently: *Extract fifty_connectivity
  Package*, *Restructure fifty_arch as Template*, *Migrate Tactical Grid to
  fifty_map_engine* — genuine refactor work minted under `BR-` **only because no
  refactor prefix exists**.

**The operator DECLINED adding an `RF-` mint prefix.** So the canonical set is
deliberately **no longer exactly the image of the prefix map**. This is a
recorded exception, not an oversight.

> Do not apply the prefix rule mechanically and remove `Refactor`. A future
> `RF-` prefix in `/register` would remove the exception; that is not in scope
> for TD-328.

## The three observers

| Surface | Catches | Where | Posture |
|---|---|---|---|
| **Write-boundary echo** | **Minting** — a 51st spelling at the instant it is created, in whichever harness is running | `brain-mcp-server/src/tools/briefs.ts` (`igris_brief_create` / `_sync` / `_update` append a NOTE to the response) | Informs; never rejects, never rewrites |
| **Repo validator** | **Accumulation** — a value that arrived via remote sync or an older client, where nobody saw the echo | `scripts/validate_brief_type_vocabulary.sh`, wired into `scripts/git-hooks/pre-commit` | **WARN only** — prints the report, does not block |
| **Ingress report (TD-338)** | **Arrival** — a value REWRITTEN or PASSED THROUGH at replication ingress, named at the moment it lands | `mergeRows` in both packages; surfaced in the `igris_brain_pull` summary, the `POST /sync/push` response body, and the `igris boot-sync` digest | Informs; silent when clean |

The third observer closes the gap the first two structurally could not see. The
write-boundary echo needs a tool RESPONSE to append a NOTE to, and an inbound
sync row is an LWW **column copy** — there is no tool call and no response. The
repo validator sees the aftermath but not the event, so it can tell you a
spelling exists and never which sync brought it. See
`core/enforcement/sync-ingress-normalization.md`.

The validators are WARN, not hard-fail, for the same reason the write boundary
does not reject: a blocking gate here would re-introduce the hard-reject posture
the brief rejected. Flipping to hard-fail once the data is proven clean is a
one-line change in the hook.

## The "apply v22 on the VPS too" instruction (TD-338 AC-5)

The v22 comment and this doc both instruct: *apply the migration on the VPS
brain too.* TD-338 asked whether the ingress fold retires that instruction. It
does not — it **demotes** it, and the honest outcome is worth recording.

- **Before TD-338** the instruction was load-bearing for LOCAL correctness. Or
  so it read. In fact the sharper statement is: it was load-bearing for local
  correctness *only for rows the remote would go on to touch*, because an
  untouched row arrives at an equal timestamp and loses LWW anyway.
- **After TD-338** an un-migrated remote cannot write a non-canonical spelling
  into us at all — ingress folds it. The instruction now buys only (a) the
  remote's OWN reads being clean and (b) the two stores being literally
  identical.
- **It is not retirable**, because an ingress fold deliberately does not write
  back (that is what keeps LWW honest) and no code path lets brain A migrate
  brain B. It is only demotable from **correctness** to **hygiene**.

The measured consequence of NOT doing it, as of 2026-08-03: 339 `brief_status`
rows hold the canonical spelling locally and the pre-v22 spelling on the VPS, at
identical timestamps, and neither side will ever overwrite the other.

**Packaging note — `brain-mcp-server/` IS shipped, so brain-side changes cost
tarball bytes.** The `cli` npm package bundles the compiled brain server at
`dist/brain-mcp-server/dist/**`, so the write-boundary echo in `briefs.ts` and
the fold tables in `brief-normalize.ts` are packed. Only the repo-side validator
(`scripts/`) and the bats trio are genuinely free. Do not repeat the claim that
these observers are "outside the npm package" — the plan asserted it and it is
false. `brain-mcp-server/scripts/normalize_brief_types.ts` is likewise packed
into `dist/brain-mcp-server/scripts/`, which already ships eight comparable
maintenance scripts (`td286_renormalize_backfill.ts`, `backfill_brief_edges.ts`,
…) — it follows that precedent rather than opening a new class, so **do not
delete it on sight** as stray weight. The measured cost is recorded in the pack
ledger in `cli/src/__tests__/tarball.test.ts`; consult it before planning, not
this doc, because the ledger is the surface that is kept current.

The **dashboard brief-type filter** (`cli/dashboard/src/pages/layers/Briefs.tsx`)
enumerates its options **from the rows**, not from a hard-coded allowlist. That
honesty is what exposed the defect in the first place. **Do not add an allowlist
there** — keep the filter honest and fix the data instead.

## Adding or changing a type

1. Edit `CANONICAL_BRIEF_TYPES` / `BRIEF_TYPE_ALIASES` in
   `brain-mcp-server/src/tools/brief-normalize.ts` — the **single source of
   truth**. The v22 migration, the backfill script and the write boundary all
   import it; there is deliberately no second hand-copied list.
2. Mirror the canonical set into `scripts/validate_brief_type_vocabulary.sh`'s
   `CANONICAL_BRIEF_TYPES` array (no build step generates one from the other).
   **The bats trio only spot-checks that the TD-328 additions are present on
   both sides — it is NOT an element-for-element parity guard.** It cannot catch
   a 13th type added to one side, a removal of one of the nine pre-existing
   members, or an order change, so a green suite is not proof the two copies
   agree. TD-330 owns building the real guard (the shape
   `test/validate_canonical_phase_parity.test.bash` already has for
   `CANONICAL_PHASES`). Until then this step is a HUMAN obligation.
   **TD-330's scope is now THREE bash canonical arrays, not one**: TD-338 added
   `CANONICAL_PRIORITIES` to `scripts/validate_brief_priority_vocabulary.sh` and
   TD-333 added `CANONICAL_STATUSES` to
   `scripts/validate_brief_status_vocabulary.sh`. Those two are small enough
   that their bats suites check element COUNT in both directions, which IS a
   real guard for them — this 12-member pair is the one still only
   spot-checked, and the generic guard is what TD-330 owes.
3. Fold historical rows in a **NEW migration version** — never edit a shipped
   one.
4. **Extending the `/register` prefix map REQUIRES adding the matching canonical
   type, and vice versa. The two sets move together.**
5. Re-verify the §17.2 pre-tag audit IN-list still covers the "broken
   feature/bug" class.

## Escalation tripwire — the `brief_subtype` column

The ~16 compound values are evidence the schema is missing a tag/subtype. TD-328
folded them to their head type **only where the qualifier already survives in the
row's own title or content** (so nothing recoverable is lost) and left the rest
unfolded and reported. A dedicated `brief_subtype` column was **rejected as
disproportionate** — it would need sweeping into the sync egress manifest, two
LWW column lists, import/export, the dashboard payload types and the remote
brain schema, for 16 rows.

> **TRIPWIRE: if compound values ever exceed 25 rows OR 5% of the corpus at any
> run of `validate_brief_type_vocabulary.sh`, FILE THE `brief_subtype` COLUMN
> BRIEF.**

The validator checks both thresholds on every run and names the brief to file.
This converts "we decided not to" into a tripwire instead of an omission.

## Known ambiguity, deliberately not resolved here

`/register` §2 maps **both `bug` and `feature` to the `BR` prefix**. So:

- `BR` as a *type value* does not fold (it could be either).
- `BR-` prefixed rows with a NULL type are **not** inferred — they stay NULL and
  are reported. AC-4 is satisfied by explanation, not only by assignment.

That collision is the same defect class as TD-328 one level up — an
unconstrained mapping at the **mint** surface. It deserves its own brief and is
explicitly out of scope here.

## TD-311 carve-out

TD-311 forbids resolving brief-**STATE** contradictions by editing brief data.
The v22 migration touches `brief_status.brief_type` and nothing else — not
`status`, `phase`, `claimed_by`, `title`, `content`, `embedding`, and
deliberately **not `updated_at`** (it is an LWW sync column; bumping it would
make folded local rows fight an un-migrated remote brain). It resolves no state
contradiction and creates none. This is a **type-vocabulary normalisation**,
categorically outside TD-311's rule — the same carve-out v18 relied on.
