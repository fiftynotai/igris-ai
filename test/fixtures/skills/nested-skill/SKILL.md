---
name: nested-skill
description: Fixture exercising nested override block with Claude-specific keys
disable-model-invocation: false
platform_overrides:
  claude:
    allowed-tools:
      - Read
      - Write
      - Grep
      - mcp__igris-brain__igris_brief_list
    triggers:
      - "NESTED"
      - "deep frontmatter"
---

# Nested Skill Fixture

This fixture verifies that nested Claude-specific frontmatter keys are
preserved for Claude but stripped when converted for Gemini and Codex.

## Portability

A helper script lives alongside this skill and should be ignored by both
converters -- they read only the top-level skill definition file.
