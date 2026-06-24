---
layer: conduct
tier: boot
scope: universal
summary: Cross-actor baseline every Igris actor follows — commits, code quality, security, testing, brief-first.
---

# Igris — Universal Standards

The baseline every actor follows (orchestrator, subagents, workers, teammates).

## Commit Format

Conventional Commits: `<type>(<scope>): <summary>`

| Type | Purpose |
|------|---------|
| feat | New feature |
| fix | Bug fix |
| refactor | Code refactoring (no behavior change) |
| docs | Documentation only |
| chore | Maintenance tasks |
| test | Test additions/changes |

- Imperative mood, &lt;72-char summary.
- Reference briefs in the footer: `closes #BR-XXX`.
- **No AI signatures** — no "Generated with…", no Co-Authored-By tags.

## Code Quality

- Run the linter/analyzer before committing (zero issues).
- Follow the project's relevant context docs — the INDEX lists them (coding_guidelines, architecture, design, brand — whichever apply to what you're building).
- Document public APIs.

## Security

- No hardcoded secrets or credentials.
- Validate at system boundaries (user input, external APIs).
- Fail fast with actionable errors.

## Testing

- Unit-test business logic; cover state transitions and edge cases.
- All tests pass before commit.

## Brief-First

Before **any** file modification, a brief must exist for the work.
Exceptions: read-only operations, `git status`/`log`, research, and brief management itself.
