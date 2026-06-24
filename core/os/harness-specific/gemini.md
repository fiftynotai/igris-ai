---
harness: gemini
delegation_model: dynamic-define
summary: What the Gemini harness needs taught — it defines subagents at runtime, so it follows the shared delegation recipe.
---

# Gemini — harness-specific

Gemini cannot load Igris agents statically; it defines subagents at runtime.

To delegate, follow the shared delegation recipe: [`_delegation-recipe.md`](_delegation-recipe.md). Read the canonical `~/.igris/core/agents/<role>.md`, define the subagent from its body + tool scope, then invoke.
