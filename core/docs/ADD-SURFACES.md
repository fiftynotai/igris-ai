# Adding & Removing Surfaces — the `igris add` / `igris remove` reference (FR-180 / FR-203)

This is the canonical reference for extending Igris with a new **surface**: a
skill, agent, MCP server, or hook — and for **removing** one symmetrically with
`igris remove` (see "Removing surfaces" below). It is routed into context via
the os/ INDEX `surfaces-detail` module (the on-demand `igris add` reference;
`consult_when: when adding or repairing a surface via igris add`).

> **Phase status.** `igris add` ships FOUR **material** surfaces — `skill`,
> `agent`, `mcp`, and `hook` — end-to-end (personal + core): each projects
> content into a per-harness native config or file. (FR-202 M4 retired the
> `identity` surface — the per-harness delegation mechanism is now a context
> layer, `core/os/harness-specific/<harness>.md`, loaded at Boot for the
> Detect-resolved harness, not an `igris add` surface. See the harness-specific
> point under "if dynamic-define" in the onboard-harness runbook.)

---

## The one command

```
igris add <skill|agent|mcp|hook> <name> [--from <dir-or-github>] \
          [--target <type:...>] [--core | --no-core] [--harness <type>]
```

`igris add` is **atomic, one-step, and self-verifying**. For one invocation it:

1. **Materializes** the surface — vendors/registers it into the
   `~/.igris/loadout/` overlay (personal), or writes the `core/` source file +
   mirrors it to the runtime brain (core).
2. **Projects** it via `harness compile --surface <s>` to every harness whose
   descriptor declares that surface. **The roster is per-surface and derived, not
   a fixed list** — read it from `harness-manifest.json`, never from a number
   written in prose:
   - **skills** and **MCP** — every harness with an `agent_id`
     (`skillAgentIds()` / `mcpAgentIds()`), i.e. the whole declared roster;
   - **agents** — the harnesses with an `agents` block (`agentTargetTypes()`);
   - **hooks** — the harnesses with `hooks.supported: true`
     (`hookTargetTypes()`). Block PRESENCE is not the test: every harness
     declares a `hooks` block, and the unsupported ones declare
     `"supported": false`.

   Re-derive any of them with
   `jq -r '.harnesses | keys[]' harness-manifest.json` and the per-surface
   predicate above; see `docs/multi-cli.md` § Harness tiers for the definition.

   **Antigravity** takes the MCP surface through its own
   `~/.gemini/config/mcp_config.json` (gemini-identical no-`type` shape, FR-179)
   rather than the shared writer. It also rides the skills
   `agents/symlink` target (skill items reach it via the install-created
   `~/.gemini/antigravity-cli/skills` → `~/.agents/skills` symlink); it is
   **documented N/A** for agents (no `agents` block — no static-subagent path);
   its **hooks ARE wired** (FR-181 —
   PreToolUse brief-gate + PostToolUse via the antigravity BASH bridge into
   `~/.gemini/config/hooks.json`).
3. **Verifies** the projection is drift-clean via `harness check`.

If the projection produced **zero targets** (the TD-235 silent-no-op), `igris
add` **fails loudly** with an actionable message — it can never report a phantom
success. This is the whole point of the verb: the old `loadout add-* → harness
compile` two-step could silently no-op; `igris add` closes that hole. (FR-218: a
consumer compile that projects a personal skill also re-affirms the global core
skills — never pruning them — see "Core SKILLS are GLOBAL" below.)

---

## Core vs personal (always announced)

