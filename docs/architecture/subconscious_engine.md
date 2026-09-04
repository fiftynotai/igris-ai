# Subconscious Engine — the cognition subsystem

> **Status (v7.1): the subconscious is an LLM cognition INSTANCE, gated OFF by default.**
> FR-118 replaced the FR-106/FR-108 rule-detector pipeline (the `stalled`/`gap`/
> `conflict`/`pattern` detectors + the FR-108 conflict verifier + the
> `pattern_observations` smoothing table) with an LLM extractor that reads a
> deterministic brain digest and queues open-typed `suggestions`. The rule engine
> was deleted in FR-118 M4b. The instance runs only when
> `~/.igris/config.json:subconscious.enabled` (or `cognition.subconscious.enabled`)
> is `true` — the default is `false` until the engine is verified live.

**Briefs:** FR-118 — the cognition subsystem (an expandable LLM-extraction host)
**Supersedes:** FR-106 (rule subconscious) + FR-108 (conflict verifier) — both deleted.
**Schema:** `brain-mcp-server/src/engine/components/subconscious/schema.ts` —
v1 (`suggestions` + `dismissed_patterns`), v3 (rebuild: open `source_module` + LLM
columns), v4 (drop the dead `pattern_observations`). v2 created `pattern_observations`;
v4 drops it.

---

## The cognition subsystem

The subconscious is no longer a standalone rule engine — it is one **instance** of
the **cognition** subsystem, an instance-agnostic LLM-extraction host. The subsystem
is a sub-mechanism of `memory` (it is HOW some memory rows come to exist): it reads
brain state and proposes candidates for human review.

Its parts (`brain-mcp-server/src/engine/components/cognition/`):

| Part | Path | Role |
|---|---|---|
| **The agnostic engine** | `cognition/engine/` | `runExtractor(db, instance, args, deps)` — owns the cold-start / daily-budget / timeout / bytes gates, the one-terminal-event-per-run lifecycle, the prompt-injection wrap, and the auto-push. It runs ANY registered instance and never changes to add one. |
| **The harness-agnostic LLM backend** | `cognition/backend/` | spawn-map, parse-output, brain-isolation, env, exec. `resolveHarness` picks which CLI runs the call via the 4-layer chain (env → global `llm_extractor.harness` → per-instance pin → default `claude`); `isHarnessCliAvailable` probes it. Ported from FR-201's pluggable judge backend. |
| **The self-describing instances** | `cognition/extractors/<name>.ts` | each declares its own `buildContext` / `promptBuilder` / `parseResponse` / `persistCandidate` / `config` / `id`. Perception and subconscious are the two shipped instances. |
| **The OPEN registry** | `cognition/registry.ts` | discovers the instance files — it is OPEN, not a closed `'perception'|'subconscious'` enum. A new extractor is a new FILE; the engine discovers it with zero engine edit. |
| **The merged component** | `cognition/index.ts` | `createCognitionComponent()` composes both instances' surfaces (schema migrations under their original component keys, MCP tools, events, schedule bootstrap) into ONE engine component. |
| **The auto-action layer** | `cognition/actions/` (subconscious) | `igris_suggestion_apply_action` + the action kinds (tick_ac / dismiss_existing / create_brief / flag_for_review / add_edge). Operator-invoked; never auto-fires. |

**Expandability (the design goal):** adding a hypothetical third extractor — say a
roadmap-drift watcher — takes exactly a new `cognition/extractors/roadmap_drift.ts`
(declaring its contract), its appearance in the registry's glob, and optionally an
MCP run-tool + schedule entry. No engine edit, no backend edit, no new gate code. If
adding an instance ever requires touching `cognition/engine/`, the abstraction has
leaked — fix the engine, not the instance.

---

## The subconscious instance

`cognition/extractors/subconscious.ts` is the instance that reads the **brain
digest** (a deterministic summary of recent brain state — `subconscious/digest.ts`)
and asks an LLM to propose `suggestions`: things worth the operator's attention that
no single rule could name. The model names the suggestion KIND (`source_module` is
OPEN, `type_inferred=1`), unlike the old fixed `stalled`/`gap`/`conflict`/`pattern`
rule modules.

