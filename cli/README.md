# IGRIS

they resume your chat — IGRIS resumes your work.

Igris is the engineering OS for AI coding agents: cross-harness work-state
handoff, enforcement-as-code, and one brain across every harness. The npm
package is published as [`igris-ai`](https://www.npmjs.com/package/igris-ai);
the binary command is `igris`.

## Install

```bash
npm install -g igris-ai
igris init
cd /path/to/your-project && igris install .
```

`igris init` bootstraps the centralized brain at `~/.igris/`, registers the
bundled `igris-brain` MCP server, and projects the global skills, agents, MCP,
and hook surfaces. `igris install .` is register-only: it records the project in
the brain so those global surfaces apply, without copying Igris files into your
repo.

First-class harnesses: Claude Code, OpenCode, and Antigravity. Codex and Gemini
CLI are supported bridges.

Cursor remains an onboarding target, not a shipped surface.

## Why Igris

You can get pieces of this elsewhere: specs, shared rule files, memory tools,
and checkpoint notes. Igris is for the failure mode where pieces are not enough:
multiple harnesses, multiple sessions, mid-workflow interruption, write
enforcement, stale claims, crash recovery, cross-project memory, and sync all
need one lifecycle.

The launch-facing README, proof storyboard, and substitution comparison live in
the monorepo:

- [Project README](https://github.com/fiftynotai/igris-ai#readme)
- [Substitution comparison](https://github.com/fiftynotai/igris-ai/blob/main/docs/substitution.md)
- [Launch assets](https://github.com/fiftynotai/igris-ai/tree/main/docs/images/launch)

## Contributor note

Source lives at `cli/` in the
[`fiftynotai/igris-ai`](https://github.com/fiftynotai/igris-ai) monorepo. The
sections below are for contributors working on the CLI source.

## End-user quick reference

| Verb | What it does |
|---|---|
| `igris init` | Bootstrap `~/.igris/` (or upgrade an existing install) |
| `igris configure` | Re-runnable onboarding dial for an existing install (persona, identity, VPS, perception toggles) |
| `igris refresh` | Re-fetch `~/.igris/core/` from the configured channel |
| `igris install <path>` | Register a project with the brain; no repo-local surfaces are copied |
| `igris update [--all\|--slug X\|--self] [--dry-run]` | Update materialized layer |
| `igris register-project [path]` | Write the brain registry row only |
| `igris add <skill\|agent\|mcp\|hook> [name]` | One-step add of a surface — materialize, project to all harnesses, verify drift-clean |
| `igris remove <skill\|agent\|mcp\|hook> [name]` | Symmetric inverse of `add` — un-project from every harness and verify absent |
| `igris harness <compile\|check>` | Regenerate or drift-check the per-harness agent-prompt projections |
| `igris loadout <action>` | Register Layer-2 personal customizations into the overlay (superseded by `igris add`) |
| `igris sync <code\|data\|all\|status>` | Push code/data to the VPS brain |
| `igris export <project> [--tier core\|standard\|full] [--since <date>]` | Serialize one project's brain slice into a portable `<slug>.igris-pack.tar.gz` (the handoff PRODUCER) |
| `igris import <bundle> [--dry-run] [--on-conflict ask\|theirs\|mine\|newer] [--as <slug>] [--project-path <path>]` | Import a `.igris-pack` bundle with a reviewed, ancestor-based merge (the handoff CONSUMER) |
| `igris doctor [--fix\|--remove-orphans]` | Diagnose and repair drift |

`--dry-run` is supported on every state-changing verb.

> **Internal / skill-invoked verbs.** `detect`, `boot-sync`, `session`,
> `instance`, `housekeeping`, `assess`, and `context-docs` are lifecycle verbs
> shelled out by skills and hooks (awaken, rest, session handoff) — not typed by
> hand. They are hidden from `igris --help` but remain directly callable.

End-user docs (install, upgrade, channels) live in the repo-root
[`README.md`](https://github.com/fiftynotai/igris-ai#readme).

## Contributor flow

```bash
# Clone the monorepo
git clone https://github.com/fiftynotai/igris-ai
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

The CLI owns the entire install pipeline natively in TypeScript. FR-212c/d
made the surfaces GLOBAL and `igris install` **register-only** — there is no
per-project `.claude/` layer anymore:

- **Hooks are global** — the canonical Igris hooks block is merged ONCE into
  `~/.claude/settings.json` at `igris init` (`cli/src/lib/global-hooks.ts` +
  `json-merge.ts` + `canonical-hooks.ts`). The per-project `_gate.sh`
  registration gate de-no-ops them outside a registered project.
- **Surfaces are global** — skills land in the universal store
  (`~/.claude/skills` + `~/.agents/skills`) via the pinned `skills` CLI delegate;
  agents project into the global harness agent dirs. All at `igris init`.
- **`igris install <path>` is register-only** — it writes NO files into the
  project repo (no `.claude/` symlinks, no per-project `settings.json`, no
  `CLAUDE.md` [FR-191], no `.igris_version` [FR-212d]). It registers the
  project path with the brain (the de-no-op gate) + writes
  `installed_features.json`. See `cli/src/verbs/install.ts`.
- Brain `projects` registry rows (direct `better-sqlite3` access, see
  `cli/src/lib/registry.ts`)
- `~/.igris/projects/<slug>/installed_features.json` (content hashes for
  upgrade detection; schema v2 includes `brain_channel` + `brain_ref`)
- `~/.igris/config.json` `cognition.{perception,subconscious}.enabled` defaults
  (FR-191 zero-config — both default OFF, only-set-if-absent)
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
| `clean` | All checks pass (registered + path exists — the register-only happy path) |
| `path-missing` | Registry path no longer exists (orphan) |
| `hooks-missing` | The GLOBAL `~/.claude/settings.json` lacks the Igris SessionEnd hook (brain-level; the TD-100 silent-failure class). FR-212d moved hooks global — there is no per-project hooks layer. |
| `hooks-stale` | The global settings carry the Igris hooks but at a non-canonical command path (brain-level) |
| `slug-basename-mismatch` | Informational — slug != basename(path) |
| `duplicate-path` | Multiple slugs share the same realpath |
| `symlink-target` | Registered path is itself a symlink |
| `brain-core-missing` | `~/.igris/core/` absent or empty (M5) |
| `brain-core-stale` | `~/.igris/core/` content hash diverges from configured channel head (M5) |
| `channel-mismatch` | Per-project `cli_version` ahead of current CLI (M5) |
| `bridge-missing` | CLI on PATH lacks configured bridge (M5) |
| `mcp-unregistered` | `~/.claude.json` lacks the igris-brain MCP entry (TD-168) |
| `secret-perms` | An Igris-written secret file or harness config is group/world-readable or git-tracked (TD-220) |

FR-212d retired the `not-installed` class — `igris install` is register-only
and writes no per-project `.claude/` layer, so its absence no longer means
"not installed"; a registered project whose path exists is clean.

`--fix` repairs `hooks-missing`/`hooks-stale` by re-merging the GLOBAL Igris
hooks (`mergeGlobalCanonicalHooks` — a single brain-level action, no per-project
re-install); `brain-core-missing` by invoking `runRefresh()`; `bridge-missing`
by invoking partial-mode `runInit()`; `mcp-unregistered` by re-registering the
brain MCP; `secret-perms` by chmod 600. Other classes require manual decisions.

`--remove-orphans` interactively deletes `path-missing` rows. Skip
prompts with `--yes`. Per-row prompts accept `y`/`n`/`a` (abort)/`all`
(yes-all).

## `igris sync`

Replaces the retired `scripts/igris_vps_update.sh` (deleted in M4 of MG-014).

| Sub-verb | Action |
|---|---|
| `status` | HTTP GET `<remote_brain.url>/health`, prints reachability + brain version + local queue depth + last-push timestamp |
| `data`   | Atomically drains local `~/.igris/projects/<slug>/sync_queue.jsonl` (rename-then-process; concurrency-safe under multi-harness use — see FR-128) via remote `igris_sync_queue_drain` MCP call. Recovers any stale `sync_queue.jsonl.draining-*` files from a prior crashed drain before processing. |
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

## Project handoff — `igris export` / `igris import`

`igris export <project>` and `igris import <bundle>` are the point-in-time
project-handoff pair. Export serializes ONE project's brain slice into a
portable, self-describing `<slug>.igris-pack.tar.gz`; import merges such a bundle
back into a local brain with a **reviewed, ancestor-based** merge that is safe
across owners.

**Why import is not a plain sync.** The sync stack (`mergeRows`) is same-owner:
natural-key upsert with SILENT timestamp last-writer-wins. For a colleague
handoff that can clobber their edits based purely on `updated_at`. So `igris
import` never uses that path — it classifies every row against a recorded
**ancestor hash** and only writes what a policy explicitly decides.

```bash
# Always dry-run first: preview the merge, write nothing.
igris import ./acme.igris-pack.tar.gz --dry-run

# Apply with an explicit conflict policy (no prompt).
igris import ./acme.igris-pack.tar.gz --on-conflict theirs

# Import a colleague's bundle under a different local slug (all NEW).
igris import ./acme.igris-pack.tar.gz --as acme-review
```

Each row is classified **NEW / UNCHANGED / INCOMING / LOCAL_ONLY / CONFLICT** by
a 3-way compare (bundle hash vs local hash vs the ledger's recorded ancestor —
NOT a naive `updated_at` compare). `--on-conflict` governs the **CONFLICT class
only**:

| Policy | CONFLICT behaviour |
|---|---|
| `ask` (default) | interactive per-conflict prompt on a TTY; on a pipe it applies NOTHING and asks you to pass an explicit policy |
| `theirs` | the bundle row wins |
| `mine` | the local row is kept |
| `newer` | the row with the newer `updated_at` wins (opt-in LWW, reported per row) |

NEW inserts, INCOMING fast-forwards to theirs, and LOCAL_ONLY always keeps mine —
none of those are conflicts, so no policy reverts a non-conflicting local edit.

- **Fresh-machine handoff.** If the target project isn't registered yet, the
  `projects` row is auto-registered inside the apply transaction (so the
  `brief_status` foreign key is satisfied atomically) — `--project-path <path>`
  (default: cwd) sets its recorded path. An already-registered project keeps its
  real path/name.
- **Partial-apply safety.** If any row fails to apply, the run prints a loud
  failure sample, exits with a distinct non-zero code (`3`), and does NOT mark the
  bundle applied — so a corrective re-import re-classifies and lands the
  previously-failed rows once the cause is fixed. The digest's `applied` field is
  `full` / `partial` / `none`.
- **Idempotent.** Re-importing the same bundle after a CLEAN apply is a no-op
  (checksum-keyed applied-bundle marker; a lost ledger still no-ops because every
  landed row re-classifies UNCHANGED).
- **Provenance ledger.** Ancestor hashes, the source fingerprint, and the
  applied-bundle set live in a CLI-local ledger under
  `~/.igris/projects/{slug}/imports/` (no brain-schema change). Pre-overwrite
  context-doc copies are backed up there.
- **Security.** The bundle is untrusted data end-to-end: the checksum is verified
  and executable-surface / unknown stores are rejected BEFORE any DB write; the
  `EXPORT_TABLES` column set is the write allowlist, so `claimed_by`/`claimed_at`
  can never be written. A corrupt/tampered bundle or a missing brain DB is a hard
  failure (exit 1, zero writes).
- **Re-embed.** Imported learnings/briefs land with NULL embeddings (embeddings
  are never exported); the next brain interaction re-derives them via the FR-220
  post-merge backfill.

Continuous bidirectional co-management is out of scope for v1 — its answer is
"both point at one VPS brain," not this feature.

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
