# Multi-CLI Support

**Briefs:** FR-103 (Skill Distribution), FR-104 (Hook Bridge Layer), FR-170 (Harness abstraction), FR-171 (OpenCode first-class), FR-172 (Onboard-harness runbook)
**Status:** Stable
**Last Updated:** 2026-06-08

Igris skills and hooks live canonically under `~/.igris/core/`. This document defines
how those surfaces are distributed to multiple CLI agents (Claude Code, OpenCode,
Gemini CLI, Codex CLI) via filesystem routing — no duplication, no drift.

Two independent axes of coverage:

- **Skills Distribution** (FR-103) — canonical skills in `~/.igris/core/skills/` shipped
  per-CLI via symlink / converter / compiler / none. See [Skills](#skills-distribution)
  below.
- **Hook Coverage** (FR-104) — shared bash hooks in `~/.igris/core/hooks/shared/`
  routed through per-CLI bridges. See [Hook Coverage](#hook-coverage) below.

Both axes use the same `cli_targets` block in `~/.igris/config.json` and the same
`--cli=<list>` flag. An orthogonal `--include=<list>` flag controls which surfaces
ship (defaults to `all`).

---

## Skills Distribution

---

## Supported CLIs

| CLI | Method | Target | Notes |
|-----|--------|--------|-------|
| Claude Code | `symlink` | `~/.claude/skills/` | Each registry-vendored skill (`~/.igris/registry/skills/<name>/`) becomes a symlink at `~/.claude/skills/<name>/`. The compiler emits the symlink from `<target_path>` to the registry-vendored copy — first-class projection on par with codex/gemini (FR-149, see L-519). Core skills live at `~/.igris/core/skills/` and follow the same mechanism. Full directory linked so nested assets (`scripts/`, `workflow-template.md`, `templates/*.md`) are available. |
| OpenCode | `command` | `~/.config/opencode/command/` | **FR-171:** First-class skills distribution via thin command wrappers. Each registry-vendored / core skill gets a `<command-dir>/<name>.md` wrapper whose body loads the canonical `SKILL.md` via OpenCode's `@file` directive (`@~/.igris/core/skills/<name>/SKILL.md`) plus `$ARGUMENTS`. The canonical SKILL.md stays the single source of truth — the wrapper is a pointer, not a copy (no edit-drift; only ADD/REMOVE drift). Supersedes the prior `none`/soft-fallback posture that relied on OpenCode reading `~/.claude/skills/`. OpenCode is ALSO first-class for agents — see [Subagent Distribution](#subagent-distribution). |
| Codex CLI + Gemini CLI (cross-CLI shared) | `symlink` | `~/.agents/skills/` | **FR-157:** Codex AND Gemini both natively discover `~/.agents/skills/` as the cross-CLI shared skill location (Codex's `core-skills/src/loader.rs` walks it; Gemini docs at `docs/cli/skills.md` reference it explicitly). Per-skill symlink at `~/.agents/skills/<name>/` → registry-vendored canonical OR `~/.igris/core/skills/<name>/` for core skills. Symlink target MUST be absolute (codex resolves relative-path symlinks from cwd — same D2 enforcement as the legacy `codex/symlink` target). Antigravity CLI (Gemini's successor, post 2026-06-18) is expected to standardize on this path. |
| Codex CLI (legacy per-CLI) | `symlink` | `~/.codex/skills/` | **Retained for back-compat**. Pre-FR-157 personal overlays may still declare `codex/symlink` targets at `~/.codex/skills/`. New manifests should use the cross-CLI `agents/symlink` target instead. Drift-verify enforces the same D2 absolute-path guard. |
| Gemini CLI (legacy per-CLI) | `symlink` | `~/.gemini/skills/` | **Retained for back-compat**. Pre-FR-157 personal overlays may still declare `gemini/symlink` targets at `~/.gemini/skills/`. New manifests should use the cross-CLI `agents/symlink` target instead. |

---

## Configuration

`~/.igris/config.json` has a top-level `cli_targets` block controlling distribution:

```json
{
  "cli_targets": {
    "claude":   { "method": "symlink", "target": "~/.claude/skills/" },
    "opencode": { "method": "command", "target": "~/.config/opencode/command/" },
    "gemini":   { "method": "symlink", "target": "~/.gemini/skills/" },
    "codex":    { "method": "symlink", "target": "~/.codex/skills/" }
  }
}
```

Each entry supports:
- `method` — one of `symlink`, `command` (FR-171, OpenCode skill wrappers),
  `none` (the legacy `converter` / `compiler` methods were retired by FR-153
  along with their adapter scripts)
- `target` — output path (tilde-expanded, relative paths resolve from project root at sync time)
- `note` — human-readable intent, for maintainers

> **Scope of `cli_targets`:** this block governs **SKILLS distribution only** —
> turning `~/.igris/core/skills/` into per-CLI skill artifacts. It does **not**
> govern per-agent subagent prompts. Subagent distribution is a separate layer
> — see [Subagent Distribution](#subagent-distribution) below (TD-021). The
> optional `codex.agents` sub-block (added by TD-021) describes the subagent
> surface.

> **`cli_targets.<harness>.target` is DESCRIPTIVE, not load-bearing (FR-172).**
> The string `cli_targets` does **not appear at all** in the bash adapters
> (`compile_harnesses.sh` / `check_harness_drift.sh`), and the only TS consumers
> read its **top-level keys** for a CLI-installed-but-unbridged presence check
> (`cli/src/lib/drift/bridge-missing.ts`) — neither dereferences `.target`. The
> **actual projection paths** come from `surfaces-manifest.json` (skills) and
> `harness-manifest.json` + the personal overlay (agents). So `target`/`method`
> here are honest documentation for human readers, but editing `.target` will
> **not** change where a surface projects — edit the manifest for that.

### Skills as a `surfaces.skills` manifest declaration (FR-137 → FR-153)

As of FR-137 the skill projection logic lives inside the FR-136 manifest-driven
harness engine as first-class `surfaces.skills` targets — projected (and
drift-checked) by `igris harness compile` / `igris harness drift`, exactly the
way per-agent harnesses are. **FR-153** then unified all three harnesses
(claude/codex/gemini) onto the same per-skill registry-anchored symlink
projection that FR-149 established for claude, and **retired** the legacy
`md_to_agents_md.sh` (AGENTS.md aggregator) + `md_to_gemini_toml.sh` (per-skill
TOML converter) scripts entirely.

The core skills surface is declared once, globally, in the core-owned
`core/scripts/cli-adapters/surfaces-manifest.json`. Post-**FR-157**, the
recommended shape is the **2-target** form (claude + agents):

```json
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      {
        "source": "~/.igris/core/skills",
        "layer": "core",
        "targets": [
          { "type": "claude", "method": "symlink", "path": "~/.claude/skills" },
          { "type": "agents", "method": "symlink", "path": "~/.agents/skills" }
        ]
      }
    ]
  }
}
```

The compiler walks each `<skill>/SKILL.md` under `source` and emits one symlink
per skill at `<path>/<name>` → `<source>/<name>`. The `agents` target writes to
the cross-CLI shared dir that both Codex and Gemini natively discover; the
`claude` target writes to Claude Code's per-CLI dir (Claude does not yet read
`~/.agents/skills/`).

Post-TD-191 `surfaces.skills` is an ARRAY of `{source, layer, targets}` blocks
(was a single object pre-TD-191; legacy single-object manifests normalize to a
1-element array on read — no schema version bump). Each block compiles its own
source independently; personal blocks coexist alongside core. See L-519
(Igris-owned topology — per-harness compilers inside Igris OS project each
block to its own targets) and the array schema at
`core/scripts/cli-adapters/manifest.schema.json`.

- `source` — skills root (`{name}/SKILL.md` entries). `~`/absolute paths are
  used verbatim; a relative path resolves from `--project-root`.
- `targets[].method` — post-**FR-157** the valid `(type, method)` pairs are
  `claude/symlink`, `agents/symlink`, `codex/symlink`, `gemini/symlink`. All
  four are first-class projection targets — the symlink IS the projection,
  anchored at the registry-vendored copy (FR-149/FR-153/FR-157). An invalid
  pair (e.g. `claude/compiler`, `agents/compiler`, `codex/converter`) is
  rejected at schema validation. **FR-157** introduces `agents/symlink` as the
  cross-CLI shared target that Codex and Gemini both natively discover. The
  legacy per-CLI pairs (`codex/symlink`, `gemini/symlink`) remain in the enum
  for back-compat with pre-FR-157 personal overlays — new manifests should
  prefer `agents/symlink`.
- **Codex absolute-path enforcement (FR-153 D2, inherited by FR-157):** codex
  resolves relative-path symlinks from cwd (POSIX-incorrect — observed
  behavior). The compiler hard-fails when a `codex/symlink` OR `agents/symlink`
  target would be relative; drift-verify flags any literal-relative symlink at
  either path as DRIFTED. (The `agents/symlink` branch inherits this guard
  because Codex reads `~/.agents/skills/` too, not just `~/.codex/skills/`.)
- The drift guard verdicts each per-skill symlink by realpath against the
  registry-vendored canonical (L-515 containment), pairing line-for-line
  with the compile-side branch (L-519 §18.1). No more date-stamped marker
  stripping — the symlink IS the projection, so date drift is impossible.
- `igris harness compile --surface skills` projects only the skills surface;
  `--target codex|gemini|claude` narrows to one harness.

The core `surfaces-manifest.json` declares **global Layer-1** skills and is only
unioned when the project being compiled owns it (its realpath is under
`--project-root`) — so core skills never leak into an unrelated project's
projection. A project may also carry its own `surfaces.skills` in its
`harness-manifest.json` for project-specific skills.

**FR-139 overlay seam (post-TD-191).** A consumer's **personal** skills arrive
via the FR-139 overlay (`~/.igris/registry/harness-manifest.personal.json`),
which carries its own `surfaces.skills` array — typically one block per
personal-skill source written by `igris registry add-skill` (per L-516,
copy-vendored to `~/.igris/registry/skills/<name>/`; per L-517, typed
subfolder layout). `merge_overlay_manifest` **concatenates** the base
`surfaces.skills[]` with the overlay `surfaces.skills[]` — overlay blocks
coexist alongside base blocks (NOT merged into a single base block; the
pre-TD-191 "additive merge into base" semantics is superseded). A
**cross-block target-path collision** between any pair of blocks (base-vs-base,
base-vs-overlay, or overlay-vs-overlay) is a **hard error** — a personal
customization must not silently shadow a core skill (and the writer-side
`runAddSkill` mirrors the same guard at write time). See L-519 (Igris-owned
topology — each per-harness compiler inside Igris OS reads every block's
canonical content from the registry, regardless of which block it came from).

`/onboard-harness` is a standard core skill (under `core/skills/`, projected to
every harness like any other core skill). It is the executable companion to the
"Add a New Harness (the five-surface runbook)" below — run it to walk that same
checklist step-by-step. (FR-179 retired the short-lived TD-224 "framework-dev"
project-scoped skill category; `/onboard-harness` is now shipped globally.)

---

## MCP Servers as a `surfaces.mcp_servers` manifest declaration (FR-160 epic)

MCP servers are a **third** first-class manifest surface, alongside agents and
skills — projected and drift-checked by `igris harness compile` /
`igris harness check`, exactly the way skills are. Unlike skills (symlinks) and
agents (symlinks/hardlinks), **MCP projection is a config MERGE**: each declared
server is upserted into the four CLIs' native MCP config files, leaving every
other entry and top-level key in those (hot, user-owned) files byte-for-byte
untouched.

### Registering an MCP server — `igris add mcp` (one-step) / `igris registry add-mcp` (write-only)

> **FR-180:** for the common case, prefer the one-step `igris add mcp <name>
> --command <bin> --target type:merge` — it registers the server AND projects it
> to all four harness configs AND verifies drift-clean in one command (and fails
> loudly if nothing projected). `igris registry add-mcp` below is the
> **write-only** low-level primitive (register only, no project/verify), kept as
> the repair primitive. See `core/docs/ADD-SURFACES.md`.

`add-mcp` registers a **global** MCP server into the personal overlay's
`surfaces.mcp_servers[]` (it writes only the overlay + an inline origin — it
never touches a live CLI config; that projection is `igris harness compile`):

```
igris registry add-mcp <name> \
  --command <bin> [--arg <value> ...] \
  [--env KEY=${VAR} ...] \
  [--startup-timeout-sec <n>] \
  --target <type>:merge[:enabled] [--target ...]
```

- `<name>` matches `/^[a-z0-9][a-z0-9-]*$/` and is the server identity (one
  block per name).
- `--command` is **required for a new server**; a same-name re-add inherits it.
- `--arg` is repeatable → the launch `args[]`.
- `--target` is repeatable; `<type>` ∈ `{claude, codex, gemini, opencode}`,
  `method` is always `merge`, and an optional `:false` disables the entry for
  that harness (opencode passthrough).
- **`--env` values MUST be a single `${VAR}` indirection reference** (e.g.
  `--env API_KEY=${MY_TOKEN}`). An inline secret is **rejected** at the verb
  boundary — the real secret never enters the registry or any config. The
  literal lives only in `~/.igris/secrets.env` (chmod 600, gitignored, outside
  the repo) and is resolved at projection time **for Codex only**.
- v1 is **global-only**: `--scope project` / `--project` are rejected.

### Secret-file permissions (TD-220)

Igris writes `~/.igris/config.json` (may carry `remote_brain` credentials) and
`~/.igris/secrets.env` at mode **600** (owner read/write only) — `igris init`
creates them at 600 and tightens a pre-existing loose file on every run. **Never
commit these files.** `igris doctor` flags any secret file that is group/world-
readable or git-tracked (including the four harness configs above); `igris doctor
--fix` chmods them to 600. A git-tracked file stays flagged after `--fix` because
chmod cannot untrack it — remove it from git. On Windows the perms check is a
no-op (NTFS has no POSIX mode bits), so init/doctor never false-flag there.

### Skill/agent surface migration — legacy whole-dir symlinks (TD-223)

The per-surface model wants `~/.claude/skills` and `~/.claude/agents` to be **real
directories** holding one symlink per skill/agent (core → `~/.igris/core/...`,
personal → the registry-vendored copy). A **v6-era install** instead made each a
**whole-directory symlink** → `~/.igris/core/{skills,agents}`. That state is
actively harmful: because the target *is* the canonical source, a per-item
projection (`igris harness compile`) writes its symlink **into** `~/.igris/core/`,
polluting the source (observed: a `content-pipeline` skill symlink and three
`content-{deck,writer,designer}.md` agent symlinks leaked into the core dirs).

`igris doctor` detects this as the `skills-pollution` drift class: it flags any
declared surface root that is a whole-dir symlink to its canonical source, plus
any stray registry-projection symlink found inside the core source. `igris doctor
--fix` **migrates** each affected root to a real directory of per-item symlinks
(materialized directly from the canonical source + the personal overlay — never
via a recompile, which the FR-137 commonpath gate / the absence of a core-agent
`claude` target would leave empty), then removes the stray source symlinks. The
fix is guarded: it prints a before/after inventory and **fails closed** if any
item would be lost, **backs up** the old root symlink to `<root>.bak-<UTC>`
(never deletes canonical content), removes **only** registry-anchored projection
symlinks from the source (never a real dir), realpath-contains every mutation,
refuses a root symlink pointing anywhere other than the canonical source, and is
idempotent (a migrated real dir is a no-op on re-run). On Windows it is a no-op.

### The four native per-harness shapes (the projection)

`igris harness compile --surface mcp` (or `--surface all`) flattens every
`surfaces.mcp_servers[]` block into one `(server, target)` row per declared
harness and merges the native entry into that harness's config. The bash pass is
a thin driver; the JSON/TOML merge (atomic, idempotent, malformed-never-clobber,
single rolling `.igris.bak`) lives in **one** place in the CLI — bash never
re-implements it (L-519 §18.1). The four shapes:

| Harness | Config file | Map | Native entry shape |
|---------|-------------|-----|--------------------|
| Claude | `~/.claude.json` | `mcpServers.<name>` | `{ type:"stdio", command, args[], env{} }` — env values are `${VAR}` |
| Gemini | `~/.gemini/settings.json` | `mcpServers.<name>` | `{ command, args[], env{} }` (no `type`) — env values are `${VAR}` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp.<name>` | `{ type:"local", command:[cmd, ...args], enabled, environment{} }` — command+args **fused** into one array; env KEY is `environment`; env values are `{env:VAR}` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.<name>]` | `{ command, args[], startup_timeout_sec?, [.env] }` — env values are **resolved literals** |

**The `${VAR}` indirection rule (FR-160e).** Claude, Gemini and OpenCode resolve
the env reference + inherit exported env at launch, so the registry's `${VAR}`
(translated to `{env:VAR}` for OpenCode) is written verbatim — **no secret ever
lands in those configs**. Codex's sandbox (`inherit="core"`) resolves neither
refs nor inherited env, so its env values are the **resolved literal** read from
`~/.igris/secrets.env` at compile time. When a Codex `${VAR}` has no entry in
`secrets.env`, the projection **fails for that row** naming the missing VAR (never
a value) — the other harnesses are unaffected.

**Overlay merge.** `merge_overlay_manifest` concatenates the base
`surfaces.mcp_servers[]` with the overlay's, with a block-NAME collision being a
**hard error** (a personal MCP must not shadow a core one) — the same posture as
agents and skills.

### Drift verification

`igris harness check` runs a line-paired MCP drift pass: for each
`(server, harness)` it reads the on-disk entry, derives the expected native
shape from the **same** shared shape helper compile uses, and compares —
verdict `MATCH` / `DRIFTED` (naming the differing **key names**, never values) /
`MISSING` (no entry; run compile). For Codex it re-resolves each `${VAR}` from
`secrets.env` and compares the resolved literal against the on-disk literal
**without printing either**. A malformed config is reported `DRIFTED`
("unparseable") rather than clobbered.

> `igris registry project-mcp` is the **internal** per-harness projector the
> compile/drift bash passes invoke (one config write per call). It is not a
> user-facing verb — register servers with `add-mcp` and project them with
> `igris harness compile`.

### Shipped default: `igris-brain`

The Igris brain MCP server is itself a **registry-distributed default** — it
rides the very mechanism described above to reach all four harnesses. It is
registered and projected exactly like any other server:

```
igris registry add-mcp igris-brain \
  --command node --arg <bundled-path> \
  --target claude:merge --target gemini:merge \
  --target opencode:merge --target codex:merge
igris harness compile --surface mcp
```

**Canonical path (resolved, not invented).** `<bundled-path>` is the bundled
`cli/dist/brain-mcp-server/dist/index.js`. This was triangulated from three
agreeing sources — the live `~/.claude.json` entry, `paths.ts`'s
`bundledMcpEntryPath()`, and what `igris init` registers — not chosen by hand.
The Codex entry had been the one outlier, still pointing at the repo-source
`brain-mcp-server/dist/index.js` (L-427: same-name MCP, divergent paths across
harnesses); `compile --surface mcp` normalized it onto the bundled path. Prefer
the **bundled** path: it survives a `npm install -g` reinstall, whereas the
repo-source path does not.

**Env-free, by design.** `igris-brain` carries **no `--env`** — it reads
`~/.igris/config.json` directly (the config-file-read pattern), so its
projection exercises the merge mechanism with **no secret path involved**. It
sits at the verbatim end of the env model above (no `${VAR}`, so nothing to
translate for OpenCode and nothing to resolve from `secrets.env` for Codex).

**Per-harness native shapes apply unchanged.** `igris-brain` lands in each
harness in that harness's native shape per the matrix above — Claude's
`type:"stdio"` + `env`, Gemini's no-`type` form, OpenCode's `type:"local"` +
fused `command[]` + `enabled` + `environment`, and Codex's
`[mcp_servers.igris-brain]` table.

**Verifying a rollout (fresh process, not the running one).** An MCP config
change takes effect only on a process's **next** launch — a CLI already running
holds its config from start-up (L-256: verify MCP changes in a fresh process).
The rollout was confirmed by running `gemini mcp list` in a **fresh** Gemini
process, which reported `✓ igris-brain ... - Connected`; checking the
already-running session would have shown stale state. `igris harness check`
returned **MATCH** for the `igris-brain` entry on all four harness targets.

---

## Orchestrator identity as a `surfaces.os_identity` manifest declaration (TD-233)

The orchestrator-identity file is the **fifth** first-class per-harness surface,
alongside agents, skills, MCP, and hooks — projected and drift-checked by
`igris harness compile` / `igris harness check` like the rest. It closes GAP-3
from the TD-227 parity audit: before TD-233, Gemini greeted as "Gemini CLI" and
Codex as "Codex" at the bare CLI, because the Igris identity block only reached
the harnesses that happen to auto-read `CLAUDE.md`. The identity layer was an
*implicit* surface; this section makes it a tracked one, so a future harness can
never silently miss it.

**Identity model: Model A** ("the agent IS Igris AI") — operator decision
2026-06-10. Model B ("I am \<model\> running Igris OS") is **parked** for a
later deliberate decision; do not implement it.

### Per-harness identity filename map (empirically A/B-confirmed 2026-06-10)

Each harness auto-reads ONE project-root context file at launch; the identity
block must land in that file:

| Harness | Identity file (project root) | How the identity region gets there |
|---------|------------------------------|-------------------------------------|
| **Claude** | `CLAUDE.md` | Native — the rendered `CLAUDE.md` (from `core/templates/CLAUDE.md.tmpl`) carries the canonical identity block |
| **OpenCode** | `CLAUDE.md` | Reads Claude's file (A/B-proven: removing `CLAUDE.md` reverts OpenCode's greeting) — no separate target needed |
| **Gemini** | `GEMINI.md` | `os_identity` projection — Igris-managed region-merge (TD-233) |
| **Codex** | `AGENTS.md` | `os_identity` projection — Igris-managed region-merge (TD-233) |

> **`AGENTS.md` naming collision — do not conflate.** `AGENTS.md` was *also*
> the filename of the retired FR-153 Codex **skills-aggregator** (the pre-FR-153
> `md_to_agents_md.sh` output, deleted with its 32 KB cap). That aggregator is
> gone; the project-root `AGENTS.md` today is the **Codex orchestrator-identity
> file**, generated by the `os_identity` pass — an unrelated artifact that
> happens to reuse the name Codex natively reads. Likewise, the home-level
> `~/.codex/AGENTS.md` is a pre-existing Igris-generated v6 brain-info file and
> is **NOT** an identity target in v1.

### Mechanism (projected surface, region-merge)

- **Canonical source:** `core/templates/identity.tmpl` — the single authored
  Model-A identity block. Two tokens: `{{IGRIS_VERSION}}` (resolved from the
  block's `version_source`, `cli/package.json`) and `{{HARNESS_SELF_NAME}}`
  (the per-harness self-name reword: "Not Gemini CLI using Igris AI", "Not
  Codex using Igris AI" — never hand-duplicated content that can drift).
- **Manifest block:** `surfaces.os_identity[]` in the repo-root
  `harness-manifest.json` (NOT `surfaces-manifest.json`) with
  `method:"file"`, per-target `filename`, and project-root scope
  `{type:"project", paths:["."]}` — the identity files emit only when compiling
  from inside the igris-ai checkout and are a silent scope-skip elsewhere
  (FR-155 semantics).
- **Projection primitive:** a **region-merge**, not a whole-file write. The
  rendered block lands between `<!-- IGRIS:OS_IDENTITY:BEGIN ... -->` /
  `<!-- IGRIS:OS_IDENTITY:END -->` markers; user content outside the region is
  preserved byte-for-byte. Compile narrows via `--surface identity`.
- **Drift:** `igris harness check` re-derives the expected region from the SAME
  shared shape helper compile uses (`_common.sh::normalize_identity_shape`,
  §18.1-paired byte-identical with `cli/src/lib/identity-shape.ts`) and reports
  `MATCH` / `DRIFTED` / `MISSING` per `(harness, identity-file)` — the GAP-3
  recurrence guard.
- The generated `GEMINI.md` + `AGENTS.md` at the repo root are
  **committed-as-canonical** derived artifacts: edit
  `core/templates/identity.tmpl` and recompile; never hand-edit inside the
  managed region.
- **Adding an identity block — `igris add identity` (FR-180 D6):** the one-step
  add verb materializes a `surfaces.os_identity[]` block (personal → the registry
  overlay, project-scoped; core → the repo-root `harness-manifest.json`) then
  projects + verifies it. `igris add identity <name> --target <type:file:filename>`
  (`--core` for the source tree). FR-180 (D6) lifted the v1 "personal os_identity
  accepted but NOT merged" restriction — `merge_overlay_manifest` now unions
  os_identity blocks (base ++ overlay), so a personal identity projects exactly
  like a core one; a personal (type, filename) target that shadows a core one is a
  hard reject. The projection mechanics (`normalize_identity_shape`) are
  UNCHANGED, so the §18.1 golden parity holds. The low-level
  `igris registry add-identity` + `igris harness compile --surface identity`
  two-step survives as the repair primitive.

Onboarding a new harness wires this surface via the `/onboard-harness` skill's
identity step (probe the auto-read filename, add the `os_identity` target, add
the self-name mapping to BOTH §18.1 twins, compile, verify "who are you?" →
**Igris AI** in a fresh process).

---

## Portability Convention

Skills are authored for Claude Code first. To mark CLI-specific frontmatter, use the
optional `platform_overrides` block:

```yaml
---
name: scan
description: Show system status report
disable-model-invocation: false
platform_overrides:
  claude:
    allowed-tools:
      - Read
      - Grep
      - Glob
      - Bash
      - mcp__igris-brain__igris_project_status
    triggers:
      - "SCAN"
      - "REPORT"
---
```

> **Note (post-FR-153):** the legacy `platform_overrides.codex.include: false`
> opt-out is **no longer load-bearing** for the skill projection. Every
> `SKILL.md` under the source tree gets a per-skill symlink under every
> consumer's skills dir — there is no exclusion step. Authors targeting only
> Claude can omit the codex/gemini blocks entirely; co-installed Claude-only
> skills appear as inert reference docs in `~/.codex/skills/` /
> `~/.gemini/skills/` rather than being skipped at compile time. The
> `is_claude_only` helper in `_common.sh` remains defined for back-compat but
> is no longer called by the live compile path.

### Frontmatter Handling Per CLI

| CLI | Behavior |
|-----|----------|
| Claude | Reads `SKILL.md` natively via per-skill directory symlink. Full frontmatter preserved verbatim (all keys including `platform_overrides.claude`). |
| Gemini | Reads `SKILL.md` natively via per-skill directory symlink (FR-153 — unified onto the claude/symlink primitive). Full frontmatter preserved verbatim. Pre-FR-153 only `description` was extracted into a per-skill TOML; the converter (`md_to_gemini_toml.sh`) has been retired. |
| Codex | Reads `SKILL.md` natively via per-skill directory symlink (FR-153 — unified onto the claude/symlink primitive). Full frontmatter preserved verbatim. Pre-FR-153 the entire frontmatter was stripped and the body concatenated into a single `AGENTS.md` under a 32 KB cap; the aggregator (`md_to_agents_md.sh`) has been retired. |

### Flat Frontmatter (Current Default)

Existing skills use flat Claude-specific keys (`allowed-tools`, `triggers`,
`disable-model-invocation`) at the top level. Adapters continue to tolerate flat
frontmatter as a fallback — migration to `platform_overrides` is **optional**, not
required.

---

## Claude-Only Skill Detection — RETIRED

**Pre-FR-153** the codex compiler excluded skills that were Claude-only. A
skill was considered Claude-only when **either** signal was present:

1. `platform_overrides.codex.include: false` in frontmatter (explicit opt-out).
2. The body contained `Agent(...)` or `Skill(...)` invocation patterns — a
   heuristic for orchestration skills that assume Claude's subagent API.

Excluded skills were logged to stderr and listed in a trailing `<!-- -->`
comment inside the generated `AGENTS.md`.

**Post-FR-153 the entire mechanism is dead.** The symlink projection has no
exclusion step — every `SKILL.md` under the source tree gets a per-skill
symlink in every consumer's skills dir. Consumers that can't execute
Claude-orchestration skills will see them as inert reference docs rather than
active commands. The `is_claude_only` helper in `_common.sh` is preserved as
defence-in-depth back-compat but is no longer called by the live compile path.

---

## Nested Skill Files

Post-FR-153, all three harnesses (claude/codex/gemini) project each skill as a
**directory symlink** to the registry-vendored `<source>/<name>/` tree — so
nested files like `scripts/*.sh`, `workflow-template.md`, and
`register/templates/*.md` are visible to every consumer that follows symlinks.

The `find -mindepth 2 -maxdepth 2 -name 'SKILL.md'` walk used by the compiler
only enumerates each skill's top-level `SKILL.md` to identify which symlinks to
emit — but the symlinks themselves point at the full directory, so consumers
that read sibling files (e.g. claude reading `scripts/`) see them automatically.

---

## Nested Agent Files (FR-156)

Personal-overlay agents are vendored as **full directory trees** into
`~/.igris/registry/agents/<name>/` — the same shape as skills (symmetric
topology with FR-149 + TD-191, L-519 §18.1). An agent's `system-prompt-vN.md`
body can reference siblings like `routing/_routing.md`, `registry/types.md`,
or `archetypes/ARCH-*.md` and `igris registry add` / `igris registry update`
will vendor the entire source dir alongside the body. This closes the L-516
violation where pre-FR-156 only the frontmatter + chosen body file were
copied — supporting files lived in the operator's source dir only, so the
registry copy was not self-sufficient.

**Reference convention** — bodies SHOULD cite siblings via the absolute
registry path:

```
See ~/.igris/registry/agents/deck/routing/_routing.md for the routing rules.
```

NOT a relative path. Igris does **not** rewrite operator-authored body text;
the body you author is the body the harness reads. (See TD-197 for the
content-pipeline migration that converts the in-tree DECK/DESIGNER bodies
to this convention.)

**Vendor skip-list** excludes operator-author noise from the registry copy:

- `MAINTAINING.md` — internal-author-only doc
- `.DS_Store` — macOS filesystem cruft
- `.git*` — VCS metadata (matches `.git`, `.gitignore`, `.gitkeep`, `.github`)
- `node_modules/`, `.venv/`, `__pycache__/` — language deps + caches
- `*.pyc` — compiled python
- `harness.claude.md`, `harness.gemini.md` — FR-152 / FR-158 per-harness
  α-assembled outputs (derived, not source)
- `REGISTRY-NOTICE.md` — TD-202 sidecar (vendored-copy notice, not source)

The skip-list is fixed (per-agent `.igrisignore` overrides are deferred —
add as a fast-follow if a real case appears post-ship).

**Drift detection** — `check_harness_drift.sh` runs a per-agent tree-hash
pre-check (`[<name>/tree] MATCH/DRIFTED`) BEFORE the per-target FR-152
symlink check. The two verdicts are orthogonal (tree-match doesn't imply
symlink-correct, and vice versa) so both fire so the summary count is
honest. A DRIFTED verdict locates up to 5 differing relpaths in a sub-line
(architect-chosen Decision 2 — strict single tree verdict + file-list diff,
NOT per-file fan-out).

**`igris registry update <name>`** re-vendors the whole tree from the
recorded path origin. A change ANYWHERE in the source tree (content,
addition, removal) flips the recorded hash → status=changed. Update
semantics widened with FR-156: pre-FR-156 a sibling unrelated file added to
the source dir was IGNORED; post-FR-156 it's vendored on next update. This
is BY DESIGN (closes L-516). Author-only files belong in the skip-list or
outside the agent dir.

---

## Editing Vendored Content (TD-202)

Personal-overlay skills and agents are copy-vendored from operator source dirs
into `~/.igris/registry/{skills,agents}/<name>/`. The registry-vendored copy is
what runtime harnesses load (claude/codex/gemini all read from the same
registry-anchored symlinks per FR-152/FR-153/FR-156). **The registry is not the
editing surface** — direct edits there are silently overwritten on the next
`igris registry update` or `add` cycle.

**Editing flow:**

```bash
# 1. Find the source dir (recorded at vendor time):
cat ~/.igris/registry/origins.json | jq '."skill:content-pipeline"'
# { "type": "path", "dir": "/Users/me/automation/content/skills/content-pipeline", "hash": "..." }

# 2. Edit at source:
$EDITOR /Users/me/automation/content/skills/content-pipeline/SKILL.md

# 3. Re-vendor:
igris registry update content-pipeline
# →   content-pipeline: changed
# →
# →   Reminder: edits to vendored surfaces must happen at the SOURCE path,
# →   not under ~/.igris/registry/. Re-run `igris registry update <name>`
# →   after editing the source. See TD-202 / coding_guidelines.md §18.5.
```

**In-band notice.** Every vendored tree carries a `REGISTRY-NOTICE.md` sidecar
(emitted by `igris registry add` / `add-skill` / `update`) naming the source
path. Editors who open the registry-vendored copy see the notice next to the
file they were about to mutate. The sidecar is excluded from the FR-156 vendor
skip-list (hash basis stays in sync with the operator's source tree that has
no such file).

**Detection.** If the registry copy diverges from the recorded source tree,
`check_harness_drift.sh` reports `[<name>/tree] DRIFTED` with up to 5
differing relpaths (FR-156 for agents; TD-201 extended to skills). The
verdict pairs the registry sha + source sha so the operator can locate the
divergence without re-deriving the diff.

**Github-origin caveat.** Surfaces vendored from `github:owner/repo@ref` have
no on-disk source path — the `Source:` line in `REGISTRY-NOTICE.md` is the
`github:owner/repo@ref` URI. Edit upstream, tag a new release, then
`igris registry update` picks up the newer tag.

See `coding_guidelines.md` §18.5 and TD-202 for the full rationale.

---

## 32KB Cap (Codex) — RETIRED

Pre-FR-153 the codex skill surface was an aggregated `AGENTS.md` under a 32KB
size cap. FR-153 retired that aggregator in favor of the per-skill symlink
projection (consumer-natural directory traversal — no cap, no Claude-only
heuristic). The legacy `md_to_agents_md.sh` script is deleted.

---

## How to Add a New CLI Adapter

1. Pick a method: `symlink` or `none` (the legacy `converter` / `compiler`
   methods were retired by FR-153).
2. Add an entry to `cli_targets` in `~/.igris/config.json`.
3. For `symlink`, no adapter script is needed — the skills pass inside
   `compile_harnesses.sh` walks each `<name>/SKILL.md` under the source root
   and emits one symlink per skill at `<target>/<name>` → `<source>/<name>`.
4. Source `scripts/cli-adapters/_common.sh` for shared helpers
   (`parse_frontmatter`, `strip_frontmatter`, `is_claude_only`, `toml_escape`).
5. Add a vitest case in `cli/src/__tests__/bridges.test.ts` (or a bats fixture
   in `cli/tests/integration/install-symlinks.bats`) exercising the new adapter.

---

## Invocation

- **Bootstrap-time:** `igris init --cli-bridge=claude,gemini,codex` (or the
  default auto-detect, which probes PATH + config dirs).
- **Install-time:** `igris install <project-dir>` — bridges already wired
  during init are propagated to the project automatically.
- **Runtime refresh:** `igris refresh` re-fetches `~/.igris/core/` and
  re-runs the bridge materialization step.

`--cli-bridge=auto` (the default) expands to every CLI detected on
PATH AND with a config dir present. `--cli-bridge=none` opts out of
all bridges.

---

## Subagent Distribution

**Brief:** TD-021 (parent FR-006)

Skills distribution (above) and subagent distribution are **two separate
concerns**. The `cli_targets` block + the skills pass inside
`compile_harnesses.sh` handle SKILLS — projecting `~/.igris/core/skills/` as
per-skill symlinks under each consumer's skills dir (`~/.claude/skills/`,
`~/.codex/skills/`, `~/.gemini/skills/`). Agent *subagent prompts* are
different: each agent has one canonical prompt that must be regenerated into
per-CLI harness files (`.claude/agents/<name>.md`, `.codex/agents/<name>.toml`).
Conflating the two is a known drift trap — the skills surface is NOT a
subagent generator.

### Canonical is the sole source of truth

Each agent has exactly one canonical prompt. Every harness file is a GENERATED
artifact derived from it. **Editing a harness file directly is a process
error** — the next compile run will overwrite it. Two canonical conventions
coexist:

- **Content-pipeline agents** — versioned canonical:
  `agents/<name>/system-prompt-v<X.Y>.md`. The compiler resolves the newest
  version via `latest_canonical`.
- **Igris-core agents** — unversioned canonical: `core/agents/<name>.md`.

### Components

| File | Role |
|------|------|
| `scripts/cli-adapters/harness-manifest.json` | Declarative manifest: per agent, the canonical source (dir + glob/file + `versioned` flag) and the set of harness targets. Handles both canonical conventions. |
| `cli/src/verbs/registry.ts::assembleCodexHarness` | Vendor-side α-assembler — writes `<brain>/registry/agents/<name>/harness.codex.toml` (3-key TOML: `description`, `developer_instructions`, `name`) from `frontmatter.claude.md` + body. FR-159 TS port replacing the retired `sync_codex_agents.sh`. |
| `cli/src/verbs/registry.ts::assembleOpencodeHarness` | Vendor-side α-assembler — writes `<brain>/registry/agents/<name>/harness.opencode.md` (OpenCode-shaped frontmatter: `mode: subagent`, boolean `tools:` map via `CLAUDE_TO_OPENCODE_TOOLS`, `permission:` MCP grant) from `frontmatter.claude.md` + body, OR honors an operator-authored `frontmatter.opencode.md` verbatim. FR-171. Byte-identical to the compile-side bash inline-python3 translator (§18.1 golden-fixture parity). |
| `scripts/cli-adapters/compile_harnesses.sh` | Orchestrator — reads the manifest, projects per-harness registry-resident files (`harness.claude.md`, `harness.codex.toml`, `harness.gemini.md`, `harness.opencode.md`) to each target. claude + codex + opencode emit via symlink (FR-171: OpenCode's agent loader follows symlinks); gemini emits via hard link (TD-208). For core agents without vendor-side α-assembly, `assemble_*_harness_into_registry` provides byte-equivalent compile-side fallback. `--project-root`, `--filter`, `--target` flags. |
| `scripts/cli-adapters/check_harness_drift.sh` | CI-style drift guard — exits non-zero if any claude/codex/opencode symlink target is non-registry-anchored, refuses-to-clobber a real-file target, or any gemini hard-link target has diverged (TD-208). All 4 agent harnesses use per-harness registry-resident files as verdict basis (FR-159 retired the codex body-sha verdict; FR-171 added opencode). |
| `scripts/cli-adapters/body-exceptions/*.json` | Documented intentional body divergences (see below). |

### Manifest schema

```json
{
  "agents": [
    {
      "name": "content-deck",
      "canonical": { "dir": "agents/deck", "glob": "system-prompt-v*.md", "versioned": true },
      "targets": [
        { "type": "claude", "path": ".claude/agents/content-deck.md" },
        { "type": "codex",  "path": ".codex/agents/content-deck.toml" }
      ]
    },
    {
      "name": "forger",
      "canonical": { "dir": "core/agents", "file": "forger.md", "versioned": false },
      "targets": [
        { "type": "codex", "path": ".codex/agents/forger.toml" }
      ]
    }
  ]
}
```

- `canonical.dir` / `glob` / `file` resolve relative to `--project-root`.
- `versioned: true` → adapter uses `latest_canonical` on `glob`;
  `versioned: false` → adapter uses `file` verbatim.
- An optional `body_exception` key names a sidecar in `body-exceptions/` —
  see below.

### Body exceptions

A harness body is normally byte-equal to the canonical body (minus
frontmatter). One documented exception exists: DESIGNER's `.claude/agents`
harness carries one extra paragraph (the harness-skill invocation note). The
manifest entry sets `"body_exception": "designer-harness-skill-para"`, and the
sidecar `body-exceptions/designer-harness-skill-para.json` declares a unique
`anchor` line plus the `insert` paragraph. The appendix is applied at
ASSEMBLY time (FR-152) — baked into BOTH per-harness registry-resident outputs
(`harness.claude.md` and `harness.gemini.md`, FR-158) by both the TS vendor
primitive and the bash `compile_harnesses.sh` assembly helper — and
`check_harness_drift.sh` verifies registry-anchored containment of the symlink,
so the exception is not flagged as drift and is not silently lost on recompile.
The body-exception sidecar is body-relative (the anchor line is in the SAME
body both harnesses consume), so a single JSON file applies identically to
both outputs — there is no per-harness body-exception variant.

### Per-harness frontmatter sidecars (FR-158)

Each agent that ships through `igris registry add` can carry one or both of
two operator-authored sidecars co-located with its body file(s):

| Sidecar | Consumed by | Behavior when present |
|---|---|---|
| `frontmatter.claude.md` | `assembleClaudeHarness` (always) AND `assembleGeminiHarness` (when no Gemini sidecar) | Claude-shape frontmatter (PascalCase tools, no `kind` field). Vendored verbatim into `<registry>/agents/<name>/harness.claude.md`. Auto-translated for Gemini when `frontmatter.gemini.md` is absent. |
| `frontmatter.gemini.md` | `assembleGeminiHarness` (overrides) | Gemini-shape frontmatter — honored verbatim with no field-by-field merge. Author this when the Claude→Gemini auto-translate doesn't fit (e.g., an agent declaring `Glob` whose Gemini equivalent semantics matter). |

When NEITHER sidecar is present, the assemblers no-op and the compile-side
fallback in `compile_harnesses.sh` synthesizes the harness from the canonical's
inline frontmatter (TD-195 / FR-158 compatible mode).

#### Claude → Gemini tool-name translation map

The auto-translate path (used when only `frontmatter.claude.md` exists) applies
this 1:1 map to the `tools:` field, ALWAYS adds `kind: local`, and drops
`model:` / `temperature:` / `max_turns:` / `memory:` (operators override via
`frontmatter.gemini.md`). `memory:` is dropped because Gemini's strict subagent
schema rejects it (`Unrecognized key(s) in object: 'memory'`). `mcp__`-prefixed
tool tokens are also filtered out of the Gemini `tools:` list — Claude's
`mcp__srv__tool` double-underscore grammar is invalid in Gemini's `mcp_srv_tool`
form, and Gemini agents reach the brain MCP via session-level `mcpServers` in
`settings.json`, not the per-agent tools array. Other fields pass through verbatim.

| Claude tool | Gemini tool | Notes |
|---|---|---|
| `Read` | `read_file` | direct match |
| `Write` | `write_file` | direct match |
| `Edit` | `replace` | Gemini's built-in edit tool (`edit_file` is not valid) |
| `Bash` | `run_shell_command` | direct match |
| `Grep` | `grep_search` | direct match |
| `Glob` | `list_directory` | **imperfect** — Glob is recursive pattern matching; `list_directory` is single-dir listing. Use a `frontmatter.gemini.md` override if semantics matter. |
| `Task` | `task` | lowercased |
| `WebFetch` | `web_fetch` | direct match |
| `WebSearch` | `web_search` | direct match |

`tools:` accepts string (`tools: Read`), CSV (`tools: Read, Grep`), and YAML
flow-list (`tools: [Read, Grep]`) input shapes; output is emitted as YAML
flow-list (`tools: [read_file, grep_search]`). Unknown tool names pass
through verbatim — Gemini's loader will surface a clear "unknown tool" error,
which IS the right behavior (an unknown tool means an operator override is
required).

#### Codex emission (FR-159 — TS port complete)

Codex emission is TS-driven from FR-159 onwards. `assembleCodexHarness` in
`cli/src/verbs/registry.ts` reads the FR-151 `frontmatter.claude.md` sidecar
+ canonical body and writes `<brain>/registry/agents/<name>/harness.codex.toml`
at vendor time (alongside `harness.claude.md` + `harness.gemini.md`). For core
agents without vendor-side α-assembly, `compile_harnesses.sh` provides a
byte-equivalent compile-side fallback (`assemble_codex_harness_into_registry`).
The `.codex/agents/<name>.toml` target is a SYMLINK to the registry file
(parity with the claude primitive — codex follows symlinks for both skills
and agent .toml loaders). The retired `sync_codex_agents.sh` is gone (FR-153
retirement posture; no `--d1-reimplement` no-op flag remains because the
surface that accepted it was the bash script).

### Per-harness agent-target primitive (TD-208)

The consumer-side agent target (`.claude/agents/<name>.md`,
`.gemini/agents/<name>.md`, `.codex/agents/<name>.toml`) is materialized by
`compile_harnesses.sh` from the registry-resident assembled harness file.
Each harness uses a DIFFERENT filesystem primitive — chosen so the consumer's
subagent loader actually reads the registry bytes:

| Harness | Primitive | Path | Why |
|---|---|---|---|
| Claude | Symbolic link (`ln -sf` via `atomic_symlink`) | `~/.claude/agents/<name>.md` | Claude follows symlinks fine; symlink is the cheapest atomic-repoint primitive (temp+rename). |
| Gemini | Hard link (`ln` via `emit_md_hardlink`) | `~/.gemini/agents/<name>.md` | Gemini's subagent loader does NOT follow symbolic links (verified live 2026-06-01) but DOES follow hard links. Hard link preserves **L-516** registry-canonical: same inode = same bytes-on-disk = registry is THE single physical home. A `cp` copy would break L-516 (two bytes-on-disk copies, not one). |
| Codex | Symbolic link (`ln -sf` via `atomic_symlink`) | `~/.codex/agents/<name>.toml` | FR-159: codex consumes TOML, but its subagent .toml loader follows symlinks fine (parity with claude and with codex's already-symlinked skill loader per FR-157). `assembleCodexHarness` writes the 3-key TOML to the registry; the target is a symlink to it. |

**Operational notes**

- **Atomic re-vendor invalidates the hard link.** `vendorAgentTreeAtomic` in
  `cli/src/verbs/registry.ts` uses temp-file + rename for the registry
  `harness.gemini.md`, which assigns a NEW inode. The OLD hard link at
  `~/.gemini/agents/<name>.md` now points at an orphaned inode. The very next
  `igris harness compile` `rm -f`'s and re-`ln`'s the target against the new
  inode. Tested in `test/harness_drift_gate.test.bash` — the
  *atomic re-vendor + recompile* case.
- **Operator `cp` is detectable.** If an operator manually `cp`-replaces the
  hard link with a real-file copy (byte-equal but inode-divergent), the drift
  verifier emits a `DRIFT-WARN` verdict: content is fine but the primitive
  contract is broken (L-516 violated). The hint is `igris harness compile` to
  re-establish the hard link.
- **Cross-filesystem caveat.** Hard links require `~/.gemini/agents/` and
  `~/.igris/registry/agents/<name>/` to be on the same filesystem. Both live
  under `$HOME/` on the standard macOS dev setup. If `ln` ever fails with
  "Cross-device link", it surfaces a clean error from `set -euo pipefail` —
  no silent fallback. Linux portability + alternate-filesystem support are
  out of scope for TD-208 (BSD `stat -f` / `md5 -q` are darwin-only flags).
- **The Gemini compile branch does NOT refuse-to-clobber.** A hard link IS a
  real file (non-symlink), so refusing any real file at the target would make
  Gemini refuse to overwrite its own output. The new contract: the compile
  pipeline OWNS the gemini target path; re-emit is idempotent. The
  `DRIFT-WARN` verdict surfaces operator-replaced state at drift-check time
  (the equivalent of a refuse-to-clobber for the symlink-era contract).

### Decision D1 — codex wrap vs reimplement (RESOLVED — REIMPLEMENT, FR-138)

The legacy `sync_codex_agents.sh` (retired by FR-159) could either WRAP the
codex CLI's native agent-import command or REIMPLEMENT the TOML emit. FR-138
**resolved D1 in favor of REIMPLEMENT**: the emit writes the fully-specified
3-key codex subagent TOML directly, as the live default path — no opt-in
flag, no env gate. FR-159 ported the REIMPLEMENT path to TS
(`assembleCodexHarness`) + a parallel bash helper for compile-side fallback.
The 7 Igris-
core agents now distribute to `.codex/agents/*.toml` by default whenever
`compile_harnesses.sh --target codex` (or `--target all`) runs. The former
`--d1-reimplement` flag and `IGRIS_CODEX_D1=reimplement` env opt-in are retained
only as deprecated, accepted no-ops for back-compat with any caller still
passing them. A WRAP variant remains possible behind a future `--d1-wrap` flag
if the `codex` CLI's native import is ever found to be scriptable + idempotent.

### `cli_targets.codex.agents` sub-block

The runtime `~/.igris/config.json` `cli_targets.codex` entry carries an
`agents` sub-block (TD-021) describing the subagent surface — its `compiler`,
`orchestrator`, `manifest`, `drift_guard`, and `target`. This is distinct from
the sibling skills surface (post-FR-153: symlink-projected). The two are no
longer conflated under one mechanism.

### Invocation

```bash
# Regenerate every harness for a project (all targets; codex is live since FR-138):
bash ~/.igris/core/scripts/cli-adapters/compile_harnesses.sh \
  --project-root /path/to/project --filter 'content-*' --target all

# Check for drift (exit non-zero if any harness is stale):
bash ~/.igris/core/scripts/cli-adapters/check_harness_drift.sh \
  --project-root /path/to/project --filter 'content-*'
```

The content-pipeline wires this into its `install.sh` via a
`compile-harnesses.sh` step (see that project's `agents/MAINTAINING.md`).

---

## Hook Coverage

Igris hooks are the lifecycle integration layer: session start/end, pre/post tool use,
and pre/post compact. Before FR-104 these lived only as per-project Claude Code scripts
(`.claude/hooks/*.sh`). FR-104 extracts the six cross-CLI-portable events into a shared
bash layer and adds per-CLI bridges that route each CLI's native events into it.

### Portable Events

The following six events are CLI-portable — they have a semantically equivalent trigger
across all three supported CLIs (Claude, OpenCode, Codex):

| Igris event | Script | Purpose |
|-------------|--------|---------|
| `session_start` | `~/.igris/core/hooks/shared/session_start.sh` | Inject session state and active brief summary. |
| `session_end` | `~/.igris/core/hooks/shared/session_end.sh` | Flip CURRENT_SESSION.md to REST MODE; deregister instance from brain. |
| `pre_compact` | `~/.igris/core/hooks/shared/pre_compact.sh` | Emit recovery context before context compaction. |
| `post_compact` | `~/.igris/core/hooks/shared/post_compact.sh` | Log compact completion; future hook point. |
| `pre_tool_use` | `~/.igris/core/hooks/shared/pre_tool_use.sh` | Brief-first gate for Write/Edit tool calls. |
| `post_tool_use` | `~/.igris/core/hooks/shared/post_tool_use.sh` | Dispatcher for `post_tool_use.d/*.sh` handlers (currently: lint). |

### Per-CLI Coverage

| CLI | Wired events | Mechanism | Notes |
|-----|--------------|-----------|-------|
| Claude Code | All 6 portable + Claude-only (SubagentStop, Stop, TaskCompleted, TeammateIdle, Notification) | `.claude/settings.json` entries point directly at shared script paths | Claude-only events continue to use project-local `.claude/hooks/` since no other CLI has an equivalent. |
| OpenCode | All 6 portable | TypeScript plugin at `~/.config/opencode/plugins/igris-bridge.ts` | Auto-loaded by Bun at startup; raw `.ts` — no build step. |
| Codex CLI | `session_end` only | `notify` program wrapper at `~/.igris/core/hooks/bridges/codex-notify.sh` | Codex exposes only post-turn notification. The user's original `notify` program is backed up to `~/.igris/config.json → cli_targets.codex.user_notify_backup` and invoked first. |
| Gemini CLI | None | Not supported | Gemini CLI has no hook API. Igris hook layer is a no-op for Gemini. |

### Shared Script Input Contract

Every shared script accepts two input shapes. Bridges translate native events to the
unified shape before piping; legacy Claude-native shape is also accepted for backward
compatibility (direct `settings.json` invocation with no bridge).

**Unified shape (preferred, from bridges):**
```json
{
  "source": "claude" | "opencode" | "codex",
  "event":  "session_start",
  "project_dir": "/absolute/path",
  "payload": { /* CLI-specific fields */ }
}
```

**Native Claude shape (back-compat):**
```json
{ "tool_name": "Write", "tool_input": { "file_path": "/..." } }
```

**Environment variable fallback** (when stdin is empty):

| Variable | Meaning |
|----------|---------|
| `IGRIS_HOOK_SOURCE` | `claude` / `opencode` / `codex` |
| `IGRIS_HOOK_EVENT` | Matches filename: `session_start`, `pre_tool_use`, etc. |
| `IGRIS_PROJECT_DIR` | Absolute path to project root. |
| `IGRIS_TOOL_NAME` | Tool name for `pre_tool_use` / `post_tool_use`. |
| `IGRIS_FILE_PATH` | File path for Write/Edit operations. |

### Post-Tool-Use Dispatcher

`post_tool_use.sh` is a dispatcher — it reads the JSON input once, then fans out to every
executable file under `post_tool_use.d/` in lexicographic sort order. Each handler runs
in its own subshell with a 10s timeout (configurable via `IGRIS_POST_TOOL_USE_TIMEOUT`).
Handler failures are isolated: one crashing handler does not block the others.

Default handlers:

| File | Purpose |
|------|---------|
| `01-lint.sh` | Run shellcheck on modified `.sh` files. |

Add new handlers by dropping a `NN-name.sh` file into `~/.igris/core/hooks/shared/post_tool_use.d/`
and `chmod +x`. Disable without deletion via `chmod -x`.

### OpenCode-Specific Notes

OpenCode's plugin event model was verified end-to-end against `opencode 1.14.22` on
2026-04-24 (TD-044). Findings:

**Event-name drift vs. docs.** OpenCode's plugin docs list `session.created`, but in
headless `opencode run` mode it never fires — sessions come into existence via
`session.updated` / `session.status` on the same event bus. The bridge synthesises
`session_start` from the first `session.updated`/`session.status` per unique session id,
with an in-memory `seenSessions` set guarding against re-fire.

**End-event dedupe.** `session.idle` reliably fires in both run and TUI modes; the bridge
dedupes via an `endedSessions` set keyed by session id so `session_end` dispatches exactly
once per session. `server.instance.disposed` is a server-lifecycle event, **not** a
session-end signal — the bridge ignores it.

**Tool-hook coverage.** `tool.execute.before` / `tool.execute.after` subscriptions are
wired per OpenCode's documented API and compile clean, but exercising them depends on
the provider issuing tool calls. During TD-044 verification the Z.AI Coding Plan endpoint
(anthropic-compatible) returned clean sessions with zero tool invocations, so
write-tool flow through the bridge was not observed live. Re-test with a provider that
reliably emits tool calls before relying on that path.

**Trace flag for debugging.** Set `IGRIS_BRIDGE_TRACE=/path/to/trace.log` before launching
OpenCode to capture every event the bridge sees and every dispatch it fires. Zero impact
when unset.

**E2E script.** `test/e2e/opencode_bridge.sh` smoke-tests the session lifecycle path.
Skips with exit code 77 when `opencode`, `bun`, or `ZAI_API_KEY` are unavailable.

### Config Block

`~/.igris/config.json` extends `cli_targets.*` with a `hooks` sub-block:

```json
{
  "cli_targets": {
    "claude": {
      "hooks": {
        "settings_file": "$CLAUDE_PROJECT_DIR/.claude/settings.json",
        "events_covered": ["session_start","session_end","pre_tool_use","post_tool_use","pre_compact","post_compact"],
        "claude_only_events": ["SubagentStop","Stop","Notification","TaskCompleted","TeammateIdle"]
      }
    },
    "opencode": {
      "hooks": {
        "plugin_dir": "~/.config/opencode/plugins/",
        "plugin_file": "igris-bridge.ts",
        "events_covered": ["session_start","session_end","pre_tool_use","post_tool_use","pre_compact","post_compact"]
      }
    },
    "codex": {
      "hooks": {
        "notify_wrapper": "~/.igris/core/hooks/bridges/codex-notify.sh",
        "events_covered": ["session_end"]
      },
      "user_notify_backup": []
    },
    "gemini": {
      "hooks": {
        "events_covered": [],
        "note": "Gemini CLI has no hook API. Not supported."
      }
    }
  }
}
```

### Installation

Installation is controlled by `igris init` (bootstrap-time bridge
selection) and `igris install` (per-project propagation):

- `igris init --cli-bridge=<list>` — which CLIs to target during the
  one-time `~/.igris/` bootstrap (`claude,opencode,codex` or `none`).
  Defaults to auto-detect.
- `igris install <project-dir>` — propagates the wired bridges to the
  given project. No flag needed; the bridges already live in
  `~/.igris/config.json#cli_targets`.

Examples:

```bash
# Auto-detect bridges during bootstrap (default):
igris init

# Explicit set during bootstrap:
igris init --cli-bridge=claude,codex

# Opt out of all bridges (Claude-only):
igris init --cli-bridge=none

# Install in a project (uses whatever bridges are wired):
igris install /path/to/project
```

Runtime refresh:

```bash
# Re-fetch ~/.igris/core/ from the recorded channel and re-run bridge
# materialization. After init+refresh, no further runtime sync is needed —
# the brain serves all CLIs from a single source.
igris refresh
```

### Degradation on Gemini

Because Gemini has no hook API, these Igris behaviors are unavailable in a Gemini
session:

- No session_start context injection — Gemini will not see the active brief / session
  mode / blockers summary on session start.
- No `pre_tool_use` brief-first gate — Gemini can write files without requiring an
  active brief.
- No `post_tool_use` lint — file edits are not auto-linted on Gemini.
- No session_end REST MODE flip — CURRENT_SESSION.md remains at its last state until
  something else flips it.

All other Igris surfaces (skills, agents, rules) continue to work on Gemini
via the FR-153 symlink projection at `~/.gemini/skills/`.

### Testing

Hook coverage tests live at `test/igris_hooks_sync.test.bash`. Fixtures at
`test/fixtures/hooks/`:

- `settings_pristine.json` — user's Claude settings with no Igris entries.
- `settings_with_existing.json` — mixed user + stale-Igris entries (tests merge-replace).
- `codex_config_pristine.toml` — user's Codex config with a non-Igris `notify`.
- `codex_config_post_install.toml` — expected output after Igris wrap.

Run with `bats test/igris_hooks_sync.test.bash`. All tests should pass on macOS and
Linux.

---

## Agent-prompt harnesses (FR-136)

Agent prompts (the 7 Igris-core agents and any project agents) are projected to
per-CLI harness files (Codex `.toml`, Claude `.md`) by the TD-021 adapters under
`core/scripts/cli-adapters/`. FR-136 formalized this:

- **Schema** — `core/scripts/cli-adapters/manifest.schema.json` is the canonical
  contract. Core ships only the schema; **each project ships its own data
  manifest** validated against it.
- **Per-project manifest** — lives at the project's repo root
  (`<project-root>/harness-manifest.json`), NOT under `core/`. It declares each
  agent's canonical prompt source and the harness targets to regenerate. The
  adapters resolve `<project-root>/harness-manifest.json` by default (override
  with `--manifest <path>`).
- **Personal overlay (Layer-2)** — an OPTIONAL gitignored overlay at
  `~/.igris/registry/harness-manifest.personal.json` is auto-discovered and its
  `agents[]` merged into the base before flattening. A personal agent whose name
  collides with a core agent is a hard error (no shadowing). This is the FR-139
  customization-registry seam. Override with `--overlay <path>`.
- **`igris harness` verb** — `igris harness compile` regenerates harnesses;
  `igris harness check` runs the drift guard. Both shell out to the bash adapters
  (`compile_harnesses.sh` / `check_harness_drift.sh`) with exit-code passthrough.
  Flags: `--project-root`, `--manifest`, `--overlay`, `--target`, `--filter`.

### The three adapter naming families (reconciled — FR-138; middle family retired by FR-153)

Three naming families have lived under `core/scripts/cli-adapters/` since
FR-138. They are NOT interchangeable; each owns a distinct concern. FR-138
fixed the canonical disposition of each, and **FR-153 retired the middle
family** in favor of the unified symlink projection — only the first and
third families have live disposition today:

| Family | Concern | Disposition |
|--------|---------|-------------|
| `sync_<target>.sh` (+ `compile_harnesses.sh` / `check_harness_drift.sh`) | **Per-agent subagent prompts** (TD-021). One canonical `core/agents/<name>.md` → one harness per target. | **Canonical** for subagent harnesses. `sync_*` are the per-target emitters; `compile_harnesses.sh` orchestrates; `check_harness_drift.sh` guards. |
| `md_to_<surface>.sh` (`md_to_agents_md.sh`, `md_to_gemini_toml.sh`) | **Skills surfaces** (FR-103 / FR-137). The `~/.igris/core/skills/` tree → per-CLI skill artifacts. | **RETIRED by FR-153** — superseded by the symlink-based registry-anchored skill projection (`compile_harnesses.sh` skills pass + `_common.sh`'s pair allowlist). Both scripts deleted. |
| `<target>.sh` (e.g. `codex.sh`, `gemini.sh`) | The dormant FR-104-era bridge contract: `<target>.sh <project-path>`, invoked by `materializeBridges()` in `cli/src/lib/bridges.ts` during `igris init`. | **Superseded by the `igris harness` verb.** No `<target>.sh` script exists, so `materializeBridges` skips every target today (a silent no-op). The harness verb (`cli/src/verbs/harness.ts`) is the live seam — it shells out to `compile_harnesses.sh` / `check_harness_drift.sh` directly and deliberately never touches `bridges.ts`. The inert `bridges.ts` contract is left in place for a follow-up cleanup brief (no code change in FR-138); do not build `<target>.sh` scripts against it. |

### Add a New Harness (the five-surface runbook)

> **The harness abstraction.** Igris keeps **one canonical source** per surface
> and derives **N per-harness artifacts** from it deterministically. Editing a
> derived artifact (a `~/.claude/agents/<name>.md` symlink, a
> `~/.config/opencode/command/<name>.md` wrapper, an `AGENTS.md`) is a **process
> error** — the compiler regenerates it from the canonical source on the next
> run. To change a harness's behavior, edit the canonical source (the agent
> prompt, the SKILL.md, the manifest) and recompile. A new harness is "onboarded"
> by teaching the five surfaces how to project to it, never by hand-writing its
> artifacts.

A harness becomes first-class across **five surfaces**, each with its own
projection primitive:

| Surface | Canonical source | Projection primitive |
|---------|------------------|----------------------|
| **Agents** | `core/agents/<name>.md` → registry-assembled `harness.<label>.<ext>` | per-harness symlink **or** hard-link (depends on whether the loader follows symlinks) |
| **Skills** | `core/skills/<name>/SKILL.md` (+ registry-vendored personal skills) | `symlink` (whole skill dir) **or** `command` (thin `@file` wrapper) |
| **MCP** | `surfaces.mcp_servers[]` canonical block | config-**merge** into the harness's native MCP config |
| **Hooks** | `~/.igris/core/hooks/shared/*.sh` | per-harness **bridge** (plugin / notify-wrapper) |
| **Identity** | `core/templates/identity.tmpl` (Model-A block) via `surfaces.os_identity[]` | **region-merge** of the rendered block into the harness's auto-read project-root context file (TD-233) |

#### Per-harness method matrix (the four harnesses today)

This consolidates the per-surface facts; the authoritative tables it draws from
are linked so a reader chases the single source of truth, not a copy:

| Harness | Agent primitive | Skills method | MCP map key + entry shape | Hooks | Identity file |
|---------|-----------------|---------------|---------------------------|-------|---------------|
| **Claude** | Symlink (`atomic_symlink`) → `~/.claude/agents/<name>.md` | `symlink` → `~/.claude/skills/` | `mcpServers.<name>` / `{type:"stdio",…}` | All 6 portable + Claude-only events | `CLAUDE.md` (project root — carries the canonical identity block natively) |
| **Codex** | Symlink (`atomic_symlink`) → `~/.codex/agents/<name>.toml` (FR-159) | `symlink` → `~/.agents/skills/` (FR-157 cross-CLI) | `[mcp_servers.<name>]` / resolved-literal env | `session_end` only (notify wrapper) | `AGENTS.md` (project root — `os_identity` region-merge, TD-233) |
| **Gemini** | **Hard link** (`emit_md_hardlink`) → `~/.gemini/agents/<name>.md` — loader does NOT follow symlinks (TD-208) | `symlink` → `~/.agents/skills/` (FR-157 cross-CLI) | `mcpServers.<name>` / no-`type` env | **None** (no hook API) | `GEMINI.md` (project root — `os_identity` region-merge, TD-233) |
| **OpenCode** | Symlink → `~/.config/opencode/agent/<name>.md` — loader **does** follow symlinks (FR-171, verified live 1.14.22) | `command` → `~/.config/opencode/command/<name>.md` thin `@file` wrapper (FR-171) | `mcp.<name>` / `{type:"local", command:[…fused…], environment{}}` | All 6 portable (TS plugin) | `CLAUDE.md` (reads Claude's file — A/B-proven; no separate target) |

- Agent primitive details: see the **TD-208 subagent-distribution primitive
  table** (above, "The consumer-side agent target …").
- MCP entry shapes: see the **FR-160 four-native-shapes table** (above, "The four
  shapes").
- Hook coverage: see the **FR-104 per-CLI coverage table** (above, "Per-CLI
  Coverage").
- Identity filename map + mechanism: see the **TD-233 orchestrator-identity
  section** (above, "Orchestrator identity as a `surfaces.os_identity` manifest
  declaration").

#### OpenCode-native-location facts (FR-171, verified live `opencode 1.14.22`)

- **Agents** — `~/.config/opencode/agent/<name>.md` (singular `agent/`). The
  loader **follows symlinks**, so OpenCode uses the symlink primitive (like
  Claude/Codex), not the Gemini hard-link.
- **Skills/commands** — `~/.config/opencode/command/<name>.md` (singular
  `command/`). Each is a thin wrapper whose body is `@~/.igris/core/skills/<name>/SKILL.md`
  + `$ARGUMENTS` — the canonical SKILL.md stays the single source of truth.
- **MCP** — `~/.config/opencode/opencode.json`, map `mcp.<name>`, `type:"local"`,
  command+args **fused** into one `command[]` array, env key `environment`,
  values `{env:VAR}`.
- **Hooks** — `~/.config/opencode/plugins/igris-bridge.ts` (TS plugin, Bun
  auto-loads; no build step).

> **Gemini `~/.gemini/commands/` is RETIRED (L-608).** The legacy per-command
> TOML converter target was removed by FR-153; Gemini now reads skills from the
> cross-CLI shared `~/.agents/skills/` (FR-157), the same location Codex reads.
> Any `cli_targets.gemini.target` still pointing at `~/.gemini/commands/` is
> stale documentation, not a live projection path.

#### Steps (each surface in dependency order)

1. **Phase 0 — PROBE the loader first** (non-destructive, throwaway HOME): which
   agent dir? command dir? does the loader follow symlinks (→ symlink) or not
   (→ hard-link)? frontmatter/tools shape? MCP-permission key shape? which
   project-root context file does it auto-read for orchestrator identity
   (unique-marker A/B + "who are you?" — the TD-233 method)? The emit
   primitive, dir names, and identity filename are CHOSEN from these probes —
   see FR-171 plan §1.
2. **Type catalog** — add `"<NEW>"` to the `CLITarget` union in `cli/src/types.ts`.
3. **MCP surface** — add the native entry shape to `buildHarnessMcpEntry`
   (`cli/src/lib/mcp-shape.ts`), `"<NEW>"` to `ALL_HARNESSES`
   (`cli/src/lib/mcp-register.ts`), and the config path to `cli/src/lib/paths.ts`.
4. **Manifest schema** — add `"<NEW>"` to the agent `targets[].type` enum and the
   `surfaces.skills.targets[].type` enum in `manifest.schema.json`, plus a new
   `(type, method)` `oneOf` branch on the skills target item. The skills method
   enum is `["compiler", "converter", "symlink", "command"]` (`compiler`/`converter`
   are retired-but-retained for back-compat) — pick `symlink` unless the harness
   reads skills from a native command/prompt surface (then `command`). Mirror the
   same pair in `valid_pairs` inside `_common.sh validate_manifest` and
   `VALID_SKILL_TYPE_METHOD_PAIRS` in `cli/src/verbs/registry.ts`.
5. **Compiler passes (dual-impl — §18.1 parity MANDATORY)** — add the agent
   dispatch arm to `case "$ttype" in` and the skills dispatch arm to
   `case "$s_type/$s_method" in` in `compile_harnesses.sh`; add the bash
   compile-side α-assembler `assemble_<NEW>_harness_into_registry` (core-agent
   path) + its inline-python3 tool translator; add the TS vendor-side
   `assemble<New>Harness` + `CLAUDE_TO_<NEW>_TOOLS` in `cli/src/verbs/registry.ts`
   (personal-agent path) wired into the 4 vendor sites. The bash and TS
   translators MUST be **byte-identical**, pinned by a golden-fixture parity test
   (L-554). Post-FR-153 the skills compile branch calls either
   `emit_skill_symlink <label> <link_path> <skill_dir>` (symlink) or the
   `<NEW>/command` wrapper-writer (command), never a `sync_<target>.sh` adapter —
   those were retired by FR-152/FR-153/FR-159.
6. **Drift checker** — add `"<NEW>"` to the agent verdict gate, the per-harness
   agent verdict, and the skills drift branch in `check_harness_drift.sh`. The
   drift verdict for symlink/hard-link agents is **link-realpath**, not a body-sha
   compare (FR-159). Drift MUST mirror the compile emit line-for-line (L-519
   §18.1) — a divergence makes `check` report DRIFTED right after a clean compile.
7. **Hooks / bridge** — add the harness's event bridge under
   `core/hooks/bridges/<NEW>/` routing the portable events to
   `~/.igris/core/hooks/shared/*.sh`. A harness with no hook API (like Gemini) has
   a documented no-op bridge, not a missing touchpoint.
8. **Declare targets** — add the `<NEW>` agent targets to `harness-manifest.json`
   (core agents) + `~/.igris/registry/harness-manifest.personal.json` (personal
   agents), and the `<NEW>` skills target to `surfaces-manifest.json`.
9. **Runtime config (descriptive)** — add `cli_targets.<NEW>` to
   `~/.igris/config.json` with `{method, target, note, hooks}`. Remember:
   `target`/`method` here are **descriptive labels, not read by the projection**
   (see the Configuration section's `cli_targets` callout) — the live paths come
   from the manifests in steps 4 + 8.
10. **Orchestrator-identity surface (TD-233)** — add the Phase-0-confirmed
    identity filename as `{type:"<NEW>", method:"file", filename:"<probed>.md"}`
    to `surfaces.os_identity[].targets` in the repo-root `harness-manifest.json`
    (if the harness already auto-reads `CLAUDE.md`, like OpenCode, no target is
    needed), and add the harness's Model-A self-name to BOTH §18.1 twins
    (`_common.sh::normalize_identity_shape` `SELF_NAMES` +
    `cli/src/lib/identity-shape.ts` `HARNESS_SELF_NAMES` — byte-identical).
    Verify: `igris harness compile --surface identity` → OK row, then a fresh
    `<NEW> -p "who are you?"` greets as **Igris AI**.
11. **Mirror + test** — every touched `core/scripts/cli-adapters/*` file is in the
    TD-096 runtime mirror set: `cp` to `~/.igris/core/scripts/cli-adapters/` and
    verify with `verify_mirror.sh`. Add `<NEW>` to the bats matrix
    (`test/harness_*.test.bash`) + the vitest `assemble<New>Harness` + parity
    tests. **Gate scope:** a project-relative target path is auto in-scope for the
    `validate_harness_drift.sh` commit gate (MISSING → fatal); a home/absolute
    path is auto out-of-scope (MISSING → NOTICE).

**Closing gate:** `igris harness compile && igris harness check` must be
drift-CLEAN, then a fresh `<NEW> agent list` must enumerate every agent and a
fresh `<NEW> -p "who are you?"` must greet as **Igris AI** (step 10). A
DRIFTED/MISSING verdict names the harness + surface — trace it back to the step
above.

#### Procedure: the `/onboard-harness` skill

The doc above is the **why** (the harness abstraction + the five-surface model).
The **do** is the executable [`/onboard-harness`](../core/skills/onboard-harness/SKILL.md)
skill — run it to walk this same checklist step-by-step with a cheap self-verify
after each touchpoint (so a dropped step is CAUGHT, not assumed). The skill
treats `opencode` (FR-171) as its worked example throughout.

---

## Overlay scope (FR-155)

Personal overlay entries (agents + skills declared in the Layer-2 customization
overlay, FR-139) carry an optional `scope` field that controls **which working
directories** the harness emits the entry into.

| Shape | Behavior |
|---|---|
| `scope` absent | Default: emit unconditionally (back-compat) |
| `{type: "global"}` | Emit unconditionally |
| `{type: "project", paths: [...]}` | Emit only when `--project-root`'s realpath ∈ realpath'd `paths[]` |

`paths[]` entries and `--project-root` are realpath'd before comparison on both
sides (handles macOS `/tmp` ↔ `/private/tmp`). Non-matching project-scoped
entries are silently skipped — neither counted in `TOTAL` nor flagged as drift.

### CLI semantics

```bash
# Global (default): targets emit as absolute paths (~/.claude/agents/<name>.md, etc.).
# Available to claude/codex/gemini from any working directory.
igris registry add --name X --from ./path/to/source

# Project-scoped: targets emit as project-relative paths. Only emits when
# compile/drift runs against the listed --project-root realpath.
igris registry add --name X --from ./source --project /abs/proj-a

# Multi-project additive: same name + --project again appends to scope.paths.
igris registry add --name X --project /abs/proj-b   # paths becomes [proj-a, proj-b]

# Idempotent: re-adding the same project on a project entry is a no-op.
igris registry add --name X --project /abs/proj-a   # already present; no change

# Conversion (explicit — silent auto-convert is refused):
igris registry add --name X --scope project --project /abs/proj-a   # global → project
igris registry add --name X --scope global                          # project → global (paths dropped)
```

Re-add with `--project P` against an existing **global** entry is refused with
an actionable hint pointing at `--scope project` for explicit conversion —
narrowing availability has downstream effects on every harness consumer, so
the conversion must be operator-acknowledged.

The same `--project` / `--scope` flags apply to `add-skill`.

On-disk shape: `scope` is OMITTED when global (schema treats absent as
global). Project-scoped entries write `scope: {type: "project", paths: [...]}`
with realpath'd absolute paths.

---

## Related

- Brief: FR-103 Multi-CLI Skill Distribution
- Brief: FR-104 Multi-CLI Hook Bridge Layer
- Brief: FR-136 Harness manifest schema + per-project model + `igris harness` verb
- Brief: FR-137 Skills surface folded into the harness manifest engine
- Brief: FR-138 Un-gate codex emit (D1 resolved) + drift-guard MISSING→FATAL scoping + add-a-harness contract
- Canonical skills: `~/.igris/core/skills/`
- Canonical shared hooks: `~/.igris/core/hooks/shared/`
- Bridges: `~/.igris/core/hooks/bridges/`
- Skill adapters: `scripts/cli-adapters/`
- Hook adapters: `scripts/hook-adapters/`
- Config: `~/.igris/config.json` → `cli_targets`
