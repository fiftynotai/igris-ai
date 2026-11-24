---
type: test_standards
target: test_standards.md
tree_key: test_standards
applies_when: "testable projects (has automated tests or a test harness)"
consult_when: "writing or reviewing tests, choosing what to test, or setting up a test fixture"
maintain_when: "a testing convention, coverage expectation, or fixture pattern changes"
summary: "The project's testing conventions — what to test, how tests are structured, and the fixture patterns to follow."
optional: true
kind_affinity: "test"
---

# test_standards

The project's authoritative testing conventions: what gets tested, how tests are
structured and named, and the fixture patterns the project follows. This is the
doc `/promote` graduates a **test** standard into.

## Section skeleton

> The structure `/ground` authors from. Fill each section from the project's
> actual test suite and harness.

## What to test
The coverage expectations — which layers/behaviors must have tests (business
logic, state transitions, edge cases) and what may be skipped.

## Test structure & naming
How tests are organized, named, and grouped; the arrange/act/assert conventions.

## Fixtures & test data
The fixture patterns (builders, factories, golden files) and how test data and
state are set up and torn down.

## Conventions & decisions
Testing decisions the project stands by (a chosen runner, a mock-vs-real policy, a
rejected approach) — each with its why.

## Reviewer checks
Optional; omit it if the project has none. `/hunt` reads it, up to the next
`## ` heading, when it opens a review worktree for the tester and reviewer:
- `Review worktree links: <path>...` — gitignored dependency or build
  directories (for example `node_modules`) linked into the review worktree from
  the main checkout, so suites can run there without an install.
- `Review worktree home links: <name>...`, or `(none)` — entries of the real
  home directory the project's suites need (a toolchain cache), linked into the
  temporary HOME. Never `.igris`.
- `### Tester` — project checks the tester runs: which suites cover which
  paths, failures a fresh worktree shows at HEAD too, deploy-time checks.
- `### Reviewer` — project review items for the reviewer: what the project's
  secret scanner or release process needs a human eye for.
