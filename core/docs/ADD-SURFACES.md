# Adding Surfaces — the `igris add` reference (FR-180)

This is the canonical reference for extending Igris with a new **surface**: a
skill, agent, MCP server, hook, or orchestrator identity. It is routed into
context via `core/igris_tree.json` (`context_files.surface_management`) and
paired with the `surface_management` section in `core/prompts/igris_os.md`.

> **Phase status.** FR-180 ships ALL FIVE surfaces — `skill`, `agent`, `mcp`,
> `identity`, and `hook` — end-to-end (personal + core). Hooks were the
> net-new first-class surface (Phase 5, D7 Option B): they now ride the same
> `surfaces.hooks[]` flatten → compile → drift scaffold as the other four.

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
| **Hook** | `igris add hook <name> --event <Event> [--matcher <glob>] [--timeout <n>] [--target <type:merge[:enabled]>]` | config-merge of an event-hook GROUP into each harness's native hook surface. `<Event>` is one of `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`. Targets default to `claude:merge`; the two hook harnesses are **claude** (the `.claude/settings.json` `hooks.<Event>[]` array) and **opencode** (covered by the FR-104 plugin — codex supports only session_end and gemini has no hook API, so those are documented, not projected). **Personal** writes the hook SCRIPT to `~/.igris/registry/hooks/<name>/<Event>.sh` + a `surfaces.hooks[]` overlay block; the registry-prefix command path is what the canonical re-merge **preserves** (see the R2 gotcha). `--core` writes `core/hooks/shared/<Event>.sh` + a `surfaces.hooks[]` block in `core/scripts/cli-adapters/surfaces-manifest.json` + TD-096 mirrors both. `--matcher` only applies to `Pre/PostToolUse`. |
| **Identity** | `igris add identity <name> --target <type:file:filename>` | region-merge of the Igris-managed identity block into the harness's natively auto-read identity file (e.g. `gemini:file:GEMINI.md`, `codex:file:AGENTS.md`). **Personal** writes a project-scoped `surfaces.os_identity[]` block to the overlay — FR-180 (D6) lifted the v1 "personal os_identity accepted but NOT merged" gate so it now projects like core. A personal (type, filename) target that collides with a core one is REJECTED. `--source` / `--version-source` override the canonical template / `{{IGRIS_VERSION}}` source (defaults: `<brain>/core/templates/identity.tmpl`, `<brain>/config.json`). `--core` appends an os_identity block to the repo-root `harness-manifest.json` (the SAME file the TD-233 core block lives in) using the canonical mirrored template. |

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
- **Core adds are one-step — they materialize AND project AND verify.** Run an
  `igris add --core <surface>` from the igris-ai checkout (auto-detected) or pass
  `--core`. It writes the source + TD-096 mirror, then **projects to all four
  harnesses and drift-verifies** — atomically. The projection half runs against
  the RUNTIME BRAIN ROOT (`~/.igris`), not the checkout, because (a) the
  ownership gate that admits the core surfaces keys on the runtime
  `surfaces-manifest.json` (only a root that OWNS it — the brain — passes), and
  (b) the repo manifest's agent `canonical.dir` is the project-relative
  `core/agents`, which resolves to the runtime mirror `~/.igris/core/agents/…`
  under the brain root. `igris add` computes this projection root for you; you
  just run the one command. (Earlier builds wrote the source only and then
  loud-failed `FAIL core <surface> — not owned by --project-root <repo>`; that is
  FIXED — core adds now land in the harnesses.)
- **The loud `FAIL  core <surface> — not owned …` is still reserved** for a
  genuinely mis-routed `--expect-core` compile — e.g. someone runs `harness
  compile --surface skills --expect-core` with a `--project-root` that owns no
  core surfaces. The gate is intact; `igris add --core` simply passes the
  CORRECT project-root so it never trips on a legitimate core add.
