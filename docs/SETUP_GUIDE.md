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

Igris AI v7.0 uses a single brain-based install. The centralized brain lives at `~/.igris/` and projects receive symlinks into it, so updates to the brain automatically propagate to every linked project.

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
- Registers the bundled `igris-brain` MCP server into all 4 supported harnesses (Claude → `~/.claude.json`, OpenCode → `~/.config/opencode/opencode.json`, Codex → `~/.codex/config.toml`, Antigravity → `~/.gemini/config/mcp_config.json`) so each serves the brain tools (no manual MCP setup — it ships inside the `igris-ai` npm package)
- Symlinks `.claude/agents/` and `.claude/skills/` into your project so all projects share the same brain content
- Merges the canonical Igris hooks block into `.claude/settings.json` (creating the file if absent, backing up any existing one)
- Writes a `.igris_version` marker for upgrade detection
- Registers the project in the brain so it shows up in `/projects` and cross-project queries

> **Restart your harness(es) after `igris init`** so they pick up the newly registered `igris-brain` MCP server. The brain tools are not available until the harness reloads its config (e.g. Claude Code reloads `~/.claude.json`).

Project state (sessions, briefs, plans, generated context docs) lives under `~/.igris/projects/<slug>/` — **not** in the project repo. The only files Igris writes into the project repo are `.claude/` and `.igris_version` (FR-191 zero-config: no `CLAUDE.md` is generated).

### Onboarding (`igris configure`)

A fresh install is deliberately **zero-config**: no persona override, no VPS, and both LLM-extraction engines (perception + subconscious) **OFF**. `igris configure` is the opt-in onboarding verb — a re-runnable dial of an existing install. Run it any time after `igris init`:

```bash
igris configure
```

It walks you through four things, **seeding every prompt from your current state** (press Enter to keep the current value):

1. **Identity** — your name + email (written to `~/.igris/USER.md`).
2. **Persona** — pick a shipped SOUL preset:
   - `character` — the battle-ready, evolution-style Igris voice (the shipped default).
   - `professional` — a dry, neutral, matter-of-fact register.

   The chosen preset is copied over `~/.igris/core/SOUL.md`. Every preset carries the required `layer/tier/scope/summary` frontmatter, so the OS-index generator stays valid.
3. **Remote brain (VPS)** — **by address presence**: enter a URL to enable cross-machine sync, or leave it **blank to disable** it. A non-local `http://` URL is **refused** (your `api_key` would travel in cleartext) unless you set `IGRIS_ALLOW_INSECURE_SYNC=1`; use `https://` instead. The `api_key` is stored in `~/.igris/config.json`, which is always chmod-tightened to `600`.
4. **Cognition toggles** — turn perception and/or subconscious ON or OFF. These write the nested `cognition.perception.enabled` / `cognition.subconscious.enabled` keys in `config.json`.

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
# Confirm the Igris surface inside your project
ls -la .claude/
cat .igris_version

# Expected structure inside the project repo:
# .claude/
# ├── agents/             # 7 native subagents (symlinks → ~/.igris/core/agents/)
# │   ├── architect.md
# │   ├── forger.md
# │   ├── sentinel.md
# │   ├── warden.md
# │   ├── mender.md
# │   ├── seeker.md
# │   └── sage.md
# ├── skills/             # skills (per-dir symlinks → ~/.igris/core/skills/)
# └── settings.json       # Claude Code config + Igris hooks block
#
# .igris_version          # JSON marker recording the installed CLI version

# Brain-side state (outside the project repo) lives under:
# ~/.igris/projects/<slug>/
# ├── session/            # Session tracking
# ├── briefs/             # Local brief cache (briefs live in the brain DB)
# ├── plans/              # Architect plans
# └── context/            # Generated architecture docs (from /document)
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
to every supported harness (Claude, OpenCode, Codex, Antigravity).

**It ships inside the `igris-ai` npm package and registers itself
automatically.** `npm install -g igris-ai` bundles a pre-built
brain-mcp-server, and `igris init` / `igris install` add the `igris-brain`
entry to all 4 supported harness configs (`~/.claude.json`,
`~/.config/opencode/opencode.json`, `~/.codex/config.toml`,
`~/.gemini/config/mcp_config.json` for Antigravity). There is no separate
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
| `/projects` | List brain-registered projects |
| `/portfolio` | Cross-project dashboard |
| `/dashboard` | Brief and session tracker |

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

### Issue: Symlinks broken after moving Igris AI repo

**Solution:**
```bash
# Re-run the install script to recreate symlinks
igris install .
```

---

## Next Steps

After setup:

1. **Restart your harness** (Claude, OpenCode, Codex, or Antigravity) - so it picks up the bundled `igris-brain` MCP server registered by `igris init` into all 4 harness configs
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