**What "passive" still buys us:** the instance proposes, it never mutates briefs,
learnings, goals, or edges on its own. A suggestion costs the operator a glance; the
operator decides whether to act (via `igris_suggestion_acted` / `apply_action`) or
dismiss (`igris_suggestion_dismiss`). The auto-action layer's `create_brief` kind
DRAFTS a brief for approval — it does not create one.

**The run path:** the `subconscious_engine` cron schedule (every 6h) fires
`igris_subconscious_run`, which calls `runSubconscious` (`subconscious/runner.ts`).
That builds a fresh instance from the resolved config and drives it through
`runExtractor`. The handler also accepts a manual fire (`force` bypasses the
cold-start + min-digest-bytes gate, but never the daily budget or the disabled
switch).

---

## Gates (where a run is skipped)

`runExtractor` evaluates these in order; the first that trips writes a `run_skipped`
lifecycle event and returns:

1. **DISABLED** — `config.enabled === false` → `run_skipped(reason='disabled')`.
2. **COLD-START** — a session booted within the grace window → `run_skipped`.
3. **DAILY-BUDGET** — today's `run_started` count ≥ `llm_daily_budget` (default 8) →
   `run_skipped(reason='budget')` with `used_today` + `budget` in the payload.
4. **BYTES** — the digest is below `min_digest_bytes` (default 10 KB), unless `force`.
5. **BACKEND** — the resolved harness CLI is absent → `run_skipped(reason='cli_missing')`.

Past the gates, the engine writes `run_started` (consuming budget), runs the isolated
LLM call, persists candidates via the instance's `persistCandidate`, and writes
exactly one terminal event: `run_succeeded` (with `persisted` count) or `run_failed`
(with `reason`, plus `detail` when the backend classified it). The one-terminal-event-per-run
invariant (TD-074) is enforced in the lifecycle emitter so a run can never double-report
nor surface as stuck-RUNNING.

`run_failed.reason` is a closed vocabulary with two writers. The BACKEND
(`cognition/backend/index.ts`, `BackendFailReason`) writes `timeout`, `non_zero_exit`,
`spawn_error`, `empty_response`, `api_error` and `auth_error`, each with a `detail`
string carrying the CLI's own message (first 200 chars; `(http N)` appended when the
envelope named a status). The ENGINE (`cognition/engine/index.ts`) writes
`build_context_error`, `backend_error`, `parse_error` and `db_error`; `response_bytes`
accompanies `parse_error` ONLY. Since **TD-447** a claude `{type:"result", is_error:true}`
envelope — the CLI reporting an API or auth failure INSIDE its JSON with exit 1 — is
classified `api_error` (or `auth_error` on 401/403 or an authentication message) BEFORE
text extraction, so it never reaches an instance parser and is never `parse_error`.
Perception's legacy path carries both classes at BOTH of its scopes: the extractor
(`perception/extractors/llm_via_claude_code.ts`) writes them as `perception.run_failed`'s
`reason`, and the runner (`perception/runner.ts`) maps that reason onto `llm_status` as
`failed:api_error` and `failed:auth_error` — the value the MCP tool result and the
`perception_extract_cli.ts` summary line print — instead of `failed:unknown`.

---

## Lifecycle events

The engine writes the run lifecycle DIRECTLY to `event_log` (NOT the bus) under the
per-instance namespace `cognition.subconscious`:

- `cognition.subconscious.run_started`
- `cognition.subconscious.run_succeeded` (`payload.persisted` = suggestions queued)
- `cognition.subconscious.run_failed` (`payload.reason` from the vocabulary above;
  `payload.detail` for backend-classified failures; `payload.response_bytes` for
  `parse_error` only)
- `cognition.subconscious.run_skipped` (`payload.reason`; `budget` adds `used_today`/`budget`)

Observe them with `igris_event_log component='cognition.subconscious'` or a direct
`sqlite3` read.

