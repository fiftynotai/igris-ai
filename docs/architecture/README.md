# Igris Architecture Documentation

Contributor-facing reference for how the system fits together.

**Start here if you're new:** [`SYSTEM.md`](./SYSTEM.md) is the canonical system overview — the 4 layers, the 19 brain components, the brief lifecycle, the hook dataflow, the 7-agent roster + 21 skills, and "how do I add X?" extension points. It links out to the per-feature docs below for every subsystem.

For any specific subsystem, read its per-feature doc directly. These are the source of truth; `SYSTEM.md` summarizes and cross-links.

---

## System overview

- **[`SYSTEM.md`](./SYSTEM.md)** — Contributor map of the entire system. The 4 layers (brain DB / orchestrator / subagents+skills / agent teams), the brief lifecycle, the hooks resolution order, the sync model, and the extension-point templates.

## Graph & data model

- **[`typed_edges.md`](./typed_edges.md)** — Foundational graph layer over briefs, learnings, errors, sessions, and goals (FR-105). Soft-delete on archive; relation catalog driven by enums.
- **[`graph_traversal.md`](./graph_traversal.md)** — Three read-only MCP tools — `igris_graph_neighbors`, `igris_graph_path`, `igris_graph_subgraph` — for structured navigation of the entity-edge graph (FR-113).
- **[`goals.md`](./goals.md)** — Outcome-level goals as first-class entities distinct from briefs (FR-110). Goals own measurable outcomes; briefs own work items.

## Perception & learning

- **[`perception_channel.md`](./perception_channel.md)** — LLM-only background extraction of learnings from session transcripts (FR-109, TD-066). Headless `claude -p` extractor + review-workflow gating.
- **[`provenance.md`](./provenance.md)** — Provenance tags on learnings (FR-107). Five accepted values record *how* a learning was acquired and its trust level.

## Observability & integration

- **[`subconscious_engine.md`](./subconscious_engine.md)** — Passive observer + rule-based detectors (FR-106, FR-108). **Status: DISABLED in v7 pending FR-118 redesign (TD-102).** Codebase preserved as reference material for the LLM-driven replacement.
- **[`git_hooks.md`](./git_hooks.md)** — Repo-level `pre-commit` dispatcher and conditional validators (enum drift, tree line-range drift, lockfile sync, PI-004 phase guard).

---

## Adjacent reference docs

- [`docs/HOOK_EVENT_SCHEMA.md`](../HOOK_EVENT_SCHEMA.md) — Hook event JSON contract used by all CLI bridges.
- [`docs/multi-cli.md`](../multi-cli.md) — Cross-CLI adapters (Codex, Gemini, OpenCode).
- [`docs/visualization.md`](../visualization.md) — `/visualize` skill internals (brief-graph mermaid renders).
- [`docs/operations/cli_lifecycle.md`](../operations/cli_lifecycle.md) — `igris init` / `refresh` / `install` / `update` / `doctor` lifecycle.
- [`docs/operations/perception-dedup-tuning.md`](../operations/perception-dedup-tuning.md) — Perception dedup parameters.
- [`docs/SETUP_GUIDE.md`](../SETUP_GUIDE.md), [`docs/UPDATE_GUIDE.md`](../UPDATE_GUIDE.md), [`docs/IGRIS_BRAND_BOOK.md`](../IGRIS_BRAND_BOOK.md).

---

## Maintenance contract

When you change a subsystem documented here, update the per-feature doc AND the `SYSTEM.md` summary (the system-overview sentence or table row). The contributor checklist for which enumeration surfaces to update lives in [`CONTRIBUTING.md`](../../CONTRIBUTING.md) "Documentation invariants".
