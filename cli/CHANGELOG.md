# Changelog

All notable changes to the `igris-ai` CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **The dashboard can set a brief's priority and attach it to a goal (FR-247)** — two new mutations on the briefs LIST, reached through the existing `POST /api/triage` door. **No new endpoint: the surface is still sixteen GET and one POST**, and that is a measurement rather than a claim — `dashboard.bats`'s exact-set string and `SMOKE_PROBE_PATHS` are byte-identical to their pre-FR-247 values. The frozen delegation map grows five rows → seven (`set_priority` → `igris_brief_update`, `attach_goal` → `igris_edge_create`), which stays the one place a dashboard mutation can be added.
  - **The row SHAPE widened once, because a brief is not addressable by an integer.** The five FR-241 rows key on `ids: number[]`; `igris_brief_update` declares `required: ['project','brief_id']`, and although `brief_status.id` exists and is on the wire, **no brain tool accepts it** — translating id → pair in the server layer would mean a SQL lookup, which that tier's zero-SQL scan forbids by construction. So the body gained `refs: [{project, brief_id}]` beside `ids`, a `target` on each map row says which one it takes, and the two are mutually exclusive with the wrong one refused by name.
  - **A priority-only write READS before it writes, and the reason is a fork in the shipped handler.** `igris_brief_update` is a genuine partial update — but for a brief that exists in `brief_files` with **no `brief_status` row** it takes a row-CREATING branch and writes `title = ''` and `status = 'Ready'`. A priority click would therefore blank a title and invent a status: two writes into the canonical build-state invariant (TD-311) from a request that named neither field. The write path now reads every ref through the FR-240 **read door** (`getBrief` on a `query_only = ON` handle, one connection per POST) and refuses such a ref with the reason stated per item. Measured: **1** such brief exists on the operator brain. The endpoint suite drives the defect RED against the real handler first, then GREEN through the endpoint.
  - **The guard's predicate is `status !== null`, not `record !== null`, and the difference is the whole guard.** `getBrief` LEFT-JOINs `brief_files → brief_status`, so for exactly the population this refuses it returns a **non-null** record whose status columns are all null — a `record !== null` test would have passed every ref it was written to refuse, while looking present and commented. It holds because `brief_status.status` is `NOT NULL`, and that constraint is read out of the live schema by a test so a migration relaxing it fails loudly instead of quietly un-arming the guard.
  - **The picker PRESCRIBES the vocabulary; it does not report it.** Four canonical values plus CLEAR (which sends the empty string and lands as SQL NULL), mirrored from `brief-normalize.ts`. This deliberately departs from FR-245's data-derived rule for the board columns and the filter chips — that rule is right for a surface that REPORTS what the brain holds, and wrong for one that decides what an operator may ASSIGN. Enumerating from data would offer `P4-Trivial` and a bare `P2` as assignable values, minting new instances of a drift that already exists. Measured read-only: 5 bare `P2`, 2 bare `P1`, 1 `P4-Trivial`, out of 1,818 rows. **They stay visible**: the row badge renders the value verbatim, the read filter's options are still data-derived so it remains filterable, and the picker shows a non-canonical CURRENT value as a disabled *not offerable* entry so a brief never silently looks unset. **TD-338 owns folding them** — they arrived through SYNC, an LWW column copy with no normaliser, so folding them here without closing that door would just re-run.
  - **Goal ATTACHMENT ships; goal CREATION is deferred to FR-249, and that is a decision rather than a gap.** `dispatchTriage` discards the tool's success payload, so create-then-attach would need one map row to fire two tools and thread the new goal's id between them — the first exception to *one row is one dispatch*, which is the property that makes the map a review artifact. A `create_goal` row firing `igris_goal_create` alone, with the operator attaching in a second click, preserves it.
  - **`attach_goal` mints a project-ambiguous edge, and says so where it happens.** `entity_edges.from_id` is the bare brief id with no project column, `BR-001` names a different brief in 25 projects, and `getGoal`'s serving-briefs join carries no project predicate. Pre-existing (BR-078) and not fixed here — but the map row DROPS the ref's `project` explicitly, at the point the ambiguity is created, rather than in a builder nobody reads. That join is also an INNER join on `brief_status`, which is the second, independent reason the precondition refuses a status-less brief for attachment too: the edge would be invisible.
  - **The write affordances are LIST-only, by parameter rather than by convention.** `briefRow` is ONE mapper shared by the list and the board (FR-245's own guarantee that a card and a list row cannot drift), so an unconditional checkbox would have put a write path onto the status board — `status`'s own view. The list supplies an affordance builder and the board passes none; the compiler refuses `.map(briefRow)`, a source scan slices the board region of the file, and a browser gate injects the leak into `.record-board` to prove the check can fire.
  - **A brief write can reach the network, and the tests are fenced for it.** `igris_brief_update` emits `brief.synced`; the `sync` component subscribes it unconditionally and, when `auto_push` is configured, pushes `brief_status` and `brief_files` to the remote brain. That is **parity** — an MCP update does the same — and it is documented rather than suppressed. It also means an unfenced fixture write could egress, so every mutating suite arms a fence that points `HOME` at its sandbox AND replaces `globalThis.fetch`, reads both back, and is PROVEN by an arm that configures `auto_push: true` against a fictional remote and requires the blocked request to be observed.
  - **The audit trail gets its first genuinely non-empty parity control.** FR-241's `event_log` differ compared `[]` with `[]` for four of five actions. `brief.synced` is in `EVENT_COMPONENT_MAP` and monitoring subscribes it, so a priority write through the dashboard and the same write through MCP now produce one identical, non-empty `event_log` row each — compared byte-for-byte in two separate processes, alongside a `brief_status` diff. `attach_goal` is the declared-EMPTY control: `edge.created` is in neither the map nor the listen list, so its `[]` is a traced finding, with `entity_edges` carrying the "something really happened" half.
- **Brief search that really is search, and four filters that admit they are filters (FR-246)** — the Briefs tab gains **hybrid BM25 + vector recall** (`GET /api/briefs/search`, RRF-fused at `k = 60`), and Goals / Context Docs / Suggestions / Candidates gain an honest substring `q`. **The endpoint count moves sixteen → seventeen, and that is the ONLY path added**: the other four surfaces took a `q` PARAMETER on paths that already existed, so the contract sweep moved once rather than five times.
  - **Briefs had no lexical arm at all, and the vector arm was thinner than it looked.** Before this, the only retrieval over briefs was `briefs_vec` — and `extractBriefProblem` embeds the **title plus the `## Problem` section only** (falling back to the first 500 characters), is called at CREATE and by the backfill tool and **nowhere else**, and the only trigger on it is a DELETE. So a brief's **body was not searchable at all**, and an edited brief carries a **stale vector**. The new `briefs_fts` index is therefore not merely the offline fallback for the vector arm — **it is the only arm that reaches `brief_files.content`**, and the only one that is current after an edit. (Whether to re-embed on update is a separate brief and is deliberately not fixed here.)
  - **Schema v23: `briefs_fts`, CONTENTLESS, and the size is measured rather than guessed.** Built both ways against a `VACUUM INTO` snapshot of the operator brain (1,814 `brief_status` rows; 1,597 `brief_files` rows totalling 6,211,271 bytes of content): a contentful fts5 cost **+11,452,416 B**, a `content=''` + `contentless_delete=1` one **+3,846,144 B**. The reader needs only `rowid` and `rank` — it hydrates every displayed column from `brief_status` — so the second copy of 6.2 MB of prose would have bought nothing. Six triggers keep it current on both source tables. The sharp edge, invisible in the DDL and verified rather than assumed: a contentless fts5 does **not** reject an INSERT for a rowid it already holds, so every trigger is DELETE-then-INSERT and a test drives all four real writer shapes and pins the resulting row count — because a stale FTS index is indistinguishable from a search that legitimately found nothing.
  - **v23 is additive and still takes a proven backup.** It creates new objects, touches no existing row and **never bumps `updated_at`** (an LWW sync column) because it issues no UPDATE at all. It nonetheless writes a `.pre-v23.bak` and **verifies** it (`PRAGMA integrity_check` = `ok` **and** a matching `brief_status` row count), aborting at v22 if that snapshot cannot be verified. A failed v23 is not fatal: the reader reports `bm25_reason: "brain table absent: briefs_fts (schema v23 not applied)"` rather than silently returning a thinner list.
  - **`igris_brief_similar` did NOT become hybrid.** It is `/register`'s duplicate check and it filters on *cosine similarity ≥ threshold*; a BM25 hit has no cosine similarity to threshold against, so making it hybrid would have quietly changed what counts as a duplicate. It keeps its own pure-vector reader and the two share one `briefs_vec` call site. Its prose is pinned byte-for-byte across the extraction by literal goldens transcribed from the pre-change source — not by a snapshot recorded after it, which would only have asserted that the new code equals itself.
  - **The four substring surfaces say `substring` IN THE PAYLOAD.** `search: {mode: "substring", fields: [...]}`, never a hard-coded sentence in the UI — a sentence is the claim that goes stale when someone swaps the implementation, and no gate can catch a stale sentence. A payload field can be asserted, and `G-BR-13b` does: no surface reporting `substring` may render a recall readout, driven RED on purpose by a mutation that injects one. Substring is proportionate where it is used and the numbers are the argument, measured read-only: **6 goals**, a suggestion queue that is drained rather than recalled over, and five context-doc files of prose (that one is `grep`, and it says `body` rather than a column name because there is no table). Wildcards are neutralised — `?q=%` matches a literal per-cent sign, not every row.
  - **The candidates tab filters BY DESIGN, not by shortcut.** `hybridSearchLearnings` hard-gates `review_status='approved'` on both arms (FR-109) and again on hydration (TD-059), so it **structurally cannot return a `pending_review` row** — routing triage through recall would answer empty for every query. Relatedly, `/api/learnings/search` used to parse `review_status` and silently drop it while the UI bannered "SHOWING PENDING REVIEW ROWS"; it now **says** it dropped it. Widening FR-109's gate is a cognition decision and is filed separately.
  - **Cross-layer search is designed, costed and filed as its own brief.** Its spine is RRF over per-layer ranks — not `igris_graph_brain`, which by construction carries labels only, truncated, with no body content. That makes per-layer retrieval a strict PREREQUISITE rather than a substitute, which is why this brief is the half that ships first.
- **A board view for briefs, and the list stays the default (FR-245)** — `#/layers/briefs` now has two arrangements of the same rows: the list, and a **board partitioned by `status`**. The toggle sits beside the heading and persists in `sessionStorage` for the session (a reload keeps it; a new tab opens on the list). **No endpoint was added — the count stays sixteen.** The column SET comes from `/api/summary`'s existing `briefs.by_status` (a complete `GROUP BY status` over the same scope) and each column's cards and count come from the existing `/api/briefs?status=…`, one request per column. Every displayed count is the `total` from that column's own response; the summary supplies the set and never a number.
  - **The board folds nothing, and the duplicate columns are the data being honest.** `brief_status.status` has no CHECK constraint, and this brain holds three spellings of finished (`Done` 1195, `Completed` 24, `Complete` 1), two of in-flight (`In Progress` 26, `InProgress` 4), one status with a commit hash welded into it and two that are whole sentences. Each gets **its own column with its own count**, because merging is arithmetic over values the system does not know are the same — it would hide a data defect behind a tidy column. **TD-333 owns the status vocabulary.** The only concession is ORDER: spellings that normalise equal sort adjacent, so `InProgress` sits beside `In Progress`. A test pins three separate `Done`-ish columns, so a future "helpful" merge fails rather than ships.
  - **Columns are DATA ∪ VOCABULARY, never a hand-list.** The union of the statuses present in scope with the documented lifecycle (`Draft`/`Ready`/`In Progress`/`Blocked`/`Done`/`Archived`), so a project with nothing in flight still gets an `In Progress` column, and `Superseded`/`Deferred`/`Cancelled` — real values absent from the documented set — still get columns.
  - **`Done` is 75% of the corpus, and the answer is a uniform cap.** Every column shows at most 12 cards with `12 OF 493` in its header and an `OPEN IN LIST →` control that switches to the list pre-filtered to that status. Collapsing `Done` would special-case one *value* of an open vocabulary — the same error as a hand-listed column set, one layer down.
  - **Read-only, measured rather than asserted.** There is no drag-to-change-status and there will not be: `status` is the canonical build-state source. Because "this page issues no writes" is trivially true of a page with no write code, the claim is guarded twice with a positive control on each side — a drag-vocabulary scan with a planted affordance it must find, and a browser gate that drags a card with real mouse events while an in-page counter reports zero non-GET requests **and** non-zero GETs in the same reading.
  - All five existing filters work in both views. The board's `status` filter narrows the COLUMN SET rather than being passed into each column's query; the other four pass through into every column. The board reads once per scope and filter set, stamps `AS OF` and offers `REFRESH` — it deliberately does not follow the shell's 5-second beat.
- **`brief_type` is a vocabulary, not free text (TD-328)** — the column had drifted to **50 distinct non-NULL values plus NULL for ~10 concepts**: `Technical Debt` / `Debt` / `TD` / `TechDebt` / `TechnicalDebt` / `tech_debt` / `Tech-Debt` / `Tech Debt` / `debt` all naming one thing, `Feature` / `Feature Request` / `FR` / `FeatureRequest` splitting one class across four dashboard buckets, and ~16 compounds (`Bug Fix / Compliance`, `Feature / UI Enhancement`) cramming a second fact into a single-value field. Two causes, and fixing either alone fixes nothing: the alias map in `brief-normalize.ts` had only **two** entries, and `normalizeBriefType` ran on **write only**, so no existing row was ever backfilled. TD-328 does both. After the fold: **50 → 19 distinct non-NULL values, 68 → 19 NULL rows, 328 of 1,805 rows changed, zero collateral columns touched.**
  - **The deeper defect, named.** `CANONICAL_BRIEF_TYPES` and the `/register` brief-ID prefix map were never the same set. `/register` mints `DU-` (dependency) and `AC-` (architecture) briefs, but neither `Dependency Update` nor `Architecture` was a canonical type — so those briefs had **no legal type to write**, and one got invented. The canonical set is now **defined as the image of the prefix map ∪ `{Documentation}`**, which gives a mechanical decision rule: *a value with a mint prefix is a type; a value without one is a spelling.* The `/register` §2 table now carries a canonical-type column so the two sets are visibly one, and `MAINTAINING.md` pins that they move together.
  - **`Refactor` is canonical without a mint prefix — a measured exception, deliberately recorded.** The plan recommended folding it into `Technical Debt` and set its own flip criterion: "<70% of `Refactor` rows carry a `TD-` prefix ⇒ promote instead". Measurement said **41%** (19 of 46; 25 were `BR-`, 2 `UI-`), and the `BR-` titles read as genuine refactor work minted under `BR-` only because no refactor prefix exists. The operator declined an `RF-` prefix, so the canonical set is knowingly no longer exactly the prefix-map image. That exception is written into the code, the validator and the enforcement doc so nobody "corrects" it back by applying the rule mechanically.
  - **The correction to insert-narrow / read-widen (#228).** The no-hard-reject half survives untouched — rejecting `Bug (pub.dev Score)` would have meant that brief was never created, and inbound sync rows have no rejection path at all. What does **not** survive is the assumption that tolerance is self-correcting. The old code comment promised "writes get cleaner over time"; the data says they produced 50 spellings, because **tolerance without observation has no gradient**. Read-widen is a *tolerance* policy, not a *silence* policy — a widened read needs an observer or the widening is permanent. Two now exist: a **write-boundary echo** in the `igris_brief_create`/`_sync`/`_update` responses (catches minting, in whichever harness is running) and `scripts/validate_brief_type_vocabulary.sh` wired into pre-commit as **WARN-only** (catches accumulation via remote sync or an older client). Neither rejects; both report. **This costs packed bytes, and an earlier draft of this entry wrongly claimed it did not.** The `cli` npm package BUNDLES the compiled brain server at `dist/brain-mcp-server/dist/**`, so the write-boundary echo (`briefs.ts`) and the fold tables (`brief-normalize.ts`) ship; only the repo-side validator under `scripts/` and the bats trio are genuinely free. The measured own share is recorded in the pack ledger in `cli/src/__tests__/tarball.test.ts` — consult that, never this entry, because the ledger is the surface kept current. The largest single line item is a new packed entry, `dist/brain-mcp-server/scripts/normalize_brief_types.ts`; note that `dist/brain-mcp-server/scripts/` already ships eight comparable maintenance scripts (`td286_renormalize_backfill.ts`, `backfill_brief_edges.ts`, …), so it follows that precedent rather than opening a new class — **do not delete it on sight** as stray weight.
  - **Compounds fold only when the fold is provably lossless.** Each compound folds to its head type **only where the qualifier token already survives in that row's own title or content** (13 of 16 rows qualified). The 3 that did not — plus `Bug/Feature`, which has no head type — are left alone and reported, visible rather than quietly damaged. A `brief_subtype` column was rejected as disproportionate (a 6-file cross-subsystem sweep for 16 rows) but the deferral is a **tripwire, not an omission**: the validator files it as a finding if compounds ever exceed 25 rows or 5% of the corpus.
  - **The 68 NULL rows are all accounted for.** 49 are filled by decoding the mint prefix — a *lossless decode* of a field `/register` assigned from the very type question being asked, filling an absence rather than overwriting a stated value. The other 19 are **explained, not assigned**: 17 are `BR-`, and `/register` maps **both** `bug` and `feature` to that prefix, so inference would silently mistype an unknown number of features; 2 are `INT-`, not a mint prefix at all. That `bug, feature → BR` collision is the same defect class one level up and is flagged for its own brief.
  - **Migration v22, with a backup that is proven rather than assumed.** The fold ships as a WHERE-guarded, bound-param, idempotent data migration touching `brief_status.brief_type` and nothing else — verified against the backup: 0 rows with a changed `updated_at`, title, status, phase, priority, claimed_by or effort, and 0 changed `brief_files` rows. `updated_at` is deliberately **not** bumped because `brief_type` is an LWW sync column and a bumped timestamp would make folded local rows fight an un-migrated remote brain. Unlike v19, whose operation was non-destructive, **v22 aborts at v21 if its `VACUUM INTO` snapshot fails or cannot be verified** (`PRAGMA integrity_check` = `ok` **and** a matching `brief_status` row count) — a fold is unrecoverable from the row itself, so a backup nobody verified is not a backup. A dry-run-**default** backfill script (`normalize_brief_types.ts`) reports every proposed `brief_id · old → new · reason` before any write.
  - **`coding_guidelines.md` §17.2 now records why the widened IN-list stays.** Post-fold, `'FR'` and `'Feature Request'` match zero local rows — and they are **retained deliberately** as defense-in-depth, because an un-normalized row can arrive from a remote brain at any time and the write boundary never rejects one. Deleting them would re-open the exact TD-289 hole for the first row that syncs in. The §17.2 ↔ `/release` Step 0 ↔ bats trio was verified byte-aligned and **unchanged**.

- **`igris dashboard` — the local server verb + application shell (FR-238)** — the first persistent visual surface. `igris dashboard` starts a loopback-only (`127.0.0.1`) HTTP server and opens a browser at it. It was read-only as shipped by FR-238; FR-241 adds exactly one write endpoint (see the security-posture bullet below). Nothing is regenerated: reload and you see the state on disk right now. The shell ports the fifty.dev design language — four runtime palettes (`blood`/`cyber`/`acid`/`mono`), the 3-tier type stack (Anton / Space Grotesk / JetBrains Mono, **vendored as woff2 — no CDN, no network fetch at runtime**), sharp corners, hairline borders, grain overlay, ring+dot cursor, and a `prefers-reduced-motion` block that zeroes every animation (GSAP timelines are gated, not merely slowed). Four read-only endpoints — `/api/health`, `/api/projects`, `/api/summary`, `/api/graph/stats` — all of which return HTTP 200 with a `degraded` field for a missing, empty, unmigrated or corrupt brain, never a 500. FR-239 (graph), FR-240 (layer views) and FR-241 (cognition triage) mount inside this shell.
  - **First external consumer of the FR-237 pure brain-graph builder.** `cli/src/lib/brain-bridge.ts` dynamic-`import()`s the vendored compiled `buildBrainGraph` and calls it with its own read-only handle, honouring MAINTAINING row 105 without breaking the `cli/` ↔ `brain-mcp-server/` zero-cross-import rule. `/api/graph/stats` strips `nodes` and `edges` at the route layer, so the shell physically cannot render a graph that FR-239 owns.
  - **The server layer holds zero SQL.** Reads go through the FR-237 pure builder or the existing MAINTAINING-pinned CLI accessors (`listProjects`, `briefStatusSummary`, `listInstances`) — asserted mechanically in the test suite.
  - **New lifecycle convention.** The CLI's first long-lived verb: foreground, single-instance via `~/.igris/dashboard.lock` over `process-liveness.ts` (pid + start-time, so a recycled pid cannot masquerade as live), signal-released. A second invocation re-opens the running URL and exits 0 rather than binding a second port.
  - **Security posture.** Loopback bind only, `Host`-header allowlist (defeats DNS rebinding), no CORS headers, `nosniff` + `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` + `Referrer-Policy: no-referrer` on every response, path-traversal guard, and — as of FR-238 — zero write endpoints. FR-241 adds one (`POST /api/triage`) behind method, `Origin`, `Content-Type` and body-size fences.
  - **Zero new runtime dependencies.** Vite/React/Tailwind/GSAP are `devDependencies`; the server is `node:http`. Measured tarball cost: **+156.8 KB packed**. (The +250 KB soft budget this originally cited was retired — see `tarball.test.ts`, which keeps ONE asserted number because a figure nothing executes cannot be caught when it goes stale.)
  - **BR-082 — the scope chip clears to a system-wide view.** `pages/Overview.tsx` was the one page FR-241 did not migrate onto the shared `useProjectScope`: it kept its own copy of the `default_project` ladder and its chip strip had no clear affordance at all, so a page called OVERVIEW could only ever show one project. It now consumes the shared hook and control, and `/api/summary`'s `project` became OPTIONAL — an omitted one drops the predicate on both reads rather than returning `degraded`. The unscoped label is **`everything`**, not "all projects", and the distinction is real rather than pedantic: `instances.project_slug` is nullable, so an active session belonging to no project is in the unscoped count and in no project's count. `briefs.*` does reconcile, because `brief_status.project` is `NOT NULL` with a live FK.
  - **TD-326 — the project-less queue is reachable.** 377 of the 1,210 pending suggestions carry `project_slug = NULL` — synapse's `edge_inference` output, which belongs to the brain rather than to any project — so the project-scoped Triage default could not reach them and nothing said they existed. `/api/suggestions` gained `project_scope=brain-level` (a separate param with a closed vocabulary, deliberately NOT a magic `project` slug, which every other endpoint would have bound verbatim against zero rows) and a `facets.brain_level` count. The scope strip gained a `(brain-level)` chip. The three states are three different sets: `project=<slug>`, `project_slug IS NULL`, and neither — and `brain-level` is the COMPLEMENT of every project, so a bulk action there cannot reach a row any project owns.
  - **FR-244 — the whole-brain canvas is legible when zoomed out.** Node size was drawn at a constant SCREEN size, so zooming out shrank the world between nodes while the nodes stayed 8 px: they had to converge. Measured before it was fixed, in a real browser at Tier C (710 nodes) — the field held **97.5%** of its connected components at two-thirds of fit and **15.9%** one step further out, collapsing to a single blob below that. A percolation transition, not a fade. The fix is a **clamped divisor** (`shapes.ts#nodeWorldSize`): above `K_FLOOR` nothing changes and the 8 px `--s-1` floor is honoured exactly as before; below it the node is frozen in WORLD units, so the field and the nodes in it scale down together as one photograph and every gap survives. Same measurement after: **98.3%** where it had been 15.9%. `K_FLOOR = 0.11` is derived from the sweep, not picked, and the docstring carries the portable form of the derivation (the ratio `0.66 · k_fit`) because the absolute figure is a function of the canvas box and the payload.
    - **One law, five call sites.** The paint, the pointer-area buffer, the selection ring, the pointer-capture size and the label obstacle boxes all route through one function. A sixth open-coded `sizePx / globalScale` is refused by a source scan with a self-negative-control — a call site keeping its own division would make hit-testing disagree with the rendered picture at low zoom, which presents exactly like FR-239's dead canvas. **Two floors are traded, and both are written down:** the 8 px node floor and the 44 px coarse-pointer capture area, which scales with it below `K_FLOOR` so a capture radius cannot outgrow the shrinking nodes around it and select the wrong one.
    - **The canvas takes the vertical column.** `.graph-surface`'s `clamp(420px, 62vh, 900px)` is retired — no viewport however tall could show more than 900 px of canvas — and the query twin moved from a full-width block below the layout into the side column beneath the inspector, which is what freed the height. Exemption 04 asks for adjacency, not for a particular edge, and the twin renders in both branches so the no-nodes scope still carries one. At 1440x900 the page no longer scrolls (it did: 1164 px against 900); at 1600 px tall the canvas is 1210 px.
    - **The DENSITY banner is an overlay, and that is a bug fix twice over.** It is the one banner whose visibility is computed from the canvas's own ResizeObserver box, so with a full-column canvas a page-row banner could mount → shrink the canvas → refire the observer → unmount → grow. Out of flow, that loop cannot start. It also carries `pointer-events: none`: an opaque out-of-flow strip over the canvas ate every hover, click and wheel that landed on it — caught in review, and now asserted by a gate check with a mutation that restores the defect on purpose.
    - **`tracePath` is untouched, deliberately.** The brief's first AC asked for circular nodes; it was withdrawn at sign-off. At Tier C the chrome is `silhouette` — no border, no dash, no glyph — and colour encodes interaction state rather than role, so shape is the entire role signal in exactly the view the complaint came from. Legibility was the goal, circles were a proposed means, and the means was dropped rather than the goal.
    - **A new browser gate, and a metric repair validated by a mutation built first.** `G-BR-11` drives real wheel events over a sixth (Tier C) sandbox world and counts connected components of canvas ink; it was written and recorded RED against the unfixed tree before the fix existed. `G-BR-7`'s `7d` then went red, and the cause was **not** the size law — proven by reverting the layout and re-running — but `inkSpread`, which accumulated its moments in grid-cell INDEX units and was therefore silently coupled to the canvas aspect ratio. It now weights by cell pixel size. Because repairing a metric in the same breath as discovering it went red is indistinguishable from tuning it, `7d` was first given its own mutation, proven to bite against the OLD metric, and re-proven after. **`7d` remains red and its thresholds were not touched** — the residual and every figure are recorded in the gate's own notes and in `MAINTAINING.md` row 109.
  - Adds `cli/src/lib/open-url.ts`, a TypeScript port of the cross-platform browser ladder that until now existed only as bash inside `core/skills/visualize/SKILL.md`. The bash original is deliberately left in place — collapsing the two is TD-308's job.
  - Docs: `docs/dashboard.md` (verb, API, lifecycle, security posture) and `cli/dashboard/PORTING.md` (every ported file mapped to its fifty.dev origin, with each deliberate divergence recorded).

### Fixed

- **The `cli` vitest suite ran in no push/PR workflow** — `cd cli && npm test` was gated only by `npm-publish.yml`, which triggers on version tags, so a cli unit test could be red for weeks and only surface at release. Added a `Run CLI vitest suite` step to `test.yml`'s existing `cli-bats` job (which already does `npm ci` + build). Same gap class TD-303 closed for the bats suite. The new `cli/dashboard/` app had the identical problem for a different reason — `vite build` strips types without checking them and the app's tsconfig is isolated from the CLI's — so a `typecheck:dashboard` script and a matching CI step were added beside it.

---

## [7.2.0] - 2026-07-05

### Added

- **`/setup` — first-run onboarding + reconfiguration (FR-235)** — fresh
  installs get a guided first run: `igris init` ends with a human
  next-step, `/boot` shows a one-time Welcome, and the new `/setup` skill
  teaches the register→hunt→rest loop with a consented, repo-safe first
  `/ground`. Returning users get a re-runnable settings editor (shells the
  existing `igris configure` verb) covering identity, remote brain, and
  cognition toggles, plus three new `USER.md` preferences (addressing,
  notification style, auto-approve threshold). Adds a hidden
  `igris onboarding` verb and a `config.json`
  `onboarding.{completed,boot_welcomed}` first-run flag.

### Changed

- **`igris init` final report** now leads with the human next-step;
  technical details move behind `--verbose`.

### Fixed

- **`igris init --upgrade` tripped the config.json preservation guard on
  the onboarding stamp (BR-077)** — the FR-235 onboarding-completed stamp
  reserialized `config.json` on upgrade, breaking the byte-for-byte
  preservation test. The stamp is an additive, sibling-preserving system
  write — all user-authored config values are provably unchanged.
  Corrected the misleading `init.ts` comment and refined the `init.bats`
  upgrade test to assert `USER.md` byte-for-byte and `config.json`
  user-data unchanged (number-normalized), with the additive onboarding
  key as the only permitted delta.

---

## [7.1.0] - 2026-07-04

### Changed

- **`igris sync code` pre-restart smoke check** — the `better-sqlite3`
  `node -e 'require(...)'` smoke gate now runs BEFORE `pm2 restart`
  instead of after. If the native binding fails to load, the deploy
  aborts and the previously-running brain process is left untouched,
  vs the prior behavior where pm2 restart was issued first and the
  new process crashed on next DB access. Smoke is a standalone node
  subprocess that reads only filesystem state, so success-path
  behavior is unchanged. Closes #TD-141 (supersedes the post-restart
  trade-off taken in TD-135).

### Added

- **Project-handoff line (FR-229 / FR-230 / FR-231 / FR-232)** — a
  complete cross-installation project-portability workflow:
  - **`igris export <project>`** (FR-229) — read-only verb that
    serializes a project's brain slice (briefs + brief-graph + context
    docs + goals by default; `+learnings/errors/concept-graph` at
    `--tier full`) into a portable `.igris-pack.tar.gz` bundle. Supports
    `--out`, `--tier core|standard|full`, `--include`, `--since`.
  - **`igris import <bundle>`** (FR-230) — the consumer half. Unpacks a
    `.igris-pack.tar.gz`, verifies its checksum, and rejects
    executable-surface/unknown stores before any DB write. Classifies
    every row NEW/UNCHANGED/INCOMING/LOCAL_ONLY/CONFLICT via an
    ancestor-based 3-way compare (bundle hash vs. local hash vs. a
    recorded ancestor hash in a CLI-local ledger under
    `~/.igris/projects/<slug>/imports/` — deliberately NOT a naive
    `updated_at` last-writer-wins), previews the plan, requires explicit
    confirmation, and applies the chosen `--on-conflict
    ask|theirs|mine|newer` policy in one transaction. Auto-registers the
    target project on a fresh machine so the `brief_status` foreign key
    is satisfied atomically; `--dry-run` previews with zero writes;
    `--as <slug>` imports under a different slug. A partial apply exits
    non-zero and stays retryable; BLOB content (context-doc bodies)
    round-trips losslessly.
  - **`/handoff` skill** (FR-231) — wraps the export/import verbs with an
    in-chat preview/confirm ceremony, and records the project-slice
    portability contract in the OS knowledge-map (tiers + exclusions,
    and the two-mode portability decision: VPS sync for same-owner
    continuous access vs. bundle export/import for cross-owner
    point-in-time handoff).
  - **README + brand assets** (FR-232) — new project-handoff section
    documenting the `/handoff` export/import workflow, plus a top brand
    banner and a 2400×1260 OG/social preview card generated via the
    fifty.dev `oss-readme` asset pipeline.

