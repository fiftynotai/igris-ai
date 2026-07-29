# Changelog

All notable changes to the `igris-ai` CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **`igris dashboard` — the local server verb + application shell (FR-238)** — the first persistent visual surface. `igris dashboard` starts a loopback-only (`127.0.0.1`) read-only HTTP server and opens a browser at it. Nothing is regenerated: reload and you see the state on disk right now. The shell ports the fifty.dev design language — four runtime palettes (`blood`/`cyber`/`acid`/`mono`), the 3-tier type stack (Anton / Space Grotesk / JetBrains Mono, **vendored as woff2 — no CDN, no network fetch at runtime**), sharp corners, hairline borders, grain overlay, ring+dot cursor, and a `prefers-reduced-motion` block that zeroes every animation (GSAP timelines are gated, not merely slowed). Four read-only endpoints — `/api/health`, `/api/projects`, `/api/summary`, `/api/graph/stats` — all of which return HTTP 200 with a `degraded` field for a missing, empty, unmigrated or corrupt brain, never a 500. FR-239 (graph), FR-240 (layer views) and FR-241 (cognition triage) mount inside this shell.
  - **First external consumer of the FR-237 pure brain-graph builder.** `cli/src/lib/brain-bridge.ts` dynamic-`import()`s the vendored compiled `buildBrainGraph` and calls it with its own read-only handle, honouring MAINTAINING row 105 without breaking the `cli/` ↔ `brain-mcp-server/` zero-cross-import rule. `/api/graph/stats` strips `nodes` and `edges` at the route layer, so the shell physically cannot render a graph that FR-239 owns.
  - **The server layer holds zero SQL.** Reads go through the FR-237 pure builder or the existing MAINTAINING-pinned CLI accessors (`listProjects`, `briefStatusSummary`, `listInstances`) — asserted mechanically in the test suite.
  - **New lifecycle convention.** The CLI's first long-lived verb: foreground, single-instance via `~/.igris/dashboard.lock` over `process-liveness.ts` (pid + start-time, so a recycled pid cannot masquerade as live), signal-released. A second invocation re-opens the running URL and exits 0 rather than binding a second port.
  - **Security posture.** Loopback bind only, `Host`-header allowlist (defeats DNS rebinding), no CORS headers, `nosniff` + `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'` + `Referrer-Policy: no-referrer` on every response, path-traversal guard, and zero write endpoints.
  - **Zero new runtime dependencies.** Vite/React/Tailwind/GSAP are `devDependencies`; the server is `node:http`. Measured tarball cost: **+156.8 KB packed** against a +250 KB budget.
  - Adds `cli/src/lib/open-url.ts`, a TypeScript port of the cross-platform browser ladder that until now existed only as bash inside `core/skills/visualize/SKILL.md`. The bash original is deliberately left in place — collapsing the two is TD-308's job.
  - Docs: `docs/dashboard.md` (verb, API, lifecycle, security posture) and `cli/dashboard/PORTING.md` (every ported file mapped to its fifty.dev origin, with each deliberate divergence recorded).

### Fixed

- **The `cli` vitest suite ran in no push/PR workflow** — `cd cli && npm test` was gated only by `npm-publish.yml`, which triggers on version tags, so a cli unit test could be red for weeks and only surface at release. Added a `Run CLI vitest suite` step to `test.yml`'s existing `cli-bats` job (which already does `npm ci` + build). Same gap class TD-303 closed for the bats suite. The new `cli/dashboard/` app had the identical problem for a different reason — `vite build` strips types without checking them and the app's tsconfig is isolated from the CLI's — so a `typecheck:dashboard` script and a matching CI step were added beside it.

---

## [7.2.0] - 2026-07-05

### Added

- **`/setup` — first-run onboarding + reconfiguration (FR-235)** — fresh
  installs get a guided first run: `igris init` ends with a human
  next-step, `/boot` shows a one-time Welcome, and the new `/setup` skill
  teaches the register→hunt→rest loop with a consented, repo-safe first
  `/ground`. Returning users get a re-runnable settings editor (shells the
  existing `igris configure` verb) covering identity, remote brain, and
  cognition toggles, plus three new `USER.md` preferences (addressing,
  notification style, auto-approve threshold). Adds a hidden
  `igris onboarding` verb and a `config.json`
  `onboarding.{completed,boot_welcomed}` first-run flag.

### Changed

- **`igris init` final report** now leads with the human next-step;
  technical details move behind `--verbose`.

### Fixed

- **`igris init --upgrade` tripped the config.json preservation guard on
  the onboarding stamp (BR-077)** — the FR-235 onboarding-completed stamp
  reserialized `config.json` on upgrade, breaking the byte-for-byte
  preservation test. The stamp is an additive, sibling-preserving system
  write — all user-authored config values are provably unchanged.
  Corrected the misleading `init.ts` comment and refined the `init.bats`
  upgrade test to assert `USER.md` byte-for-byte and `config.json`
  user-data unchanged (number-normalized), with the additive onboarding
  key as the only permitted delta.

