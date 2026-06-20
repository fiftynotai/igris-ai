---
name: distill
description: "Guided knowledge lifecycle - capture mode harvests reusable learnings/modules/archetype from a project (dedup-checked); promote mode merges a hardened learning's standard into a project-context doc with lineage (one-fact-one-source)."
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - mcp__igris-brain__igris_project_register      # Phase 2 archetype
  - mcp__igris-brain__igris_registry_add          # Phase 3 module register
  - mcp__igris-brain__igris_registry_search       # Phase 3 dedup against catalog
  - mcp__igris-brain__igris_registry_update       # Phase 5 rebrand_checklist
  - mcp__igris-brain__igris_memory_recall         # Phase 4 dedup pre-check + promote candidate surface
  - mcp__igris-brain__igris_memory_search         # Phase 4 dedup (FTS) + promote candidate surface
  - mcp__igris-brain__igris_memory_store          # Phase 4 store (source_extractor:'distill')
  - mcp__igris-brain__igris_memory_get            # inspect a candidate's full content
  - mcp__igris-brain__igris_memory_dashboard      # promote: candidate sizing (by_review_status)
  - mcp__igris-brain__igris_memory_mark_promoted  # promote: mark the source learning promoted
  - mcp__igris-brain__igris_edge_create           # promote: derived_from lineage breadcrumb
  - mcp__igris-brain__igris_brief_dashboard       # Phase 1 completed-brief scan
triggers:
  - "DISTILL"
  - "distill"
  - "harvest knowledge"
  - "extract learnings"
---

# DISTILL — Knowledge Lifecycle Skill

Deliberately harvest reusable knowledge from a project into the brain: curated
**learnings** (memory), reusable **modules** (registry / the lego catalog), and
the project **archetype**. Every step is **operator-guided, never automatic** —
this is the proven principle from the original capture design (revived FR-100):
the model proposes, the operator decides what is worth keeping.

> **Two complementary modes.** **Capture** (M1) harvests reusable knowledge
> from a project into the brain. **Promote** (M2) lifts a *hardened* learning
> out of memory and into a project-context doc — the FR-196 memory→doc pipeline
> (one-fact-one-source). Capture composes already-shipped MCP tools; promote
> additionally uses the FR-200 `igris_memory_mark_promoted` tool + a
> `derived_from` lineage edge.

## Arguments

`$ARGUMENTS` selects the mode:
- `capture` → **(default)** run the 6-phase guided knowledge harvest.
- `promote` → run the memory→doc promotion pass (surface hardened learnings →
  operator approves → merge the standard into the right context doc → record
  lineage → mark the learning promoted). See §"Promote mode" below.