- **`igris sync code` advisory for `.claude/*` real dirs** — warns
  (does not abort) when any of `.claude/{agents,rules,skills}/` is a
  real directory rather than a symlink. RSYNC_EXCLUDES treats these
  as symlinks per the v6 install model; a real directory would have
  its contents silently stripped at deploy time. The advisory surfaces
  the partial-install footgun before it bites. Closes #TD-139.

- **Multi-harness distribution redesign** — consolidated per-harness
  wiring (agents, skills, MCP servers, hooks) onto one descriptor model
  with a single `igris harness` compile/check surface and an `igris
  registry` verb for Layer-2 overlays. Cursor onboarded as a 6th
  first-class harness alongside Claude, Codex, Gemini, OpenCode, and
  Antigravity; drift-guard parity extended across agent, skill, MCP,
  and hook surfaces so a stale projection is caught the same way on
  every harness instead of only Claude's. (FR-150 epic, FR-161/164/165,
  FR-171/172/179, FR-202, FR-217, TD-283, and related harness/registry
  work)

- **Bundled brain — cognition engine (review-gated, off by default)** —
  the `igris-brain` MCP server bundled into this package gains a shared
  cognition host running single-purpose LLM instances that observe the
  brain and *propose* candidates for review; nothing is auto-written to
  conscious memory. Instances: `perception` (transcripts → learnings),
  `subconscious` (digest → suggestions), `synapse` (learning-to-learning
  edge inference), and the `janitor` family (`arbiter` contradiction
  resolution, `curator` stale-learning pruning, `cartographer` Leiden-
  clustering meta-learnings). Every instance and every auto-apply flag
  defaults to disabled/`false` in `~/.igris/config.json`; the new `igris
  configure` verb onboards persona/VPS/cognition opt-ins. Documented in
  `docs/COGNITION.md`. (FR-118, FR-116, FR-210, FR-211)

