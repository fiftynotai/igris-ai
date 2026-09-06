# Igris AI Setup Guide

Complete guide to setting up Igris AI v7.0 in your project.

---

## Prerequisites

Before you begin, ensure you have:

- **Git** - Version control system
- **Claude Code** - Claude Code CLI installed and configured
- **Python 3** - For JSON manipulation and utilities (usually pre-installed on Mac/Linux)
- **Bash** - Shell environment (Mac/Linux/WSL on Windows)
- **sqlite3** - For brain database operations (usually pre-installed)
- **Node.js 20+** - (Optional) Required only if using the MCP brain server

---

## Installation

Igris AI v7.0 uses a single brain-based install. The centralized brain lives at `~/.igris/`, and every surface (skills, agents, MCP, hooks) projects **globally** at `igris init` (FR-212c/d) — into the universal skill store, the global harness agent/MCP dirs, and the one global `~/.claude/settings.json` hooks block. `igris install <path>` is **register-only**: it registers the project with the brain (so the global hooks apply) and writes no files into the project repo. A single `igris init`/`igris refresh` re-projects the global surfaces and every registered project sees the change immediately.

```bash
# Step 1: Install the CLI globally from npm
npm install -g igris-ai

# Step 2: Initialize the brain
igris init

# Step 3: Install into your project
cd /path/to/your-project/
igris install .
```

**What this does:**
- Bootstraps the centralized brain at `~/.igris/` (SQLite database with FTS5 search, agents, skills, prompts)
- Registers the bundled `igris-brain` MCP server into the supported harness configs: Claude Code → `~/.claude.json`, OpenCode → `~/.config/opencode/opencode.json`, Codex → `~/.codex/config.toml`, Gemini CLI → `~/.gemini/settings.json`, Antigravity → `~/.gemini/config/mcp_config.json` (Antigravity rides the Gemini config family, from its own file), and Cursor → `~/.cursor/mcp.json`.
- First-class harnesses — Igris's gates run natively there: Claude Code, OpenCode, Antigravity. Bridge harnesses — brain, skills and MCP reach them, and agents too where the harness has a static-agent surface (Cursor has none; it reads the canonical agent files in-process instead); only the gates soften to advisories: Codex, Gemini CLI, Cursor. The tier derives from `harnesses.<id>.hooks.supported` in `harness-manifest.json` — see [Harness tiers](multi-cli.md#harness-tiers) for the definition and the one-line command that re-derives the membership.
- **Projects every surface GLOBALLY at `igris init`** (FR-212c/d): skills via the pinned `skills` CLI into the universal store (`~/.claude/skills` + `~/.agents/skills`); agents into the global harness agent dirs; the canonical Igris hooks block merged ONCE into the GLOBAL `~/.claude/settings.json`
- Registers the project in the brain so it shows up in `/ops` and cross-project queries — this registration is what de-no-ops the global hooks for the project (the `_gate.sh` registration gate)

> **`igris install <path>` is REGISTER-ONLY (FR-212d):** it writes NO per-project
> `.claude/` symlink layer, NO per-project `settings.json`, and NO `.igris_version`
> marker. Those were retired — every surface projects globally at `igris init`.
> `install` just registers the project path with the brain (so the global hooks
> apply) + writes `installed_features.json` for upgrade detection.

> **Restart your harness(es) after `igris init`** so they pick up the newly registered `igris-brain` MCP server. The brain tools are not available until the harness reloads its config (e.g. Claude Code reloads `~/.claude.json`).

Project state (sessions, briefs, plans, generated context docs) lives under `~/.igris/projects/<slug>/` — **not** in the project repo. FR-212d made `igris install` register-only: it writes **no files into the project repo** (FR-191 zero-config already removed the `CLAUDE.md` render; FR-212d removed the `.claude/` symlink layer + `.igris_version`).

### Onboarding (`/setup` and `igris configure`)

A fresh install is deliberately **zero-config**: no persona override, no VPS, and both LLM-extraction engines (perception + subconscious) **OFF**.

The guided path is the **`/setup`** skill. On a fresh brain, `/boot` shows a one-time Welcome and points you into `/setup`, which teaches the register → hunt → rest loop with a consented, repo-safe first `/ground`. Run `/setup` again any time later and it becomes a **re-runnable settings editor** (and can re-play the tour). Under the hood `/setup`'s reconfigure path shells the `igris configure` verb described below — so you can also run that verb directly:

