---
layer: conduct
tier: boot
scope: universal
summary: Cross-actor baseline every Igris actor follows — commits, code quality, security, testing, claims-and-evidence, brief-first.
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

- Imperative mood, 72-char summary max (≤72; enforced by the `commit-msg` hook).
- Reference briefs in the footer: `closes #BR-XXX`.
- **No AI signatures** — no "Generated with…", no Co-Authored-By tags.

## Code Quality

- Run the linter/analyzer before committing (zero issues).
- Follow the project's relevant context docs. The context-doc type catalog lists
  when to consult each doc (`consult_when`) and when a change makes it stale
  (`maintain_when`).
- Document public APIs.

## Security

- No hardcoded secrets or credentials.
- Validate at system boundaries (user input, external APIs).
- Fail fast with actionable errors.

## Testing

- Unit-test business logic; cover state transitions and edge cases.
- All tests pass before commit.

## Claims and Evidence

A claim ships only at the scope it was measured at. This applies to every
sentence an actor writes about a measurement — brief, plan, review, summary,
docstring, comment, commit message — not only to test code.

### Writing a claim

1. **Quote the measurement and name its scope.** Let the reader draw the
   summary; do not draw it for them one step removed from the evidence.
2. **A verification word applied to a SET is a claim about every member.**
   Split the set at the verification boundary rather than taking the strongest
   member's status for the whole.
3. **A guarantee is a claim about what cannot happen, and it is never
   measurable when written.** Either ship the mechanism that would detect the
   failure, or state the fact and stop. Do not attach "so this cannot recur" to
   a correction.

### Verifying a claim by mutation

These four apply once you have chosen mutation as your verification method.

4. **A stated rationale is a claim, and belongs in the mutation battery.**
   "We do X rather than Y because Y would Z" asserts that Y does Z.
5. **A GREEN mutation is a finding about the probe input before it is a finding
   about the code.** Find the input that separates the implementations.
6. **A mutation harness asserts the anchor string was found AND the subprocess
   return code** — never merely a count of FAILED lines.
7. **Ship a control mutation that must SURVIVE**, so "all killed" is a
   measurement rather than a stuck instrument.

Nothing gates this while you write. Warden REJECTs on it at review — but on the
claude harness only: measured 2026-08-13, the codex, gemini and opencode warden
copies carry zero occurrences of the check (TD-385). Provenance, measured
instances, and this obligation's true enforcement strength:
`core/enforcement/rationale-is-a-claim.md`.

## Brief-First

Before **any** file modification, a brief must exist for the work.
Exceptions: read-only operations, `git status`/`log`, research, and brief management itself.
