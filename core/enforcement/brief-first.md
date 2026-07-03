---
obligation: "Brief-first — a brief must exist before any file modification"
mechanism: gate
status: shipped
lives_in: "core/hooks/shared/pre_tool_use.sh"
summary: "PreToolUse hook blocks Write/Edit when no Active Brief is in progress; one-shot escape via IGRIS_BYPASS_BRIEF_GATE."
---

# Brief-first

The brief-first conduct rule is enforced at the harness boundary: a `PreToolUse`
hook (`core/hooks/shared/pre_tool_use.sh`) refuses a Write/Edit unless a brief is
in progress. Fail-open emergency escape: `IGRIS_BYPASS_BRIEF_GATE=1` (one-shot,
never exported).
