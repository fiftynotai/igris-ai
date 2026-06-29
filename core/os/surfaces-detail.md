---
layer: capability
tier: on-demand
scope: orchestrator
summary: The full `igris add` reference — per-surface command table, core-vs-personal, and the gotchas.
consult_when: when adding or repairing a surface via igris add
---

# Adding Surfaces — the `igris add` reference

The canonical reference for extending Igris with a new **surface**: a skill, agent, MCP server, or hook. The boot-tier `self-extension` module routes here.

> **Status.** Four **material** surfaces — `skill`, `agent`, `mcp`, and `hook` — work end-to-end via `igris add` (personal + core): each projects content into a per-harness native config or file. The per-harness **delegation mechanism** is no longer a projected surface — it is a CONTEXT LAYER (`core/os/harness-specific/<harness>.md`), loaded at Boot for the Detect-resolved harness. The `harnesses.<type>.delegation_model` (`native-static` | `dynamic-define`) descriptor in `harness-manifest.json` survives only as the applicability predicate that selects which harness-specific file applies; a skill still delegates abstractly ("delegate to role X") and the harness reads its own file for the *how* — zero per-skill harness branching.

---

## The one command

```
igris add <skill|agent|mcp|hook> <name> [--from <dir-or-github>] \
          [--target <type:...>] [--core | --no-core] [--harness <type>]
```

`igris add` is **atomic, one-step, and self-verifying**. For one invocation it:

1. **Materializes** the surface — vendors/registers it into the `~/.igris/loadout/` overlay (personal), or writes the `core/` source file + mirrors it to the runtime brain (core).
2. **Projects** it to all four harnesses (Claude, Gemini, Codex, OpenCode). The **MCP** surface additionally projects to **Antigravity** (gemini-identical no-`type` shape) — a 5th MCP target. Antigravity also rides the skills `agents/symlink` target; it is **documented N/A** for agents (no static-subagent path); its **hooks ARE wired** (PreToolUse brief-gate + PostToolUse via the antigravity BASH bridge). For delegation, Antigravity (a `dynamic-define` harness) reads its harness-specific file at Boot.
3. **Verifies** the projection is drift-clean.

If the projection produced **zero targets**, or the ownership gate skipped a requested core surface, `igris add` **fails loudly** with an actionable message — it can never report a phantom success. That is the whole point of the verb: the old `loadout add-* → harness compile` two-step could silently no-op when the ownership gate skipped a surface; `igris add` closes that hole.

---

## Core vs personal (always announced)

| Mode | When | What it edits |
|---|---|---|
| **Personal** (default) | normal use | `~/.igris/loadout/` overlay — available across all your projects |
| **Core** | `--core`, or running from the igris-ai checkout (auto-detected) | the Igris source (`core/…`), mirrored + byte-verified to the runtime brain |

- Auto-detection fires when the resolved `--project-root` is the igris-ai checkout (it has `core/scripts/cli-adapters/surfaces-manifest.json` AND a repo-root `harness-manifest.json`).
- `--core` forces core; `--no-core` forces personal. Explicit flags win over auto-detection.
- The resolved mode is **always printed** (`operating in CORE mode …` / `… PERSONAL mode …`).

---

## Per-surface command table

