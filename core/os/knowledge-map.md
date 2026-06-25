---
layer: knowledge-map
tier: on-demand
scope: orchestrator
summary: The map of where knowledge lives — the stores, what each holds, and the rule for routing a fact to the right one.
consult_when: deciding where a piece of knowledge belongs / routing knowledge across stores
---

# Knowledge Map

The OS's knowledge lives in distinct **stores**. Each holds one kind of knowledge, with one authoritative medium and one way to keep it in sync. This is the map you consult when deciding where a fact belongs.

## The stores

| Store | Kind it holds | Authoritative medium | Sync mechanism |
|---|---|---|---|
| Memory | experiential structured-records (learnings, goals, errors, metrics, sessions-meta, briefs-meta, graph) — route each by kind to its table | brain DB (`knowledge.db`) | VPS push/pull (accumulated knowledge) |
| Project-context docs | curated authored-prose standards (coding_guidelines, architecture, design, brand) | file (`~/.igris/projects/{project}/context/`) | *(portability follow-on)* |
| Catalog (reusable-assets "lego" store) | reusable-asset references — what · where · when-to-use · how-to-integrate (NOT the asset code) | brain DB `catalog` table (`knowledge.db`) | VPS push/pull (in SYNC_TABLES) |
| Loadout (your portable personal overlay) | the operator's bring-your-own extensions — personal skills / subagents / MCPs that project to harnesses; carried machine-to-machine | files (`~/.igris/registry/` — dir + `igris registry` verb rename to `loadout` pending) | *(portability follow-on)* |
| Code | code facts (ground truth) | the repo | external — **read, never stored** |
| Git | history | git | external — **read, never snapshot** |

## The routing principle

**Each store holds ONE kind of knowledge with ONE authority. Route a fact to the store matching its KIND** (standard → doc, lesson → memory, code-fact → code, history → git, structured-record → its DB table). **A fact lives in exactly one source — never duplicated. When a fact changes kind, it MOVES (promotes), never copies.** Memory stages raw lessons; a lesson that hardens into a standard **promotes** into a doc (via `/promote`) — memory is staging, docs are curated, promotion is the pipeline.

Project-context docs are a store; their *types* are the self-describing **catalog** at `core/context-doc-types/` (one definition per type, declaring when it applies, when to consult it, and when it goes stale). `/promote` reads the catalog to route a hardened standard to the right doc; `/ground` authors a doc from its type's skeleton.

The Catalog store is the reusable-assets catalog. It is consulted **reuse-before-rewrite** (`conduct` → "Reuse before rewrite"): search it before building something new and reach for a block if one fits via `/reuse`; `/harvest` seeds it. The shared mechanics are in `core/docs/catalog-recipe.md`.

**Loadout vs Catalog — the test.** Loadout is what you bring *into* the OS: your personal skills / subagents / MCPs, projected to your harnesses via `igris add`, carried machine-to-machine (push to the VPS, pull on a fresh install). The Catalog is what you reach *for* when building: reusable blocks consulted reuse-before-rewrite. One **extends** the OS with your customizations; the other **supplies** blocks to reuse — different kinds, different stores, never conflated.

Build-state (the answer to "is this brief built?") is a structured-record fact whose authority is **`brief_status.status` in the Memory DB** — read it via `igris_brief_dashboard`/`igris_brief_list`, never infer build-state from a plan doc (plans are INTENT, not state; the #811 failure). `phase` and `git log` are supporting/ground-truth and must agree; the reconciliation validator surfaces any disagreement. See `docs/architecture/brief-state-source-of-truth.md`.

Extensible by construction: add a store → it declares the three axes (kind · authoritative medium · sync mechanism) → routing, de-dup, and portability all absorb it, no collision possible.