If `$ARGUMENTS` is empty, default to `capture` (or, if the operator's intent is
unclear, ask: "Capture project knowledge now, or promote a hardened lesson into
a doc?").

## 0. Track Invocation

Silently emit a skill invocation event (never blocks execution):
```bash
bash "$CLAUDE_PROJECT_DIR/scripts/emit_skill_event.sh" "distill" 2>/dev/null || true
```

---

# CAPTURE MODE (default)

Guided harvest in six phases. Determine the current project slug, name, and
absolute path up front (the project the operator is in) — Phases 2–4 key off it.

> **Degradation (applies to EVERY brain call below):** if the `igris-brain` MCP
> server is unavailable, do **not** block. Continue the operator interview,
> collect the same answers, and warn **once** at the top:
> `Note: brain MCP unavailable — capturing the interview locally; the learnings/modules/archetype will not be persisted to the brain this run. Re-run /distill when the brain is reachable to store them.`
> Then, for each phase that would have written to the brain, write a clean
> capture note to `~/.igris/projects/{project}/context/distill-capture-{date}.md`
> (Markdown: the chosen archetype, the module list, and each curated learning in
> the same shape Phase 4 would have stored) so the harvest is not lost. This
> mirrors the awaken/rest skip-on-MCP-unavailable convention — never error,
> never block, warn once.

## Phase 1 — Analysis

Build a picture of the project from ground truth (no brain needed for this scan):

1. **Tech stack** — Glob + Read the manifest(s): `pubspec.yaml`, `package.json`,
   `pyproject.toml` / `requirements.txt`, `Cargo.toml`, `go.mod`, `Gemfile`,
   `pom.xml` / `build.gradle`, etc. Extract framework + key dependency versions
   (e.g. scan `pubspec.yaml` → `get: ^4.6.6` → "Flutter + GetX").
2. **Folder structure** — Glob the source tree (e.g. `lib/**`, `src/**`) to map
   the architecture (feature-first vs layered, where models/services/views live).
   Sample a few representative files (e.g. `lib/features/*_view_model.dart`) to
   confirm the patterns actually in use.
3. **Completed briefs** — call `igris_brief_dashboard` (`project` = slug,
   `summary_only: true`) for the shipped-work landscape; the completed briefs are
   the source references (`source_brief`) the curated learnings cite.
4. **Existing context docs** — Read whatever is present under
   `~/.igris/projects/{project}/context/` (e.g. `coding_guidelines.md`,
   `architecture_map.md`). Knowing what is already documented prevents
   re-capturing it as a "new" learning in Phase 4.

Present a short scan summary to the operator before proceeding.

## Phase 2 — Archetype classification

1. From the Phase-1 scan, **suggest** an archetype (e.g. "enterprise mobile MVVM",
   "Flutter design kit", "marketing web", "AI platform").
2. **Confirm with the operator** — never assume. Let them correct or replace it.
3. Persist via `igris_project_register`:
   ```
   igris_project_register({
     slug:       "<project-slug>",
     name:       "<project-name>",
     path:       "<absolute-project-path>",
     tech_stack: "<comma-separated stack from Phase 1, e.g. 'Flutter:3.9.2,GetX:4.6.6'>",
     archetype:  "<confirmed archetype>"
   })
   ```
   (Register upserts by `slug` and COALESCEs `archetype`, so this is safe to
   re-run; it also refreshes `last_session_at`.)

## Phase 3 — Module identification (the lego catalog seed)

Catalog reusable, **standalone** modules so future projects can reuse them
instead of rebuilding (the dark-theme-incident lesson; this is the FR-198 lego
catalog seed).

1. Propose an **interactive checklist** of candidate standalone modules found in
   the scan (self-contained packages/libraries/components with a clear boundary —
   a design-kit package, an auth module, a reusable service, etc.).
2. For each candidate, **before** registering, dedup against the existing catalog:
   call `igris_registry_search` (`query` = the module name/keywords,
   `type: 'module'`). If a strong match already exists, offer to **skip** or
   **update** (`igris_registry_update`) rather than create a duplicate row.
3. For each module the operator confirms as new, register it:
   ```
   igris_registry_add({
     name:              "<module name>",
     type:              "module",
     github_repo:       "<owner/repo>",          # REQUIRED — ask the operator if not derivable
     github_path:       "<path within repo>",     # optional
     description:       "<what it is / when to reuse it>",
     tags:              "<comma-separated>",
     source_project:    "<project-slug>",
     standalone:        true,
     rebrand_checklist: "<optional — usually set in Phase 5 for templates>"
   })
   ```
   **`github_repo` is required** by the registry — if the module's repo is not
   derivable from the scan, ask the operator for it (or skip the module rather
   than inventing a value).

## Phase 4 — Knowledge extraction (3–8 curated learnings)

The heart of the harvest. The operator picks **3–8** reusable learnings worth
keeping (resist storing everything — curation is the value).

1. From the scan + completed briefs, propose a **guided checklist** of candidate
   learnings across the kinds: architecture **patterns**, tech-stack
   **decisions**, reusable code **patterns**, project **discovery** (structure /
   conventions), and **mistakes** (with the fix). For each, draft a title and a
   one-line rationale; ask the operator the "why" (e.g. "Why GetX over Provider?
   What problem was it solving?") so the stored content captures the reasoning,
   not just the fact.

2. **CRITICAL — dedup pre-check (before EVERY store):** for each candidate the
   operator wants to keep, FIRST call `igris_memory_recall`:
   ```
   igris_memory_recall({ project: "<slug>", context: "<candidate title + key terms>" })
   ```
   (optionally `igris_memory_search` for an FTS pass, and `igris_memory_get` to
   read a near-match's full content). If a **strong near-duplicate** already
   exists, do **not** blindly create a new row — offer the operator:
   - **skip** (the existing learning already covers it),
   - **merge** (fold the new detail into the existing one — read it, combine,
     and re-store the improved version), or
   - **update** (the existing one is stale — replace it).

   This dedup gate is load-bearing: re-creating duplicate learnings is the exact
   failure the guided-not-automated design exists to prevent. Never skip it.

3. **Store survivors** via `igris_memory_store` — one call per curated learning:
   ```
   igris_memory_store({
     project:          "<slug>",
     category:         "<pattern | decision | discovery | mistake | optimization>",
     title:            "<concise, searchable title>",
     content:          "<the full markdown writeup: overview, code, why, trade-offs, when-to-use, sources>",
     tags:             "<comma-separated: domain, tech, archetype>",
     tech_stack:       "<e.g. 'Flutter:3.9.2,GetX:4.6.6'>",
     source_brief:     "<the brief(s) this came from, e.g. 'BR-008,BR-012'>",
     confidence:       <0.0-1.0, default 0.8 — higher = battle-tested>,
     source_extractor: "distill"
   })
   ```
   - **`source_extractor: "distill"` is mandatory** on every Phase-4 store — it
     marks the row as conscious operator-curated harvest (distinct from the
     `llm`/perception channel). The write path already accepts this value.
   - `category` MUST be one of the five enum values above (no others are
     accepted): `pattern`, `decision`, `discovery`, `mistake`, `optimization`.
   - These rows land at `review_status: 'approved'` by default — they appear in
     recall immediately (operator-curated content needs no perception review).
   - For the exact JSON shape of high-quality learnings (the worked examples:
     MVVM+GetX `conf 0.85`, Fifty-UI decision `conf 0.80`, WebSocket pattern
     `0.80`, folder-structure discovery `0.75`, PM2 mistake `0.85`), the
     `distill_concrete_examples.md` research note is the canonical reference.

## Phase 5 — Rebrand checklist (template archetypes only)

Only when the project is a **template/starter** archetype (something future
projects clone-and-rebrand):

1. Produce the rebrand checklist — the concrete steps to white-label this
   template for a new brand (app name, bundle id, color tokens, logo assets,
   API endpoints, store metadata, etc.).
2. Store it on the relevant registry **module** row via `igris_registry_update`
   (the `rebrand_checklist` field), or pass it inline as `rebrand_checklist` in
   the Phase-3 `igris_registry_add` call for that module.

Skip this phase entirely for non-template projects.

## Phase 6 — Summary

Report what was captured:
```
## Distill complete — <project-slug>

- Archetype: <confirmed archetype>
- Modules cataloged: <M> (<new>, <updated>, <skipped-as-dup>)
- Learnings stored: <N> (source_extractor: distill)
  - <title> [<category>, conf <x>]
  - ...
- Dedup: <k> candidate(s) skipped/merged against existing memory
```
If the run was degraded (brain absent), point the operator at the local capture
note that was written and remind them to re-run when the brain is reachable.

---

# PROMOTE MODE

`/distill promote` — the memory→doc **promotion** pass (FR-196 one-fact-one-source).

A learning earns promotion once it has **proven itself** — it is recalled often,
high-confidence, and a stable standard rather than a fresh observation. Promotion
moves that standard out of the recall stream and into the project's authored
**context doc**, which then *owns* it. The learning row is **never deleted**: it
becomes a lineage stub (`promoted_to_doc` points readers at the doc), and recall
stops double-surfacing the raw content. The operator approves **every** promotion
— the model proposes, never silently writes a doc.

> **Degradation — promote CANNOT run with the brain absent.** Unlike capture,
> this pass *requires* the brain: it queries candidates, records a
> `derived_from` lineage edge, and marks the source learning promoted — none of
> which has a local fallback. If the `igris-brain` MCP is unavailable, **warn
> and exit cleanly without touching any doc**:
> `Note: /distill promote needs the brain MCP (to query candidates, record lineage, and mark the learning promoted) and it is unavailable — exiting without changes. Re-run when the brain is reachable.`
> **Never half-merge:** do not write a standard into a doc if you cannot
> immediately record the lineage edge AND mark the learning promoted — a merge
> without the marking re-introduces the exact double-surfacing this pass exists
> to prevent (the doc owns it AND recall keeps surfacing the raw learning).

Determine the current project slug + absolute path up front (promotion targets
that project's `~/.igris/projects/{slug}/context/` docs).

## P1 — Surface hardened candidates

Find learnings that have earned a doc home. Use `igris_memory_recall` (or
`igris_memory_search` for an FTS pass) scoped to the project, and prefer rows
exhibiting the "this lesson has proven itself" signals:

- **high `confidence`** (battle-tested, near 1.0),
- **high `access_count`** (recalled frequently — the recall composite already
  surfaces these higher),
- **`category` IN (`decision`, `pattern`)** — the kinds that become standards
  (a one-off `discovery` or a `mistake` usually is not a doc-worthy standard),
- **`scope = 'global'`** — already cross-project-proven (the brain's internal
  scope-promotion lifted it because it recurred across projects); a strong
  doc-promotion candidate.

`igris_memory_dashboard` (`project` = slug, `summary_only: true`) gives a quick
sizing of the memory footprint (`by_review_status`, `by_category`) to frame how
many candidates exist.

**Two hard filters on the candidate set:**
1. **`review_status = 'approved'` only** — never promote a `pending_review` row
   (a perception-channel candidate a human has not yet vetted). The default
   recall/search filter already hides pending rows, so a candidate surfaced via
   `igris_memory_recall`/`_search` is already approved — but state it and do not
   reach around the filter.
2. **Exclude rows already promoted** — `igris_memory_get` a candidate and skip
   it if its recall output shows a `Promoted: → <doc>` pointer (it already lives
   in a doc; re-promoting would duplicate it).

Present the shortlist to the operator with, for each: title, category,
confidence, access_count, scope, and the proposed target doc (next step).

## P2 — Propose a target doc per candidate

Map each candidate to the right authored doc under
`~/.igris/projects/{slug}/context/`:

| Candidate kind | Target doc |
|---|---|
| code **decision** or reusable code **pattern** | `coding_guidelines.md` |
| **structural** / architecture (layers, module boundaries, folder org) | `architecture_map.md` |
| **UI** / design-token / component standard | `design_system.md` |
| **API** shape / endpoint convention | `api_pattern.md` |
| **test** standard | `test_standards.md` |

Read whatever target docs already exist (Glob the context dir). If the right
doc-type is **absent**, offer the operator to **create it** (a new, minimal,
well-headed doc) or to **skip** this candidate — do not force a standard into a
mismatched doc.

## P3 — Operator approves each promotion

For **each** candidate, present the proposal and get an explicit decision —
approve / skip / change-target. **Never promote silently.** A "no" leaves the
learning exactly as-is (still in memory, still surfaced by recall).

## P4 — Merge the standard into the doc (read → dedup → merge → write)

For each **approved** candidate:

1. **Read** the target doc fully (`Read`).
2. **Dedup against existing content** — if the doc already documents this
   standard (a heading or paragraph covering the same rule), do **not** append a
   second copy. Offer to **refine the existing section** (fold in any new detail
   from the learning) instead, or skip the merge if the doc already says it
   well. Appending a standard the doc already carries is the exact duplication
   this pass must avoid.
3. **Merge** the learning's standard under a **stable heading** — either an
   existing topical section it belongs under, or a clear new `## <heading>` (a
   `## Promoted Standards` section is a reasonable home when there is no
   topical fit). Write the *standard* (the rule + the why + when-to-apply),
   distilled from the learning's content — not a verbatim dump of the row.
4. **Write** the doc back (`Edit` for a surgical section insert, or `Write` for
   a doc you are creating). **Never overwrite the whole file** with unrelated
   content — a context doc is operator-authored; merge into it, do not clobber
   it. Note the heading anchor you merged under (you need it for P5/P6).

## P5 — Record the lineage breadcrumb (a `derived_from` edge)

Lineage is a **graph edge, not a copy** of the content (FR-196: lineage is "a
different kind, not a duplicate"). After the merge, record where the standard
came from:

```
igris_edge_create({
  from_type:  "learning",
  from_id:    "<learning id>",
  to_type:    "concept",
  to_id:      "<slug>:context/<doc>#<anchor>",   # e.g. "igris-ai:context/coding_guidelines.md#error-handling"
  edge_type:  "derived_from",
  provenance: "user",                             # operator-approved, not observed/inferred
  metadata:   { "promoted_at": "<ISO timestamp>", "target_doc": "<doc>", "target_anchor": "<anchor>", "approved_by": "operator" }
})
```

(`to_type: "concept"` is the free-standing-node type for "a doc section" — it is
not itself a DB entity. The edge is idempotent on its tuple, so a re-run is
safe.)

## P6 — Mark the source learning promoted

Set the recall pointer so the doc becomes the single source going forward:

```
igris_memory_mark_promoted({
  id:         <learning id>,
  doc_path:   "<slug>:context/<doc>",     # same path used in the edge's to_id (without the #anchor)
  doc_anchor: "<anchor>"                   # the heading slug you merged under; a leading '#' is stripped
})
```

After this, `igris_memory_recall` surfaces `Promoted: → <doc>#<anchor>` for that
learning instead of its raw content — the standard now lives in exactly one
place (the doc), with a recall breadcrumb pointing there.

## P7 — Promote summary

Report what was promoted:

```
## Distill promote complete — <slug>

- Candidates reviewed: <N>
- Promoted: <P>
  - <title> [<category>, conf <x>] → <doc>#<anchor>
  - ...
- Skipped: <k> (already-promoted / operator-declined / dedup — doc already covered it)
- Lineage edges recorded: <P> (derived_from: learning → concept)
```

---

## Constraints

1. **GUIDED, never automatic** — the operator chooses every archetype, module,
   learning (capture) and every promotion (promote). The model proposes; it
   never silently stores a learning or writes a standard into a doc.
2. **DEDUP before writing** — capture: `igris_memory_recall` /
   `igris_registry_search` a candidate before creating a new row (offer
   skip/merge/update). Promote: read the target doc and dedup the standard
   against existing content before merging (offer refine-existing/skip). This is
   the load-bearing guard against duplicate-knowledge drift in BOTH modes.
3. **`source_extractor: "distill"`** on every capture-Phase-4 `igris_memory_store`.
4. **Curate, don't dump** — capture targets 3–8 learnings; promote moves only
   *hardened* standards (approved, high-confidence/recall, decision|pattern).
5. **Graceful degradation** — capture: brain absent → continue the interview,
   warn once, write a local capture note, never block. Promote: brain absent →
   warn and **exit without touching any doc** (no local fallback; never
   half-merge a standard you cannot mark + lineage).
6. **One-fact-one-source** (promote) — after a promotion the *doc owns the
   standard*; mark the learning promoted so recall points to the doc. Never
   merge a standard into a doc without then recording lineage AND marking the
   learning promoted.
7. **NEVER clobber an authored doc** (promote) — read-then-merge under a stable
   heading; never overwrite a whole context doc.
8. **NEVER modify source code** — distill catalogs knowledge and merges
   standards into context docs; it does not edit the project's application code.
