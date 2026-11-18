# Changelog

All notable changes to the `igris-ai` CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---


## [Unreleased]

### Added

- **`igris attention` (FR-276, FR-276a, FR-276b).** Records and inspects a
  chat's machine-local attention recording: `begin`, `bind`, `read`, `call`,
  `event`, `epoch`, `end`, `show`, `sessions`, `inventory` (exit 0 ok, 1
  refused, 2 usage, 3 attention unavailable or degraded). `show` exits 0 for a
  snapshot whose only degradation is its size bound; it still carries
  `truncated: true`, `counts` and a `Snapshot bounded: …` sentence in
  `degraded.reason`. `bind` rejects an instance id outside
  `^[a-zA-Z0-9_-]{1,256}$` (exit 2). `read` returns an OS module,
  skill, agent or context doc by canonical id and records full or preview
  delivery; `call --tool <name> --args-file <json>` runs a brain tool through
  the bundled local engine and returns its result unchanged plus
  `_meta.igris_attention`. The bundled brain adds the `attention` component
  and its three tools; nothing it records is synced or exported.

- **`igris session register --attention-session <uuid>
  [--harness-session-id <id>]` (FR-276b).** Binds the recording `/boot` began
  before Detect to the registered instance, refuses a recording already bound
  to another instance or chat, and adds an `**Attention Session ID:**` line to
  the instance scratchpad.

- **`igris session register` never overwrites a bound native chat
  (FR-276b).** A plain register (no `--attention-session`) whose recovered
  `--self-instance-id` is bound to a different chat than
  `--harness-session-id` mints a fresh instance (exit 0, `minted: true`) and
  leaves the old instance untouched. With `--attention-session`, a chat
  conflict, the recording's or the recovered instance's, is still refused;
  re-running without `--self-instance-id` mints a fresh instance bound to the
  recording, which is what `/boot` §4.4 does.

- **`igris dashboard --session <uuid>`, `--ensure` and `--stop` (FR-276b,
  FR-276c).** `--session` opens the Graph page on that recording. `--ensure`
  starts or reuses one managed loopback dashboard after checking it through
  `/api/health` (which gains `attention_protocol`, `server_pid` and
  `dashboard_bundle_present`) and prints `{available, url, reason}`; `--stop`
  stops only a dashboard whose identity checks out. New read-only GETs
  `/api/attention/sessions`, `/api/attention/session` and
  `/api/attention/inventory` answer 200 with `degraded` on a missing or
  unreadable brain, 400 on a malformed request and 404 for an unknown session.
  The Graph page gains the session panel, legend, evidence inspector and
  history replay.

- **Session focus on the Graph page (FR-276d).** With a session selected the
  map opens on This chat (only recorded nodes), with Whole brain and "Show
  related nodes" (one-hop neighbours, no invented activity) as toggles; hidden
  nodes lose labels, links and pointer targets too. `igris attention read`,
  `call` and `event` take `--selection boot|task|retrieval|user_request` and
  `--selection-ref <id>`, and the inspector's "Why selected" tells a reported
  reason from an observed retrieval; older receipts show "Not recorded".

- **`igris sync drain` (TD-489).** Retries this machine's brain retry queue
  (the `sync_queue` table failed pushes fill) with the key read from config,
  via the bundled `igris_sync_queue_drain` handler. `/rest` §2.6.5 runs it.