Since **TD-327** neither skill queries this namespace itself. Both run
`igris cognition health`, whose roster is DERIVED from the brain's projected
extractor registry, and render its digest: `/scan` §6.5 prints the full roster
(the subconscious is one row of seven), `/boot` §4.10 prints only the
non-healthy instances. The subconscious health surface is therefore NO LONGER
gated behind `cognition.subconscious.enabled` — a disabled instance renders as
`disabled` rather than rendering nothing, because "silently absent" is precisely
how five instances went unnoticed for four weeks. What IS still gated behind the
flag is the pending-suggestions table.

> The legacy `subconscious.*` bus events (`run_start`/`run_complete`/
> `suggestion_emitted`/`suggestion_suppressed`) are GONE — they belonged to the
> deleted rule pipeline. The only surviving bus emit is
> `subconscious.bootstrap_failed` (the schedule-bootstrap failure on `engine.ready`).

---

## The finding key (TD-440)

Every suggestion carries a **stable, entity-anchored key** that the model's free-text
label cannot perturb. `subconscious/finding-key.ts` owns it, and the persist path
uses it to BUMP a recurrence counter on the pending row instead of filing another
one.

**The defect it fixes.** TD-437's audit, 2026-09-01, judged **358** subconscious rows
and clustered them by hand to roughly **25** distinct findings. The old dedupe key
began with `source_module`, which is the model's free choice — **195 distinct labels
over those 358 rows, 147 used exactly once** — so a re-emission under a fresh label
was a different key and the dedup could never fire. One finding (`fifty_eco_system` is
abandoned) occupied 38 rows under 9 labels; that grouping is a hand-labelling of the
corpus, not a query, and is not re-derivable in SQL.

**These are SNAPSHOTS, and here is how to re-take them.** The population is the
subconscious's own output — rows whose kind the LLM named, excluding the five fixed
labels the deterministic producers write:

```sql
-- the subconscious's rows; add `AND status = 'pending'` for the live queue
SELECT COUNT(*) AS rows_, COUNT(DISTINCT source_module) AS labels
  FROM suggestions
 WHERE type_inferred = 1
   AND source_module NOT IN ('janitor','arbiter','curator','cartographer','edge_inference');
```

Re-run 2026-09-03 against that population as it stood **before** the 2026-09-01
triage (1,288 rows dismissed between 10:52:51 and 11:07:12 that morning), it returns
**360 rows over 196 labels, 147 used exactly once**. The `147` is identical; the
two-row, one-label gap against TD-437's denominator is the audit's own scope, not
drift, and it is the reason this section names TD-437 rather than presenting 358 as a
table census. Two readings taken 2026-09-03 for scale: whole table **410 rows / 236
labels**, still-pending slice **50 rows / 47 labels**.

**The figure is a fixed audit denominator, never a current count, so every site in
this repo that quotes it must name BOTH `TD-437` and the date.** Do not take that on
trust — re-derive it, because the obvious sweep cannot see the defect. A sweep that
ENUMERATES on `TD-437` alone reports clean, and one that enumerates on `2026-09-01`
alone reports clean:
only the INTERSECTION is empty, so each conjunct alone reports success without having
checked the claim. Three details are load-bearing and each one hid a site during
TD-440: the enumeration must include UNTRACKED files (`git ls-files` alone omits new
ones, which is where two of the misses lived); the match must span a TWO-LINE JOIN
(the figure wraps mid-phrase in `core/skills/scan/SKILL.md`); and each number must be
keyed to its own noun — the label count to a label word, the row count to a row word —
or the unrelated push-row count in `docs/reference/hunt-cost-record.md` is swept in as
a false member.

```bash
git ls-files --cached --others --exclude-standard | while IFS= read -r f; do
  case "$f" in *CHANGELOG.md|*.png|*.gif|*.gz|*.woff2) continue;; esac
  [ -f "$f" ] || continue
  awk -v F="$f" '
    { L[NR] = $0 }
    END { for (i = 1; i <= NR; i++) {
      j = L[i] " " (i < NR ? L[i+1] : "")
      if (j !~ /195[^0-9]{0,30}(label|value)/ && j !~ /(label|value)[a-z_]*[^0-9]{0,30}195/ &&
          j !~ /358[^0-9]{0,30}row/     && j !~ /row[a-z_]*[^0-9]{0,30}358/) continue
      lo = i > 10 ? i - 10 : 1; hi = i + 10 < NR ? i + 10 : NR
      td = 0; dt = 0
      for (k = lo; k <= hi; k++) { if (L[k] ~ /TD-437/) td = 1; if (L[k] ~ /2026-09-01/) dt = 1 }
      printf "%s %s:%d (TD-437=%d date=%d)\n", (td && dt) ? "OK        " : "INCOMPLETE", F, i, td, dt
    } }' "$f"
done | sort
```

