---
name: claude-only-skill
description: Fixture whose body contains Agent() to trigger Codex exclusion
disable-model-invocation: false
allowed-tools:
  - Task
  - Read
triggers:
  - "CLAUDE-ONLY"
---

# Claude-Only Fixture

This skill orchestrates subagents via Agent(forger) and Agent(sentinel).

The `is_claude_only` heuristic should match `\bAgent\(` in the body and
exclude this skill from the Codex `AGENTS.md` output.

## Why Claude-Only

Skill(rest) style invocations and Agent() calls are Claude-native APIs that
make no sense when surfaced to plain markdown consumers like Codex.