| Surface | Command | Notes |
|---|---|---|
| **Skill** | `igris add skill <name> --from <skills-dir> --target <type:method:path>` | `<skills-dir>/<name>/SKILL.md` is vendored; target is e.g. `agents:symlink:~/.agents/skills`. Core skills auto-discover — `--core` writes `core/skills/<name>/SKILL.md` only (no manifest edit). |
| **Agent** | `igris add agent <name> --from <dir> --target <type:path>` | all-four-harness α-assembly at vendor time. `--core` writes `core/agents/<name>.md` + the repo-root `harness-manifest.json` entry, then re-runs `core/scripts/gen_os_index.sh` to regenerate the `core/os/INDEX.md` agent roster from the new agent's own frontmatter (FR-187 Phase 2b — no `igris_tree.json` / CLAUDE.md enumeration writes). |
| **MCP** | `igris add mcp <name> --command <bin> [--arg …] [--env KEY=${VAR}] [--startup-timeout-sec <n>] --target <type:merge[:enabled]>` | config-merge into each harness's native MCP config (claude/gemini `mcpServers`, opencode `mcp`, codex `[mcp_servers.<name>]`). **`--env` values MUST be `${VAR}` indirection refs — inline secrets are REJECTED** at the writer boundary (the real secret is resolved from the environment by the harness at launch, never stored). `--core` appends a `surfaces.mcp_servers[]` block to `core/scripts/cli-adapters/surfaces-manifest.json` + TD-096 mirror. |
| **Hook** | `igris add hook <name> --event <Event> [--matcher <glob>] [--timeout <n>] [--target <type:merge[:enabled]>]` | config-merge of an event-hook GROUP into each harness's native hook surface. `<Event>` is one of `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`. Targets default to `claude:merge`; the hook harnesses are **claude** (the `.claude/settings.json` `hooks.<Event>[]` array), **opencode** (covered by the FR-104 plugin), and **antigravity** (config-merge into the antigravity hooks config via the BASH bridge; PreToolUse brief-gate + PostToolUse, session lifecycle rides `/boot`+`/rest`). codex supports only session_end; gemini-cli 0.45.0 has a `gemini hooks` API but is not yet onboarded. **Personal** writes the hook SCRIPT to `~/.igris/loadout/hooks/<name>/<Event>.sh` + a `surfaces.hooks[]` overlay block; the loadout-prefix command path is what the canonical re-merge **preserves** (see the R2 gotcha). `--core` writes `core/hooks/shared/<Event>.sh` + a `surfaces.hooks[]` block in `core/scripts/cli-adapters/surfaces-manifest.json` + TD-096 mirrors both. `--matcher` only applies to `Pre/PostToolUse`. |

---

## Gotchas