- **Bundled brain — knowledge-graph cluster** — new graph tools (node
  CRUD, search, dashboard, graph render/visualization), store-time
  knowledge-graph edge population, and goals + metrics dashboards with
  a drift validator.

### Fixed

- **Global install left the bundled brain MCP unbootable (BR-075)** —
  `npm install -g igris-ai` set `npm_config_global=true` in the
  postinstall's environment, which the bundled brain's nested install
  inherited and aborted on, leaving `dist/brain-mcp-server/node_modules`
  empty so `igris-brain` crashed on spawn with `ERR_MODULE_NOT_FOUND`.
  Fixed by sanitizing the child environment (stripping inherited
  `npm_config_*` vars) so the nested install always runs as a clean
  local install. Verified in a Docker clean-room (`npm install -g` →
  `igris init` → brain boots). Shipped as an interim `7.0.1` hotfix
  ahead of this release; recorded here for completeness.

- **`igris sync code` Python cache coverage** — `*.pyo` and `*.pyd`
  were missing from `RSYNC_EXCLUDES` despite being covered by
  `.gitignore`'s `*.py[cod]` glob. Added both, plus a new vitest
  audit (`gitignore-sync.test.ts`) that parses `.gitignore` and
  asserts every (non-skip-listed, glob-expanded) pattern is mirrored
  in `RSYNC_EXCLUDES`. Catches future drift programmatically. Closes
  #TD-140.

