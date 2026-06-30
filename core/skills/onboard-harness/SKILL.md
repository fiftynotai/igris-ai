---
name: onboard-harness
description: "Onboard a new CLI/IDE harness to Igris by filling its ONE canonical descriptor block in harness-manifest.json (agent_id, agents, MCP, grant, hooks, delegation model) — adding a thin format emitter only where the harness's format is genuinely new — then verifying with igris harness compile/check (drift + agents parity-guard) that every surface, and every future igris add, reaches it"
disable-model-invocation: false
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Edit
  - Write
triggers:
  - "ONBOARD HARNESS"
  - "onboard-harness"
  - "add a new harness"
  - "add a new CLI"
---

# ONBOARD-HARNESS — Add a new harness to Igris

Make a new harness (`<NEW>`) a **first-class Igris target** by filling its **ONE
canonical descriptor block** — `harnesses.<NEW>` in `harness-manifest.json`. That
block is the single source of truth every wiring consumer reads (TS via
`cli/src/lib/harness-descriptor.ts`; bash via `read_harness_descriptor` in
`_common.sh`). Once it's filled, *everything Igris already has* — and everything
added later via `igris add` — reaches `<NEW>` automatically.

**Three concerns, in order of effort:**

1. **DISTRIBUTION** (skills + MCP) — delegated to `npx skills` / `npx add-mcp`,
   **auto-detected by `agent_id`**. Igris writes ~no code here; you only confirm
   `<NEW>` has an agent-id.
2. **PROJECTION** (agents + MCP entry shape) — a **thin format emitter ONLY where
   `<NEW>`'s format is genuinely new**; reuse an existing shape otherwise.
3. **VERIFICATION** — the descriptor-driven drift engine + parity-guard prove every
   surface (and every future `igris add`) reaches `<NEW>`.

Igris projects **four material surfaces — agents, skills, MCP, hooks** — plus
`delegation_model`, the 5th descriptor field / connection point that selects a
**context layer** (not a projected surface). **Identity is NOT a surface** (it's
`/awaken`). Per-surface participation is **DERIVED from block presence** in the
descriptor — there is no separate harness list to maintain.

> ## The principle: prove the read-path for CUSTOM surfaces, never assume
>
> Skills + MCP placement is **owned by the npx tools** (auto-detected by
> `agent_id`) — you do NOT discover those paths. The only surfaces you must
> empirically PROVE are the two **custom** ones — **agents and hooks**:
>
> 1. **Prove every custom read-path with a marker test before wiring it**
>    (Phase 5). Never infer a path from another harness or from "it shares a
>    config root."
> 2. **Global scope ≠ project scope** — a custom surface may read from different
>    paths per scope. Determine both.
> 3. **A shared config root does NOT mean a shared subpath — but Igris can bridge
>    it with an install-time symlink.** Prove the read-path FIRST; only then, if it
>    differs from where Igris already projects, bridge it. Skipping the marker test
>    ships a wrong-but-plausible read-path — the single most likely failure of this
>    skill.

## Arguments

`$ARGUMENTS` = the new harness name, lowercase (e.g. `cursor`). If empty, ask the
operator which harness to onboard.