- **Personal vs incidental skip** — when you compile an unrelated personal
  project (WITHOUT `--expect-core`), the core surfaces are intentionally skipped
  with a single visible `SKIPPED core surfaces (personal-project compile)` line
  (exit 0). That is not an error — it is the gate doing its job (core surfaces
  don't leak into unrelated projects).
- **MCP secrets (§14)** — `igris add mcp --env KEY=${VAR}` stores only the
  `${VAR}` indirection ref; an inline secret value is REJECTED. The harness
  resolves the real value from the environment at launch time, so no secret ever
  enters the registry overlay or the core surfaces manifest.
- **MCP verify scoping (S1)** — unlike a per-item symlink (skills/agents), an MCP
  add is a config-MERGE into each harness's native MCP config. The MCP compile +
  drift passes honor `--filter <name>` (wired in Phase 3 for parity with skills/
  agents), so `igris add mcp <name>` scopes its drift verify to just the added
  server — a pre-existing UNRELATED MCP drift can't false-fail a clean add.
- **Identity has no `name` (D6)** — an os_identity block is keyed by its (type,
  filename) target pairs, not a name; the positional `<name>` is just a label for
  logging. The verify is scoped by `--surface identity` (the surface) + the
  block's project-scope, NOT by `--filter` (which is a name glob and does not
  apply to identity). A personal `add identity` writes the block `scope:{type:
  "project", paths:[realpath(--project-root)]}` so the personal identity only
  projects into THIS project's identity files.
- **Identity version source under the brain root (core)** — a core `add identity`
  projects against the RUNTIME BRAIN ROOT (`~/.igris`), where a repo-relative
  `version_source: cli/package.json` would NOT resolve (the brain has no
  `cli/package.json`). So the core writer OMITS `version_source` (it defaults to
  `<brain>/config.json`, which exists) and uses `source: core/templates/
  identity.tmpl` (the mirrored canonical). The existing TD-233 core identity
  block keeps its own `cli/package.json` source — that block is projected when
  `harness compile` runs from the igris-ai CHECKOUT (where `cli/package.json`
  resolves), the normal full-repo compile path; `igris add --core identity` is
  the one-step path that projects against the brain.
- **Hooks survive `igris update` / `doctor --fix` (R2 — the central hazard)** —
  `install` / `update` / `doctor --fix` re-merge the canonical hooks from
  `~/.igris/core/hooks/canonical-settings.json` into `.claude/settings.json`,
  dropping-then-re-applying every group whose command starts with the CORE
  prefix `$HOME/.igris/core/hooks/`. A **personal**-added hook lives under a
  DIFFERENT prefix — `$HOME/.igris/registry/hooks/<name>/` — which the
  re-merge classifies as user-owned and **preserves**. That is the merge gate:
  a personal hook is never clobbered by a refresh. (A core hook IS re-applied
  by the canonical re-merge because it carries the core prefix — that is also
  correct; the core hook is part of the canonical set.) The
  refresh-no-clobber behavior is regression-tested (the R2 merge gate for
  Phase 5).
- **Hooks are a config-MERGE surface (like MCP), not a symlink** — the hook
  compile pass invokes `igris registry project-hook`, which appends the hook
  GROUP into the `hooks.<Event>[]` array idempotently (a re-project of the same
  command path replaces in place — never a duplicate) and preserves every
  pre-existing user group + every other top-level settings key. The drift pass
  asserts the command path is PRESENT under its event (MATCH) or absent
  (MISSING). The verify is name-scoped via `--filter <name>` (S1), so a
  pre-existing unrelated hook drift can't false-fail a clean add.
- **opencode hooks are covered by the FR-104 plugin** — a `claude:merge` target
  writes the settings.json group; an `opencode:merge` target does NOT write a
  config (the FR-104 `igris-bridge.ts` plugin already routes all six events to
  the shared scripts). The projector/drift verify the plugin EXISTS at
  `~/.config/opencode/plugins/igris-bridge.ts` (covered → OK/MATCH; absent →
  loud failure pointing at `igris install`). codex (session_end-only) and gemini
  (no hook API) are not hook projection targets.

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
