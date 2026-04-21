---
name: simple-skill
description: A minimal test fixture with flat frontmatter
disable-model-invocation: false
allowed-tools:
  - Read
  - Bash
triggers:
  - "SIMPLE"
---

# Simple Test Skill

This is the shortest possible skill body used for round-trip conversion tests.

## Usage

Call this skill when you need to verify basic frontmatter parsing and
body extraction.

## Notes

- Plain top-level frontmatter keys, no nested override block.
- Body has no subagent invocation patterns, so the claude-only heuristic
  should not trigger.
- Body has no special characters, so TOML escaping passes it through.