- **`igris init`/`refresh` dry-run output** — `--from-source --dry-run`
  previously printed `rename: <core> -> <core>` for the core/ deposit,
  but the actual non-dry path uses recursive `copyFromSource(...)`.
  Added a `wouldCopy()` primitive to `DryRunCollector` with a
  dedicated `copy:` printer block, and switched both verbs to use it.
  Closes #TD-142.

- **`igris init` interactive prompts** — `igris init` now interactively
  prompts for user identity (name, email) and optional remote_brain
  config (URL + API key). Previously, USER.md shipped with literal
  `{{USER_NAME}}` / `{{USER_EMAIL}}` placeholders that the user had to
  hand-edit after install, and `--skip-remote` was effectively a no-op
  (it gated a prompt that did not exist). `--yes`, `--upgrade`,
  `--dry-run`, and non-TTY shells all auto-skip prompts using defaults
  so CI and `curl | bash` installers never hang. Closes #TD-144.

- **brief-gate hook reads the brain DB** — `pre_tool_use.sh` now queries
  `brief_status` (sqlite3) for an `In Progress` brief instead of grepping
  `~/.igris/projects/<slug>/briefs/` only — v5+ briefs (brain-only, no
  filesystem cache) were invisible to the gate, so a legitimately-active
  brief still produced "No active brief found". It also resolves the
  project slug by walking `PROJECT_DIR`'s ancestors against `projects.path`
  in the registry, so a subagent whose cwd is a subdirectory (e.g.
  `<repo>/cli`) no longer resolves the wrong slug via `basename`. Both new
  paths degrade to the legacy v4 filesystem-cache behavior when sqlite3 or
  the brain DB is unavailable; the resolved slug is validated against
  `^[a-z0-9_-]+$` before any SQL interpolation. New
  `cli/tests/integration/pre-tool-use-hook.bats` (5 cases). Closes #TD-146.

