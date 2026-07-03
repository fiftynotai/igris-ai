---
harness: antigravity
delegation_model: dynamic-define
summary: What the Antigravity harness needs taught — it defines subagents at runtime, so it follows the shared delegation recipe.
---

# Antigravity — harness-specific

Antigravity cannot load Igris agents statically; it defines subagents at runtime (`define_subagent` / `invoke_subagent`).

To delegate, follow the shared delegation recipe: [`_delegation-recipe.md`](_delegation-recipe.md). Read the canonical `~/.igris/core/agents/<role>.md`, define the subagent from its body + tool scope, then invoke.
