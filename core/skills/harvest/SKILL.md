---
name: harvest
description: "Harvest reusable knowledge from a project into the brain - guided, dedup-checked capture of learnings (memory), modules (the lego catalog), and the project archetype."
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
  - mcp__igris-brain__igris_memory_recall         # Phase 4 dedup pre-check
  - mcp__igris-brain__igris_memory_search         # Phase 4 dedup (FTS)
  - mcp__igris-brain__igris_memory_store          # Phase 4 store (source_extractor:'distill')
  - mcp__igris-brain__igris_memory_get            # inspect a candidate's full content
  - mcp__igris-brain__igris_brief_dashboard       # Phase 1 completed-brief scan
triggers:
  - "HARVEST"
  - "harvest"
  - "harvest knowledge"
  - "extract learnings"
  - "capture knowledge"
---

# HARVEST — Knowledge Capture Skill

Deliberately harvest reusable knowledge from a project into the brain: curated
**learnings** (memory), reusable **modules** (registry / the lego catalog), and
the project **archetype**. Every step is **operator-guided, never automatic** —
this is the proven principle from the original capture design (revived FR-100):
the model proposes, the operator decides what is worth keeping.

## 0. Track Invocation

Silently emit a skill invocation event (never blocks execution):
```bash
bash "$CLAUDE_PROJECT_DIR/scripts/emit_skill_event.sh" "harvest" 2>/dev/null || true
```

---

Guided harvest in six phases. Determine the current project slug, name, and
absolute path up front (the project the operator is in) — Phases 2–4 key off it.

> **Degradation (applies to EVERY brain call below):** if the `igris-brain` MCP
> server is unavailable, do **not** block. Continue the operator interview,
> collect the same answers, and warn **once** at the top:
> `Note: brain MCP unavailable — capturing the interview locally; the learnings/modules/archetype will not be persisted to the brain this run. Re-run /harvest when the brain is reachable to store them.`
> Then, for each phase that would have written to the brain, write a clean
> capture note to `~/.igris/projects/{project}/context/harvest-capture-{date}.md`
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
     **Do NOT "fix" this to `'harvest'`:** the value is a *persisted DB
     channel-tag enum* (`VALID_SOURCE_EXTRACTOR`), not the skill name. The skill
     was renamed `/distill` → `/harvest`, but the enum value intentionally stays
     `'distill'` — every learning already stored carries it, and renaming the
     enum would orphan those rows and force a DB migration. The invocation NAME
     and the channel-tag value are deliberately decoupled.
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
## Harvest complete — <project-slug>

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

## Constraints

1. **GUIDED, never automatic** — the operator chooses every archetype, module,
   and learning. The model proposes; it never silently stores a learning.
2. **DEDUP before writing** — `igris_memory_recall` / `igris_registry_search` a
   candidate before creating a new row (offer skip/merge/update). This is the
   load-bearing guard against duplicate-knowledge drift.
3. **`source_extractor: "distill"`** on every Phase-4 `igris_memory_store` (the
   persisted channel-tag enum — NOT the skill name; intentionally kept after the
   `/distill` → `/harvest` rename, see the Phase-4 note).
4. **Curate, don't dump** — capture targets 3–8 learnings; resist storing
   everything — curation is the value.
5. **Graceful degradation** — brain absent → continue the interview, warn once,
   write a local capture note, never block.
6. **NEVER modify source code** — harvest catalogs knowledge into the brain; it
   does not edit the project's application code.