- **Core skill `description:`** — if it contains a mid-value `: ` (e.g. `usage: /foo`), the WHOLE scalar MUST be double-quoted, or strict YAML parsers (Codex) silently skip the skill. `igris add --core skill` scaffolds a quoted `description:` for you; preserve the quoting when you fill it in.
- **Core mode mirror** — every `core/` write is mirrored to `~/.igris/core/…` and byte-verified with `verify_mirror.sh`. A non-MATCH fails the add. Note: the repo-root `harness-manifest.json` and the root `CLAUDE.md` are NOT runtime-mirrored — the manifest is read from the checkout when `harness compile` runs, and the root `CLAUDE.md` is the working copy. Only `core/…` files (e.g. the agent prompt) get the mirror.
- **Core agent roster (FR-187 Phase 2b)** — `igris add --core agent` writes `core/agents/<name>.md` (the canonical prompt) + the repo-root `harness-manifest.json` entry (codex/gemini/opencode targets; claude carries no explicit target — it reads agents natively from `.claude/agents/`), then re-runs `core/scripts/gen_os_index.sh` so the agent's own frontmatter (`name`/`description`) is discovered into the `core/os/INDEX.md` agent roster. There is no `igris_tree.json` agents map or "Available Agents" CSV anymore — the roster is the single frontmatter-derived source. The scaffold preloads no context; fill in the prompt body and the agent's own CONTEXT PROTOCOL doc list afterward.
- **Core adds are one-step — they materialize AND project AND verify.** Run an `igris add --core <surface>` from the igris-ai checkout (auto-detected) or pass `--core`. It writes the source + TD-096 mirror, then **projects to all four harnesses and drift-verifies** — atomically. The projection half runs against the RUNTIME BRAIN ROOT (`~/.igris`), not the checkout, because (a) the ownership gate that admits the core surfaces keys on the runtime `surfaces-manifest.json` (only a root that OWNS it — the brain — passes), and (b) the repo manifest's agent `canonical.dir` is the project-relative `core/agents`, which resolves to the runtime mirror `~/.igris/core/agents/…` under the brain root. `igris add` computes this projection root for you; you just run the one command.
- **The loud `FAIL  core <surface> — not owned …` is still reserved** for a genuinely mis-routed `--expect-core` compile — e.g. someone runs `harness compile --surface skills --expect-core` with a `--project-root` that owns no core surfaces. The gate is intact; `igris add --core` simply passes the CORRECT project-root so it never trips on a legitimate core add.
- **Personal vs incidental skip** — when you compile an unrelated personal project (WITHOUT `--expect-core`), the core surfaces are intentionally skipped with a single visible `SKIPPED core surfaces (personal-project compile)` line (exit 0). That is not an error — it is the gate doing its job (core surfaces don't leak into unrelated projects).
- **MCP secrets** — `igris add mcp --env KEY=${VAR}` stores only the `${VAR}` indirection ref; an inline secret value is REJECTED. The harness resolves the real value from the environment at launch time, so no secret ever enters the loadout overlay or the core surfaces manifest.
- **MCP verify scoping** — unlike a per-item symlink (skills/agents), an MCP add is a config-MERGE into each harness's native MCP config. The MCP compile + drift passes honor `--filter <name>`, so `igris add mcp <name>` scopes its drift verify to just the added server — a pre-existing UNRELATED MCP drift can't false-fail a clean add.
- **Hooks survive `igris update` / `doctor --fix` (R2 — the central hazard)** — `install` / `update` / `doctor --fix` re-merge the canonical hooks from `~/.igris/core/hooks/canonical-settings.json` into `.claude/settings.json`, dropping-then-re-applying every group whose command starts with the CORE prefix `$HOME/.igris/core/hooks/`. A **personal**-added hook lives under a DIFFERENT prefix — `$HOME/.igris/loadout/hooks/<name>/` — which the re-merge classifies as user-owned and **preserves**. That is the merge gate: a personal hook is never clobbered by a refresh. (A core hook IS re-applied by the canonical re-merge because it carries the core prefix — that is also correct; the core hook is part of the canonical set.) The refresh-no-clobber behavior is regression-tested.
- **Hooks are a config-MERGE surface (like MCP), not a symlink** — the hook compile pass invokes `igris loadout project-hook`, which appends the hook GROUP into the `hooks.<Event>[]` array idempotently (a re-project of the same command path replaces in place — never a duplicate) and preserves every pre-existing user group + every other top-level settings key. The drift pass asserts the command path is PRESENT under its event (MATCH) or absent (MISSING). The verify is name-scoped via `--filter <name>`, so a pre-existing unrelated hook drift can't false-fail a clean add.
- **opencode hooks are covered by the FR-104 plugin** — a `claude:merge` target writes the settings.json group; an `opencode:merge` target does NOT write a config (the FR-104 `igris-bridge.ts` plugin already routes all six events to the shared scripts). The projector/drift verify the plugin EXISTS at `~/.config/opencode/plugins/igris-bridge.ts` (covered → OK/MATCH; absent → loud failure pointing at `igris install`). **antigravity** IS a hook projection target (config-merge via the BASH bridge). codex (session_end-only) and gemini (has a `gemini hooks` API as of 0.45.0 but not yet onboarded) are not hook projection targets.

---

## The low-level path (repair primitive)

`igris add` is the common-case front door. The two-step it replaced still works and is the right tool for doctor / `--fix`-style repair:

```
igris loadout add-skill <source-dir> --name <name> --target <type:method:path>
igris harness compile --surface skills
igris harness check   --surface skills
```

`igris loadout add-*` is **write-only** (no project/verify); `igris harness compile/check` is the low-level projection/drift tool. Use them when you need to re-project an already-registered surface without re-vendoring, or when scripting a repair. For "add a new surface," prefer `igris add`.

---

**See also:** the boot-tier `self-extension` module, `docs/multi-cli.md` (harness method matrix).
