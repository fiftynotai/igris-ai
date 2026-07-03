# Changelog

All notable changes to the `igris-ai` CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [7.0.2] - TBD

### Changed

- **`igris sync code` pre-restart smoke check** — the `better-sqlite3`
  `node -e 'require(...)'` smoke gate now runs BEFORE `pm2 restart`
  instead of after. If the native binding fails to load, the deploy
  aborts and the previously-running brain process is left untouched,
  vs the prior behavior where pm2 restart was issued first and the
  new process crashed on next DB access. Smoke is a standalone node
  subprocess that reads only filesystem state, so success-path
  behavior is unchanged. Closes #TD-141 (supersedes the post-restart
  trade-off taken in TD-135).

### Added

- **`igris export <project>`** — new read-only verb that serializes a
  project's brain slice (briefs + brief-graph + context docs + goals by
  default; `+learnings/errors/concept-graph` at `--tier full`) into a
  portable `.igris-pack.tar.gz` bundle for cross-installation handoff.
  Supports `--out`, `--tier core|standard|full`, `--include`, `--since`.
  Producer half of FR-229; the import/merge consumer (FR-230) and
  `/handoff` skill (FR-231) are pending.

- **`igris sync code` advisory for `.claude/*` real dirs** — warns
  (does not abort) when any of `.claude/{agents,rules,skills}/` is a
  real directory rather than a symlink. RSYNC_EXCLUDES treats these
  as symlinks per the v6 install model; a real directory would have
  its contents silently stripped at deploy time. The advisory surfaces
  the partial-install footgun before it bites. Closes #TD-139.

### Fixed

- **`igris sync code` Python cache coverage** — `*.pyo` and `*.pyd`
  were missing from `RSYNC_EXCLUDES` despite being covered by
  `.gitignore`'s `*.py[cod]` glob. Added both, plus a new vitest
  audit (`gitignore-sync.test.ts`) that parses `.gitignore` and
  asserts every (non-skip-listed, glob-expanded) pattern is mirrored
  in `RSYNC_EXCLUDES`. Catches future drift programmatically. Closes
  #TD-140.

- **`igris init`/`refresh` dry-run output** — `--from-source --dry-run`
  previously printed `rename: <core> -> <core>` for the core/ deposit,
  but the actual non-dry path uses recursive `copyFromSource(...)`.
  Added a `wouldCopy()` primitive to `DryRunCollector` with a
  dedicated `copy:` printer block, and switched both verbs to use it.
  Closes #TD-142.

- **`igris init` interactive prompts** — `igris init` now interactively
  prompts for user identity (name, email) and optional remote_brain
  config (URL + API key). Previously, USER.md shipped with literal
  `{{USER_NAME}}` / `{{USER_EMAIL}}` placeholders that the user had to
  hand-edit after install, and `--skip-remote` was effectively a no-op
  (it gated a prompt that did not exist). `--yes`, `--upgrade`,
  `--dry-run`, and non-TTY shells all auto-skip prompts using defaults
  so CI and `curl | bash` installers never hang. Closes #TD-144.

- **brief-gate hook reads the brain DB** — `pre_tool_use.sh` now queries
  `brief_status` (sqlite3) for an `In Progress` brief instead of grepping
  `~/.igris/projects/<slug>/briefs/` only — v5+ briefs (brain-only, no
  filesystem cache) were invisible to the gate, so a legitimately-active
  brief still produced "No active brief found". It also resolves the
  project slug by walking `PROJECT_DIR`'s ancestors against `projects.path`
  in the registry, so a subagent whose cwd is a subdirectory (e.g.
  `<repo>/cli`) no longer resolves the wrong slug via `basename`. Both new
  paths degrade to the legacy v4 filesystem-cache behavior when sqlite3 or
  the brain DB is unavailable; the resolved slug is validated against
  `^[a-z0-9_-]+$` before any SQL interpolation. New
  `cli/tests/integration/pre-tool-use-hook.bats` (5 cases). Closes #TD-146.

---

## [7.0.1] - 2026-05-11

