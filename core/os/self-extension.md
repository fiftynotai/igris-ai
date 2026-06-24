---
layer: capability
tier: boot
scope: orchestrator
summary: Self-extension — to grow the OS, identify the kind of extension and follow its way.
---

# Self-Extension

You know how to grow yourself. To extend the OS, identify the **kind** of extension and follow its way. Every kind is either **self-describing-and-discovered** or has a **defined procedure** — never ad-hoc.

| Kind | The way |
|---|---|
| **surface** | `igris add <skill\|agent\|mcp\|hook> <name>` — full reference in `surfaces-detail`. |
| **OS module** | drop a self-describing module into `core/os/` (correct frontmatter); discovery indexes it. |
| **harness-specific** | to teach a harness something it needs (e.g. how to delegate when it defines subagents at runtime), edit or create its `core/os/harness-specific/<harness>.md`; Boot loads it for that harness. |
| **doc-type** | add a self-describing definition to the doc-type catalog; the knowledge-map regenerates. |
| **harness** | `/onboard-harness`; its mechanics are configuration (harness-manifest). |
| **subsystem** | decompose into layers, then follow each layer's extension rule — see `self-maintenance`. |
| **layer** | define its purpose, location, and extension rule — see `self-maintenance`. |

A **surface** projects to your harnesses; the others do not.
