---
layer: reference
tier: on-demand
scope: orchestrator
summary: How to correctly extend the Igris OS itself — find the layer, follow its rule, sweep the consumers.
consult_when: before working on or extending the Igris OS itself
---

# Self-Maintenance

Consult this before working on the Igris OS itself. Canonical spec: **`plans/FR-187/os-architecture.md`** — the full layer table, each layer's extension rule, and the frontmatter schema. Read it before non-trivial OS work.

The OS is a layered, self-describing architecture: every concern belongs to exactly one layer; each layer has one location and one extension rule; parts declare their own metadata so the OS discovers them and generates its index. To add anything: **find its layer, then follow that layer's extension rule.**

## Find the layer — the boundary tests

- **Change-together = one layer.** Things that change together belong in the same layer; things that change independently are separate layers. That's the test for whether something earns its own layer.
- **Invoke vs always-follow.** If you *invoke* it (`/hunt`), it's a **protocol** — a skill. If you *always follow* it (brief-first, the delegation decision, the consumer sweep), it's **conduct** — a rule, never a skill.
- **Contract vs implementation.** What the model reads is a **contract**; the code/data behind it is the **implementation**. A contract **never names** its implementation — so the mechanism swaps without touching what the model reads. A DB path, a tool count, or wiring detail belongs on the mechanism side.

Adding a capability module? Drop a self-describing `core/os/<cap>.md` with correct frontmatter; discovery indexes it — no registry to hand-edit. Same shape for every layer: add a self-describing part, the index regenerates.

## Extend a subsystem

A subsystem spans more than one layer. Don't treat it as a single unit: **decompose it into its layers, place each piece in the layer it belongs to, then follow that layer's extension rule.** The project-context-docs subsystem is the worked example — its catalog is OS core (self-describing doc-type definitions), its generate workflow is a protocol (skill), its presence-enforcement is enforcement + conduct, its instances are OS project-knowledge, and its inventory is a shared CLI primitive consumed by the protocol surfaces.

**Enforcement-layer extension rule:** to add an enforcement, drop the mechanism — a hook/gate in `core/hooks/` (or a gate-step in a skill) for a `gate`, a pipeline for `automation`, or nothing for `honor-system` — AND a self-describing definition in `core/enforcement/<slug>.md` (frontmatter: `obligation` · `mechanism` · `status` · `lives_in` · `summary`), then re-run `core/scripts/gen_enforcement_registry.sh` so `core/enforcement/INDEX.md` regenerates. Never hand-edit the INDEX.

## Add a new layer

A new layer is rare. Earn it with the change-together test: a concern only deserves its own layer when it changes independently of every existing one. To add it, **define its three properties** — purpose (the one concern it owns), location (where its parts live), and extension rule (how new parts are added) — then record it in the architecture spec.

## The maintenance discipline

When you change a **contract**, you may have changed what its **consumers** rely on. Sweep them: **`MAINTAINING.md`** (repo root) is the contract→consumer map. Find the contract you touched, check each consumer it lists, and update anything stale. Same discipline as a code refactor's call-site sweep — a contract with drifted consumers is a silent breakage waiting to surface.