### Fixed

- **`igris sync code`** — workstation `node_modules/` is no longer rsynced
  to the VPS. Native modules built on the dev workstation (e.g. macOS-
  arm64 `better-sqlite3`) crashed when loaded on the Linux x86_64 VPS.
  The new pipeline runs `npm ci` on the VPS post-rsync so native bindings
  are Linux-native, then runs `npm run build` for `brain-mcp-server/`,
  then `pm2 restart igris-brain`, then a `require("better-sqlite3")`
  smoke check that fails loud if the native binding can't load. Closes
  #TD-135.

### Changed

- `igris sync code` rsync now applies an exclusion list mirroring
  `.gitignore` (`node_modules/`, `.git/`, `dist/`, `build/`, IDE files,
  logs, temp files, `*.tar.gz`, etc.). `--dry-run` enumerates the full
  exclusion list for audit.

---

## [7.0.0] - 2026-05-08

First public npm release. Renamed from `@igris-ai/cli` to `igris-ai`.

### Added

- **`igris init`** — bootstrap a fresh `~/.igris/` (or upgrade an existing
  v6 install) from a GitHub release tarball or a local source repo.
  Supports `--from-source <path>`, `--channel <ref>`, `--upgrade`,
  `--skip-remote`, `--cli-bridge <list|none>`, `--dry-run`, `--yes`.
- **`igris refresh`** — re-fetch `~/.igris/core/` from the recorded
  channel (or switch channels). Supports `--from-source`, `--channel`,
  `--no-propagate`, `--dry-run`, `--yes`. Cache-fast-path: same SHA →
  no-op.
- **`igris install <path>`** — full native TS pipeline for installing
  Igris in a project: `.claude/settings.json` hooks block (merged),
  `.claude/{agents,rules,skills}` symlinks, `CLAUDE.md` regen,
  `.igris_version` marker, brain registry row, `installed_features.json`.
  Supports `--slug`, `--no-hooks`, `--dry-run`. Hooks installed by
  default (TD-100 silent-failure inversion).
- **`igris update`** — update materialized layer for one or more
  projects. Supports `--all`, `--slug <slug>`, `--self` (npm self-
  upgrade), `--dry-run`.
- **`igris register-project [path]`** — write the brain registry row
  only (no `.claude/`, no hooks, no `CLAUDE.md`). Supports `--slug`,
  `--allow-missing-path`.
- **`igris sync <code|data|all|status>`** — push code/data to the VPS
  brain. Replaces `scripts/igris_vps_update.sh`. Supports `--dry-run`,
  `--if-changed` (cron parity).
- **`igris doctor [--fix] [--remove-orphans]`** — read-only diagnostic
  walk over the registry. Reports drift across 12 classes:
  - `path-missing` — registry row points at a deleted dir
  - `not-installed` — path exists but `.claude/` missing
  - `hooks-missing` — settings.json present but no Igris SessionEnd hook
    (the TD-100 silent-failure class)
  - `hooks-stale` — Igris hooks present but command path differs from
    canonical
  - `slug-basename-mismatch` — informational; row.slug != basename(path)
  - `duplicate-path` — multiple slugs share a single realpath
  - `symlink-target` — registered path is itself a symlink
  - `brain-core-missing` (NEW in 7.0) — `~/.igris/core/` absent or empty
  - `brain-core-stale` (NEW in 7.0) — `~/.igris/core/` content hash
    diverges from configured channel head
  - `channel-mismatch` (NEW in 7.0) — per-project `cli_version` ahead
    of current CLI
  - `bridge-missing` (NEW in 7.0) — CLI on PATH lacks configured bridge
  - `clean` — none of the above
  `--fix` repairs `not-installed`, `hooks-missing`, `hooks-stale`,
  `brain-core-missing` (invokes `runRefresh()`), and `bridge-missing`
  (invokes partial-mode `runInit()`).
- **`--dry-run` flag** — supported on every state-changing verb (init,
  refresh, install, update, sync). Prints a non-destructive plan.