| Mode | When | What it edits |
|---|---|---|
| **Personal** (default) | normal use | `~/.igris/loadout/` overlay — available across all your projects |
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
| **Agent** | `igris add agent <name> --from <dir> --target <type:path>` | α-assembly at vendor time for every harness with an `agents` block (`agentTargetTypes()`). `--core` writes `core/agents/<name>.md` + the repo-root `harness-manifest.json` entry, then re-runs `core/scripts/gen_os_index.sh` to regenerate the agent roster in `core/os/INDEX.md` (FR-187 Phase 2b: the roster is discovered from each agent's own frontmatter — no `igris_tree.json` / CLAUDE.md enumeration writes). |
| **MCP** | `igris add mcp <name> --command <bin> [--arg …] [--env KEY=${VAR}] [--startup-timeout-sec <n>] --target <type:merge[:enabled]>` | config-merge into each harness's native MCP config (claude/gemini `mcpServers`, opencode `mcp`, codex `[mcp_servers.<name>]`). **`--env` values MUST be `${VAR}` indirection refs — inline secrets are REJECTED** at the writer boundary (the real secret is resolved from the environment by the harness at launch, never stored). `--core` appends a `surfaces.mcp_servers[]` block to `core/scripts/cli-adapters/surfaces-manifest.json` (the global Layer-1 surfaces file the MCP flatten reads) + TD-096 mirror. |
| **Hook** | `igris add hook <name> --event <Event> [--matcher <glob>] [--timeout <n>] [--target <type:merge[:enabled]>]` | config-merge of an event-hook GROUP into each harness's native hook surface. `<Event>` is one of `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`. Targets default to `claude:merge`; the hook harnesses are **claude** (the `.claude/settings.json` `hooks.<Event>[]` array), **opencode** (covered by the FR-104 plugin), and **antigravity** (FR-181 — config-merge into `~/.gemini/config/hooks.json` via the BASH bridge `core/hooks/bridges/antigravity/<event>.sh`; PreToolUse brief-gate + PostToolUse, session lifecycle rides `/boot`+`/rest`). codex supports only session_end; gemini-cli 0.45.0 DOES have a `gemini hooks` API (the prior "no hook API" note was stale — onboarding tracked under FR-182, not yet projected). **Personal** writes the hook SCRIPT to `~/.igris/loadout/hooks/<name>/<Event>.sh` + a `surfaces.hooks[]` overlay block; the loadout-prefix command path is what the canonical re-merge **preserves** (see the R2 gotcha). `--core` writes `core/hooks/shared/<Event>.sh` + a `surfaces.hooks[]` block in `core/scripts/cli-adapters/surfaces-manifest.json` + TD-096 mirrors both. `--matcher` only applies to `Pre/PostToolUse`. |

---

## Removing surfaces — the `igris remove` counterpart (FR-203)

`igris remove` is the **symmetric inverse** of `igris add`. The same four
material surfaces (`skill`, `agent`, `mcp`, `hook` — NO `identity`, retired by
M4), the same auto-detected core-vs-personal mode (always printed), the same
no-phantom-success discipline — run in reverse.

```
igris remove <skill|agent|mcp|hook> <name> [--core | --no-core] \
             [--harness <type>] [--event <Event>] [--yes] [--force]
```

For one invocation it:

1. **Un-projects** the surface from every harness — deletes the
   loadout-anchored symlink/hardlink (skill/agent) or un-merges the named
   native-config block (mcp/hook), preserving every OTHER server / hook group /
   top-level key byte-for-byte.
2. **De-materializes** it from the loadout overlay (personal) OR deletes the
   `core/` source + un-sweeps the §13 agent enumeration surfaces (core),
   re-mirroring every touched mirrored `core/` file (TD-096).
3. **Verifies ABSENT** via `harness check` — for `remove`, a drift-clean result
   (the surface matches NOTHING) is the SUCCESS verdict (the empty-match
   inversion vs `add`). A still-PRESENT row means un-projection missed a target
   → loud fail.

**The inverted no-phantom-success gate (TD-235, flipped):** a removal that
de-projected ZERO targets AND found nothing in the loadout/`core/` to delete is
a **LOUD FAIL** ("already absent? check the name") — never a phantom success.

**The one intentional asymmetry — a destructive `--yes` confirm.** Because
`remove` deletes config + files, it prints exactly what WILL be de-projected and
asks for confirmation unless `--yes` is passed (scripted / round-trip use).
`igris add` has no confirm because it is additive.

### Per-surface removal table

| Surface | Command | Notes |
|---|---|---|
| **Skill** | `igris remove skill <name>` | Deletes the per-harness symlink(s) the skill projected, splices the `surfaces.skills[]` overlay block (drops the `skill:<name>` origin sidecar key + the vendored tree). `--core` deletes `core/skills/<name>/` + the runtime mirror (skills auto-discover — no manifest edit, the inverse of the add). |
| **Agent** | `igris remove agent <name>` | Deletes the per-harness compiled agent files (codex `.toml`, gemini hardlink, opencode `.md`), reuses the existing `loadout remove` (overlay + origin + vendor dir). `--core` deletes `core/agents/<name>.md` + mirror, SPLICES the repo-root `harness-manifest.json` entry, then re-runs `core/scripts/gen_os_index.sh` so the agent drops out of the regenerated `core/os/INDEX.md` roster (FR-187 Phase 2b: frontmatter-discovered, no enumeration surfaces to un-sweep). **Refuses to remove a BUILTIN agent without `--force`** (architect/forger/sentinel/warden/mender/seeker/sage/aegis/scribe are load-bearing in delegation). |
| **MCP** | `igris remove mcp <name> [--harness <type>]` | Un-merges the `mcpServers.<name>` / `mcp.<name>` / `[mcp_servers.<name>]` block from each harness's native config (every harness with an `mcp` block — `mcpTargetTypes()` — incl. antigravity's distinct `~/.gemini/config/mcp_config.json`), splices the `surfaces.mcp_servers[]` block. `--harness` scopes to one harness. `--core` splices the core `surfaces.mcp_servers[]` block + TD-096 re-mirror. |
| **Hook** | `igris remove hook <name> [--event <Event>]` | Un-merges the hook GROUP from each harness's `hooks.<Event>[]` array (matched by the loadout-prefix command path; neighbor groups preserved; the now-empty `hooks` key is dropped). `--event` is required to locate the group (recovered from the store when omitted). Deletes the loadout hook script `~/.igris/loadout/hooks/<name>/`. **#828:** removes ONLY the hooks-SURFACE mechanism — NEVER a `core/enforcement/*.md` def. opencode hooks ride the shared FR-104 plugin (which is NEVER removed — a covered no-op). `--core` splices the core `surfaces.hooks[]` block + TD-096 re-mirror; deletes the shared `core/hooks/shared/<Event>.sh` only when no OTHER block references it (reuse-don't-clobber, in reverse). |