```bash
igris configure
```

It walks you through five things, **seeding every prompt from your current state** (press Enter to keep the current value):

1. **Identity** — your name + email (written to `~/.igris/USER.md`).
2. **Persona** — pick a shipped SOUL preset:
   - `character` — the battle-ready, evolution-style Igris voice (the shipped default).
   - `professional` — a dry, neutral, matter-of-fact register.

   The chosen preset is copied over `~/.igris/core/SOUL.md`. Every preset carries the required `layer/tier/scope/summary` frontmatter, so the OS-index generator stays valid.
3. **Remote brain (VPS)** — **by address presence**: enter a URL to enable cross-machine sync, or leave it **blank to disable** it. A non-local `http://` URL is **refused** (your `api_key` would travel in cleartext) unless you set `IGRIS_ALLOW_INSECURE_SYNC=1`; use `https://` instead. The `api_key` is stored in `~/.igris/config.json`, which is always chmod-tightened to `600`. Before you enter the URL, the prompt discloses exactly what egresses to the VPS; local filesystem paths are relativized before any row leaves your machine. Full disclosure: [`docs/reference/sync-egress-manifest.md`](reference/sync-egress-manifest.md).
4. **Cognition toggles** — turn perception and/or subconscious ON or OFF. These write the nested `cognition.perception.enabled` / `cognition.subconscious.enabled` keys in `config.json`.
5. **Preferences** — addressing (how Igris refers to you), notification style, and the auto-approve effort threshold, all written to the `## Preferences` block of `~/.igris/USER.md`.

**Flags:**

| Flag | Effect |
|------|--------|
| `--persona <name>` | Apply a persona preset directly; skips the persona prompt. |
| `--skip-remote` | Skip the VPS prompt; leave `remote_brain` unchanged. |
| `--dry-run` | Print the plan of would-be writes and exit — writes nothing. |
| `-y, --yes` | Keep the current values; skip all prompts. A `--yes` run is a **no-op on values** (nothing is reset to a default). |

`igris configure` requires `igris init` to have run first (it dials an existing install — it does not create `config.json`).

You can also pick a persona at install time:

```bash
igris init --persona professional
```

> **Note on `igris refresh`:** a refresh re-fetches `~/.igris/core/` (where `SOUL.md` lives) but preserves your `config.json` toggles. Because the active persona is written under `core/SOUL.md`, **re-run `igris configure --persona <name>`** after a refresh if you want to keep a non-default persona.

### Verify Installation

```bash
# FR-212d: surfaces project GLOBALLY (not into the project repo). Confirm the
# global skills store + the global hooks block + the brain MCP registration:
ls -la ~/.claude/skills/        # skills via the `skills` CLI delegate (claude)
ls -la ~/.agents/skills/        # the cross-CLI universal store (every skills-target harness EXCEPT claude)
cat ~/.claude/settings.json     # the ONE global Igris hooks block (FR-212c)
igris doctor                    # registry + brain-MCP + drift health

# The project repo gets NO Igris files (register-only install): no .claude/
# symlink layer, no settings.json, no .igris_version, no CLAUDE.md.

# Brain-side state (outside the project repo) lives under:
# ~/.igris/projects/<slug>/
# ├── session/            # Session tracking
# ├── briefs/             # Local brief cache (briefs live in the brain DB)
# ├── plans/              # Architect plans
# └── context/            # Generated architecture docs (from /document)
# ├── installed_features.json   # content hashes for `igris update` detection
```

### Check Brain Health (Brain-First Only)

```bash
# Verify brain is installed
ls ~/.igris/

# Check database integrity
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA integrity_check; PRAGMA journal_mode;"

# List registered projects
sqlite3 ~/.igris/memory/knowledge.db "SELECT slug, path, status FROM projects;"
```

### Verify the brain MCP is registered

```bash
# Confirm the igris-brain MCP entry exists in ~/.claude.json
python3 -c "import json; print(json.load(open('$HOME/.claude.json'))['mcpServers']['igris-brain'])"

# Or let doctor check it for you (reports the `mcp-unregistered` drift
# class if the entry is missing or points at a deleted file):
igris doctor
```

If `igris doctor` reports `mcp-unregistered`, run `igris doctor --fix` (or
`igris init --upgrade`) to register it, then restart Claude Code.

---