**Two id-spaces** (don't conflate them): the **shape id** = the `harnesses.<NEW>`
key (also the agent/MCP/hook target `type` and the `entry_shape` switch key); the
npx **`agent_id`** = how `skills`/`add-mcp` name the harness — identical to the
shape id *except* `claude→claude-code` and `gemini→gemini-cli`.

---

## Phase 1 — Recon (non-destructive)

Establish ground truth. **Branch early** — not every harness is a clean headless
CLI.

1. **Install + locate the binary.** How is `<NEW>` invoked? Standalone CLI, or an
   IDE with a CLI companion?
2. **Auth gate? (BRANCH — operator-gated.)** Run a trivial command. If it demands
   interactive sign-in, **STOP and ask the operator to sign in** — you cannot
   complete an interactive login, and most surfaces (and the config root) don't
   materialize until first sign-in. Resume only after they confirm.
3. **Config root(s).** After sign-in, find where `<NEW>` persists config; watch for
   a **shared root** (a harness may live inside another's root with its own subdir).
4. **Headless mode (BRANCH — GUI-first harnesses).** Confirm a non-interactive
   invocation (close stdin — some CLIs hang otherwise). If `<NEW>` is IDE-only with
   no headless mode, that is itself a finding: document how projection +
   verification work for it (you may need the operator to drive the GUI for live
   checks).

Output: binary path, auth model, config root(s), headless invocation. Nothing
wired yet.

---

## Phase 2 — Classify delegated-surface support (DISTRIBUTION)

Does `<NEW>` have an agent-id the npx tools recognise?

```bash
npx skills list-agents      # is <NEW> (or its agent_id) listed?
npx add-mcp list-agents     # likewise for MCP
```

- **YES → skills + MCP placement is auto-detected** by the npx tool from
  `agent_id`. (Gotcha: an agent-id can differ from the shape id — e.g. `gemini-cli`
  not `gemini`; see the two id-spaces above.) You write **no per-surface
  skills/MCP path code**.
- **NO → decision branch:** either contribute the agent-id **upstream** to the npx
  tool, or onboard `<NEW>` **without** the delegated surfaces (agents + hooks
  only). Surface the choice to the operator.

The core skills SOURCE is declared **once, harness-agnostically**, in
`surfaces-manifest.json` — you add **NO per-harness skills target**; the npx tool
places skills by `agent_id`.

---

## Phase 3 — Fill the ONE descriptor block (THE BULK)

Add `harnesses.<NEW>` to `harness-manifest.json`. This is the bulk of onboarding:

| field | what it captures | notes |
|---|---|---|
| `agent_id` | the npx agent id (Phase 2) | the DISTRIBUTION key |
| `agents{target_type,projection}` | static-agent surface; `projection` = `symlink` (loader follows symlinks) or `target-row` (per-agent file) — from Phase 5 | **omit the whole block** if `<NEW>` is `dynamic-define` / has no static agents |
| `mcp{config_path,format,map_key,entry_shape}` | MCP wiring; `entry_shape` names the emitter to reuse (Phase 4) | omit if `<NEW>` has no MCP |
| `grant{kind,path?,token?}` | the no-prompt grant the MCP path writes | operator-gated nuance below |
| `hooks{supported,config_path?,method?}` | hook surface; `supported:false` is a valid documented N/A | from Phase 5 |
| `delegation_model` | `native-static` or `dynamic-define` (Phase 6) | selects the context layer |
| `harness_specific_file?` | the context-layer file, if `dynamic-define` (Phase 6) | omit for `native-static` |

**Register the id-space (still hand-kept — NOT descriptor-derived):** add `<NEW>`
to `HarnessId` + `VALID_HARNESS_IDS` in `cli/src/lib/harness-descriptor.ts`, **and**
to the `CLITarget` union in `cli/src/types.ts`. These two unions are the only
id-space edits "fill the descriptor" doesn't cover — verify both. Everything else —
per-surface participation — is **DERIVED from block presence**; do not write a
separate harness list.

**Grant nuance (operator-gated):** the harness's security model correctly forbids
an agent from editing its own permission allow-list. So either `igris install`
writes the `grant` *as part of the install the user consents to*, or you **emit the
exact change for the operator to apply** — never silently.

---

## Phase 4 — Thin emitter ONLY if the format is genuinely new (PROJECTION)

Two possible thin emitters, **both conditional** — add code only if `<NEW>`'s
format diverges from every existing one:

- **Agent frontmatter** — a translator in the descriptor-driven compile engine,
  **only if** `<NEW>`'s agent-file format is new (existing families:
  Markdown-frontmatter, TOML).
- **MCP entry shape** — a branch in `buildHarnessMcpEntry`
  (`cli/src/lib/mcp-shape.ts`) keyed by `entry_shape`, **only if** the entry shape
  is new.

Existing `entry_shape` values to **reuse** (set `mcp.entry_shape` to one — no new
emitter): JSON `mcpServers` (claude/gemini shape), JSON `mcp` local-array (opencode
shape), TOML `[mcp_servers]` (codex shape). If `<NEW>` matches one (e.g. a
JSON-`mcpServers` harness), reuse it; write a new `entry_shape` only for a genuinely
new wire format.

---

## Phase 5 — Marker-protocol read-path discovery (CUSTOM surfaces ONLY)

Apply only to the two custom surfaces — **agents and hooks**. (Skills/MCP paths are
npx-owned — Phase 2 already settled them.) Per surface, per scope:

1. **Enumerate candidate paths**, **drop a uniquely-named marker** in each, **run
   `<NEW>` headless**, observe which it loaded, **record the winner + format, tear
   the marker down**, then **repeat at the other scope**.

- **Agents:** does the loader **follow symlinks**? → set `agents.projection` to
  `symlink`; if not (it needs a real per-agent file) → `target-row` (and the agent
  appears as a `targets[]` row in `harness-manifest.json`). This is exactly what the
  Phase-7 agents parity-guard keys on.
- **Hooks:** is there an event/hook API? Route it to the shared hooks via a bridge
  under `core/hooks/bridges/<NEW>/`. If there is **no** hook API, set
  `hooks.supported:false` — a deliberate **documented N/A**, not a silent gap.

Capture the proven `config_path`s into the descriptor. (The shared-root caution from
the intro applies here: bridge a differing read-path with an install-time symlink
only AFTER the marker proves it.)

---

## Phase 6 — Delegation / context layer

Set `delegation_model`:

- **`native-static`** — `<NEW>` loads Igris agents statically; a skill's
  `subagent_type:<agent>` resolves directly. Nothing more to do.
- **`dynamic-define`** — `<NEW>` can only define subagents at runtime. Author
  `core/os/harness-specific/<NEW>.md` (frontmatter `harness:`/`delegation_model:`/
  `summary:`; body **points at** `core/os/harness-specific/_delegation-recipe.md`,
  never copy-pastes it) and set `harness_specific_file`. Re-run
  `core/scripts/gen_os_index.sh` so the Boot harness-specific roster picks it up.
  Boot loads only the file whose `harness:` matches the resolved harness — zero
  per-skill branching.

---

## Phase 7 — Verify (both gates + the cross-check)

```bash
igris harness compile        # descriptor-driven engine: compile_harnesses.sh
igris harness check          # descriptor-driven engine: check_harness_drift.sh
```

Both must be **drift-CLEAN** AND the **agents parity-guard** must pass (it flags an
agent that dropped a `target-row` harness its siblings keep). The
**descriptor↔schema cross-check** must pass — the harness-bearing enums are
VALIDATED against `manifest.schema.json`, not hand-added (guarded by
`test/harness_descriptor.test.bash`).

**Future-add guarantee** — the thing the old flow lacked. For each surface, add a
throwaway and assert it reaches `<NEW>`, then tear down:

```bash
for s in skill agent mcp hook; do
  igris add "$s" "igrisprobe_$s"   # → assert it landed in <NEW>; then remove
done
```

`cli_targets.<NEW>` in `~/.igris/config.json` is **DESCRIPTIVE-only** —
human-readable labels, **not read by the projection** (only a presence-check reads
its top-level key). Don't edit `.target` expecting a projection change.

Onboarding is **done** only when both gates pass, the future-add guarantee holds,
and every N/A is documented in `docs/multi-cli.md`.

---

## Phase 8 — Cognition headless-run connection point (where applicable)

A headless `<NEW>` can be registered as a **config-selectable extraction backend**
for the cognition subsystem (`config.json` `llm_extractor.harness` / `cognition`).
Note it as a connection point — not a required onboarding step.

---

## Why this works

The `harnesses.<NEW>` descriptor is the **single source of truth**; the two readers
+ the `igris harness` / `igris add` verbs are the engine the skill RUNS — it
interprets their harness-agnostic output, it does not hand-edit a scatter of
per-harness lists. This skill is a standard core skill projected to every harness
via the single core skills block in `surfaces-manifest.json` —
**self-demonstrating**: it reaches each harness by the exact mechanism it
documents. It is **research-first**: the harness-specific shape is an *input* to
recon + the marker protocol, never an assumption baked into the steps.

**Cross-links:** `docs/multi-cli.md` § "Add a New Harness" (the canonical *why*);
`core/os/self-extension.md` (harness onboarding is configuration — the descriptor);
`core/os/surfaces-detail.md` (the surface / adapter boundary). **Worked
references:** `opencode` (a clean headless CLI, FR-171); `antigravity` (auth-gated,
shared config root, FR-179).