`CHANGELOG.md` is excluded: it quotes shipped entries verbatim and is not rewritten to
match a later convention. Reading at TD-440's commit, 2026-09-03: 30 hits across ten
files, every one `OK`. Both halves are armed: deleting the date at one site, and
then deleting `TD-437` instead, reds that site's three lines each time.

**Two stages.**

| stage | function | what it does |
|---|---|---|
| BLOCK | `entityKey(candidate)` | ONE anchor: the project, else the primary cited brief, else learning, else suggestion, else `global` |
| DISCRIMINATE | `claimsMatch(a, b, …)` | subject-id gate, then a short-claim guard, then Jaccard over `claimTokens` |

`entityKey` deliberately does **not** use the whole set of cited identifiers. The
model attaches an *illustrative* `evidence.brief_id` to a project-level finding and
varies which one — across the 38 abandoned-project rows it cited AC-001, BR-037,
BR-029, BR-040, BR-074 and null, while `project_slug` stayed constant. A key built
from the set splits one finding across six blocks; measured on a 73-row labelled
corpus it collapses to 37 rows where the anchor collapses to 10.

`claimTokens` reuses `perception/dedup.ts#normalizeForDedup` verbatim rather than
re-implementing text normalisation (L-138's fix is the source of truth, tuned on a
201-pair labelled corpus), then drops tokens under 3 characters and pure-numeric
tokens — day counts move between re-emissions of one finding.

**The subject gate.** `normalizeForDedup` turns `BR-128` into `br 128`; `br` is two
characters and `128` is pure-numeric, so both are dropped and a cited brief is
INVISIBLE to the claim tokens. Without a gate, `BR-128 is the only P0-Critical
brief …` and `BR-023 is the only P0-Critical brief …` score **1.000** and merge.
`subjectIds(title)` re-extracts the identifiers the TITLE names, and two claims whose
subject sets are both non-empty and DISJOINT never match. One empty set is not
disjoint, so a project-level finding still absorbs a re-emission that happens to name
an example brief.

**Why Jaccard, and why 0.25.** Both were chosen by sweeping a 113-row hand-labelled
corpus of REAL titles across two projects, and the sweep inverted the expectation.
The Szymkiewicz–Simpson overlap coefficient (`|A∩B| / min(|A|,|B|)`) is length-robust,
which sounded right — but on real data it is length-robust in the wrong direction: it
scored a 4-token title 0.750 against a 16-token one and produced false merges on
BOTH projects at every threshold with usable recall. Jaccard produced zero false
merges on 2,628 + 780 adversarial same-entity pairs at 0.25. On that labelled corpus
the highest-scoring pair of genuinely different findings sharing an entity scored
**0.226**.

**0.25 IS A TUNED KNOB, NOT A PROVEN GAP, AND THE DIFFERENCE IS WORTH THE PARAGRAPH.**
Replaying the shipped `entityKey` / `claimsMatch` over the FULL population (410 rows,
38 anchors — the query is in "The defect it fixes" above), measured 2026-09-03, the
cluster count is a smooth slope with no plateau anywhere near the line:

| threshold | 0.226 | 0.240 | **0.250** | 0.260 | 0.300 |
|---|---|---|---|---|---|
| clusters | 140 | 147 | **153** | 168 | 198 |

There is no step in that curve to point at. What the sweep established is a clean
BAND on the labelled corpus, and 0.25 is a value chosen inside it — every claim in
this repo that reads as "the lowest step above a measured separation" overstates the
evidence and should be read as this paragraph instead.

