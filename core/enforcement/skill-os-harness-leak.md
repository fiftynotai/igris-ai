---
obligation: "Skills and the OS core must name only abstract intents, never harness-specific branches"
mechanism: gate
status: shipped
lives_in: "scripts/validate_skill_os_harness_leak.py"
summary: "Pre-commit validator scans core/skills/*/SKILL.md + core/os/*.md + core/prompts/*.md for known harness-leak token classes (CLAUDE_CODE_* flags, per-harness config-path targets, define_subagent/invoke_subagent) and hard-fails on a genuine instruction-level leak; an explicit allowlist exempts the adapter-authoring/by-design files."
---

# Skill/OS harness-leak guard (TD-248)

Skills and the OS core must express only **abstract intents** — they delegate
through the harness-agnostic adapter boundary, never by hardcoding one
harness's env var, behavior flag, per-harness config path, or runtime-subagent
API. When a harness-specific branch leaks into a skill or OS doc it silently
breaks (or silently no-ops) on every other harness. TD-244 (the `/hunt`
delegation contract) and TD-247 (`/team` Agent-Teams) are the cautionary tales.

The pre-commit validator scans `core/skills/*/SKILL.md`, `core/os/*.md`, and
`core/prompts/*.md` and hard-fails on a genuine, instruction-level hit in the
known token classes:

- harness experimental/behavior flags (`CLAUDE_CODE_*`)
- per-harness config paths used as a read/write target (`.claude/agents/`,
  `.claude/settings.json`, `~/.gemini/`, `~/.config/opencode/`, `.codex/`)
- runtime-subagent APIs (`define_subagent` / `invoke_subagent`)

## Branch vs mention

A token is flagged only when it appears as an **executable instruction** —
inside a fenced code block, or on a line carrying an imperative verb / redirect
/ glob shape that makes the path a target. A bare **prose mention** describing
the adapter mechanism (e.g. "the MCP server is registered in `~/.claude.json`")
is NOT flagged, nor is the disclaimed brand word "Claude" in identity/voice
prose. `subagent_type` is never flagged — it is the harness-agnostic delegation
CONTRACT, not a branch.

## Allowlist

An explicit, commented constant in the validator exempts the files where
harness-specific tokens are by design, a declared single-harness capability, or
a known-deferred leak tracked elsewhere: `onboard-harness/SKILL.md` (the
adapter-authoring guide), `core/os/surfaces-detail.md` (documents the adapter
boundary), `team/SKILL.md` (declared single-harness — Claude-native Agent-Teams,
FR-202 M6; intentional, not a leak to remove), and the deferred leak
(`igris_os.md` → TD-247). The allowlist
must never be broadened to launder a real leak — a new entry is questioned in
review (L-448).

## Scope honesty (L-400)

This is a **recurrence net for the known token classes, not a completeness
proof**. It catches a new `.claude/`-path instruction or a new `CLAUDE_CODE_*`
flag; it does NOT catch a novel harness behavior expressed in fresh vocabulary.
It is conservative by design — when a hit is ambiguous it does not flag, because
under-flagging is recoverable while over-flagging erodes trust and trains
`--no-verify` habits. Same posture as the strict-YAML frontmatter guard: it
catches the known bug class, no more.