## The Brain MCP Server

The `igris-brain` MCP (Model Context Protocol) server provides the brain
tools — persistent memory, brief management, cross-project intelligence —
to every harness Igris supports. Claude Code, OpenCode and Antigravity are
first-class (the gates run natively); Codex, Gemini CLI and Cursor are bridge
harnesses (the gates soften to advisories, while brain, skills and MCP still
reach them — as do agents, on the harnesses with a static-agent surface). See
[Harness tiers](multi-cli.md#harness-tiers).

**It ships inside the `igris-ai` npm package and registers itself
automatically.** `npm install -g igris-ai` bundles a pre-built
brain-mcp-server, and `igris init` adds the `igris-brain`
entry to the supported MCP config files (`~/.claude.json`,
`~/.config/opencode/opencode.json`, `~/.codex/config.toml`,
`~/.gemini/settings.json`, `~/.gemini/config/mcp_config.json` for
Antigravity, and `~/.cursor/mcp.json`). There is no separate
clone-build-configure step.

**Restart Claude Code** after `igris init` so it picks up the new MCP
server.

### Native dependencies (built at install time)

The brain MCP relies on native modules (`better-sqlite3`, `sqlite-vec`)
whose compiled binaries must match your machine's OS and architecture — so
the `igris-ai` package does **not** ship them pre-built. A `postinstall`
step builds them on your machine immediately after `npm install -g igris-ai`.
Watch the install output for these lines:

```
igris-ai: installing igris-brain MCP dependencies...
igris-ai: igris-brain MCP dependencies ready.
```

**Verify after install** that the dependencies landed:

```bash
ls "$(npm root -g)/igris-ai/dist/brain-mcp-server/node_modules/@modelcontextprotocol/sdk" >/dev/null 2>&1 \
  && echo "brain MCP dependencies OK" \
  || echo "brain MCP dependencies MISSING — see Troubleshooting"
```

If the install instead printed a `WARNING: igris-brain MCP dependency
install did not complete` block, or the check above reports `MISSING`, the
brain MCP will fail to spawn — see [Brain MCP fails to spawn](#issue-brain-mcp-fails-to-spawn-err_module_not_found)
in Troubleshooting for the one-command fix.

### Degraded mode (vector search)

The MCP's vector-search feature depends on `@huggingface/transformers`, a
heavyweight optional dependency (ONNX runtime). It is listed under
`optionalDependencies`, so if `npm install -g igris-ai` cannot build it on
your platform, the install still succeeds and the MCP still boots — only
semantic/vector search degrades to FTS5 keyword search. Briefs, memory,
sessions, tasks, and sync are unaffected.

### Contributors (developing Igris itself)

If you are working on the Igris source and want Claude Code to use your
working clone's MCP rather than the bundled copy:

```bash
igris init --upgrade --dev --from-source /path/to/igris-ai
```

`--dev` registers `<clone>/brain-mcp-server/dist/index.js` so your
edit-rebuild-test loop is not broken by a repoint to the stale bundled
copy. `--dev` requires `--from-source`.

### Sandboxing the brain — the env seams

Anything that boots the brain server outside your real `~/.igris` — a test, a
build step, a maintenance script — must point it at a throwaway tree, or it
opens **and migrates** the live `~/.igris/memory/knowledge.db`. The server
resolves its DB through ONE function, `brain-mcp-server/src/db.ts#resolveDbPath(explicit?)`,
highest tier first (empty strings fall through to the next tier):

1. **explicit path** — CLI verbs (`cli/src/lib/paths.ts#brainDbPath`) and
   maintenance scripts (`--db`) pass one; env vars never move it.
2. **`IGRIS_DB_PATH`** — full-path override for a process that passes none
   (the standalone `dist/index.js` boot, `brain-mcp-server/scripts/*`).
3. **`IGRIS_BRAIN_DIR`** → `<dir>/memory/knowledge.db`.
4. **default** — `~/.igris/memory/knowledge.db`, with `os.homedir()` read at
   call time.

**A sandbox sets `IGRIS_BRAIN_DIR`.** It is the one seam that moves everything
together: the CLI helpers' brain root, the server's DB (tier 3), its pidfile
registry (`brain-mcp-server/src/stdio-lifecycle.ts#pidsDir`: `IGRIS_PIDS_DIR` >
`IGRIS_BRAIN_DIR/brain-mcp-server.pids` > `~/.igris/brain-mcp-server.pids`) and,
since TD-414, the brief/session projection root
(`brain-mcp-server/src/engine/components/cache/handlers.ts#cacheRoot`:
`<dir>/projects/` > `~/.igris/projects/`, read at call time) — so a sandboxed
brain never projects brief files into your real `~/.igris/projects/`.
Create `<dir>/memory/` first — better-sqlite3 creates the DB file, never its
parent directory, and a missing parent crashes the boot.

`IGRIS_DB_PATH` is a server/scripts override only. CLI verbs and the dashboard
IGNORE it by design (the FR-241 poison fence:
`cli/src/__tests__/dashboard-triage-endpoint.test.ts` asserts that a poison
value does not move their writes); never add it to `paths.ts`.

Neither seam moves `os.homedir()`: anything that reads `~/.claude.json` or
`~/.igris/config.json` still sees your real home. A hermetic spawn sets a fake
`HOME` as well (tier 4 follows it).

The server prints the DB it opened on boot — `[brain] db: <path>` on stderr.
`cli/scripts/smoke-bundled-mcp.sh` (run by `cd cli && npm run build` and by
the publish workflow) sets tiers 2 and 3 to a `mktemp` sandbox, parses that
line, and fails the build unless the path is inside the sandbox and the sandbox
DB exists non-empty; `cli/tests/integration/build-smoke-sandbox.bats` proves it against
a decoy brain under a fake `HOME`. Before TD-426 the build booted the bundle
against the live brain and applied whatever migration was pending (instances
v3 on 2026-08-26, v4 on 2026-08-27).

Model-cache location for the embeddings backend after a rebuild: TD-429.

---

## Configuration

### Generate Architecture Documentation

After installation, generate project-specific documentation:

```
/document architecture
```

This will:
1. Scan your project structure
2. Ask clarifying questions about your architecture
3. Generate documentation files in `~/.igris/projects/{project}/context/`:
   - `architecture_map.md` - Architecture overview
   - `api_pattern.md` - API interaction patterns
   - `coding_guidelines.md` - Code style and conventions
   - `module_catalog.md` - Module inventory

### Generate Coding Guidelines

```
/ground analyze
```

This analyzes your codebase and generates project-specific coding guidelines.

---

## First Brief

### List Briefs

```
List all bugs
```

### Register a New Brief

```
/register bug "Memory leak in UserViewModel"
```

### Implement a Brief

```
/hunt BR-001
```

This activates the multi-agent workflow:
1. **ARCHITECT** plans the implementation
2. **FORGER** writes the code
3. **SENTINEL** runs tests
4. **WARDEN** reviews the changes
5. Commit and mark brief as Done

---

## Daily Workflow

### Morning: Check Status

```
/scan
```

This shows session status, active briefs, blockers, and recommendations.

### Register New Work

```
/register bug "Profile picture doesn't update after upload"
```

### Implement Work

```
# Ask for recommendations
What should I work on next?

# Implement the recommendation
/hunt BR-005
```

### End of Day

```
/rest
```

This archives the current session to `~/.igris/projects/{project}/session/archive/`.

---

## Available Commands

| Command | Purpose |
|---------|---------|
| `/scan` | System status report |
| `/boot` | Start/resume session |
| `/rest` | Pause/end session |
| `/register` | Create new brief |
| `/hunt` | Implement brief (full workflow) |
| `/archive` | Archive completed brief |
| `/document` | Documentation workflow |
| `/ground` | Generate coding guidelines |
| `/release` | Release preparation |
| `/ideate` | Feature brainstorming |
| `/audit` | Codebase audit |
| `/team` | Parallel execution |
| `/ops` | Cross-project command center: in-flight work, blockers, projects, and brain health |

---

## Troubleshooting

### Issue: "Igris AI not initialized"

**Solution:**
```bash
# Run the initialization (v7 CLI):
igris install .
```

### Issue: "Permission denied" when running scripts

**Solution:**
```bash
chmod +x scripts/*.sh
```

### Issue: Python not found

**Solution:**
```bash
# Mac:
brew install python3
# Ubuntu:
sudo apt-get install python3
```

### Issue: sqlite3 not found

**Solution:**
```bash
# Mac (usually pre-installed):
brew install sqlite3
# Ubuntu:
sudo apt-get install sqlite3
```

### Issue: Brain database corrupted

**Solution:**
```bash
# Check integrity
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA integrity_check;"

# If corrupted, re-initialize
cd /path/to/igris-ai && igris init
```

### Issue: Brain MCP fails to spawn (`ERR_MODULE_NOT_FOUND`)

**Symptom:** The `igris-brain` MCP server does not connect in Claude Code.
Its MCP log shows:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@modelcontextprotocol/sdk'
```

**Cause:** The brain MCP's native dependencies were never installed. This
happens when `npm install -g igris-ai` ran with install scripts disabled
(`--ignore-scripts`, or `npm config get ignore-scripts` returns `true`), so
the `postinstall` step that builds them was skipped.

**Solution:** Build the brain dependencies manually. The bundle lives at
`$(npm root -g)/igris-ai/dist/brain-mcp-server`:

```bash
cd "$(npm root -g)/igris-ai/dist/brain-mcp-server"
npm install --omit=dev
```

If npm is configured to ignore scripts, the native modules still cannot
build — re-enable scripts first, then re-run the install above:

```bash
npm config set ignore-scripts false
```

Restart Claude Code once the install completes. To confirm the fix, re-run
the verification check from
[Native dependencies (built at install time)](#native-dependencies-built-at-install-time).

### Issue: Brain MCP stack traces name `dist/…/*.js`, not `src/…/*.ts`

**Symptom:** An error thrown inside the bundled brain
(`$(npm root -g)/igris-ai/dist/brain-mcp-server/dist/**`) reports a frame like
`at Module.sanitizeFts5Query (…/dist/utils/fts5.js:32:27)`. With the source
map present the same frame reads `…/src/utils/fts5.ts:33:25`.

**Cause:** Since TD-444 (2026-09-06) the published tarball ships no `.js.map`
for the bundled brain. Their `sources` named a `src/` directory the tarball
never shipped and carried no `sourcesContent`, so no consumer could resolve
them anyway; dropping the 139 of them recovered 155.4 KB (159,151 B) of packed size. Two
bounds on what was lost: nothing in Igris spawns the brain with
`--enable-source-maps`, so those frames named `dist/*.js` already unless you
opted in; and the maps stay on disk in a repo checkout and on the VPS
(`scripts/igris_brain_deploy.sh` builds from source) — only a tarball install
lacks them. The CLI's own maps (`dist/index.js.map`, `dist/lib/*.js.map`)
still ship.

**Solution:** Recover the original position against the published tag. The
bundle's version is the tag:

```bash
version="$(node -p "require('$(npm root -g)/igris-ai/dist/brain-mcp-server/package.json').version")"
git clone https://github.com/fiftynotai/igris-ai && cd igris-ai
git checkout "v$version"
cd brain-mcp-server && npm ci && npm run build
```

Then read the frame against the rebuilt `dist/` and its maps — run the
reproduction with `node --enable-source-maps`, or open the sibling
`dist/utils/fts5.js.map` and look up the position by hand. The frame's
`dist/…/*.js:line:col` is the same on both machines because the tag is the
same build input.

### Issue: Global surfaces stale after moving Igris AI repo or upgrading

FR-212d retired the per-project `.claude/` symlink layer — every surface
(skills/agents/MCP/hooks) projects **globally** at `igris init`. If the global
skills/agents/hooks look stale, re-project them:

**Solution:**
```bash
# Re-project the GLOBAL surfaces (skills, agents, MCP, hooks)
igris init

# Or refresh the brain core from the configured channel first:
igris refresh
```

`igris install .` only registers the project with the brain (register-only) — it
does not recreate any surfaces.

---

## Next Steps

After setup:

1. **Restart your harness** (Claude Code, OpenCode, Antigravity, Codex, Gemini CLI, or Cursor) - so it picks up the bundled `igris-brain` MCP server registered by `igris init`
2. **Generate architecture docs** - Run `/document architecture`
3. **Analyze codebase** - Run `/migrate-analyze`
4. **Review generated briefs** - Run `List all briefs`
5. **Start implementing** - Run `/hunt BR-XXX`

---

## Getting Help

- **Documentation:** See `CONTRIBUTING.md` for contribution guidelines
- **Issues:** https://github.com/fiftynotai/igris-ai/issues
- **Discussions:** https://github.com/fiftynotai/igris-ai/discussions

---

**Setup complete! You're ready to use Igris AI v7.0.**