Two merges the line admits are arguably distinct findings, named so they can be
argued with rather than left implicit:

- `[1660]` *"Four active projects carry 19 open briefs between them and zero
  learnings…"* absorbed at **0.250** into `[1291]`, the lifeOS-has-zero-learnings head.
- `[1473]` *"lifeOS has 14 briefs untouched for ~119 days… yet no stall suggestion
  has ever been raised"* absorbed at **0.259** into `[1275]`, the lifeOS `BR-023`
  P0-Critical head.

An independent rebuild of the same corpus by the reviewer put the SAME two
absorptions at 0.286 and 0.276 against different heads. The absorptions reproduce;
the scores and the heads do not, because the accept loop is greedy first-match
against cluster HEADS and head assignment moves with corpus order. That instability
is itself the argument: these numbers are not a boundary.

One trap, recorded because it looks like a precision reading and is not. The highest
same-anchor pair landing in DIFFERENT clusters at 0.25 scores **0.944** — three
near-identical `fifty_eco_system` re-emissions that were each absorbed by a different
earlier head. That is a RECALL artefact of the greedy loop, not a false-merge ceiling.
The quantity that means something on an unlabelled corpus is the highest same-anchor
pair scoring BELOW the line (**0.244** here), and even that is not the labelled
corpus's 0.226, because "genuinely different" is a label this population does not
carry.

The four falsifiers below all hold at 0.25, so the value stood at TD-440 and was
re-swept at TD-445 — see the next block — and `recurrence_titles` puts both merges
above on the row they happened on, where an operator can overrule them without
reading a log.

**TD-445 production re-sweep (2026-09-04) — measured, not moved.** TD-445's production
window (T0 `2026-09-03 12:42:03Z`, three new-bundle runs, 18 parsed) found seven of the
fifteen new rows to be re-emissions of a finding already pending. Two families were
anchor splits and are TD-452's; three pairs shared an anchor and scored below the line
with the deployed matcher, and the brief's own control makes a fourth:

| pair | anchor | Jaccard | TD-445 label |
|---|---|---|---|
| `1880` / `1888` — "44 of 60 edge_inference" | `project:igris-ai` | 0.209 | SAME |
| `1814` / `1823` — igris-ai backlog, two heads | `project:igris-ai` | 0.216 | SAME |
| `1879` / `1887` — "Learning 1509 ↔ e7435d0" | `project:igris-ai` | 0.186 | DIFFERENT — the status-audit action vs the traceability action |
| `1821` / `1884` — fifty_eco_system | `project:fifty_eco_system` | 0.128 | DIFFERENT — the control |

The re-sweep instrument is checked in this time, which TD-440's was not:
`brain-mcp-server/scripts/td445_claim_threshold_sweep.ts` imports the shipped
`entityKey` / `claimOf` / `claimsMatch` / `claimSimilarity`, runs only against a
read-only `.backup` copy of the brain (it refuses the live path), and self-checks the
four scores above, the excerpt's 0.192 and three known-answer points on the subject and
short-claim gates before it scores anything. The copy held 1,880 `suggestions` rows.
Its slope, on its own named cuts — a SECOND row, not spliced into TD-440's:

| threshold | 0.18 | 0.20 | 0.21 | 0.22 | 0.226 | 0.24 | **0.25** | 0.26 | 0.30 |
|---|---|---|---|---|---|---|---|---|---|
| clusters, cut C1 (`created_at < T0`; N = 410, 38 anchors, `id ASC`) | 125 | 132 | 133 | 139 | 140 | 147 | **153** | 168 | 198 |
| clusters, cut C2 (whole table; N = 431, 43 anchors, `id ASC`) | 136 | 144 | 147 | 154 | 156 | 163 | **170** | 185 | 218 |

C1 reproduces TD-440's row point for point (140 · 147 · 153 · 168 · 198), so the two
instruments are comparable where they overlap. Both accept loops — greedy first-match
against heads (the loop described above) and production's best-match stage B — give the
SAME count at every point, by construction: a row opens a new cluster iff no head
matches, in either loop; the loop only decides WHICH head absorbs, which is the 0.944
trap above and not a count.

