---
name: reuse
description: "Reuse before rewrite - search the reusable-assets catalog (the lego store) and either scaffold a new project from a template or add a cataloged package/module to the current project. Modes: scaffold-template, add-package."
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - mcp__igris-brain__igris_catalog_search         # find a matching asset
  - mcp__igris-brain__igris_catalog_get            # full detail of a match
  - mcp__igris-brain__igris_catalog_list           # browse the catalog
  - mcp__igris-brain__igris_catalog_update         # correct a stale row found mid-flow
triggers:
  - "REUSE"
  - "reuse"
  - "reuse before rewrite"
  - "scaffold from template"
  - "add a package"
  - "grab a lego block"
---

# REUSE — Reusable-assets Catalog Integration Skill

Reach into the reusable-assets catalog (the "lego" store) instead of rebuilding.
The catalog mechanics live in the **shared catalog recipe** —
**Read it first:** `~/.igris/core/docs/catalog-recipe.md`. This skill drives the
*consume* side of that recipe (`/harvest` drives the *capture* side); both follow
the same recipe so the catalog has one home. The tools are the existing
`igris_catalog_*` MCP surface — there is no separate catalog tool.

## Arguments

`$ARGUMENTS` = **`[mode] [query]`**.

**Mode** (first token, optional):
- `scaffold-template` → start a NEW project from a cataloged `template`.
- `add-package` → add a cataloged `module`/package to the CURRENT project.
- **Empty / omitted** → infer from intent: if the operator is starting a new
  project, `scaffold-template`; if extending an existing one, `add-package`. If
  unclear, ask once.

**Query** (remaining tokens, optional): what they want (e.g. "branded buttons",
"enterprise mobile MVVM"). If omitted, ask what they're trying to build, then
search on that.

## Degradation (applies to every brain call)

If the `igris-brain` MCP server is unavailable, do **not** block. Warn once:
`Note: brain MCP unavailable — the reusable-assets catalog can't be searched this run. Re-run /reuse when the brain is reachable, or proceed manually.`
Then offer to proceed without the catalog (the operator may know the asset
directly). Never error, never block — same convention as `/harvest` and `/awaken`.

## 1. Search the catalog

Per the recipe's "consume an asset" step, search for what the operator is about
to build **before** building it:

```
igris_catalog_search({ query: "<what they want>", type: "<template|module per mode>" })
```

- For `scaffold-template`: `type: "template"`.
- For `add-package`: `type: "module"`.
- Widen the query / drop the `type` filter if the first pass is empty;
  `igris_catalog_list` to browse if the operator wants to see the shelf.

## 2. Present matches

Show the operator the top matches with the reuse-fit cue front and center:
name, `when_to_use`, `description`, where it lives (`github_repo`/`github_path`
or `source`/`source_ref`), `framework`/`archetype`, `install_command`. Pull full
detail with `igris_catalog_get({ id })` for the chosen match (includes the
`rebrand_checklist`).

- **No match** → say so plainly. Offer to build it fresh AND remind the operator
  that `/harvest` Phase 3 can catalog the result afterward so the next project
  reuses it. Do not invent a catalog row here — capture is `/harvest`'s job.
- **A near-match with stale/missing detail** → offer to enrich the row via
  `igris_catalog_update` (e.g. fill `when_to_use`, fix `install_command`) so the
  catalog improves as it's used.

## 3a. Scaffold from a template (mode: scaffold-template)

1. Confirm the chosen template and the new project's name/path with the operator.
2. Run its `install_command` (or clone `github_repo`/`github_path` if no command).
3. Work the `rebrand_checklist` — the concrete white-label steps (app name,
   bundle id, color tokens, logo, API endpoints, store metadata). Tick each item
   with the operator; this is the value of a template over a blank repo.

## 3b. Add a package/module (mode: add-package)

1. Confirm the chosen module and the current project it's going into.
2. Add it via its `install_command` (e.g. `flutter pub add <source_ref>` when
   `source` is `pub.dev`, or `npm add <source_ref>` for npm), or vendor from
   `github_repo`/`github_path` if it's a copy-in module.
3. Wire it into the project following its `description`/`when_to_use`; point the
   operator at the source for usage docs.

## 4. Summary

Report what was reused:
```
## Reuse complete

- Mode: <scaffold-template | add-package>
- Asset: <name> (<id>)
- Source: <github_repo/path | source:source_ref>
- Action: <scaffolded new project at <path> | added to <project>>
- Rebrand checklist: <N/A | <done>/<total> items worked>
```
If no asset matched, say so and remind the operator that building fresh is fine —
just `/harvest` it afterward to seed the catalog for next time.

---

## Constraints

1. **Reuse before rewrite** — search the catalog before building something new.
   This skill exists to make "grab a lego block if one fits" the default move.
2. **Follow the shared recipe** — `~/.igris/core/docs/catalog-recipe.md` is the
   canonical procedure; do not re-invent the dedup/register/consume mechanics.
3. **Consume, don't capture** — `/reuse` reads the catalog and integrates assets;
   it does NOT create catalog rows. Cataloging new assets is `/harvest` Phase 3.
   (Enriching a stale existing row via `igris_catalog_update` mid-flow is fine.)
4. **Operator-confirmed** — never scaffold or add a dependency without the
   operator confirming the asset and the target.
5. **Graceful degradation** — brain absent → warn once, offer to proceed
   manually, never block.
