# Igris CLI

The unified command-line tool for Igris AI. Published to npm as
[`igris-ai`](https://www.npmjs.com/package/igris-ai); binary command is
`igris`. Source lives at `cli/` in the
[`fifty-ai/igris-ai`](https://github.com/fifty-ai/igris-ai) monorepo.

End users do **not** clone this repo. They install with
`npm install -g igris-ai`. This README is for **contributors** working
on the CLI source.

## End-user quick reference

| Verb | What it does |
|---|---|
| `igris init` | Bootstrap `~/.igris/` (or upgrade an existing install) |
| `igris refresh` | Re-fetch `~/.igris/core/` from the configured channel |
| `igris install <path>` | Install Igris in a project (default: includes hooks) |
| `igris update [--all\|--slug X\|--self] [--dry-run]` | Update materialized layer |
| `igris register-project [path]` | Write the brain registry row only |
| `igris sync <code\|data\|all\|status>` | Push code/data to the VPS brain |
| `igris doctor [--fix\|--remove-orphans]` | Diagnose and repair drift |

`--dry-run` is supported on every state-changing verb.

End-user docs (install, upgrade, channels) live in the repo-root
[`README.md`](../README.md).

## Contributor flow

```bash
# Clone the monorepo
git clone https://github.com/fifty-ai/igris-ai
cd igris-ai

# Install root + workspace deps
npm install                # installs cli + brain-mcp-server workspaces

# Build the CLI
cd cli
npm install                # CLI deps (already covered by root install if using workspaces, harmless)
npm run build              # tsc → dist/

# Make the CLI globally available pointing at this checkout
npm link                   # creates a global symlink to ./dist/index.js
igris --version            # → 7.0.0 (whatever's in package.json)

# Iterate against your local source instead of fetching from GitHub
igris init --from-source ../          # uses this repo's core/ directly
igris refresh --from-source ../       # re-syncs without a network roundtrip

# Run tests
npm test                   # vitest unit suite
npm run test:bats          # bats integration suite
```

`--from-source` is the contributor's main loop: it copies `core/` from
your repo checkout into `~/.igris/core/` directly, skipping the GitHub
release tarball pipeline. Combined with `igris refresh --from-source
.` it's a fast inner loop for editing brain content (skills, agents,
rules, prompts) and seeing the changes immediately.

## Architecture

The CLI owns the entire install pipeline natively in TypeScript:

- `<project>/.claude/settings.json` hooks block (merged, not overwritten — see
  `cli/src/lib/json-merge.ts` and `canonical-hooks.ts`)
- `<project>/.claude/{agents,rules,skills}` symlinks (`cli/src/lib/symlinks.ts`)
- `<project>/CLAUDE.md` regenerated from template (`cli/src/lib/claude-md.ts`)
- `<project>/.igris_version` JSON marker (`cli/src/lib/igris-version.ts`)
- Brain `projects` registry rows (direct `better-sqlite3` access, see
  `cli/src/lib/registry.ts`)
- `~/.igris/projects/<slug>/installed_features.json` (content hashes for
  upgrade detection; schema v2 includes `brain_channel` + `brain_ref`)
- `~/.igris/config.json` `subconscious.enabled` default (TD-102 preservation)
- Optional remote-brain push (best-effort; mirrors legacy shell behavior)

The brain core (`~/.igris/core/`) is sourced from a GitHub release tarball
at install time (`igris init`) or from a local repo via `--from-source`.
There are NO shell scripts in v7 for any of this; the entire install
surface is `cli/src/lib/*.ts`.

## Drift diagnostics — `igris doctor`

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
| `brain-core-missing` | `~/.igris/core/` absent or empty (M5) |
| `brain-core-stale` | `~/.igris/core/` content hash diverges from configured channel head (M5) |
| `channel-mismatch` | Per-project `cli_version` ahead of current CLI (M5) |
| `bridge-missing` | CLI on PATH lacks configured bridge (M5) |

`--fix` repairs `not-installed`, `hooks-missing`, `hooks-stale` by
re-running install; `brain-core-missing` by invoking `runRefresh()`;
`bridge-missing` by invoking partial-mode `runInit()`. Other classes
require manual decisions or a CLI/data update.

`--remove-orphans` interactively deletes `path-missing` rows. Skip
prompts with `--yes`. Per-row prompts accept `y`/`n`/`a` (abort)/`all`
(yes-all).

## `igris sync`

Replaces the retired `scripts/igris_vps_update.sh` (deleted in M4 of MG-014).

| Sub-verb | Action |
|---|---|
| `status` | HTTP GET `<remote_brain.url>/health`, prints reachability + brain version + local queue depth + last-push timestamp |
| `data`   | Drains local `~/.igris/projects/<slug>/sync_queue.jsonl` via remote `igris_sync_queue_drain` MCP call |
| `code`   | rsync local repo to `<vps.user>@<vps.host>:<vps.repo_path>` (excludes `node_modules/`, `.git/`, `dist/`, `.env`, IDE files, etc.), run `npm ci` + `npm run build` (brain-mcp-server) on VPS, smoke-check `require("better-sqlite3")`, ssh-restart `igris-brain` via PM2, then verify `/health` |
| `all`    | `code` then `data` sequentially; aborts on `code` failure |

`--dry-run` previews the rsync/ssh/MCP calls without performing them.

`--if-changed` (cron parity with the retired shell): skip the entire
push when local HEAD matches `origin/<branch>`. Useful for cron jobs:

```cron
*/5 * * * * /usr/local/bin/igris sync code --if-changed >> sync.log 2>&1
```

### Manual code-sync verification (NOT covered by CI)

Code-sync is intentionally NOT exercised in the
`tests/integration/sync.bats` suite — the `code` sub-verb invokes real
rsync + ssh against a configured VPS, which can't be hermetically
reproduced in CI. The unit tests at `cli/src/__tests__/sync-code.test.ts`
cover command-shape and exit-code contracts via mocked `child_process`;
the manual runbook below verifies the wire-level integration before
each `npm publish`:

1. **Pre-flight:** verify `~/.igris/config.json` has both `vps` (host,
   user, repo_path) and `remote_brain` (url, api_key) blocks populated,
   and that `ssh <vps.user>@<vps.host> -- echo ok` succeeds without
   prompting (key-based auth required; the verb passes `BatchMode=yes`).
2. **Dry-run:** `igris sync code --dry-run` and confirm the printed plan
   names the expected `<src>` and `<dst>` paths.
3. **Live:** `igris sync code` and watch the output:
   - `sync code: rsync <src> -> <dst>` then any rsync transfer summary
   - `sync code: npm ci complete on VPS` (Linux-native dep rebuild, ~30s)
   - `sync code: brain-mcp-server build complete on VPS`
   - `sync code: native-module smoke check passed` (TD-141 pre-restart
     load-bearing gate; old brain stays serving on smoke fail —
     `require("better-sqlite3")` on VPS)
   - `sync code: pm2 restart issued`
   - `sync code: health OK — {"status":"ok",...}` (or a WARN if the
     service is still starting; re-run `igris sync status` to confirm)
4. **Cron parity:** `igris sync code --if-changed` from a clean tree
   should print "local HEAD matches origin; nothing to push" and exit
   0 in <1s.
5. **Failure modes:** drop the `vps` block from config.json and confirm
   `igris sync code` exits 1 with an actionable error (config gate).

## Tests

The suite is split between vitest (unit) and bats (integration). Both
must be green before a `npm publish` (the `npm-publish.yml` workflow
enforces vitest).

- `src/__tests__/json-merge.test.ts` — highest-risk module
- `src/__tests__/install.test.ts` — install verb integration
- `src/__tests__/update.test.ts` — update diff logic
- `src/__tests__/doctor.test.ts` — drift classification + exit codes
- `src/__tests__/drift-{brain-core-stale,brain-core-missing,channel-mismatch,bridge-missing}.test.ts` — M5 drift detectors
- `src/__tests__/registry.test.ts` — better-sqlite3 + projects table
- `src/__tests__/installed-features.test.ts` — schema migration + hashing
- `src/__tests__/init.test.ts`, `refresh.test.ts`, `tarball.test.ts`,
  `cache.test.ts`, `channel.test.ts`, `install-source.test.ts`,
  `cli-detect.test.ts`, `bridges.test.ts`, `from-source.test.ts`,
  `atomic-extract.test.ts`, `preflight.test.ts` — M1 building blocks
- `src/__tests__/sync-{status,data,code}.test.ts` — sync sub-verbs
- `src/__tests__/self-update.test.ts`, `register-project.test.ts` — M3
- `tests/integration/version.bats` — CLI invocation smoke
- `tests/integration/install.bats` — install end-to-end
- `tests/integration/init.bats`, `refresh.bats` — M1 verbs end-to-end
- `tests/integration/install-symlinks.bats` — M2 native symlink layer
- `tests/integration/register-project.bats` — M3
- `tests/integration/sync.bats` — M4
- `tests/integration/doctor.bats` — Phase 1 doctor end-to-end
- `tests/integration/doctor-drift-classes.bats` — M5; one fixture per
  drift class
- `tests/integration/default-install-installs-hooks.bats` — TD-100 canary
- `tests/integration/tarball-zip-slip.bats` — security regression guard

## Decision points (architect defaults — D-1 through D-4)

- **D-1**: Igris-hooks-first inside event arrays.
- **D-2**: `.bak.<timestamp>` lifecycle for first 3 releases, gated on
  `IGRIS_KEEP_BAK != 0`. Package name `igris-ai` (no scope).
- **D-3**: Native TS owns the full install pipeline (no shell-out).
- **D-4**: Direct `better-sqlite3` registry access (not via MCP).

## Releasing

The `npm publish` happens via GitHub Actions
(`.github/workflows/npm-publish.yml`) on a `v*.*.*` git tag. The
workflow:

1. Checks out the tag
2. Installs deps + builds the CLI
3. Runs `npm test` (vitest)
4. Skips publish if `NPM_TOKEN` secret is unset (Risk #3 gating)
5. Otherwise publishes with `npm publish --provenance --access public`

To produce a tag, use the `/release` skill which drives version bump,
CHANGELOG entry, and the tag itself.

## Troubleshooting

### `Canonical hooks file not found at ...`

Run `igris refresh` to re-populate `~/.igris/core/`. The canonical
hooks file lives at `~/.igris/core/hooks/canonical-settings.json` and
is shipped inside the brain-core tarball.

### `path does not exist: ...`

Pass an absolute or relative path that exists. `igris install` does
not create the project directory — that is the user's responsibility.

### `Invalid slug 'X'`

Slug grammar: `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`. Examples: `fifty-dev`,
`igris-ai`, `lifeOS`, `coffee_brand_website`.

### Mac/Linux only

The CLI uses POSIX file ops (symlinks, atomic rename, /dev/tty for
prompts). Windows-native is out of scope for v7; use WSL on Windows.
