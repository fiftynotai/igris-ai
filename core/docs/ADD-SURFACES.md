# Adding Surfaces — the `igris add` reference (FR-180)

This is the canonical reference for extending Igris with a new **surface**: a
skill, agent, MCP server, hook, or orchestrator identity. It is routed into
context via `core/igris_tree.json` (`context_files.surface_management`) and
paired with the `surface_management` section in `core/prompts/igris_os.md`.

> **Phase status.** FR-180 ships the `skill`, `agent`, and `mcp` arms
> end-to-end (personal + core). The `hook` and `identity` arms are wired in the
> dispatcher but land in later phases; until then, use the low-level path
> (below) for those surfaces.

---

## The one command

```
igris add <skill|agent|mcp|hook|identity> <name> [--from <dir-or-github>] \
          [--target <type:...>] [--core | --no-core] [--harness <type>]
```

`igris add` is **atomic, one-step, and self-verifying**. For one invocation it:

1. **Materializes** the surface — vendors/registers it into the
   `~/.igris/registry/` overlay (personal), or writes the `core/` source file +
   mirrors it to the runtime brain (core).
2. **Projects** it to all four harnesses (Claude, Gemini, Codex, OpenCode) via
   `harness compile --surface <s>`.
3. **Verifies** the projection is drift-clean via `harness check`.

If the projection produced **zero targets**, or the ownership gate skipped a
requested core surface, `igris add` **fails loudly** with an actionable message
— it can never report a phantom success (TD-235). This is the whole point of the
verb: the old `registry add-* → harness compile` two-step could silently no-op
when the ownership gate skipped a surface; `igris add` closes that hole.

---

## Core vs personal (always announced)

| Mode | When | What it edits |
|---|---|---|
| **Personal** (default) | normal use | `~/.igris/registry/` overlay — available across all your projects |
| **Core** | `--core`, or running from the igris-ai checkout (auto-detected) | the Igris source (`core/…`), mirrored + byte-verified to the runtime brain |

- Auto-detection fires when the resolved `--project-root` is the igris-ai
  checkout (it has `core/scripts/cli-adapters/surfaces-manifest.json` AND a
  repo-root `harness-manifest.json`).
- `--core` forces core; `--no-core` forces personal. Explicit flags win over
  auto-detection.
- The resolved mode is **always printed** (`operating in CORE mode …` /
  `… PERSONAL mode …`).

---

## Per-surface command table

| Surface | Command | Notes |
|---|---|---|
| **Skill** | `igris add skill <name> --from <skills-dir> --target <type:method:path>` | `<skills-dir>/<name>/SKILL.md` is vendored; target is e.g. `agents:symlink:~/.agents/skills`. Core skills auto-discover — `--core` writes `core/skills/<name>/SKILL.md` only (no manifest edit). |
| **Agent** | `igris add agent <name> --from <dir> --target <type:path>` | all-four-harness α-assembly at vendor time. `--core` writes `core/agents/<name>.md` + the repo-root `harness-manifest.json` entry + the §13 agent enumeration surfaces (igris_tree.json, CLAUDE.md template + root). |
| **MCP** | `igris add mcp <name> --command <bin> [--arg …] [--env KEY=${VAR}] [--startup-timeout-sec <n>] --target <type:merge[:enabled]>` | config-merge into each harness's native MCP config (claude/gemini `mcpServers`, opencode `mcp`, codex `[mcp_servers.<name>]`). **`--env` values MUST be `${VAR}` indirection refs — inline secrets are REJECTED** at the writer boundary (the real secret is resolved from the environment by the harness at launch, never stored). `--core` appends a `surfaces.mcp_servers[]` block to `core/scripts/cli-adapters/surfaces-manifest.json` (the global Layer-1 surfaces file the MCP flatten reads) + TD-096 mirror. |
| **Hook** | `igris add hook <name> …` | _(later phase)_ net-new surface design. |
| **Identity** | `igris add identity <name> …` | _(later phase)_ region-merge into the harness auto-read identity file. |

---

## Gotchas

- **Core skill `description:`** — if it contains a mid-value `: ` (e.g.
  `usage: /foo`), the WHOLE scalar MUST be double-quoted, or strict YAML parsers
  (Codex) silently skip the skill. `igris add --core skill` scaffolds a quoted
  `description:` for you; preserve the quoting when you fill it in (§13 #587 /
  TD-219).
- **Core mode mirror** — every `core/` write is mirrored to `~/.igris/core/…`
  and byte-verified with `verify_mirror.sh` (TD-096). A non-MATCH fails the add.
  Note: the repo-root `harness-manifest.json` and the root `CLAUDE.md` are NOT
  runtime-mirrored — the manifest is read from the checkout when `harness
  compile` runs, and the root `CLAUDE.md` is the working copy. Only `core/…`
  files (the agent prompt, `igris_tree.json`, `CLAUDE.md.tmpl`) get the mirror.
- **Core agent enumeration (§13)** — `igris add --core agent` updates ALL agent
  enumeration surfaces in one pass: `core/agents/<name>.md` (the canonical
  prompt), the repo-root `harness-manifest.json` entry (codex/gemini/opencode
  targets; claude rides the whole-file CLAUDE.md render), `core/igris_tree.json`
  `agents` map, and the "Available Agents" line in both `core/templates/
  CLAUDE.md.tmpl` and the root `CLAUDE.md`. The scaffold preloads no context;
  fill in the prompt body + the `igris_tree.json` `load` list afterward.
- **Run core adds from the igris-ai checkout** — or pass `--core`. Otherwise the
  ownership gate skips the core surface and `igris add` reports the loud
  `FAIL  core <surface> — not owned by --project-root …` message.
- **Personal vs incidental skip** — when you compile an unrelated personal
  project, the core surfaces are intentionally skipped with a single visible
  `SKIPPED core surfaces (personal-project compile)` line (exit 0). That is not
  an error — it is the gate doing its job (core surfaces don't leak into
  unrelated projects).
- **MCP secrets (§14)** — `igris add mcp --env KEY=${VAR}` stores only the
  `${VAR}` indirection ref; an inline secret value is REJECTED. The harness
  resolves the real value from the environment at launch time, so no secret ever
  enters the registry overlay or the core surfaces manifest.
- **MCP verify scoping (S1)** — unlike a per-item symlink (skills/agents), an MCP
  add is a config-MERGE into each harness's native MCP config. The MCP compile +
  drift passes honor `--filter <name>` (wired in Phase 3 for parity with skills/
  agents), so `igris add mcp <name>` scopes its drift verify to just the added
  server — a pre-existing UNRELATED MCP drift can't false-fail a clean add.

---

## The low-level path (repair primitive)

`igris add` is the common-case front door. The two-step it replaced still works
and is the right tool for doctor / `--fix`-style repair:

```
igris registry add-skill <source-dir> --name <name> --target <type:method:path>
igris harness compile --surface skills
igris harness check   --surface skills
```

`igris registry add-*` is **write-only** (no project/verify); `igris harness
compile/check` is the low-level projection/drift tool. Use them when you need to
re-project an already-registered surface without re-vendoring, or when scripting
a repair. For "add a new surface," prefer `igris add`.

---

**See also:** `core/prompts/igris_os.md` (`surface_management` section),
`docs/multi-cli.md` (harness method matrix), FR-180.