**Round-trip identity:** `igris add <surface> <name>` then
`igris remove <surface> <name>` is a true byte-restoring identity — the overlay/
manifest/`core/` file, the symlinks, and the merged config blocks all return to
their pre-add state.

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
  files (the agent prompt) get the mirror.
- **Core agent roster (FR-187 Phase 2b)** — `igris add --core agent` writes
  `core/agents/<name>.md` (the canonical prompt) + the repo-root
  `harness-manifest.json` entry (codex/gemini/opencode targets; claude carries
  no explicit target — it reads agents natively from `.claude/agents/`), then
  re-runs `core/scripts/gen_os_index.sh`
  so the agent's own frontmatter (`name`/`description`) is discovered into the
  `core/os/INDEX.md` agent roster. There is no `igris_tree.json` agents map or
  "Available Agents" CSV anymore — the roster is the single frontmatter-derived
  source. The scaffold preloads no context; fill in the prompt body and the
  agent's own CONTEXT PROTOCOL doc list afterward.
- **Core adds are one-step — they materialize AND project AND verify.** Run an
  `igris add --core <surface>` from the igris-ai checkout (auto-detected) or pass
  `--core`. It writes the source + TD-096 mirror, then **projects to every
  harness whose descriptor declares that surface and drift-verifies** —
  atomically. The projection half runs against
  the RUNTIME BRAIN ROOT (`~/.igris`), not the checkout, because (a) the
  ownership gate that admits the core surfaces keys on the runtime
  `surfaces-manifest.json` (only a root that OWNS it — the brain — passes), and
  (b) the repo manifest's agent `canonical.dir` is the project-relative
  `core/agents`, which resolves to the runtime mirror `~/.igris/core/agents/…`
  under the brain root. `igris add` computes this projection root for you; you
  just run the one command. (Earlier builds wrote the source only and then
  loud-failed `FAIL core <surface> — not owned by --project-root <repo>`; that is
  FIXED — core adds now land in the harnesses.)
