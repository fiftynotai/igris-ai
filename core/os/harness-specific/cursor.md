---
harness: cursor
delegation_model: inline
summary: What the Cursor harness needs taught — cursor-agent is a single agent with NO subagent spawning, so it follows the shared inline delegation recipe.
---

# Cursor — harness-specific

Cursor's `cursor-agent` runs as a **single agent**: it has no static Igris agent files AND no runtime `define_subagent` mechanism — there is no subagent to spawn at all.

To delegate, follow the shared inline delegation recipe: [`_inline-delegation-recipe.md`](_inline-delegation-recipe.md). Read the canonical `~/.igris/core/agents/<role>.md`, **adopt** its body + tool scope as your operating contract, execute the task INLINE as that role to completion, then resume.
