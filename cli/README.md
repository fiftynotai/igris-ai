# Igris CLI

The Igris AI unified command-line interface — `igris install`, `igris update`,
`igris doctor`. Phase 1 of MG-013 / V7 (closes #MG-013).

## What this owns

The CLI owns the entire install pipeline natively in TS (Phase 2, M2):

- `<project>/.claude/settings.json` hooks block (merged, not overwritten)
- `<project>/.claude/{agents,rules,skills}` symlinks (cli/src/lib/symlinks.ts)
- `<project>/CLAUDE.md` regenerated from template (cli/src/lib/claude-md.ts)
- `<project>/.igris_version` JSON marker (cli/src/lib/igris-version.ts)
- Brain `projects` registry rows (via direct `better-sqlite3` access)
- `~/.igris/projects/<slug>/installed_features.json` (content hashes for
  upgrade detection; schema v2 includes brain_channel + brain_ref)
- `~/.igris/config.json` subconscious.enabled default (TD-102 preservation)
- Optional remote-brain push (best-effort, mirrors legacy shell behavior)

Phase 1 wrapped `scripts/igris_install.sh` via `child_process.execFileSync`;
Phase 2 (M2 of MG-014) absorbed that symlink layer entirely and deleted the
shell script.

## Verbs

```
igris install <path> [--slug <slug>] [--no-hooks]
igris update --all
igris update --slug <slug>
igris doctor [--fix] [--remove-orphans] [--yes]
```

### `igris install`

Default: hooks ARE installed. Pass `--no-hooks` to opt out. This is the
v7 inversion of v6 behavior (TD-100 silent-failure root cause).

`--slug` accepts an explicit slug. When omitted, slug defaults to
`basename(path)` — same behavior as the existing shell. The v7 inversion is
that an explicit `--slug` is now honored (the shell ignored slug overrides).

### `igris update`

`--all` walks every registered project. `--slug <slug>` updates one. Skips
projects whose canonical hashes match installed.

### `igris doctor`

Read-only by default. Walks the registry and classifies every row into a
drift class:

| Drift class | Meaning |
|---|---|
| `clean` | All checks pass |
| `path-missing` | Registry path no longer exists (orphan) |
| `not-installed` | Path exists but `.claude/` missing |
| `hooks-missing` | settings.json present but no Igris SessionEnd hook (the TD-100 silent-failure class) |
| `hooks-stale` | Igris hooks present but their command path differs from canonical |
| `slug-basename-mismatch` | Informational — slug != basename(path) |
| `duplicate-path` | Multiple slugs share the same realpath |
| `symlink-target` | Registered path is itself a symlink |

`--fix` repairs `not-installed`, `hooks-missing`, `hooks-stale` by re-running
the install primitive. Other classes require manual decisions.

`--remove-orphans` interactively deletes `path-missing` rows. Skip prompts
with `--yes`. Per-row prompts accept `y`/`n`/`Y` (yes-all)/`a` (abort).

## Develop

Phase 1 distribution is via `npm link`. Future Phase 2 ships via `npm publish`
and possibly Homebrew.

```bash
# From the repo root
npm install              # Installs all workspaces (cli + brain-mcp-server)
cd cli
npm run build            # Compile TS -> dist/
npm test                 # Vitest unit tests (json-merge, install, etc.)
npm run test:bats        # bats integration tests
npm link                 # Make `igris` available globally
```

After `npm link`:

```bash
igris --version
igris install /path/to/some/project
igris doctor
```

## Tests

- `src/__tests__/json-merge.test.ts` — 14 tests, the highest-risk module
- `src/__tests__/install.test.ts` — install verb integration (12 tests)
- `src/__tests__/update.test.ts` — update diff logic (7 tests)
- `src/__tests__/doctor.test.ts` — drift classification + exit codes (15 tests)
- `src/__tests__/registry.test.ts` — better-sqlite3 + projects table (6 tests)
- `src/__tests__/installed-features.test.ts` — schema migration + hashing (6 tests)
- `src/__tests__/smoke.test.ts` — vitest harness check
- `tests/integration/version.bats` — CLI invocation smoke
- `tests/integration/install.bats` — install end-to-end (9 tests)
- `tests/integration/doctor.bats` — doctor end-to-end (6 tests)
- `tests/integration/default-install-installs-hooks.bats` — TD-100 canary (1 test)

## Decision points (architect defaults — D-1 through D-4)

- **D-1**: Igris-hooks-first inside event arrays.
- **D-2**: `.bak.<timestamp>` lifecycle for first 3 releases, gated on `IGRIS_KEEP_BAK != 0`.
- **D-3**: ~~Phase 1 wraps `scripts/igris_install.sh` for the symlink layer~~ — superseded in M2: native TS owns the full install pipeline.
- **D-4**: Direct `better-sqlite3` registry access (not via MCP).

## Out of scope (Phase 1)

See MG-013 plan §"Out of scope" — full deprecation of shell scripts, plugin
format, cross-CLI extensions, npm publish, auto-detection, `igris self-update`,
Windows-native first-class support are all Phase 2.

## Troubleshooting

### `Canonical hooks file not found at ...`

Run `bash scripts/igris_brain_refresh.sh` from the Igris source repo. The
canonical hooks file lives at `~/.igris/core/hooks/canonical-settings.json`
and is populated by the refresh script.

### `path does not exist: ...`

Pass an absolute or relative path that exists. `igris install` does not
create the project directory — that is the user's responsibility.

### `Invalid slug 'X'`

Slug grammar: `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`. Examples: `fifty-dev`,
`igris-ai`, `lifeOS`, `coffee_brand_website`.