---

## [7.0.1] - 2026-05-11

### Fixed

- **`igris sync code`** — workstation `node_modules/` is no longer rsynced
  to the VPS. Native modules built on the dev workstation (e.g. macOS-
  arm64 `better-sqlite3`) crashed when loaded on the Linux x86_64 VPS.
  The new pipeline runs `npm ci` on the VPS post-rsync so native bindings
  are Linux-native, then runs `npm run build` for `brain-mcp-server/`,
  then `pm2 restart igris-brain`, then a `require("better-sqlite3")`
  smoke check that fails loud if the native binding can't load. Closes
  #TD-135.

### Changed

- `igris sync code` rsync now applies an exclusion list mirroring
  `.gitignore` (`node_modules/`, `.git/`, `dist/`, `build/`, IDE files,
  logs, temp files, `*.tar.gz`, etc.). `--dry-run` enumerates the full
  exclusion list for audit.

---

## [7.0.0] - 2026-05-08

First public npm release. Renamed from `@igris-ai/cli` to `igris-ai`.

### Added

- **`igris init`** — bootstrap a fresh `~/.igris/` (or upgrade an existing
  v6 install) from a GitHub release tarball or a local source repo.
  Supports `--from-source <path>`, `--channel <ref>`, `--upgrade`,
  `--skip-remote`, `--cli-bridge <list|none>`, `--dry-run`, `--yes`.
