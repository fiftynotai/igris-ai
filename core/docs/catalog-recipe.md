# Reusable-assets catalog recipe (the "lego" store)

The canonical procedure for cataloging and reusing assets. Both `/harvest`
(Phase 3 — capture) and `/reuse` (consume) point here instead of re-prosing it,
so the recipe has one home. The tools are the existing `igris_registry_*` MCP
surface — there is no separate catalog tool.

## What lives in the catalog

The catalog is the brain `registry` table — **reference-shaped rows**, not the
code itself. Each row records:

- **What it is** — `name`, `type` (`template` = full project scaffold;
  `module` = standalone cherry-pickable component, *including pub.dev/npm
  packages and SDKs*), `description`.
- **Where it lives** — `github_repo` + `github_path` for repos, OR `source`
  (`pub.dev` | `npm` | `github` | …) + `source_ref` (package name / spec) for
  non-github assets. A pub.dev package sets `source: "pub.dev"`,
  `source_ref: "<package_name>"`.
- **When to reach for it** — `when_to_use` (the reuse-fit cue) + `tags`.
- **How to integrate** — `install_command`, `rebrand_checklist` (for
  templates), `framework`, `archetype`, `source_project`.

## What is a "standalone module"

A self-contained unit with a clear boundary that a *different* project could
adopt without dragging in the rest of its origin: a design-kit package, an
auth module, a reusable service, an SDK, a starter template. If extracting it
would require copying half the source project, it is not standalone — do not
catalog it.

## Dedup before registering (load-bearing)

**Always search before adding** — a duplicate row is the failure this recipe
exists to prevent.

```
igris_registry_search({ query: "<name + keywords>", type: "module" })
```

- **Strong match exists** → offer to **skip** (already cataloged) or
  **update** (`igris_registry_update` — enrich `when_to_use`/`source`/tags or
  refresh a stale `install_command`/`rebrand_checklist`). Never create a second
  row for the same asset.
- **No match** → register it.

## Register an asset

```
igris_registry_add({
  name:           "<asset name>",
  type:           "template" | "module",
  github_repo:    "<owner/repo>",        # REQUIRED by the registry — ask the
                                          # operator if not derivable, or skip
                                          # rather than inventing a value
  github_path:    "<path within repo>",   # optional
  source:         "pub.dev" | "npm" | "github" | ...,   # for non-github assets
  source_ref:     "<package name / spec>",              # pairs with source
  description:    "<what it is>",
  when_to_use:    "<the reuse-fit cue — when a future project should grab this>",
  install_command:"<how to add it, e.g. 'flutter pub add <pkg>'>",
  tags:           "<comma-separated: domain, tech, archetype>",
  framework:      "<e.g. flutter, typescript>",
  archetype:      "<e.g. enterprise-mvvm-mobile>",
  source_project: "<project-slug where it originated>",
  standalone:     true,
  rebrand_checklist: "<for templates — white-label steps>"
})
```

## Consume an asset (reuse before rewrite)

Before building something new, search the catalog. If a lego block fits, reach
for it:

```
igris_registry_search({ query: "<what you're about to build>" })
igris_registry_get({ id: "<match id>" })   # full detail incl. rebrand_checklist
```

Then scaffold from the template (`install_command`, then work the
`rebrand_checklist`) or add the package (`source`/`source_ref` →
`install_command`). The `/reuse` skill drives both flows.