- **The `--expect-core` stricter assert** is the 0-targets-matched foot-guard:
  an `--expect-core` run that matches NOTHING fails loudly (`FAIL  core surfaces
  — 0 targets matched …`) rather than silently no-op'ing. `igris add --core`
  passes the CORRECT project-root so a legitimate core add always matches.
- **Core SKILLS are GLOBAL (FR-218, mechanism B)** — skills placement under the
  `skills` CLI delegate is global/user-level (there is NO project-local skills
  dir). When a consumer (non-owner) compile **projects a personal/project skill**
  (the action that, via the legacy whole-dir `~/.claude/skills` symlink, used to
  detach core), it **also (re)projects the core skills to the global user store**
  — core is re-affirmed, never pruned — and emits a single visible `WARN  core
  skills are (re)projected …` line (exit 0). An **agent-only / no-personal-skill**
  compile is a clean **no-op** for skills (core is NOT re-dispatched; no
  skills-CLI call, no global-store touch — the safety property). (Pre-FR-218 the
  ownership gate SKIPPED core for non-owners, then the personal projection pruned
  it — the 2026-06-30 incident, now fixed.)
- **MCP secrets (§14)** — `igris add mcp --env KEY=${VAR}` stores only the
  `${VAR}` indirection ref; an inline secret value is REJECTED. The harness
  resolves the real value from the environment at launch time, so no secret ever
  enters the loadout overlay or the core surfaces manifest.
- **MCP verify scoping (S1)** — unlike a per-item symlink (skills/agents), an MCP
  add is a config-MERGE into each harness's native MCP config. The MCP compile +
  drift passes honor `--filter <name>` (wired in Phase 3 for parity with skills/
  agents), so `igris add mcp <name>` scopes its drift verify to just the added
  server — a pre-existing UNRELATED MCP drift can't false-fail a clean add.
- **Hooks survive `igris update` / `doctor --fix` (R2 — the central hazard)** —
  `install` / `update` / `doctor --fix` re-merge the canonical hooks from
  `~/.igris/core/hooks/canonical-settings.json` into `.claude/settings.json`,
  dropping-then-re-applying every group whose command starts with the CORE
  prefix `$HOME/.igris/core/hooks/`. A **personal**-added hook lives under a
  DIFFERENT prefix — `$HOME/.igris/loadout/hooks/<name>/` — which the
  re-merge classifies as user-owned and **preserves**. That is the merge gate:
  a personal hook is never clobbered by a refresh. (A core hook IS re-applied
  by the canonical re-merge because it carries the core prefix — that is also
  correct; the core hook is part of the canonical set.) The
  refresh-no-clobber behavior is regression-tested (the R2 merge gate for
  Phase 5).
- **Hooks are a config-MERGE surface (like MCP), not a symlink** — the hook
  compile pass invokes `igris loadout project-hook`, which appends the hook
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
  loud failure pointing at `igris install`). **antigravity** IS a hook projection
  target (FR-181 — config-merge into `~/.gemini/config/hooks.json` via the BASH
  bridge `core/hooks/bridges/antigravity/<event>.sh`). codex (session_end-only)
  and gemini (has a `gemini hooks` API as of 0.45.0 but not yet onboarded —
  FR-182) are not hook projection targets.

---

## The low-level path (repair primitive)

`igris add` is the common-case front door. The two-step it replaced still works
and is the right tool for doctor / `--fix`-style repair:

```
igris loadout add-skill <source-dir> --name <name> --target <type:method:path>
igris harness compile --surface skills
igris harness check   --surface skills
```

`igris loadout add-*` is **write-only** (no project/verify); `igris harness
compile/check` is the low-level projection/drift tool. Use them when you need to
re-project an already-registered surface without re-vendoring, or when scripting
a repair. For "add a new surface," prefer `igris add`.

---

**See also:** `core/os/surfaces-detail.md` (the full `igris add` reference),
`docs/multi-cli.md` (harness method matrix), FR-180.
