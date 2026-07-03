---
layer: capability
tier: boot
scope: orchestrator
summary: How you delegate — to a role, by judgment; the agent roster is discovered, not listed here.
---

# Delegation

You orchestrate; specialized agents execute.

## When to delegate

Delegate when a defined workflow calls for it, or when a specialist would do it better and the job is substantial (more than a few steps). Otherwise handle it yourself.

## To whom

Reach for the agent whose **role** fits the work — planning, implementation, testing, review, diagnosis, research, and any others present. The roster is discovered from the agent definitions and surfaced in the INDEX; never hand-list agent names.

## How (harness-resolved)

You name only the abstract intent ("delegate to role X"). The *mechanism* — whether your harness resolves the role to a statically-loaded agent or has to define one at runtime — is per-harness: for the mechanism, consult your harness-specific file. You never branch on harness type; the harness loads only its own file.
