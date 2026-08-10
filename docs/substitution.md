# Why not Spec Kit + Ruler + mem0 + a memory tool?

**Dated:** 2026-06-26

This is the honest substitution case. IGRIS is not claiming every underlying feature is unique. The ecosystem now has strong tools for spec-driven development, cross-agent rule projection, and agent memory. The IGRIS claim is integration: work-state, enforcement, lifecycle, and memory are one DB-backed system projected into every harness.

## The strongest rival stack

| Piece | Steelman |
|-------|----------|
| [Spec Kit](https://github.com/github/spec-kit) | A practical spec-driven workflow for turning intent into plans and tasks before code changes. It is lightweight, model-adjacent, and does not require adopting an entire engineering OS. |
| [Ruler](https://github.com/intellectronica/ruler) | A clean way to keep agent instructions consistent across multiple coding tools. It reduces drift between Claude, Cursor, Codex, Copilot, and other assistants without asking teams to change their whole workflow. |
| [mem0](https://github.com/mem0ai/mem0) | A serious memory layer for AI agents and applications. It gives teams a reusable memory substrate without forcing that memory to be tied to a particular brief lifecycle. |
| A memory/checkpoint tool | For many teams, a simple handoff file, session transcript, or checkpoint document is enough. It is easier to inspect, easier to delete, and cheaper to adopt than a coordinated brain. |

Together, that stack can cover a lot:

- Specs and task lists before implementation.
- Shared instructions across several harnesses.
- Long-lived user, project, or agent memory.
- Human-readable checkpoints for resuming later.

For single-harness teams, small projects, or workflows where duplication is cheap, that may be the right trade.

## Where the substitution breaks

The break is not at "can this tool remember things?" or "can this tool write specs?" The break is at "does the whole workflow know what is happening right now, who owns it, and what is allowed to happen next?"

IGRIS hands off work-state, not just context:

- brief id, status, priority, and acceptance criteria
- current phase in the hunt state machine
- atomic claim holder and activity timestamp
- instance identity and supersession lifecycle
- agent log and retry count
- uncommitted working tree expectations
- brain-backed memory and cross-project learnings

A transcript can tell the next model what happened. IGRIS tells the next harness what may happen next.

## The integration claim

The 2026-06-12 feature-map search found cross-tool resume rivals. That demoted the broad "cross-harness resume" claim from unique to lead. The surviving claim is narrower and more useful:

> IGRIS combines briefs, phases, claims, sessions, fleet identity, sync, knowledge, and write enforcement as one lifecycle, backed by one local brain and projected into multiple harnesses.

That is why B2/G-14 matters. On 2026-06-16, the same work crossed Claude -> OpenCode -> Codex -> Antigravity mid-workflow with zero-context resume, then survived crash recovery and force-reclaim. The important fact was not that a second tool read a note. It resumed from phase and claim state.

## Choose the rival stack when

- You mainly want spec discipline, not workflow ownership.
- You trust agents to follow instructions and do not need write-deny gates.
- Your team works in one harness most of the time.
- A handoff note is enough because duplicate work is low-cost.
- You want memory as an application primitive, separate from engineering process.

## Choose IGRIS when

- Work jumps between harnesses — any of the CLIs the roster declares, not one.
  See [Harness tiers](multi-cli.md#harness-tiers) for the current membership and
  the one-line command that re-derives it.
- You need "no brief, no write" enforced by hooks and role tooling.
- Duplicate work, stale claims, and crash recovery are expensive.
- You want project memory, cross-project learnings, briefs, plans, sessions, and sync in one place.
- You want the next harness to resume the work, not the chat.

## Current harness claim

IGRIS treats Claude Code, OpenCode, and Antigravity as first-class targets — its
enforcement gates run natively there.

Codex, Gemini CLI, and Cursor are bridge harnesses: brain, skills and MCP reach
them, and agents too where the harness has a static-agent surface (Cursor has
none; it reads the canonical agent files in-process instead). Only the gates
soften to advisories.

The tier is derived, not declared — it follows from
`harnesses.<id>.hooks.supported` in `harness-manifest.json`. See
[Harness tiers](multi-cli.md#harness-tiers) for the definition and the one-line
command that re-derives the membership, rather than trusting this list to be
current.

## Sources

- B2/G-14 evidence: `~/.igris/projects/igris-ai/plans/feature-map/evidence/b2-test-plan.md`
- Feature-map search logs: `~/.igris/projects/igris-ai/plans/feature-map/evidence/search-logs.md`
- Spec Kit: <https://github.com/github/spec-kit>
- Ruler: <https://github.com/intellectronica/ruler>
- mem0: <https://github.com/mem0ai/mem0>