The decision set is pairwise, not a cluster statistic: M(t) is every same-anchor pair in
C2 that matches at t and does not at 0.25 — the merges a lower line would NEWLY admit,
a superset of what either loop admits and therefore conservative for precision.
|M(0.18)| = 1,018 pairs over 326 rows. Each of the 326 rows was hand-tagged with the
finding it expresses (`scripts/td445_row_findings.csv`; ten rows that visibly blend two
findings are `EXCLUDED`, the treatment TD-440's corpus used) and the pair labels
derived — SAME iff the same tag (`scripts/td445_marginal_pairs_labeled.csv`). The rule,
fixed before the list was opened: SAME if an operator resolving one would consider the
other resolved by the same action. Calibration was read first: the excerpt's four
`abandoned` titles SAME; `p0_unattended` vs `harvest_gap` DIFFERENT; TD-440's two
admitted merges `[1660]→[1291]` (0.2500 today) and `[1473]→[1275]` (0.2593) both
re-read DIFFERENT.

| candidate t | M(t) pairs | SAME | DIFFERENT | EXCLUDED | production pairs caught | verdict |
|---|---|---|---|---|---|---|
| 0.22 | 391 | 283 | **97** | 11 | none | fails precision and evidence |
| 0.21 | 547 | 388 | **137** | 22 | `1814`/`1823` | fails precision |
| 0.20 | 736 | 494 | **207** | 35 | `1814`/`1823`, `1880`/`1888` | fails precision |

The highest DIFFERENT pair is `1377`/`1821` at **0.2432** — the fifty_eco_system
slug-variant finding against its archive-outright finding, seven thousandths under the
line — and the band is dense rather than blocked by one pair: 35 of the 97 DIFFERENT
pairs at or above 0.22 are `BR-023 unattended` against `lifeOS running dark`, the
excerpt's own `p0_unattended` / `harvest_gap` calibration, which is what a lower line
would merge first. The in-repo gate cannot see any of this: with `dedupe_claim_overlap`
set to 0.22, 0.21 and 0.20 in turn, the whole brain suite stays green and no collapse
pin moves, because the excerpt's DIFFERENT arm tops out at 0.192. The excerpt floors
the value at 0.192; the labelled marginal set is what holds it at 0.25. **So 0.25
stays. The two catchable production pairs are pinned as known misses in
`__tests__/finding-key.test.ts`, and the instrument and labelled set are in the repo
for the next reading** — re-run both before the next move, on a fresh `.backup`.
TD-440's 0.226 could not be re-identified as one pair: 46 pairs in C1 score within
0.0015 of it (33 SAME, 10 DIFFERENT, 3 EXCLUDED on TD-445's labels), so the record's
figure was a maximum over a corpus this population does not carry, as the paragraph
above already said of 0.244.

The trade is deliberate and asymmetric. **A false merge destroys a true finding** —
TD-437 measured ~23 of ~25 distinct findings as true and actionable — while a missed
merge only leaves the row count where it already was. So precision is the axis that
matters, and it is asserted PAIRWISE in
`__tests__/finding-key.test.ts`. Recall is asserted per GROUP, because the two arms
overlap pairwise (the lowest SAME pair is 0.176, below the highest DIFFERENT pair at
0.192) and no threshold separates every pair. The matcher does not need it to: a
candidate is compared against every pending row in its block and takes the best
match, so a re-emission that misses the first anchor lands on a later one.

**What a bump records.** `seen_count + 1`, a fresh `last_seen_at`, an extended
`expires_at` (a still-recurring finding must not lapse), the absorbed title appended
to `recurrence_titles` (last 3 distinct), and a one-step priority promotion every
`recurrence_escalate_n`th sighting — the property that would have escalated lifeOS
BR-023 after 30 runs instead of filing 30 rows. **`created_at` is not touched**: it is
the LWW timestamp `SYNC_TABLES` compares on, so a recurrence does not re-push the row.

`recurrence_titles` is the over-merge falsifier that needs no second table and no log
archaeology — a merge that should not have happened is visible by reading the row it
happened on.

**Kill switch:** `dedupe_claim_overlap` above 1.0 disables the paraphrase stage and
leaves only exact-key dedup, mirroring perception's `dedup_enabled`.

**Rejected: cosine.** `utils/vector-search.ts` allowlists only
`learnings_vec`/`briefs_vec`/`errors_vec`, so a similarity model here would need a
`suggestions_vec` table, per-row embedding, an insert/delete lifecycle and an
sqlite-vec-absent degradation path. Once the entity is the blocking key the claim
discriminator only has to separate 1–3 findings within one entity, which is a
low-resolution problem. If the boundary corpus ever shows lexical overlap failing,
upgrading the discriminator is a contained change behind `claimsMatch`'s signature.

---

## The dismiss-reason learning loop

`subconscious/runner.ts` owns both halves:

- `recordDismissPattern(...)` — the WRITE side. UPSERTs into `dismissed_patterns`
  (dismiss_count++, reasons appended, capped). **Both** dismiss writers call it: the
  `igris_suggestion_dismiss` handler and `actions/kinds.ts#applyDismissExisting`.
- `isSuppressedByDismissal(...)` — the READ side. Consulted by the subconscious
  persist path before an INSERT.

After `dismiss_suppress_count` dismisses (default 2) the finding is suppressed
permanently; a single dismiss is silenced for `dismiss_cooldown_days` and then allowed
to re-emit. This gives the operator a quiet, code-free way to silence a noisy finding.

> **THIS POLICY DID NOT EXIST UNTIL TD-440, AND THREE DOCUMENTS INCLUDING THIS ONE
> SAID IT DID.** `dismissed_patterns` was write-only from FR-106 through FR-118: the
> only `SELECT` on the table was inside `recordDismissPattern` itself, deciding INSERT
> vs UPDATE, and `dismiss_suppress_count` / `dismiss_cooldown_days` were read by no
> code at all. A finding the operator explicitly dismissed came back on the next run.
> `applyDismissExisting` was a second dismiss writer that recorded nothing, so a
> suggestion the model itself superseded taught the loop nothing.

Since TD-440 the loop is keyed on **`(source_instance, project_slug, dedupe_key)`** —
the producer and the stable finding key. The table's schema, its composite UNIQUE and
its `syncKey` are byte-unchanged; the two columns are REPURPOSED (`source_module` now
carries the producer id, `evidence_signature` the finding key). That collapses SIX
producer values — written by eight sites, since `janitor` is stamped three times — in
place of 195 label values (TD-437's audit, 2026-09-01), and finally makes the
UNIQUE constraint
do its job, with no `syncKey` change. Rows written before TD-440 simply stop matching,
which is correct — their signatures were keyed on a label the model re-invents every
run. `computeEvidenceSignature` is retained for reading those historical rows only.

---

## Producer attribution (TD-440)

`suggestions.source_instance` names the component that wrote the row —
`subconscious`, `synapse`, `janitor`, `arbiter`, `curator`, `cartographer`. It exists
because `source_module` structurally cannot answer "who filed this": the subconscious
alone reports under 195 distinct labels (TD-437's audit, 2026-09-01), so grouping by
module reads as 195 producers where there are **six producer values written by eight
sites** — `janitor` is stamped by the extractor and by both deterministic sweeps. Six
and eight are different numbers about different things: six bounds what the producer
facet can ever render, eight is the set `__tests__/source-instance.test.ts` re-derives
and holds to its stamp.

**Every new `suggestions` writer MUST stamp it**, or its rows land in the
`(unattributed)` facet bucket and silently understate whoever they belong to.
`__tests__/source-instance.test.ts` re-derives the writer set from the source on every
run rather than checking a list, so a ninth writer that forgets reds immediately.

The two deterministic janitor sweeps (`janitor/hygiene.ts`, `janitor/emergence.ts`)
are not cognition instances, so they stamp `janitor` — the owning component, which is
what an operator would look for.

Rows written before v5 read as NULL and are **deliberately not backfilled**:
attributing them would need a hand-list of the sibling `source_module` literals over
an OPEN registry. They surface as the empty-string facet bucket instead.

---

## Schema

`subconscious/schema.ts`, applied under the `subconscious` component key in
`engine_migrations` (per-component registry, keyed by `(component, version)`):

- **v1** — `suggestions` (the canonical queued-findings store) + `dismissed_patterns`
  (the dismiss-loop UPSERT target, composite-UNIQUE on
  `source_module, project_slug, evidence_signature`) + lookup indexes.
- **v2** — `pattern_observations` (the old rule smoothing table). **Dropped by v4.**
- **v3** — REBUILD `suggestions`: open the `source_module` CHECK (the LLM emits
  open-typed kinds) and add `confidence` / `suggested_action` / `type_inferred`.
  SQLite cannot drop a CHECK via ALTER, so v3 is a table-rebuild that copies every
  legacy row across with `type_inferred=0`. The priority + status CHECKs are kept.
- **v4** — `DROP TABLE IF EXISTS pattern_observations`. Idempotent; safe on a brain
  that never applied v2. `suggestions` / `dismissed_patterns` are untouched. The
  table was never in `SYNC_TABLES`, so there is no cross-machine merge state to lose.
- **v5** (TD-440) — six additive `suggestions` columns + two indexes, ALTER-only:
  `dedupe_key` / `entity_key` (the finding key), `seen_count` / `last_seen_at` /
  `recurrence_titles` (the recurrence record that replaces a duplicate row) and
  `source_instance` (the producer). The keys are backfilled in JS by
  `finding-key.ts#backfillFindingKeys`, called once per run from `runSubconscious` —
  a WRITE path, never from `buildContext`, which is a read slot — because the key
  needs normalisation and a hash and cannot be computed in SQL.

### These tables ARE synced; the new columns are not

**`suggestions` IS in `SYNC_TABLES`** (`tools/sync.ts`, `syncKey:
['source_module','project_slug','title']`), and so is `dismissed_patterns`. An
earlier version of this document said the opposite, and anyone planning a column
change from it would have concluded, wrongly, that it was free.

The six v5 columns are nonetheless **deliberately absent from the sync config**, and
this is the reasoning so nobody re-derives it:

- `mergeRows` reads and writes only `config.columns`, and push filters to the
  configured list — a column absent from the config is invisible to every
  replication path.
- `suggestions` is **push-only** (absent from `BOOT_SYNC_PULL_TABLES`) and excluded
  from export, so no inbound row can ever arrive with these columns NULL.
- The precedent is exact: `learnings.seen_again_count` / `last_seen_at` are excluded
  from `SYNC_TABLES` **by design**, because a rediscovery count is a per-machine usage
  signal. `seen_count` is the same quantity for the same reason; the keys are
  derive-on-receiver.

Adding any of them to the config would make the remote's unmigrated schema a per-row
failure and would oblige a manifest regeneration plus a remote-first deploy. It buys
nothing — a recurrence count is about *this* machine's runs.

---

## Config

Read with defaults; absent keys fall back. The subconscious resolver
(`subconscious/index.ts:resolveSubconsciousConfig`) reads BOTH the new
`cognition.subconscious` block and the legacy top-level `subconscious` block (the new
path wins where both set a key; the legacy `subconscious.enabled` stays grep-able):

```jsonc
{
  "subconscious": { "enabled": false },          // legacy top-level — resolver fallback + grep anchor
  "llm_extractor": {                               // the shared cognition-backend harness selector
    "harness": "claude",
    "fallback_order": ["claude", "codex", "gemini"]
  },
  "cognition": {
    "perception": { "enabled": true },
    "subconscious": {
      "enabled": false,
      "llm_timeout_ms": 300000,
      "llm_daily_budget": 8,
      "min_digest_bytes": 10240,
      "harness": null                              // null = inherit the global llm_extractor.harness
    }
  }
}
```

Enabling the engine is a single flag flip (`subconscious.enabled` →
`cognition.subconscious.enabled` → `true`) — no schedule re-bootstrap needed. The
`subconscious_engine` cron schedule is bootstrapped idempotently on `engine.ready`
and fires `igris_subconscious_run` regardless of the engine internals.