- **`igris sync push` (TD-350).** Pushes the local brain delta to `remote_brain`
  with the url and key read from config (no key argument), via the bundled
  `igris_brain_push` handler; exit 1 on a partial push. `sync status`'s `last
  push` now reads `sync_state` (it read the queue file's mtime, so it printed
  `never` while pushes succeeded), and `boot-sync` adds a `push` freshness field.

- **Project relations (FR-273).** `igris project relations [--project <slug>]
  [--depth <n>] [--direction out|in|both] [--kind <k>] [--no-check]` prints a
  project's related projects from the brain (kind, detail, `repo_url`, on-disk
  flag, watermark); `--boot` prints the one-line `/boot` digest, and
  `igris project kinds list` the relation-kind registry. Read-only, through the
  brain's own relations module in the bundled engine (no second copy of the
  logic); a missing brain, module or migration degrades with the reason named,
  exit 0. The brain adds `igris_project_relations`, `igris_project_relate` and
  `igris_project_relation_kinds`, and both relation tables sync. Writes:
  `igris project relate|unrelate` and `igris project kinds add|alias|merge`
  (exit 0 written, 1 refused, 3 degraded). The brain adds
  `igris_project_relations_derive` (manifest matches → pending suggestions).

- **The brain records which commit its knowledge of a project reflects (FR-274).**
  Three nullable `projects` columns — `knowledge_sha`, `knowledge_branch` (NULL
  on a detached HEAD) and `knowledge_recorded_at` (the DB clock) — added by the
  projects component's migration v2. The new hidden verb
  `igris project watermark [--project <slug>]` records the HEAD of the project
  row's path, only when that path is a repo top level; `/rest` and the
  SessionEnd hook call it. Every failure (path gone, not a git top level, git
  missing or failing, unborn HEAD, unregistered slug, a brain without
  projects:2) writes nothing and is named in the digest's `skipped[]`, so a
  known watermark is never blanked. `igris_project_status` prints
  `Knowledge as of:`, a copy-pasteable `Since: git log --oneline '<sha>..origin/<branch>'`
  line and a local `Knowledge check:` after `Clone:` — reachable (noting
  commits ahead of origin that were never pushed), UNREACHABLE, DIVERGED (only
  for a real fork), not verified, or invalid (a stored value that is not a full
  commit SHA, refused before any git call); no fetch. A project without one reads
  `Knowledge as of: no watermark recorded`. Local to each brain — not
  replicated (FR-271 owns that).

- **Projects record where their source lives (`projects.repo_url`, FR-265), and
  `igris_project_register` validates its input and stops blanking curated
  columns (TD-365).** A new nullable `repo_url` column, added by the projects
  component's migration v1 (the component registry, independent of the legacy
  schema chain; local to each brain — not replicated). Registration fills it
  from `git remote get-url origin` when the path is a repo's top level
  (credentials stripped), `igris_project_update` sets or clears it, and
  `igris_project_status` prints `Repo URL:` and a copy-pasteable `Clone:` line.
  A project whose directory is gone but whose `repo_url` is recorded is what
  `igris doctor` reports as `source-reclaimed`. The register handler now rejects
  a null, empty or whitespace `slug`, `name` or `path` in-band
  (`Validation error: Invalid <key>: must be a non-empty string.`) instead of
  surfacing a raw `NOT NULL constraint failed`, and a call that omits
  `tech_stack` or `repo_url` no longer overwrites the stored value (the
  handler used to bind an omitted `tech_stack` as `''`). An explicit value,
  including `''`, still wins.
- **Project-context docs now replicate across machines (TD-460).**
  `context_files` joins `SYNC_TABLES` and `BOOT_SYNC_PULL_TABLES`, so a doc
  authored on one machine reaches every machine on the same VPS. The FILE under
  `~/.igris/projects/{slug}/context/` remains the authority; the row is a
  content-addressed replica for transport only. One new brain tool,
  `igris_context_sync`, reconciles both directions in a single pass and is
  called from `/boot` Mount (after `boot-sync`), `/ground` and `/document`.

  A locally-newer file is ABSORBED into the row rather than refused, because
  context docs are disk-authored; a brain-newer row is materialised to disk
  only after the prior bytes are backed up to
  `~/.igris/projects/{slug}/context-backups/`. `file_path` is excluded from the
  replicated columns — an absolute local path has no cross-machine meaning, and
  the receiver rebuilds it from its own root. What ESTABLISHES the exclusion is
  the five-column `context_files` section of the regenerated
  `docs/reference/sync-egress-manifest.md` and the pin in `auto-push.test.ts`
  asserting the column is in NEITHER `columns` NOR `redactCols`. The CLI twin
  `cli/src/lib/sync/egress-manifest.generated.ts` regenerates to identical
  bytes because it carries no per-table column list at all — that zero diff is
  not a missed regeneration, and it is not evidence of the exclusion either
  (it would read the same if `file_path` were in `columns` and merely absent
  from `redactCols`). The `.igris-pack` bundle is unchanged: it still carries
  these docs as FILES, never as rows.

  **Deploy order is a precaution here, not a constraint — and the reason
  matters.** `GET /sync/pull` iterates THE REMOTE'S OWN `SYNC_TABLES` against
  THE REMOTE'S OWN DB (`brain-mcp-server/src/index.ts`, the `/sync/pull`
  handler), so no ordering lets a client push 500 it: an old remote has no
  `context_files` entry to iterate and never reads the unknown
  `since_context_files=` query param, and a new remote ran the context
  component's v1 migration at its own boot. That holds precisely because this
  change adds a TABLE and no column to an existing one; the column hazard
  `MAINTAINING.md` states (a column the REMOTE'S config names but its DB lacks
  500s the endpoint for every table) is a different case and is not in play.
  Push-first also loses nothing: a remote that lacks the table names it in
  `skipped[]` and both push clients hold that table's watermark (BR-097).
  Deploying the VPS first is still the order to prefer — it is what makes the
  new table's rows actually reach the other machine — but it is a preference,
  not a precondition.

### Changed

- **The package's `CHANGELOG.md` starts at 7.3.1 (FR-276).** 7.3.0 and earlier
  moved verbatim to `cli/CHANGELOG-ARCHIVE.md` in the repository, which the
  package does not ship; without the move the attention map would have taken
  the tarball past its packed-size ceiling.

- **`igris sync code` reuses the VPS `node_modules` when nothing install-relevant
  changed (TD-487).** The runner fingerprints node + npm, the lockfile, the root
  and workspace `package.json` files and the root `.npmrc`; on a match with the
  marker inside the live tree it copies that tree into the stage instead of
  running `npm ci`, smokes the copy, and runs `npm ci` if anything fails. A
  skipped deploy prints the command that forces a clean install. On the brain
  VPS (Ubuntu 24.04, Node 22.23.3, 2026-10-01, one A/B pair) install fell from
  408 s to 107 s (−74%) and client wall from 762 s to 467 s (−39%); on a macOS
  workstation (warm npm cache) the copy saved nothing.

### Fixed

- **`npm install -g igris-ai` on Linux x64 installs the brain's dependencies
  again (BR-119).** The postinstall sets `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`,
  so onnxruntime-node skips its CUDA download, whose URL now returns 404.

- **A git worktree resolves to its repository's project (TD-359).** `igris
  detect` and every `--project` default resolve through a marker, the
  registry, then the main checkout instead of `basename(cwd)`. `detect` adds
  `project_source`.

- **`session register` keeps the brief on re-register and records the
  worktree root as `project_path` (TD-494).**

- **A remote that echoes the API key no longer gets it stored or printed
  (BR-118).** Brain sync redacts the key from remote error text before
  queueing, returning or logging it; `sync data` redacts it too.

- **`igris sync code` can no longer leave the VPS on a wiped dependency tree
  or report success on an unhealthy brain (BR-116).** A slow `npm ci` was
  killed by the 5-minute ssh timeout with `node_modules` already deleted. A
  DETACHED runner in `<repo_path>/.igris-deploy/` now installs + builds into a
  stage copy and swaps `node_modules` + `dist` in only after a native smoke
  (which now instantiates `better-sqlite3` — TD-141's `require` never loaded
  it), with live re-smoke + rollback; the 30-min wait is reported, never
  enforced by killing. Exit 0 needs pm2 `online` + `/health` `ok` twice (one
  restart retry), so `sync all` skips `data` on an unhealthy brain. Refuses
  when a deploy runs, a swap was interrupted or disk is short. Errors name
  npm's real exit code, not EBADENGINE warnings; `sync status` shows
  `vps node:`. Update the CLI on EVERY deploying workstation: an older CLI's
  `rsync --delete` removes `.igris-deploy/`.

- **`igris sync code` no longer exits 0 right after "launched" (BR-117).** The
  poll wait was an unref'd timer, so a standalone CLI emptied its event loop
  and abandoned the deploy before the restart and health check. The wait now
  holds the process, and an `igris sync` that ends before its result is known
  exits 1. Rebuild the CLI on every deploying workstation.

- **`igris doctor --remove-orphans` no longer reports clean while drift survives
  (BR-087).** Declining a row (`n`), aborting (`a`) and running out of piped
  input all used to exit 0 with a `path-missing` row still in the registry,
  and a pipe with more than one answer processed only the first (readline
  dropped every line that arrived while no question was pending). Answers are
  now read through a line queue, so every piped answer is consumed in order,
  and end of input means "not adjudicated". The exit code comes from a
  re-read of the registry rather than the sweep's own report, so every one of
  those rows keeps the verb at exit 1; the output names each row as
  `kept (declined): <slug>` or `not adjudicated: <slug>`. **Behaviour change:**
  a declined, aborted or unanswered sweep now exits 1.
- **`--remove-orphans` shows what each orphan owns and has a safe subset
  (TD-310).** Every `path-missing` row carries `briefs N, learnings M` (plus
  errors and sessions when non-zero) in the drift table, in a detail block
  printed on every run, and in its prompt — before anything is asked. New
  flags: `--empty-only` (non-interactive; removes exactly the rows that own
  nothing), `--slug <slug>` (one row), and `--include-owning` (with `--yes`
  only). **Behaviour change:** `--yes` alone now REFUSES a row that owns briefs
  or learnings — before, a learnings-only row (no foreign key to stop it) was
  deleted silently; `all` at the prompt no longer auto-confirms a data-owning
  row. A moved project is offered a re-point
  (`igris register-project <new-path> --slug <slug>`), and that command no
  longer resets the project's curated name or blanks its tech stack: the CLI
  registry upsert now only FILLS an empty `name`/`tech_stack` on conflict
  (`path` still moves). After the sweep, knowledge whose project row is already
  gone is reported as `dangling knowledge (no registry row)` — never deleted.
- **A deliberately reclaimed project is no longer called an orphan (FR-265,
  CLI half).** A row whose directory is gone but which records its repository
  URL is classified `source-reclaimed`: exit-neutral (not drift), printed with
  a copy-pasteable `restore <slug>: git clone -- '<url>' '<path>'` line, and
  never offered for deletion. The CLI reads that column only when the brain
  has it, so the class is dormant until the brain's repository-URL migration
  ships; `/boot` and `/igris-doctor` already ignore it.

---

## [7.3.2] - 2026-09-09

Hotfix on `v7.3.1`. The CLI half: the `brain-core-stale` detector compared a
tarball content hash against a git commit hash and so fired on every
GitHub-channel install (TD-301), and `engines.node` advertised a Node the
package cannot install on (BR-105). See the root `CHANGELOG.md` for the whole.

### Fixed

- **`brain-core-stale` no longer fires on every GitHub-channel install
  (TD-301).** The detector compared `.install-source.json`'s `content_sha256`
  (64-hex sha256 of the tarball) against a 40-hex git commit SHA — two
  different hash types, so it was unconditionally true, and the `igris refresh`
  it recommended could not clear the row (clean-room container, 2026-09-08).

  Both sides are commit SHAs now. `release`/`tag` installs are exempt (the ref
  is immutable; a force-pushed tag is knowingly not detected, and the default
  path gains no network call). `main`/`branch` installs record an optional
  `ref_commit_sha` (schema v2) compared against the ref's head; a record
  without it — every pre-7.3.2 record — is never flagged, and `igris refresh`
  backfills it. The write is best-effort: no call on the exempt paths, every
  error swallowed, `--dry-run` untouched.

  **Take it with `npm i -g igris-ai@7.3.2`** — the fix is in the published
  `dist`, so no `igris refresh` and no `igris init --upgrade` are needed.

### Changed

- **Supported Node is now `>=22.0.0 <23.0.0 || >=24.0.0 <27.0.0` (BR-105) —
  measured, not assumed.** It was `>=20.0.0 <27.0.0` in the manifest and a
  hard-coded `major < 20` in the runtime guard, so the CLI refused at a
  different boundary than it advertised.

  **This does not make Node 20 work; it stops advertising it.** The floor is a
  property of `better-sqlite3`'s prebuild matrix: with no prebuild for an ABI,
  `npm install -g igris-ai` falls through to `node-gyp` and dies without a C++
  toolchain. Measured 2026-09-08, one `npm install -g` per major in a stock
  `node:<major>-bookworm-slim` container — arm64: 20 FAIL, 21 FAIL, 22 PASS,
  23 FAIL, 24 PASS, 25 PASS, 26 PASS; x64: 20 FAIL, 22 PASS, 23 FAIL, 26 PASS;
  no `node:27` image exists and the range excludes 27. The pass set is not
  contiguous — 23 (EOL) has no prebuild — hence the two-set `||`.

  A Node-20 user now sees an `EBADENGINE` line naming the range first; the
  install still fails. `igris init` (the guard's only caller) refuses on
  20/21/23 and 27+; `doctor`, `install`, `update`, `sync` and `refresh` are
  unaffected. With `engine-strict=true` in `.npmrc` the install hard-fails
  where 7.3.1 warned. No install-time refusal was added — TD-377 owns that,
  and npm dies inside `better-sqlite3`'s build before any hook of ours runs.

  One test (`engines-parity.test.ts`) pins the three `engines.node` fields, the
  four lockfile entries, the guard's derived floor, the three CI
  `node-version` pins and the SETUP_GUIDE sentence to the one string.

---


## [7.3.1] - 2026-09-08

Patch on `v7.3.0`, the first 7.3.x published to npm (7.3.0's publish was
gated on an unset `NPM_TOKEN`). The CLI half: `igris install <path>` keeps a
foreign MCP registration (TD-455), the bats tier fences `HOME` (TD-456),
`machine.aliases` is bounded (TD-453), and the bundled brain carries the
TD-454 / TD-458 claim gates and TD-457's anchor with schema v6. The
pre-commit and commit-msg hooks a fresh install fetches from the release no
longer fail open on a quoted hostname, alias, role or project name (TD-453,
BR-104 — root `CHANGELOG.md`).

### Fixed

- **TD-455** — `igris install <path>` keeps an existing `~/.claude.json`
  `igris-brain` registration that points at a different, existing bundle
  (`igris-brain MCP kept -> <existing>`); it writes only when the entry is
  absent or dangling (old → new reported, backup `~/.claude.json.igris.bak`).
  Re-pointing is `igris init --upgrade` (`--dev` for a clone). `--dry-run`
  names the decision.
- **TD-456** — the bats tier fences `HOME` (`stage_brain` / `fence_home` +
  `assert_home_fenced`); a guard reds an unfenced `install` / `init`.

### Changed

- **TD-457** (bundled brain) — the subconscious anchor no longer takes an
  illustrative `evidence.brief_id` when the title names no brief; schema v6 re-keys
  `suggestions` on the next run.
- **TD-458** (bundled brain) — the subconscious claim matcher refuses two findings
  whose titles name DISJOINT module sets from the code's closed vocabulary (the
  `stalled`/`gap` flood is not the `edge_inference` flood); 3 same-block false merges
  fixed on the 2026-09-08 corpus, 0 labelled SAME pairs broken, no re-key.
- **TD-453** — `config.json` `machine.aliases` is bounded: the identity
  writer keeps the newest `ALIAS_CAP = 16` hostnames and evicts the oldest on
  the 17th distinct name; a hand-edited oversize list is left alone.
- **TD-454** (bundled brain) — the subconscious dedup gains a project-set
  gate: two findings that name different sets of registered projects are
  never merged as paraphrases. No re-key; the registered slugs are the
  vocabulary, loaded once per run.

---

## Earlier releases

7.3.0 and earlier are in `cli/CHANGELOG-ARCHIVE.md` in the repository, moved
there verbatim to keep the npm package inside its packed-size ceiling (FR-276).