---

## [7.1.0] - 2026-07-04

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

- **Project-handoff line (FR-229 / FR-230 / FR-231 / FR-232)** — a
  complete cross-installation project-portability workflow:
  - **`igris export <project>`** (FR-229) — read-only verb that
    serializes a project's brain slice (briefs + brief-graph + context
    docs + goals by default; `+learnings/errors/concept-graph` at
    `--tier full`) into a portable `.igris-pack.tar.gz` bundle. Supports
    `--out`, `--tier core|standard|full`, `--include`, `--since`.
  - **`igris import <bundle>`** (FR-230) — the consumer half. Unpacks a
    `.igris-pack.tar.gz`, verifies its checksum, and rejects
    executable-surface/unknown stores before any DB write. Classifies
    every row NEW/UNCHANGED/INCOMING/LOCAL_ONLY/CONFLICT via an
    ancestor-based 3-way compare (bundle hash vs. local hash vs. a
    recorded ancestor hash in a CLI-local ledger under
    `~/.igris/projects/<slug>/imports/` — deliberately NOT a naive
    `updated_at` last-writer-wins), previews the plan, requires explicit
    confirmation, and applies the chosen `--on-conflict
    ask|theirs|mine|newer` policy in one transaction. Auto-registers the
    target project on a fresh machine so the `brief_status` foreign key
    is satisfied atomically; `--dry-run` previews with zero writes;
    `--as <slug>` imports under a different slug. A partial apply exits
    non-zero and stays retryable; BLOB content (context-doc bodies)
    round-trips losslessly.
  - **`/handoff` skill** (FR-231) — wraps the export/import verbs with an
    in-chat preview/confirm ceremony, and records the project-slice
    portability contract in the OS knowledge-map (tiers + exclusions,
    and the two-mode portability decision: VPS sync for same-owner
    continuous access vs. bundle export/import for cross-owner
    point-in-time handoff).
  - **README + brand assets** (FR-232) — new project-handoff section
    documenting the `/handoff` export/import workflow, plus a top brand
    banner and a 2400×1260 OG/social preview card generated via the
    fifty.dev `oss-readme` asset pipeline.

- **`igris sync code` advisory for `.claude/*` real dirs** — warns
  (does not abort) when any of `.claude/{agents,rules,skills}/` is a
  real directory rather than a symlink. RSYNC_EXCLUDES treats these
  as symlinks per the v6 install model; a real directory would have
  its contents silently stripped at deploy time. The advisory surfaces
  the partial-install footgun before it bites. Closes #TD-139.

- **Multi-harness distribution redesign** — consolidated per-harness
  wiring (agents, skills, MCP servers, hooks) onto one descriptor model
  with a single `igris harness` compile/check surface and an `igris
  registry` verb for Layer-2 overlays. Cursor onboarded as a 6th
  first-class harness alongside Claude, Codex, Gemini, OpenCode, and
  Antigravity; drift-guard parity extended across agent, skill, MCP,
  and hook surfaces so a stale projection is caught the same way on
  every harness instead of only Claude's. (FR-150 epic, FR-161/164/165,
  FR-171/172/179, FR-202, FR-217, TD-283, and related harness/registry
  work)

- **Bundled brain — cognition engine (review-gated, off by default)** —
  the `igris-brain` MCP server bundled into this package gains a shared
  cognition host running single-purpose LLM instances that observe the
  brain and *propose* candidates for review; nothing is auto-written to
  conscious memory. Instances: `perception` (transcripts → learnings),
  `subconscious` (digest → suggestions), `synapse` (learning-to-learning
  edge inference), and the `janitor` family (`arbiter` contradiction
  resolution, `curator` stale-learning pruning, `cartographer` Leiden-
  clustering meta-learnings). Every instance and every auto-apply flag
  defaults to disabled/`false` in `~/.igris/config.json`; the new `igris
  configure` verb onboards persona/VPS/cognition opt-ins. Documented in
  `docs/COGNITION.md`. (FR-118, FR-116, FR-210, FR-211)

- **Bundled brain — knowledge-graph cluster** — new graph tools (node
  CRUD, search, dashboard, graph render/visualization), store-time
  knowledge-graph edge population, and goals + metrics dashboards with
  a drift validator.

### Fixed

- **Global install left the bundled brain MCP unbootable (BR-075)** —
  `npm install -g igris-ai` set `npm_config_global=true` in the
  postinstall's environment, which the bundled brain's nested install
  inherited and aborted on, leaving `dist/brain-mcp-server/node_modules`
  empty so `igris-brain` crashed on spawn with `ERR_MODULE_NOT_FOUND`.
  Fixed by sanitizing the child environment (stripping inherited
  `npm_config_*` vars) so the nested install always runs as a clean
  local install. Verified in a Docker clean-room (`npm install -g` →
  `igris init` → brain boots). Shipped as an interim `7.0.1` hotfix
  ahead of this release; recorded here for completeness.

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