- **`igris refresh`** — re-fetch `~/.igris/core/` from the recorded
  channel (or switch channels). Supports `--from-source`, `--channel`,
  `--no-propagate`, `--dry-run`, `--yes`. Cache-fast-path: same SHA →
  no-op.
- **`igris install <path>`** — full native TS pipeline for installing
  Igris in a project: `.claude/settings.json` hooks block (merged),
  `.claude/{agents,rules,skills}` symlinks, `CLAUDE.md` regen,
  `.igris_version` marker, brain registry row, `installed_features.json`.
  Supports `--slug`, `--no-hooks`, `--dry-run`. Hooks installed by
  default (TD-100 silent-failure inversion).
- **`igris update`** — update materialized layer for one or more
  projects. Supports `--all`, `--slug <slug>`, `--self` (npm self-
  upgrade), `--dry-run`.
- **`igris register-project [path]`** — write the brain registry row
  only (no `.claude/`, no hooks, no `CLAUDE.md`). Supports `--slug`,
  `--allow-missing-path`.
- **`igris sync <code|data|all|status>`** — push code/data to the VPS
  brain. Replaces `scripts/igris_vps_update.sh`. Supports `--dry-run`,
  `--if-changed` (cron parity).
- **`igris doctor [--fix] [--remove-orphans]`** — read-only diagnostic
  walk over the registry. Reports drift across 12 classes:
  - `path-missing` — registry row points at a deleted dir
  - `not-installed` — path exists but `.claude/` missing
  - `hooks-missing` — settings.json present but no Igris SessionEnd hook
    (the TD-100 silent-failure class)
  - `hooks-stale` — Igris hooks present but command path differs from
    canonical
  - `slug-basename-mismatch` — informational; row.slug != basename(path)
  - `duplicate-path` — multiple slugs share a single realpath
  - `symlink-target` — registered path is itself a symlink
  - `brain-core-missing` (NEW in 7.0) — `~/.igris/core/` absent or empty
  - `brain-core-stale` (NEW in 7.0) — `~/.igris/core/` content hash
    diverges from configured channel head
  - `channel-mismatch` (NEW in 7.0) — per-project `cli_version` ahead
    of current CLI
  - `bridge-missing` (NEW in 7.0) — CLI on PATH lacks configured bridge
  - `clean` — none of the above
  `--fix` repairs `not-installed`, `hooks-missing`, `hooks-stale`,
  `brain-core-missing` (invokes `runRefresh()`), and `bridge-missing`
  (invokes partial-mode `runInit()`).
