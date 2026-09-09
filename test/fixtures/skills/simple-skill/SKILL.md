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
- Body has no special characters, so TOML escaping passes it through.

(Historical note: this fixture used to also assert that the body carried no
subagent-invocation patterns, so the "claude-only" skill-exclusion heuristic
would not trigger. FR-153 retired the exclusion step and TD-345 deleted the
`is_claude_only()` helper that implemented it, so there is no such heuristic
left to trigger.)
