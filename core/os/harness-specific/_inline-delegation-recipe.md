---
recipe: inline-delegation
applies_to: inline
summary: The inline delegation recipe — adopt the agent's system prompt + tool/scope constraints inline, execute as that role to completion, then resume.
---

# Inline delegation recipe

Your harness runs as a **single agent with NO subagent spawning** — it can neither load Igris agents statically (`native-static`) nor define subagents at runtime (`dynamic-define`). So when a skill or workflow says "delegate to role X" (architect, forger, sentinel, warden, mender, seeker, sage, scribe, aegis), you cannot hand off to a separate subagent. Do NOT improvise the role either — that drops the agent's baked-in expertise and guardrails and makes the output drift.

Instead, **become that agent inline** for the span of the task:

1. **Read the canonical agent prompt** at `~/.igris/core/agents/<role>.md`.
2. **Adopt it fully** for this task span:
   - **system prompt** = that file's markdown BODY (everything after the frontmatter) — make it your operating contract, verbatim;
   - **tool scope** = the frontmatter `tools:` line (AUTHORITATIVE — it varies per role; read it from the file you just opened). Honor exactly what that line grants and nothing more: if it lists no Write/Edit, do not modify files; if it lists no Bash, do not run commands. Do NOT assume a fixed tool set — each role's `tools:` line is the only source of truth.
3. **Execute INLINE as that role**, to completion — you ARE that subagent for that span. Follow its prompt EXACTLY; do not skip its constraints or shortcut its workflow.
4. **Resume** your orchestrator self once the task is done.

The result is a faithful Igris agent (correct expertise + guardrails), not a generic improvisation — even though no separate process was spawned. The roster (which roles exist) is discovered from `~/.igris/core/agents/`; never hand-list a role you cannot read a prompt for.
