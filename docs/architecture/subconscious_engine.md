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
| BLOCK | `entityKey(candidate)` | ONE anchor: the project, else the primary cited brief **when the title names an id** (TD-457; the action's `brief_id` target always counts), else learning, else suggestion, else `global` |
| DISCRIMINATE | `claimsMatch(a, b, …)` | subject-id gate, then the project-set gate (TD-454: both titles name registered projects and the sets are not equal ⇒ different findings), then the module-name gate (TD-458: both titles name modules from the code's closed vocabulary and the sets are DISJOINT ⇒ different findings), then a short-claim guard, then Jaccard over `claimTokens` |

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

**TD-452 anchor re-design (2026-09-07) — measured, not moved.** TD-445's read left two
misses no threshold can reach because the rows never share a BLOCK: (1) a cross-project
finding has no `project_slug`, so `entityKey` falls to the illustrative `evidence.brief_id`
the model varies per run — `1822` / `1883` / `1885` ("N briefs In Progress 133–191 days")
sit in `brief:br-074` / `brief:ts-003` / `brief:br-001`; (2) one finding filed under
`global` (`1801`) and under `project:igris-ai` (`1888`), pairwise **0.414**, never
compared. Two candidate anchor changes were measured against a rule pre-registered before
any code (`plans/TD-452-plan.md` §1, TD-445's shape): every pair the change makes NEWLY
comparable that `claimsMatch`es at 0.25 is labelled from per-row tags, and DIFFERENT must be
0. The instrument is `brain-mcp-server/scripts/td452_anchor_sweep.ts` — both candidates are
expressed as transformations of the SHIPPED matcher (never re-implemented): (a-narrow) =
`entityKey` of the candidate with its evidence brief ids removed, taken only when the shipped
anchor is `brief:` and the title names no id; (c) = compare `global` ↔ `project:*` in a second
pass after the own block yields nothing. Copy of 1,912 rows, taken 2026-09-07 with
`sqlite3 -readonly … .backup`; self-checks: the stored `entity_key` equals the imported
`entityKey()` on 1,912 / 1,912 rows, TD-445's four scores, the brief's own four (0.238 /
0.200 / 0.238 no-match; 0.414 match), and C1 @0.25 = 153. Tags: TD-445's
`scripts/td445_row_findings.csv` plus 19 rows in `scripts/td452_row_findings.csv` (same rule;
TD-445's tag wins on any overlap; a project-subset instance of a portfolio class is its own
finding, TD-445's `lifeos_dark` ≠ `zero_learnings_projects` precedent).

**Neither candidate ships.** *(2026-09-08: (a-narrow) shipped under TD-457 after the TD-454 gate; see §TD-457 below.)* The decision set, cut C2 (whole table, N = 442, 46 anchors,
`id ASC`), pairwise at 0.25:

| candidate | newly comparable pairs | SAME | DIFFERENT | EXCLUDED | highest DIFFERENT |
|---|---|---|---|---|---|
| (a-narrow) demote the evidence brief — 26 rows move, all slug-less, 24 → `global`, 2 → `learning:` | 52 | 43 | **9** (4 on TD-445's tags, all `stalled_detector_gap` × `zero_learnings_projects`) | 0 | `1434`/`1486` @ 0.303 (TD-445 tags); `1596`/`1614` @ 0.581 (subset-vs-class tag) |
| (c) `global` ↔ `project:*`, second pass | 85 | 49 | **33** | 3 | `1291`/`1698` @ 0.387 — lifeOS-has-zero-learnings vs four-projects-have-zero-learnings |
| (c), asymmetric: only a later `global` row crosses | 45 | 31 | **13** | 1 | same pair |
| (c), asymmetric: only a later `project:` row crosses | 40 | 18 | **20** | 2 | `1486`/`1831` @ 0.333 |
| (a-narrow) + (c) | 208 | 108 | **90** | 10 | `1596`/`1614` @ 0.581 |

The plan's one pre-registered tightening of (a-narrow) — skip `brief:` only when the row
also has no slug — is a no-op: all 26 moved rows are slug-less already. The DIFFERENT pairs
are one class: portfolio findings whose claim tokens are the same LIST OF PROJECT NAMES
("attendance_app, lifeOS, hadir-system, moca-hr-agent") attached to different findings (the
stalled detector's scope vs zero learnings vs an inert roster). That is a discriminator
property, out of this brief's scope; the anchor is what keeps them apart today.

Beside the decision, not in it: replaying production's best-match loop on the same corpus
(the two-pass form for (c)), the absorptions the shipped anchor could not make were — (a)
alone 17 (16 SAME, 1 DIFFERENT: `1614` → `1596`); (c) alone **8, all SAME** (`1888` → `1801`
@ 0.414 among them); (a) + (c) 30 (25 SAME, **5 DIFFERENT**, including family 1's own `1883`
absorbed into `1676` "attendance_app carries four P1 briefs … In Progress 167 days" @ 0.270).
The loop reading for (c) alone is clean because a same-block home wins first; the pairwise
rule is the one that was pre-registered, it is the same conservative reading TD-445 decided
on, and it is the one that decided here. A future brief that wants (c) must re-register the
rule as loop-faithful BEFORE opening the list, and pay the greedy-head instability recorded
above (the loop only decides which head absorbs). Cluster counts, for scale and never as the
verdict — C1 (`created_at < 2026-09-03 12:42:03`, N = 410, 38 anchors) / C2 at 0.25, L2:
shipped 153 / 181; (c) alone 151 / 178; (a) alone 146 / 174; both 141 / 166. Comparisons
per candidate on C2: shipped mean 10.1 (max 39); (c) mean 15.7 (max 128); live pending bound
under (c) 135 `global` + 56 `project:` = 191 of 223 pending rows.

D-0, recorded at planning: family 1 could not have collapsed under ANY anchor at 0.25 — its
pairwise scores are 0.238 / 0.200 / 0.238, and a number-word drop in `claimTokens` (option
ii) measured 0.231 / 0.229 / 0.270, still not clearing the line on all three. Both families
are pinned AS SPLITS in `__tests__/recurrence.test.ts` (live path, verbatim rows) and the
pairs the anchor alone keeps apart in `__tests__/finding-key.test.ts` (`ANCHOR_HELD_PAIRS`:
claim gate SAME, anchors unequal, scores to 3 dp). Rejected at planning and not re-argued: a
`portfolio` anchor from a title regex (fixture-fit, does not touch miss 2, and (a-narrow)
already sends the rows to `global`); demoting `learning:` (two "merge learning A into B"
rows have identical claim tokens after the numeric drop — a guaranteed false-merge class);
a `dedupe_cross_global` config key (a switch nobody would set). Recorded for the next
attempt: an anchor change re-keys `dedupe_key` — it needs a schema bump that NULLs
`dedupe_key` / `entity_key` and a JS backfill on the next run (v5's own mechanism), and
`dismissed_patterns.evidence_signature` stops matching for every moved row. Of TD-445's seven
un-merged re-emissions this brief closes NONE: `1880`/`1888` @ 0.209 and `1814`/`1823` @ 0.216
stay TD-445's band; `1879`/`1887` reads DIFFERENT; the anchor half — `1883`, `1885` (below
the line in any block) and `1888` (the 0.414 pair) — stays split on the evidence above.

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

**TD-454 project-set gate (2026-09-07).** TD-452's DIFFERENT class is not one shape.
Re-reading the pinned pairs (`__tests__/finding-key.test.ts` `ANCHOR_HELD_PAIRS`) at
planning gave THREE: (S1) overlapping-but-unequal project lists with different claims
(`1434`/`1486`, `1434`/`1596`, `1434`/`1698`, `1474`/`1486`); (S2) a project-subset instance
against its portfolio class (`1291`/`1698`, `1430`/`1495` — `{lifeos}` vs `{lifeos,
attendance_app, hadir-system, moca-hr-agent}`); (S3) two different QUEUE FLOODS naming no
project at all (`1341`/`1801` @ 0.310, `1355`/`1801` @ 0.296 — stalled/gap rows vs
`edge_inference` rows). A project-set discriminator can touch S1 and S2; nothing built from
project names can touch S3.

*D-1, recorded 2026-09-07 at planning; the operator's decision at APPROVAL: KEEP THE
PAIRWISE RULE* (TD-445's and TD-452's pre-registered statistic — every pair a design makes
newly comparable that `claimsMatch`es at 0.25, labelled from per-row tags, DIFFERENT must be
0). The loop-faithful replay of candidate (c) read 8 absorptions / 0 DIFFERENT at TD-452, but
it is ONE arrival order: `1341`/`1801` did not absorb only because `1355` was already a head
in `project:fifty_eco_system` when `1341` arrived — in a fresh brain where the first
stalled/gap row lands after `1801`, the same loop merges two different floods. A single
order cannot bound a false-merge class; the pairwise superset can. Consequence: candidate (c)
cannot ship under any discriminator built here (S3 remains), family 2 (`1801`/`1888` @ 0.414)
stays the recorded cost, and (a-narrow) may pass iff its unnamed DIFFERENT pairs are S1/S2 —
in which case it is a follow-up brief (D-3), because an anchor change is a `dedupe_key`
re-key (schema NULL-all + backfill + dismissed `evidence_signature`s stop matching).

*The discriminator.* `loadProjectVocabulary(db)` reads `SELECT slug FROM projects` (fail-soft:
no table ⇒ empty) and maps each slug to its `normalizeForDedup` token sequence (`hadir-system`
→ `hadir system`; `attendance_app` stays one token — `_` is not in the punctuation class;
`lifeOS` → `lifeos`). `namedProjects(title, vocab)` matches those sequences over the title's
UNFILTERED normalized tokens (so `moca-hr-agent`'s two-character `hr` still matches), greedy
longest-first, non-overlapping and contiguous, and returns the lower-cased slugs. `Claim`
gains `projects`; `claimOf(title, vocab?)` with no vocabulary yields the empty set, so
`findingKey` — which hashes `tokens` + `subject` ONLY — is unchanged and NO row is re-keyed.
`claimsMatch` gains gate 1b, the PROJECT-SET GATE, between the subject gate and the
short-claim guard: both sets non-empty AND not EQUAL ⇒ no match. Equality, not disjointness:
the labelling rule already says a project-subset instance of a portfolio class is its own
finding. The extractor loads the vocabulary once per run (`snapshotExistingPending`) and
builds every pending claim and every candidate claim with it.

*Pre-registered pass criteria, written before the sweep ran (§3.4 of the plan):*
P-1 (precision) every S1/S2 pair in `ANCHOR_HELD_PAIRS` → `claimsMatch === false` with the
vocabulary; every DIFFERENT pair of (a-narrow)'s 9 and (c)'s 33 is tagged with its shape and
its separator; S3 pairs are expected to REMAIN. P-2 (recall) the equal-list SAME pairs
(`1430`/`1486`, `1486`/`1596`, `1486`/`1698`, `1596`/`1698`) still match; the count of C2 SAME
pairs that matched at HEAD inside their block and stop matching under the gate is QUOTED;
TD-440's excerpt corpus keeps DIFFERENT max ≤ 0.192 and every SAME group collapsed; the
TD-445 window pins keep their scores (the gate cannot change a score, only a verdict).
P-3 (slug-stripping from the similarity operands lands ONLY if) it separates ≥ 1 labelled
DIFFERENT pair the gate leaves matched AND breaks 0 SAME pairs the gate keeps; otherwise it
is recorded as measured and not shipped. P-4 (instrument honesty) the vocab-off self-checks
reproduce HEAD (C1 = 153, the stored column against `entityKey()`, the eight scores);
vocab-on figures are reported with their own numbers and a dated reason, never asserted
as 153.

*What the sweep read (2026-09-07, `sqlite3 -readonly … .backup` copy of 1,914 rows, cut C2
N = 444, `scripts/td452_anchor_sweep.ts --vocab-from-db --strip-slugs`, tags
`td445_row_findings.csv` + `td452_row_findings.csv`, 0 unlabelled in every set).* P-4 held:
vocab-off self-checks all `ok` (stored `entity_key` == `entityKey()` on 1,914 / 1,914; C1 =
153; the eight scores), and the vocab-off P_new reproduces TD-452 exactly (a 52 / 43 / 9;
c 85 / 49 / 33; cg 45 / 31 / 13; cp 40 / 18 / 20; ac 208 / 108 / 90). The DIFFERENT pairs by
shape (gate separates S1 and S2 only): (a-narrow) 9 = 5 S1 + 4 S2, all 9 separated by the
gate; (c) 33 = 10 S1 + 18 S2 + 4 S3 + 1 EQ, 28 separated, 5 not.

**AC-3 re-evaluation under the PAIRWISE rule with the gate** (P_new recomputed on the gated
claims — pairs newly comparable AND still matching):

| candidate | pairs | SAME | DIFFERENT | EXCLUDED | unlabelled | highest DIFFERENT | verdict |
|---|---|---|---|---|---|---|---|
| (a-narrow) | 15 | 15 | **0** | 0 | 0 | — | **passes** |
| (c) `global` ↔ `project:*` | 50 | 44 | **5** | 1 | 0 | `1341`/`1801` @ 0.310 (S3) | fails |
| (c), later `global` crosses | 34 | 31 | **3** | 0 | 0 | `1341`/`1801` @ 0.310 (S3) | fails |
| (c), later `project:` crosses | 16 | 13 | **2** | 1 | 0 | `1326`/`1888` @ 0.265 (S3) | fails |
| (a-narrow) + (c) | 87 | 67 | **19** | 1 | 0 | `1816`/`1883` @ 0.324 (S3) | fails |

(c)'s five survivors are the pre-registered residual plus one shape the plan did not name:
`1341`/`1801`, `1355`/`1801`, `1326`/`1888`, `1271`/`1815` are S3 (a flood row against a
flood row — no project list on at least one side), and `1297`/`1830` @ 0.257 is **EQ** — both
titles name exactly `{igris-ai, mbrgea-ai}` and the claims differ. **(a-narrow) passes the
pairwise rule under the gate → D-3: NOT shipped here** — an anchor change re-keys
`dedupe_key` (schema NULL-all + `backfillFindingKeys` in a transaction, the
`schema-v5-migration` version list, the family-1 split pins flip on purpose) and is a
different risk class from a discriminator; it is reported for a follow-up brief with this
table.

**P-3, slug-stripping: measured, NOT shipped.** Stripping the named slugs' tokens from the
similarity operands separates (c)'s EQ pair and nothing else the gate misses (gate+strip
leaves (c) at 4 DIFFERENT, all S3), but it breaks SAME pairs the gate keeps: inside the
shipped blocks the same-block SAME pairs that stop matching go from 49 (gate) to 131
(gate+strip), and (a-narrow) FAILS under gate+strip (`1397`/`1593` @ 0.267, S3). It fails the
"breaks 0 SAME pairs the gate keeps" clause and is recorded as measured.

**P-2, the recall cost of the gate itself** (the live consequence, independent of any
anchor): of the C2 pairs that share a stored anchor and match at HEAD, **84 stop matching
under the gate — 49 SAME (the cost), 6 DIFFERENT (the precision gain at HEAD: all six in
`project:lifeos`, `{lifeos}` against a four-project list or `{lifeos}` against
`{fifty_eco_system, lifeos}`; `1495`/`1660` @ 0.314 is the live-path pin in
`__tests__/recurrence.test.ts`), 14 EXCLUDED, 15 unlabelled.** Cluster counts, L2 @ 0.25:
C1 153 → 169, C2 183 → 200 on the 1,914-row copy of 2026-09-07 (C1 is cut-bounded and stable; C2 is not — it moves with live growth, and read 187 → 204 on a 1,918-row copy taken 2026-09-08; re-quote both with N and date whenever the sweep is re-run). The 49 are one shape — a re-emission that mentions a second
project in passing (`1275`/`1515`: `{lifeos}` vs `{fifty_eco_system, lifeos}`; `1312`/`1443`:
`{fifty_eco_system}` vs `{fifty_eco_system, igris-ai}`) — and each is "a missed merge leaves
the row count where it was". The excerpt corpus (`finding-key.test.ts`, the labelled
boundary set) is untouched by the production vocabulary: every SAME group collapse stays at
its pinned value and the DIFFERENT arm stays ≤ 0.192, so no pin moved. The equal-list SAME
pairs (`1430`/`1486`, `1486`/`1596`, `1486`/`1698`, `1596`/`1698`) still match. *The plan's
pre-registered narrowing — equality only when BOTH sets have ≥ 2 members — was measured and
NOT adopted*: it would recover 34 of the 49 SAME pairs but also give back all 6 DIFFERENT
same-block pairs, 20 of (c)'s 28 separated pairs and the two pinned S2 pairs (`1291`/`1698`,
`1430`/`1495`), i.e. it fails P-1. Precision is the axis (TD-437: ~23 of ~25 findings true and
actionable); the gate ships as pre-registered and the cost is stated here.

**Residual and the next lever.** S3 — two different floods with no project list — is
untouched by anything built from project names; (c) stays unshippable under the pairwise
rule for exactly `1341`/`1801` and `1355`/`1801` (plus `1326`/`1888`, `1271`/`1815`). The
next lever is a `source_module`-name SUBJECT gate (a flood row's own module name —
`stalled`/`gap` vs `edge_inference` — is the discriminating fact the titles carry and the
tokeniser cannot weigh), filed as the follow-up, not built here. `1297`/`1830` (EQ) says the
gate's equality reading has its own floor: two findings about the same two projects need
the claim to separate them. *2026-09-08: the module-name lever was measured under TD-458 —
see the next block; (c) is closed there.*

### TD-458 — the S3 residual and the module-name lever (2026-09-08)

**The L-35 read first** (`sqlite3 -readonly`, the 2026-09-08 `.backup` copy, 1,918 rows), the
nine rows the residual names — `source_module` column, stored anchor, title:

| id | `source_module` (LLM-authored) | anchor | title (abridged) |
|---|---|---|---|
| 1271 | `suggestion_queue_flood` | `project:fifty_eco_system` | "60 of 68 open suggestions are mechanical stalled/gap rows for one dormant project …" |
| 1297 | `learning_capture_gap` | `global` | "Learning capture is concentrated in igris-ai/mbrgea-ai while 8 active projects … zero learnings" |
| 1326 | `suggestion_queue_flooded` | `global` | "62 of 66 open suggestions are single-project fifty_eco_system stalled/gap notices …" |
| 1341 | `suggestion_queue_flooding` | `project:fifty_eco_system` | "58 of 61 open suggestions are mechanical 'stalled'/'gap' rows for one project …" |
| 1355 | `suggestion_queue_flood` | `project:fifty_eco_system` | "60 of the 60 open suggestions are mechanical stalled/gap rows on fifty_eco_system …" |
| 1801 | `suggestion_channel_flooded` | `global` | "44 of the 60 open suggestions are low-value edge_inference rows …" |
| 1815 | `suggestion_channel_flooded` | `global` | "44 of the 60 open suggestions are auto-generated edge_inference rows (ids 1712-1755) …" |
| 1830 | `backlog_growth_outpaces_closure` | `project:igris-ai` | "igris-ai carries 166 open briefs and 612 learnings … no visible closure rate …" |
| 1888 | `self_referential_finding_risk` | `project:igris-ai` | "44 of 60 open suggestions are low-value edge_inference rows — they crowd out substantive findings …" |

**Why the column lever is dead, on this data.** `1801` and `1888` are the labelled SAME pair
(family 2, 0.414) and carry two different `source_module` values —
`suggestion_channel_flooded` vs `self_referential_finding_risk`. On `type_inferred = 1` rows
the column is re-authored every run (TD-437: 195 labels over 358 rows), so a gate on the row's
own module label would break the one SAME pair the residual exists to keep; TD-440 AC-4 pins
the column out of the key on purpose (`finding-key.test.ts`, "survives 50 random
source_module strings as ONE key"). The lever the TD-454 block actually named is the module
name **the titles carry**: `stalled`/`gap` on 1271/1326/1341/1355, `edge_inference` on
1801/1815/1888, nothing on 1297/1830.

**The title-named vocabulary and its rule.** A closed vocabulary that is a property of the
CODE, not the data: the v1 `CHECK` set `stalled`, `conflict`, `gap`, `pattern`
(`schema.ts`), the synapse writer's `edge_inference` (`extractors/synapse.ts`), and the four
internal modules the corpus predicate excludes (`janitor`, `arbiter`, `curator`,
`cartographer`) — nine literals, each one token under `normalizeForDedup` (`edge_inference`
survives: `_` is not punctuation). `namedModules(title)` is the shipped `namedProjects`
algorithm over that list (nothing re-implemented). The rule is **DISJOINT**, the `subjectIds`
reading of gate 1: both titles name modules and share none ⇒ different findings. One empty
side is not disjoint (a re-emission that drops the module word still merges), and
"stalled/gap rows" vs "stalled rows" shares a member — equality would refuse that
re-emission, so EQUAL is reported beside DISJOINT and is never the verdict. Exposure: 82 of
the 448 C2 rows name at least one module word (`stalled` 66, `gap` 34, `edge_inference` 6,
`pattern` 1 — 2026-09-08), so `gap`/`stalled` as English prose is a real cost the rule below
has to pay for.

**Pre-registered rule, recorded 2026-09-08 at planning (P-A, P-B from the brief; P-C added by
operator decision D-2 at APPROVAL), BEFORE the sweep was run:**

- **P-A** — the module gate separates all four S3 pairs `1341`/`1801`, `1355`/`1801`,
  `1326`/`1888`, `1271`/`1815` (cross-block: the shipped loop compares a candidate against
  its OWN block only, so P-A alone describes pairs the live path never compares).
- **P-B** — it breaks **0** labelled SAME pairs: in P_new of every design (`a`, `c`, `cg`,
  `cp`, `ac`) and inside the shipped blocks, on C1 and C2, on the fresh copy.
- **P-C** — it separates **≥ 1** labelled DIFFERENT pair INSIDE a shipped block (a
  live-path benefit exists; otherwise the gate ships with no observable effect and a
  non-zero prose exposure).
- Ship iff P-A ∧ P-B ∧ P-C; otherwise measured-not-moved. `1297`/`1830` (EQ) is out of
  scope — no named mechanism reaches it. **(c) closes in either outcome.**

Instrument: `scripts/td452_anchor_sweep.ts --source-module-gate` (self-check points: the
four pairs' module sets as pinned and DISJOINT; the designed pair NOT disjoint; four
`namedModules` known-answer titles). Record: `scripts/td458_s3_pairs.csv`.

**Results (sweep run 2026-09-08 on the 1,918-row copy, C2 N = 448, C1 N = 410; every pair
in every decision set labelled — 0 unlabelled):**

| pair | score | label | shape | modules A | modules B | separated by |
|---|---|---|---|---|---|---|
| `1341`/`1801` | 0.310 | DIFFERENT | S3 | {gap, stalled} | {edge_inference} | mod |
| `1355`/`1801` | 0.296 | DIFFERENT | S3 | {gap, stalled} | {edge_inference} | mod |
| `1326`/`1888` | 0.265 | DIFFERENT | S3 | {gap, stalled} | {edge_inference} | mod |
| `1271`/`1815` | 0.250 | DIFFERENT | S3 | {gap, stalled} | {edge_inference} | mod |
| `1297`/`1830` | 0.257 | DIFFERENT | EQ | {} | {} | none (out of scope) |

- **P-A: PASS, 4/4.** Every S3 pair's module sets are `{gap, stalled}` vs `{edge_inference}` —
  disjoint under DISJOINT and unequal under EQUAL alike; the EQ pair names no module.
- **P-B: PASS, 0 broken.** P_new under the module gate, every design: `a` 15 / 15 SAME / 0
  DIFFERENT (15 rows), `c` 46 / 44 / 1 (the EQ pair), `cg` 31 / 31 / 0, `cp` 15 / 13 / 1 (EQ),
  `ac` 83 / 67 / 15 — and **0 SAME pairs lost** against the same design under the shipped
  project-set gate (`a` 15 → 15, `c` 44 → 44, `cg` 31 → 31, `cp` 13 → 13, `ac` 67 → 67).
  Inside the shipped blocks (same stored anchor, matching under the project-set gate and
  not under the module gate): **SAME 0** on C1 and on C2.
- **P-C: PASS, 3.** The same-block pairs the module gate separates are all `global` and all
  labelled DIFFERENT: `1326`/`1809` @ 0.258, `1326`/`1815` @ 0.250, `1384`/`1809` @ 0.250
  (`{gap, stalled}` or `{gap}` against `{edge_inference}`; `queue_flood_stalled_gap` vs
  `edge_inference_flood` on the row tags). At HEAD each of those was a live false merge —
  the second row bumped the first inside one block. Cluster counts do not move (C1 gate 169
  → mod 169, C2 204 → 204): the separated candidate lands on another head of its own
  module in the same block, so the gate's effect is WHICH row absorbs, not how many rows.
- **Verdict: P-A ∧ P-B ∧ P-C → SHIP.** Gate 1c in `claimsMatch` (`finding-key.ts`):
  both titles name modules and the sets are DISJOINT ⇒ no match. `Claim.modules` is always
  computed (the vocabulary is a constant); `findingKey` still hashes tokens + subject only,
  so **no row is re-keyed** (pinned: the stored `dedupe_key` of `1341` and `1801` reproduce
  byte-for-byte). A derivation guard re-derives the nine literals from `schema.ts` v1's
  CHECK set plus every deterministic writer's `VALUES ('…'` and asserts that exactly one
  writer binds `?` (the open-typed subconscious extractor). Live-path pins:
  `recurrence.test.ts` "TD-458" (`1326` then `1815` → two rows; `1815`/`1809` and
  `1326`/`1384` still bump). Unit pins: `finding-key.test.ts` "TD-458 module-name gate";
  three earlier pins MOVED with this date — the TD-452 arming half for `1341`/`1801` and
  `1355`/`1801` (tokeniser score, and `claimsMatch` now false), the TD-454 vocab-free
  arming half for S3 (score), and TD-454 (c) "S3 is UNCHANGED" → "separated by the module
  gate".
- **Post-ship agreement (L-930).** With gate 1c inside the imported matcher, the instrument's
  `--source-module-gate` compares the shipped claims against `noMod` (the same claims with
  the module set emptied) and reproduces the pre-ship reading exactly — P-A 4/4, P-B 0, P-C
  the same three pairs, `P_new(gate) == P_new(mod)` on `a` and `c`; the vocab-off self-check
  still reads C1 = 153 (N = 410), so the TD-440/TD-445 point did not move. The checked-in
  `scripts/td458_s3_pairs.csv` is the post-ship emission (reproducible from HEAD); the
  pre-ship emission differed only in `separated_by` (`mod|mod+strip` vs `gate|mod|mod+strip`).
- **Recorded beside the verdict, not part of it:** the EQUAL reading would also separate
  the four pairs (all unequal), but it would refuse the designed re-emission "stalled/gap
  rows" vs "stalled rows"; DISJOINT ships. `mod+strip` (the TD-454 strip variant plus the
  module gate) admits one DIFFERENT pair on design `a` (`1397`/`1593` @ 0.267, S3) — strip
  is not shipped (TD-454 P-3) and this is one more reason.
- **(c) is CLOSED.** With the four S3 pairs separated, (c)'s remaining DIFFERENT is exactly
  `1297`/`1830` (EQ, 0.257): two findings about the same two projects with no module word,
  out of reach of the anchor, the project-set gate and the module gate. It is out of scope
  by the brief's own AC-1, and it is what makes (c) unshippable under the pairwise rule
  whatever else lands. `anchorsComparable` is NOT shipped (no caller; operator D-1).

### TD-457 — anchor (a-narrow) shipped (2026-09-08)

**Pre-registered rule, recorded 2026-09-08 BEFORE any matcher or key change under this
brief:** TD-445's pairwise rule under the TD-454 gate — every pair newly comparable under
(a-narrow) that matches at the shipped threshold is labelled per row, and DIFFERENT must be
**0** on the labelled P_new of design `a`; every pin the re-key moves is re-measured and
listed old → new with this date, never relaxed; the ACTION `brief_id` param keeps anchoring
(a target, not an illustration — the instrument measured exactly that semantics).

**AC-1, the HEAD reproduction (read before TD-458's gate landed, then re-read after it):**
on the 2026-09-08 copy (1,918 rows, C2 N = 448, 26 rows move — all slug-less, 24 → `global`,
2 → `learning:`), design `a` under the project-set gate reads **15 pairs / 15 SAME /
0 DIFFERENT / 0 unlabelled → passes**, both before and after TD-458 (the module gate touches
no `a` pair). TD-454's reading of the same point on the 2026-09-07 copy was 15 / 15 / 0.

**The shipped rule.** `entityKey` consults `evidence.brief_id` / `brief_ids` only when
`subjectIds(title)` is non-empty; the ACTION `brief_id` param (`suggested_action.brief_id`) is
consulted as before — it is the target the handler acts on, so two findings that act on the
same brief belong together. Byte-equivalent to the instrument's measured `candidateAnchor`
(remove the evidence brief ids, let the shipped precedence decide). `anchorsComparable` is
NOT shipped (D-1: no caller once (c) is closed).

**The 15 pairs** (`scripts/td457_pairs_a_narrow.csv`, all SAME, 15 distinct rows, every one
pinned verbatim in `finding-key.test.ts` and asserted to share one anchor now, match with the
production vocabulary and score as recorded): 1570/1677 0.708 · 1486/1596 0.677 · 1570/1578
0.640 · 1430/1596 0.545 · 1596/1698 0.529 · 1335/1344 0.485 · 1578/1677 0.481 · 1430/1692
0.452 · 1486/1692 0.438 · 1596/1692 0.429 · 1692/1698 0.394 · 1328/1335 0.353 · 1440/1677
0.345 · 1474/1539 0.258 · 1596/1627 0.250. The instrument's emission after the code change is
byte-identical to the checked-in file.

**AC-2, the loop-faithful replay** (the shipped loop on the B anchors, own block, C2 N = 448,
2026-09-08): **9 absorptions the old anchor could not make — SAME 9, DIFFERENT 0.** The 15
pairs cover 15 rows; the loop keeps 6 heads (1328, 1300, 1474, 1440, 1430, 1578) and absorbs
the other 9 (1335, 1344, 1360 → 1328; 1397 → 1300; 1539 → 1474; 1570 → 1440; 1596, 1692 →
1430; 1677 → 1578), each onto a head labelled the same finding. Pairs the loop leaves
unmerged are the greedy-head effect — e.g. 1570/1677 (0.708) never meet because 1570 was
absorbed by the earlier head 1440 and 1677 by 1578 — recorded, not fixed; every row still
lands in a cluster of its own finding.

**The re-key (AC-3), rehearsed on a writable scratch copy** (`--rekey-check`, 2026-09-08):
schema **v6** `UPDATE suggestions SET dedupe_key = NULL, entity_key = NULL` — NULL (either
key) after v6 = 1,918 of 1,918; `backfillFindingKeys` (now ONE transaction; a thrown update
leaves every key NULL — pinned) keyed 1,918; NULL after = **0**; moved (entity_key changed) =
**26** (the same ids the pre-re-key sweep listed); unmoved rows byte-identical on BOTH keys =
**1,892 of 1,892** (dedupe_key changed on an unmoved row: 0); 5 spot-checked ids quoted in the
run. Fresh-vs-migrated agreement (`schema-v6-migration.test.ts`): 18 verbatim rows keyed by
the WRITER against 18 rows migrated from their stale stored keys — **18/18** equal, the 8
`brief:`-anchored title-id-less rows read `global`, every unmoved row equals its stored key
byte-for-byte. Between the v6 boot and the first run the three readers tolerate NULL keys
(`snapshotExistingPending` keys on the fly; the dismiss loop falls back to `findingKey`;
`suggestions-read` allows `null`).

**Instrument posture after the re-key** (asserted from the second run on): stored ≠ imported
on 0 rows, moved 0, design `a` admits **0** new pairs, and C1 @0.25 under the new anchor =
**146** (`C1_AT_SHIPPED_TD457`; N = 410, anchors 35 — was 153 with 38 anchors: the seven
one-row `brief:` blocks folded into `global`), first read 2026-09-08 and pinned. On a
pre-re-key copy the instrument still asserts 153 and `disagree === moved` (26 = 26). C2
whole-table cluster counts on the re-keyed copy: vocab-off L2 / gate L2 are printed in the
run and are not pinned (C2 is not cut-bounded).

**D-4, `moved ∩ dismissed`:** of the 26 moved rows, 21 are `dismissed` and 5 `pending`, but
**0** carry a `dedupe_key` that is a `dismissed_patterns.evidence_signature` (17 rows in that
table on the copy) — so on this brain no dismissal stops suppressing; the one-time
re-emission population is empty here and stays bounded by that count elsewhere. Accepted,
not re-signed.

**What the VPS sees (D-3).** `suggestions` IS in `SYNC_TABLES` but its column list stops at
`type_inferred`: `dedupe_key` / `entity_key` never cross the wire, the table is push-only, no
column is added, no manifest regenerates, no deploy order. v6 rides the next ordinary
`igris sync code`; wherever the bundle boots, `runMigrations('subconscious', …)` NULLs that
brain's keys and its next `runSubconscious` re-keys. Deploy note: after the first
post-deploy run, on each brain, read-only —
`sqlite3 -readonly ~/.igris/memory/knowledge.db "SELECT COUNT(*) FROM suggestions WHERE dedupe_key IS NULL"`
→ 0 expected locally; on the VPS 0 only if cognition runs there, otherwise the pre-existing
NULL population, harmless.

**Pins moved (old → new, 2026-09-08):** `schema-v5-migration.test.ts` chain `[1,2,3,4,5]` →
`[1,2,3,4,5,6]`; `finding-key.test.ts` "falls back through brief…" — `evidence.brief_id:'BR-1'`
under `'a title'` `brief:br-1` → `global` (and `'BR-1 is stale'` keeps `brief:br-1`); TD-452
"is kept apart by the ANCHOR alone" → a-narrow pairs share `global` and the project-set gate
refuses (cross-block arm unchanged); "split by an evidence brief the title never names" →
"PRE-TD-457 anchor was `brief:`; entityKey now reads global" (`PinRow.entity_key_pre_td457`
keeps the stored values for 1434/1474/1596 and the ten new rows); `recurrence.test.ts` family
1 `brief:br-074`/`brief:ts-003`/`brief:br-001` → `global` ×3 (rows still 3, scores
0.238/0.200/0.238 and `matches === false` unchanged); the NEGATIVE CONTROL's comment. Unchanged
and re-read: the TD-445 window, the excerpt corpus, the TD-454 and TD-458 describes in both
files, `ABANDONED_FAMILY`, the `suggested_action.brief_id` → `brief:td-9` case. (c) remains
closed.

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
- **v6** (TD-457) — `UPDATE suggestions SET dedupe_key = NULL, entity_key = NULL`: the re-key
  after the anchor change, NULL-all rather than a targeted WHERE (finding the moved rows in
  SQL would re-implement the old anchor); `backfillFindingKeys` re-keys every row in one
  transaction on the next run. No column change; nothing crosses the wire.

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
