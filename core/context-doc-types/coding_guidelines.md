---
type: coding_guidelines
target: coding_guidelines.md
tree_key: coding_guidelines
applies_when: "all projects (every project has code conventions to follow)"
consult_when: "writing or reviewing code, naming things, choosing a pattern, or making a code-level decision"
maintain_when: "a code convention, naming rule, or reusable pattern changes or is newly agreed"
summary: "The project's code conventions — naming, structure, idiomatic patterns, and the decisions that shape how code is written."
optional: false
kind_affinity: "decision, pattern"
---

# coding_guidelines

The project's authoritative code conventions: how code is named, structured, and
written, plus the reusable patterns and code-level decisions the project has
hardened into standards. This is the doc `/promote` graduates a code **decision**
or reusable code **pattern** into.

## Section skeleton

> The structure `/standardize` authors from. Fill each section from the project's
> actual code (base-repo analysis, project analysis, or merged best-practices).

## Naming conventions
Files, types, functions, variables — the casing and naming rules the project follows.

## Structure & organization
How code is laid out within a module/layer; where a given kind of code belongs.

## Idiomatic patterns
The reusable code patterns the project standardizes on (error handling, dependency
injection, state management, async, etc.) — the rule, the why, and when to apply it.

## Decisions
Code-level decisions the project has made and stands by (a chosen library, a
rejected approach, a convention with a non-obvious reason) — each with its why.
