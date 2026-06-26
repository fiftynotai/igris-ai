---
name: igris-doctor
tier: essential
description: Model-invocable diagnostic skill over the existing `igris doctor` CLI verb; runs, interprets, and safely orchestrates repairs without reimplementing checks.
disable-model-invocation: false
allowed-tools:
  - Bash
  - Read
  - Grep
  - mcp__igris-brain__igris_memory_recall
  - mcp__igris-brain__igris_error_lookup
triggers:
  - "IGRIS DOCTOR"
  - "igris-doctor"
  - "diagnose igris"
  - "health check"
  - "repair igris"
  - "fix igris"
---

# Igris Doctor

Run and interpret the existing `igris doctor` diagnostic verb. This skill is the
model layer only: it invokes the CLI engine, explains the results in operator
language, and carefully coordinates repairs. It must never duplicate the
deterministic checks from `cli/src/verbs/doctor.ts`.

## Contract

- **Engine:** `igris doctor` is the source of truth for all checks and drift
  classes. If a missing check is discovered, extend the CLI verb, not this skill.
- **Harness-agnostic:** do not add harness-specific branches, rules, or
  assumptions here. The CLI verb, drift gates, adapters, and docs own
  harness-specific knowledge.
- **Safe repair boundary:** only run `igris doctor --fix` automatically when every
  reported non-clean class is a safe deterministic repair. Never auto-delete
  rows, never auto-chmod secret-bearing files, and never resolve judgment calls
  without explicit operator direction.

## Usage

`$ARGUMENTS` is optional:

- Empty: run `igris doctor`, interpret the report, and recommend next actions.
- `--fix`: run `igris doctor`, decide whether `--fix` is safe, then either run it
  or ask the operator for judgment.
- `--remove-orphans`: explain that this can delete registry rows and requires
  explicit operator confirmation before invoking the CLI flag.

## Execution

### 1. Run the Diagnostic

Run from the current project:

```bash
igris doctor
```

Capture stdout/stderr and the exit code. Exit code `0` means clean. Exit code
`1` means at least one non-clean drift row or a failed repair condition; do not
treat it as a tool failure.

### 2. Parse the Drift Table

Parse rows from the markdown table:

```text
| slug | path | drift-class | recommended-fix |
```

Ignore rows whose `drift-class` is `clean`. Group the remaining rows by
`drift-class`, preserving representative slugs and paths for the report.

If the table shape changes, do not invent parsing. Report that the CLI output
shape changed and show the raw summary; the CLI remains authoritative.

### 3. Prioritize Findings

Render in this order:

1. **Broken:** `brain-core-missing`, `bridge-missing`, `mcp-unregistered`,
   `hooks-missing`, `hooks-stale`, `skills-pollution`,
   `antigravity-skills-link`, `path-missing`
2. **Degraded / needs judgment:** `secret-perms`, `brain-core-stale`,
   `channel-mismatch`, `duplicate-path`
3. **Cosmetic / informational:** `slug-basename-mismatch`, `symlink-target`

For each group, explain:

- What is wrong in plain language.
- The likely symptom the operator may see.
- Whether `igris doctor --fix` is safe for that group.
- The next command or manual decision.

Keep the report short: top issues first, then a compact class count summary.

### 4. Safe `--fix` Orchestration

The safe deterministic classes are:

- `brain-core-missing`
- `bridge-missing`
- `mcp-unregistered`
- `hooks-missing`
- `hooks-stale`
- `antigravity-skills-link`

Treat `skills-pollution` as **mixed**, not blanket-safe. It can contain safe
migration/stray-projection cleanup, but it can also contain unexpected target
roots or non-projection strays that the CLI itself tells the operator to resolve
manually. If any `skills-pollution` row is present, read its
`recommended-fix`/warning text. Only include it in the auto-fixable set when the
row contains no manual-resolution language such as `resolve manually`,
`unexpected target`, or `non-projection stray`. Otherwise ask for explicit
operator confirmation.

If `$ARGUMENTS` includes `--fix` and **all** non-clean rows are in the safe set
above, plus any `skills-pollution` rows pass the safe-row check, run:

```bash
igris doctor --fix
```

Then run `igris doctor` again and report the before/after class counts.

If any non-clean row is outside the safe set, do not auto-run `--fix`. Explain
which class blocks automatic repair and ask for explicit operator direction.
This is especially important for:

- `secret-perms`: `--fix` may chmod secret-bearing config files. Flag it; never
  auto-chmod from this skill.
- `path-missing`: row deletion requires `igris doctor --remove-orphans` and
  explicit confirmation.
- `skills-pollution`: mixed class; unexpected targets and non-projection strays
  require manual review before any repair attempt.
- `duplicate-path`, `slug-basename-mismatch`, `symlink-target`: these may reflect
  intentional aliases or workspace layout.
- `brain-core-stale` / `channel-mismatch`: these may require a channel or upgrade
  decision.

### 5. Orphan Removal

If the operator asks for orphan cleanup, first summarize the `path-missing` rows.
Only after explicit confirmation run:

```bash
igris doctor --remove-orphans
```

Use `--yes` only if the operator explicitly requested non-interactive deletion.

### 6. Output Format

When clean:

```markdown
## Igris Doctor
Clean. No drift detected.
```

When drift exists:

```markdown
## Igris Doctor
N issue(s) across M drift class(es).

### Priority Findings
- [class] count - explanation; next action.

### Repair Plan
- Safe to auto-fix: ...
- Needs operator judgment: ...
```

Do not include secret values. Do not print full config contents. Paths and drift
class names are safe to show.

## Boot Integration Contract

`/boot` may run `igris doctor` as a read-only diagnostic after the regular system
assessment. It should parse the same table and render exactly one line only when
non-clean rows exist:

```text
Igris Doctor: N issue(s) across M drift class(es) - run /igris-doctor.
```

When `igris doctor` is clean, `/boot` must stay silent. If the command is missing
or the output is unparsable, `/boot` should skip the surface silently rather than
blocking session start.
