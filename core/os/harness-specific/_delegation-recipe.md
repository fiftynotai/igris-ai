---
recipe: delegation
applies_to: dynamic-define
summary: The canonical delegation recipe — read the agent's system prompt, define the subagent from it, invoke.
---

# Delegation recipe

Your harness defines subagents at runtime instead of loading Igris agents statically. When a skill or workflow says "delegate to role X" (architect, forger, sentinel, warden, mender, seeker, sage, scribe, aegis), do NOT improvise the role — that drops the agent's baked-in expertise and guardrails and makes the output drift.

Instead:

1. **Read the canonical agent prompt** at `~/.igris/core/agents/<role>.md`.
2. **Define the subagent** with:
   - **system prompt** = that file's markdown BODY (everything after the frontmatter), verbatim;
   - **tool scope** = the frontmatter `tools:` line (AUTHORITATIVE — it varies per role; read it from the file you just opened). Map those tools to this harness's native equivalents and honor exactly what that line grants and nothing more: if it lists no Write/Edit, do not modify files; if it lists no Bash, do not run commands. Do NOT assume a fixed tool set — each role's `tools:` line is the only source of truth.
3. **Invoke** the defined subagent with the task.

The delegated subagent is then a faithful Igris agent (correct expertise + guardrails), not a generic improvisation. The roster (which roles exist) is discovered from `~/.igris/core/agents/`; never hand-list a role you cannot read a prompt for.