- **GitHub Actions npm-publish workflow** — `.github/workflows/npm-publish.yml`
  triggers on git tags matching `v*.*.*`. Gated behind
  `secrets.NPM_TOKEN` — workflow lands behind `workflow_dispatch` until
  the npm org is registered (Risk #3).

### Changed

- **Distribution model** — moved from `npm link` (Phase 1, MG-013) to
  `npm install -g igris-ai`. The package is renamed from `@igris-ai/cli`
  to `igris-ai` per the V7 distribution decision (D-2 lock).
- **Brain content delivery** — `~/.igris/core/` is now sourced from a
  GitHub release tarball at install time (`igris init`). The repo's
  `core/` directory remains canonical for development; end users no
  longer need a `git clone`.
- **Hooks default** — hooks ARE installed by default. Pass `--no-hooks`
  to opt out. This is the v7 inversion of v6 behavior, fixing the
  TD-100 silent-failure root cause.
- **CLI naming** — package binary stays `igris`; only the npm package
  name changes. `igris --version` reports `7.0.0`.

### Removed

- **`scripts/igris_brain_init.sh`** — replaced by `igris init`.
- **`scripts/igris_brain_refresh.sh`** — replaced by `igris refresh`.
- **`scripts/igris_install.sh`** — replaced by `igris install` (M2).
- **`scripts/igris_migrate_to_v4.sh`** — v3→v4 migration retired. The
  script invoked `scripts/igris_brain_init.sh` (deleted in M5) and
  `scripts/igris_brain_refresh.sh` (deleted in M5); it had been
  functionally broken at runtime since the M5 native-CLI cutover.
  Users on v3 should reinstall via `igris init` + `igris install`.
- **`scripts/igris_update.sh`** — replaced by `igris update` (M3).
- **`scripts/igris_vps_update.sh`** — replaced by `igris sync code` (M4).
- **`scripts/igris_cli_sync.sh`** — absorbed into `igris install` (M2).
- **`scripts/igris_hooks_sync.sh`** — absorbed into `igris install` (M2).
- **`scripts/validate_canonical_hooks.sh`** — the validated source
  (`scripts/hook-adapters/install_claude_hooks.sh`) is itself deleted in
  this release; the validator becomes a no-op.
- **`scripts/hook-adapters/install_claude_hooks.sh`,
  `install_codex_hooks.sh`, `install_opencode_hooks.sh`,
  `_common.sh`** — the native TS at
  `cli/src/lib/{canonical-hooks,bridges}.ts` is the sole hook writer.
- **Legacy bats fixtures** — `test/igris_init.test.bash`,
  `test/igris_hooks_sync.test.bash`, `test/igris_cli_sync.test.bash`,
  `test/validate_canonical_hooks.test.bash` are removed; their coverage
  is replaced by `cli/src/__tests__/*.test.ts` and
  `cli/tests/integration/*.bats`.

### Migration

For users on v6:

```bash
# 1. Diagnose current state
igris doctor

# 2. Preview the upgrade (no writes)
igris init --upgrade --dry-run

# 3. Apply the upgrade
igris init --upgrade

# 4. Preview project propagation
igris update --all --dry-run

# 5. Propagate to all registered projects
igris update --all
```

The `--upgrade` flow preserves `~/.igris/memory/knowledge.db`,
`~/.igris/USER.md`, and `~/.igris/config.json` byte-for-byte.

### Internal

- 19 new vitest cases across 4 files (drift detectors).
- 1 new bats integration file (`doctor-drift-classes.bats` — 8 cases,
  one per drift class).
- Total CLI test surface at 7.0.0 close: ~246 vitest + ~62 bats.
- `npm pack --dry-run` ships only `dist/`, `README.md`, `CHANGELOG.md`,
  `package.json`. Source TypeScript and tests are not published.

---

## [Pre-7.0]

Earlier development phases of the CLI shipped as `@igris-ai/cli` via
`npm link` only (no public registry). See the repo-level
`/CHANGELOG.md` for the broader Igris AI release history.