- **`--dry-run` flag** — supported on every state-changing verb (init,
  refresh, install, update, sync). Prints a non-destructive plan.
- **GitHub Actions npm-publish workflow** — `.github/workflows/npm-publish.yml`
  triggers on git tags matching `v*.*.*`. Gated behind
  `secrets.NPM_TOKEN` — workflow lands behind `workflow_dispatch` until
  the npm org is registered (Risk #3).

### Changed

- **Distribution model** — moved from `npm link` (Phase 1, MG-013) to
  `npm install -g igris-ai`. The package is renamed from `@igris-ai/cli`
  to `igris-ai` per the V7 distribution decision (D-2 lock).
- **Brain content delivery** — `~/.igris/core/` is now sourced from a
  GitHub release tarball at install time (`igris init`). The repo's
  `core/` directory remains canonical for development; end users no
  longer need a `git clone`.
- **Hooks default** — hooks ARE installed by default. Pass `--no-hooks`
  to opt out. This is the v7 inversion of v6 behavior, fixing the
  TD-100 silent-failure root cause.
- **CLI naming** — package binary stays `igris`; only the npm package
  name changes. `igris --version` reports `7.0.0`.

### Removed

- **`scripts/igris_brain_init.sh`** — replaced by `igris init`.
- **`scripts/igris_brain_refresh.sh`** — replaced by `igris refresh`.
- **`scripts/igris_install.sh`** — replaced by `igris install` (M2).
- **`scripts/igris_migrate_to_v4.sh`** — v3→v4 migration retired. The
  script invoked `scripts/igris_brain_init.sh` (deleted in M5) and
  `scripts/igris_brain_refresh.sh` (deleted in M5); it had been
  functionally broken at runtime since the M5 native-CLI cutover.
  Users on v3 should reinstall via `igris init` + `igris install`.
- **`scripts/igris_update.sh`** — replaced by `igris update` (M3).
- **`scripts/igris_vps_update.sh`** — replaced by `igris sync code` (M4).
- **`scripts/igris_cli_sync.sh`** — absorbed into `igris install` (M2).
- **`scripts/igris_hooks_sync.sh`** — absorbed into `igris install` (M2).
- **`scripts/validate_canonical_hooks.sh`** — the validated source
  (`scripts/hook-adapters/install_claude_hooks.sh`) is itself deleted in
  this release; the validator becomes a no-op.
- **`scripts/hook-adapters/install_claude_hooks.sh`,
  `install_codex_hooks.sh`, `install_opencode_hooks.sh`,
  `_common.sh`** — the native TS at
  `cli/src/lib/{canonical-hooks,bridges}.ts` is the sole hook writer.
- **Legacy bats fixtures** — `test/igris_init.test.bash`,
  `test/igris_hooks_sync.test.bash`, `test/igris_cli_sync.test.bash`,
  `test/validate_canonical_hooks.test.bash` are removed; their coverage
  is replaced by `cli/src/__tests__/*.test.ts` and
  `cli/tests/integration/*.bats`.

### Migration

For users on v6:

```bash
# 1. Diagnose current state
igris doctor

# 2. Preview the upgrade (no writes)
igris init --upgrade --dry-run

# 3. Apply the upgrade
igris init --upgrade

# 4. Preview project propagation
igris update --all --dry-run

# 5. Propagate to all registered projects
igris update --all
```

The `--upgrade` flow preserves `~/.igris/memory/knowledge.db`,
`~/.igris/USER.md`, and `~/.igris/config.json` byte-for-byte.

### Internal

- 19 new vitest cases across 4 files (drift detectors).
- 1 new bats integration file (`doctor-drift-classes.bats` — 8 cases,
  one per drift class).
- Total CLI test surface at 7.0.0 close: ~246 vitest + ~62 bats.
- `npm pack --dry-run` ships only `dist/`, `README.md`, `CHANGELOG.md`,
  `package.json`. Source TypeScript and tests are not published.

---

## [Pre-7.0]

Earlier development phases of the CLI shipped as `@igris-ai/cli` via
`npm link` only (no public registry). See the repo-level
`/CHANGELOG.md` for the broader Igris AI release history.
