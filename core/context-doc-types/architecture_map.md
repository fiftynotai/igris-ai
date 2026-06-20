---
type: architecture_map
target: architecture_map.md
tree_key: architecture_map
applies_when: "structural projects (has distinct layers, modules, or boundaries worth mapping)"
consult_when: "working across module boundaries, placing new code, or reasoning about how the system fits together"
maintain_when: "a layer, module boundary, or major structural relationship changes"
summary: "The project's structure — layers, modules, boundaries, and how the major pieces fit together."
optional: true
kind_affinity: "structural"
---

# architecture_map

The project's authoritative structural map: its layers, modules, the boundaries
between them, and how the major pieces fit together. This is the doc `/promote`
graduates a **structural** standard (layer rule, module boundary, folder
organization) into.

## Section skeleton

> The structure `/standardize` authors from. Fill each section from the project's
> actual layout and module graph.

## Layers
The project's layers (e.g. UI -> business logic -> data) and the direction of
dependency between them.

## Modules & boundaries
The major modules/packages, what each owns, and the boundary rules between them
(what may depend on what).

## Folder organization
Where a given kind of code lives on disk — the directory layout and its rationale.

## Key relationships
The load-bearing structural relationships (entry points, shared kernels, plugin
seams) and the constraints that keep them stable.
