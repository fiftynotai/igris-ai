# CLI Adapters

Scripts that distribute Igris surfaces to non-Claude CLIs. Two distinct
families live here — do not conflate them.

## Skills adapters (FR-103 → FR-153 → FR-157 → FR-202)

Skill harness projection lives in `compile_harnesses.sh` (skills pass) — for
each `<name>/SKILL.md` under the source root, each live target projects ONE
per-skill loadout-anchored symlink at `<target>/<name>` → `<source>/<name>`
(FR-153). The live skills triad is:

- `claude/symlink` → `~/.claude/skills` (Claude's native skills loader follows
  the symlink).
- `agents/symlink` → `~/.agents/skills`, the cross-CLI shared standard that
  **codex AND gemini both read natively** (FR-157) — so they need no standalone
  skill target. Keeps the FR-157 D2 absolute-target guard (codex re-resolves
  relative symlinks from cwd).
- `opencode/command` → `~/.config/opencode/command` (FR-171 thin `@file`
  command wrapper; OpenCode has no native skills dir).

The legacy AGENTS.md aggregator + per-skill TOML converter scripts
(`md_to_agents_md.sh`, `md_to_gemini_toml.sh`) were retired by FR-153. FR-202
(M1) deleted the now-dead standalone `codex/symlink` + `gemini/symlink` skill
targets (superseded by `agents/symlink`) and the long-retired
`compiler`/`converter` method enum values — no live manifest declared any of
them, and the live triad's projected bytes + drift verdicts are unchanged.

## Subagent adapters (TD-021 + FR-152 — unified harness projection)

Regenerate per-agent harness projections from a single canonical agent prompt.
Canonical (plus its FR-151 `frontmatter.md` sidecar) is the **sole source of
truth**; every claude/gemini `~/.claude/agents/<name>.md` /
`~/.gemini/agents/<name>.md` is an atomic symlink resolving to a loadout-
resident `harness.md` assembled at compile/vendor time. Codex emits a 3-key
`.codex/agents/<name>.toml`. Editing a target file directly is a process error.

| Script | Contract | Output |
|--------|----------|--------|
| `compile_harnesses.sh` | `compile_harnesses.sh --project-root <dir> [--manifest <p>] [--filter <glob>] [--target claude\|codex\|gemini\|all]` | Orchestrates: reads the manifest. All three agent harnesses (claude/codex/gemini) α-project from loadout-resident files (`harness.claude.md`, `harness.codex.toml`, `harness.gemini.md`). claude + codex emit via symlink; gemini emits via hard link (TD-208). Codex assembly is bash-side `assemble_codex_harness_into_loadout` for core agents and TS-side `assembleCodexHarness` for vendor (FR-159). |
| `check_harness_drift.sh` | `check_harness_drift.sh --project-root <dir> [--manifest <p>] [--filter <glob>]` | CI-style guard — exit 1 if any claude/codex symlink target is non-loadout-anchored, refuses-to-clobber a real-file target, or any gemini hard link has diverged (TD-208). All three agent harnesses use the per-harness loadout-resident file as their verdict basis (FR-159 retired the codex body-sha verdict). |

`sync_codex_agents.sh` was RETIRED by FR-159 — the codex TOML emit moved to
TS `assembleCodexHarness` in `cli/src/verbs/loadout.ts` (vendor-side) with a
parallel bash `assemble_codex_harness_into_loadout` in `compile_harnesses.sh`
(compile-side fallback for core agents). This mirrors the FR-153 retirement
posture (`md_to_agents_md.sh` + `md_to_gemini_toml.sh` deleted; their work
moved to symlink primitives + the TS harness assemblers).

### Exit codes (all subagent adapters)

- `0` — success / all in sync
- `1` — error, or (for `check_harness_drift.sh`) drift detected
- `2` — usage error

### The manifest

`harness-manifest.json` declares, per agent, the canonical source and the set
of harness targets. It serves two canonical conventions:

- **versioned** (`versioned: true`) — content-pipeline agents,
  `agents/<name>/system-prompt-v*.md`; the adapter resolves the newest via
  `latest_canonical`.
- **unversioned** (`versioned: false`) — Igris-core agents,
  `core/agents/<name>.md`; the adapter uses the literal `file`.

Schema details and an example: `docs/multi-cli.md` § "Subagent Distribution".

### Body exceptions

`body-exceptions/<name>.json` declares a documented, intentional divergence
between a claude harness body and the canonical body — an `anchor` line plus
an `insert` paragraph list. A manifest entry opts in via
`"body_exception": "<name>"`. FR-144/FR-152: the appendix is applied at
ASSEMBLY time (by `compile_harnesses.sh` and the TS vendor primitive in
`loadout.ts`), baked into the loadout-resident `harness.md`. Codex emitters
write the plain canonical body — the exception is claude/gemini-only via
assembly. Resolution is layer-keyed: personal-layer sidecars live under
`<brain>/loadout/body-exceptions/<name>.json`; core-layer sidecars live next
to this adapter directory. Currently one exists: `designer-harness-skill-para`
(DESIGNER's harness-skill invocation note).

### Decision D1 — codex wrap vs reimplement (RESOLVED — REIMPLEMENT, FR-138)

The legacy `sync_codex_agents.sh` (retired by FR-159) once faced Decision D1:
whether to WRAP the codex CLI's native agent-import command or REIMPLEMENT
the TOML emit. FR-138 RESOLVED it in favor of REIMPLEMENT — the emit path
writes the fully-specified 3-key codex subagent TOML directly. FR-159 then
ported the emit to TS (`assembleCodexHarness`) + a parallel bash helper
(`assemble_codex_harness_into_loadout`) for byte-equivalent compile-side
fallback. The former `--d1-reimplement` flag / `IGRIS_CODEX_D1=reimplement`
env opt-in are GONE (no surface to accept them on after the bash script
deletion). A WRAP variant remains possible behind a future `--d1-wrap` flag
if codex's import is ever found scriptable + idempotent.

## Shared helpers

`_common.sh` is sourced by every adapter. Subagent-relevant helpers added by
TD-021:

- `read_canonical_version <md>` — extract the `> **Version:** X.Y` marker (or
  a `version:` frontmatter key); empty when neither is present.
- `latest_canonical <dir> <glob>` — newest version-matching file (`sort -V`).
- `sha_body <md>` — sha256 of the body only (frontmatter stripped).

## MCP secrets (FR-160e)

MCP servers often need a secret (an API key, a token). Igris NEVER stores the
literal secret in the loadout overlay or in any git-tracked file — the overlay
holds only a `${VAR}` indirection ref (the `add-mcp` write-guard rejects any
other form). How that ref is emitted into each harness's live config depends on
the harness. Three patterns cover every MCP server:

| Pattern | Who | What the harness config holds | Secret source |
|---------|-----|-------------------------------|---------------|
| ① config-file-read | igris-brain (env-free) | nothing — no `env` block | n/a (no secret) |
| ② env-resolution | claude / gemini / opencode | a ref the harness resolves at launch | exported env (inherited) |
| ③ compile-time-literal | codex | the RESOLVED literal, written at compile time | `~/.igris/secrets.env` |

igris-brain is pattern ①: its canonical `env` is empty, so it never references
a secret and never trips the `doctor` missing-secret warning.

### Per-harness emit-rule matrix

The canonical env value is always `${VAR}`. The FR-165 normalizer
(`cli/src/lib/mcp-env-normalize.ts#normalizeEnvForHarness`) maps it per harness;
FR-164's projector consumes those values and splices them into each config.

| Harness | Canonical value | Emitted value | Why |
|---------|-----------------|---------------|-----|
| claude   | `${VAR}` | `${VAR}` (verbatim) | resolves the ref + inherits exported env |
| gemini   | `${VAR}` | `${VAR}` (verbatim) | resolves the ref + inherits exported env |
| opencode | `${VAR}` | `{env:VAR}` (token) | resolves its own `{env:…}` token |
| codex    | `${VAR}` | the literal from `secrets.env` | resolves NOTHING (sandbox `inherit="core"`) — needs the bare value |

### secrets.env setup

The real secrets live in `~/.igris/secrets.env` (OUTSIDE any repo, gitignored
belt-and-suspenders). It is a shell-sourceable file:

```sh
# ~/.igris/secrets.env  — chmod 600, never committed
export MY_TOKEN=sk-...real...value...
export OTHER_KEY="value with spaces"
```

1. Create it and lock it down: `chmod 600 ~/.igris/secrets.env`.
2. Source it from your shell rc so claude/gemini/opencode inherit the exported
   env at launch (pattern ②): `source ~/.igris/secrets.env`.
3. Codex (pattern ③) does NOT inherit env — FR-164's compile reads the literal
   directly from `secrets.env` and bakes it into `~/.codex/config.toml`.

`igris doctor` emits a read-only WARNING (never the value) for any MCP `${VAR}`
that is absent from BOTH `secrets.env` and the environment. The fix is to add
the `export VAR=…` line above; doctor will not write secrets for you.

The load-bearing guarantee: the projector NEVER writes a resolved literal into
a git-tracked file — Codex `config.toml` lives at `~/.codex/`, outside the repo,
and the loadout overlay stays `${VAR}`-only. The `.gitignore` entry for
`secrets.env` is defense-in-depth against a stray in-repo copy.

### The irreducible per-harness shape-emitters (FR-202 M2)

MCP is the surface-plugin contract's **`projection = shape-emit`** case: every
harness chose its own MCP config schema, so the canonical launch spec
(`{command, args, env}`) cannot be placed in a shared standard dir — it must be
*re-shaped* per harness. The thin core is **two plugins** (`project_mcp` /
`verify_mcp`) over the SHARED shape helper `_common.sh::normalize_mcp_shape`
(§18.1 / L-554 byte-paired with its TS twin `cli/src/lib/mcp-shape.ts#buildHarnessMcpEntry`).
There is **no custom MCP runtime** — Igris contributes only *config*; the
harness's own MCP client spawns the stdio server at launch. Distribution is
`command`-passthrough: whatever the canonical declares as `command` (`npx`, an
absolute path, a bundled binary) is emitted verbatim — the projector never
rewrites or special-cases it.

The per-harness divergence is **5 irreducible axes** (sourced from
`normalize_mcp_shape` L1663-1729 + the `verify_mcp` case L1733-1763 + the env
re-resolve L605-628). It is genuinely irreducible — collapsing any axis would
require one of the harnesses to change its own config schema:

| # | Axis | claude | gemini | antigravity | opencode | codex |
|---|------|--------|--------|-------------|----------|-------|
| 1 | **config map-key** | `mcpServers` | `mcpServers` | `mcpServers` | `mcp` | `mcp_servers` |
| 2 | **config file + format** | `~/.claude.json` (JSON) | `~/.gemini/settings.json` (JSON) | `~/.gemini/config/mcp_config.json` (JSON — distinct file from gemini, FR-179 R1) | `~/.config/opencode/opencode.json` (JSON) | `~/.codex/config.toml` (**TOML** — `extract_mcp_entry` keys off the `.toml` suffix) |
| 3 | **`type` discriminator** | `"type":"stdio"` | (none) | (none) | `"type":"local"` (+ `"enabled":bool` — the only harness reading the `enabled` column) | (none) |
| 4 | **command shape** | `command` + `args` separate | `command` + `args` separate | `command` + `args` separate | `"command":[cmd, …args]` **FUSED** | `command` + `args` separate (+ optional `startup_timeout_sec`) |
| 5 | **env key + `${VAR}` grammar** | key `env`, `${VAR}` verbatim | key `env`, `${VAR}` verbatim | key `env`, `${VAR}` verbatim | key `environment`, **`{env:VAR}`** token | key `env`, the **resolved LITERAL** on disk (FR-165 / memory #586 — codex resolves NEITHER `${VAR}` nor process-env under sandbox `inherit="core"`) |

Notes that the bare-table approximation can mislead a future maintainer:

- **antigravity is gemini-lineage but a 5th harness:** its emitted JSON is
  byte-for-byte the gemini shape (no `type`); only axis #2 (the config FILE)
  differs. It is **live** (FR-179/180) — do NOT drop it from
  `VALID_MCP_TARGET_TYPES`.
- **The codex env value is NEVER a literal in the projected shape.**
  `normalize_mcp_shape` emits the `${VAR}` REFERENCE stand-in (it never reads
  `secrets.env`, never emits a literal). The resolved literal is written ONLY by
  the TS projector at compile time into `~/.codex/config.toml` (outside any
  repo), and the drift compare re-resolves the reference to that literal **inside
  its python compare** to deep-equal the on-disk value.

**`verify_mcp_entry_drift` is the protected, secret-safe verdict — do NOT alter
it.** It is the one path that touches a resolved secret, and it is engineered to
NEVER print one: on a codex env divergence it emits only KEY names
(`DRIFTED:env.<KEY>` / `MISSING_SECRET:<VAR>` / `MATCH`), never any value
(resolved or on-disk). Changing even one `[mcp/<name>/<harness>]` verdict line —
or leaking a value while "documenting" it — is a regression. The 5 emitters +
this drift compare ARE the thin MCP surface; there is nothing to delete and
nothing to rewrite for distribution (npx is already a verbatim `command`).

## Orchestrator-identity surface — RETIRED (FR-202 M4)

The `os_identity` projection surface (TD-233) was **removed**. Igris no longer
region-merges an identity block into a harness's auto-read file. There is no
`surfaces.os_identity[]`, no `project_identity`/`verify_identity` plugin, no
`normalize_identity_shape` helper, no `identity` entry in `IGRIS_SURFACE_IDS`,
and no `igris add identity` arm. The surface registry is back to four:
`agents skills mcp hook`.

The whole-file `CLAUDE.md` render (and its `core/templates/CLAUDE.md.tmpl` +
`identity.tmpl`) was **removed in FR-191** (the zero-config "door"): `igris install`
no longer writes any identity file — project or global. Igris stays unaware of a
cold harness by default; OS identity is delivered only via the `/boot` boot
ceremony (decision #872). The per-harness delegation mechanism that used to ride
the identity region is now the harness-specific context layer (below).

## Event-hook surface (hooks — FR-180 D7)

Event-hooks: a first-class `surfaces.hooks[]` manifest surface (FR-180 D7,
Option B) so they ride the SAME flatten → compile → drift scaffold as the other
material surfaces. Each block declares a
`name`, an `event` (one of the six portable events), a `canonical.command` (the
hook script the harness runs, optionally `matcher`/`timeout`), and
per-harness `targets[{type ∈ {claude, opencode}, method:"merge"}]`.

- **Compile** (`compile_harnesses.sh`, narrows via `--surface hook`): for each
  `(hook, target)` row it dispatches to `igris loadout project-hook`, which
  config-**merges** the hook GROUP (built by the TS projector `cli/src/lib/
  hook-shape.ts`) into the target. claude → the project's `.claude/settings.json`
  `hooks.<Event>[]` array (idempotent — re-projecting replaces in place; user
  groups + other keys preserved). opencode → covered by the FR-104 plugin (verify
  it exists; no config write). codex/gemini are not hook projection targets.
- **Drift** (`check_harness_drift.sh`): hook drift is **presence-based**, NOT a
  byte-shape comparison. It asserts the hook command path is present under its
  event (`MATCH`) or absent (`MISSING`) via `_common.sh::verify_hook_entry_present`;
  for opencode it verifies the plugin. Honors `--filter <name>` (S1) so a scoped
  verify checks only the added hook. Because the hook is identified by its command
  PATH in the merged JSON (not its full byte-shape), there is **no §18.1 bash↔TS
  shape-parity contract** here the way agents have (no bash hook-shaper
  twin) — `hook-shape.ts` shapes the projector's output and is pinned by a TS-only
  golden in `hook-shape.test.ts`.
- **R2 — refresh-overwrite safety.** A core hook's command lives under
  `$HOME/.igris/core/hooks/shared/`; a personal hook's under
  `$HOME/.igris/loadout/hooks/`. `install`/`update`/`doctor --fix` re-merge the
  canonical hooks (`mergeCanonicalHooks` in `cli/src/lib/json-merge.ts`), which
  drops-then-re-applies CORE-prefix groups but PRESERVES the loadout-prefix
  personal ones — so a personal hook is never clobbered by a refresh. The
  `IGRIS_PERSONAL_HOOK_CMD_PREFIX` carve-out in `isIgrisEntry` makes this an
  explicit, regression-tested contract (the R2 merge gate).
- **Adding a hook (`igris add hook`, FR-180 D7):** the one-step add verb writes
  the hook script + a `surfaces.hooks[]` block (personal → the loadout overlay
  + `~/.igris/loadout/hooks/<name>/`; core → `surfaces-manifest.json` +
  `core/hooks/shared/`) then projects + verifies it. `merge_overlay_manifest`
  unions hook blocks (base ++ overlay) with a `name` + `(event, target)` cell
  collision guard.

## Delegation mechanism — a context layer, NOT an adapter surface (FR-202 M4)

The **delegation mechanism** is the one piece of harness-specific behavior that
previously had no home, so it leaked into a skill (the FR-183 dynamic-define
recipe embedded in `/hunt`). It was briefly carried on the identity region
(TD-244), then re-homed by FR-202 M4 into a **context layer** —
`core/os/harness-specific/<harness>.md`. It is **NOT an adapter surface**: the
compile/drift engine no longer touches it. Skills delegate **abstractly** and the
model reads the per-harness *how* from its own harness-specific file at Boot.

### The adapter boundary (what the adapter owns vs what skills/OS see)

The harness adapter owns every MATERIAL surface that differs by harness; the OS
core and skills name only **abstract intents**, resolved to a harness-specific
mechanism via **declared config**, never per-skill branching:

| Adapter-owned behavior | Declared in (config) | Compiled/drift-checked by | Abstract intent the skill/OS sees |
|---|---|---|---|
| projection (agents) | `harness-manifest.json` `agents[]` | agents pass | "the named agent's prompt is loadable" |
| skills | `surfaces.skills[]` | skills pass | "the skill is invocable" |
| MCP | `surfaces.mcp_servers[]` | mcp pass | "the brain MCP tools are callable" |
| hooks | `surfaces.hooks[]` | hook pass | "the portable event fires the shared script" |
| **delegation mechanism** (context layer, NOT a projected surface) | `harnesses.<type>.delegation_model` predicate + `core/os/harness-specific/<harness>.md` | NOT the engine — Boot loads the Detect-selected file; `gen_os_index.sh` rosters it | **"delegate to role X" resolves on BOTH a native-static and a dynamic-define harness, ZERO per-skill branching** |

### The `delegation_model` predicate + the harness-specific layer

`harness-manifest.json` carries a top-level `harnesses` map keyed by harness
`type`, each with a `delegation_model` (`native-static` | `dynamic-define`). The
map is the **applicability predicate** — it selects which harness-specific file
applies; it no longer feeds a projection surface.

- **`native-static`** (Claude/Codex/OpenCode) — the harness loads Igris agents
  statically; a skill's `subagent_type:<agent>` resolves directly. No
  harness-specific file is needed.
- **`dynamic-define`** (Antigravity, gemini-cli) — the harness can only define
  subagents at runtime. It has a `core/os/harness-specific/<harness>.md` file
  whose body points at the shared `core/os/harness-specific/_delegation-recipe.md`
  (one canonical recipe, DRY). The **Boot** stage loads ONLY the file whose
  `harness:` frontmatter matches the Detect-resolved harness, teaching the
  orchestrator the read→`define_subagent`→invoke recipe once per session.

The roster (harness → file) is discovered by `core/scripts/gen_os_index.sh` into
`core/os/INDEX.md` — the "Harness-specific roster" section there is the
Detect→Boot routing map (the Boot stage loads the file whose `harness:`
frontmatter matches the Detect-resolved harness). A harness absent from the
`harnesses` map defaults to `native-static` (no file needed).

## Surface-plugin contract (FR-202 M0)

The orchestrator (`compile_harnesses.sh`) and the drift engine
(`check_harness_drift.sh`) are **surface-agnostic dispatchers**. Each wiring
surface is a declarative plugin filling a **3-concern lifecycle** the core owns:

```
declare → distribute → project → verify
```

A surface declaration has four contract fields (formalized in
`manifest.schema.json` → `$defs/surface_contract`, annotated as `_contract` on
each surface `$def`):

| Field | Values | Meaning |
|-------|--------|---------|
| `kind` | `material` \| `behavioral` | **material** = content projected INTO a per-harness config/file. **behavioral** = a per-harness behavior injected at boot (no content distributed). |
| `distribution` | `npx` \| `native-add` \| `portable-format` \| `n-a` | How the content reaches the machine. |
| `projection` | `shape-emit` \| `place-in-standard-dir` \| `inject-at-boot` \| `merge-region` | How the declared content becomes a per-harness native shape. |
| `verification` | _(drift verdict fn)_ | The surface's drift verdict (MATCH / DRIFTED / MISSING). |

### The material surfaces (proven against real code)

| Surface | kind | distribution | projection | verification (existing fn) |
|---------|------|--------------|------------|----------------------------|
| **agents** | material | portable-format | **shape-emit** — formats genuinely diverge (Claude MD / Gemini MD / OpenCode MD / Codex TOML); `compile_md_agent_target` translates each | `verify_agents` — per-agent tree-hash + symlink/hardlink-realpath verdict |
| **skills** | material | portable-format | place-in-standard-dir | `verify_skills` — per-skill tree-hash + symlink/wrapper presence |
| **mcp** | material | npx | merge-region | `verify_mcp` — secret-safe per-(mcp,target) compare (`verify_mcp_entry_drift`) |
| **hooks** | material | native-add | merge-region | `verify_hook` — `verify_hook_entry_present` (presence-based MATCH/MISSING) |

All four projected surfaces are **material** (content projected into a per-harness
config/file). The single **behavioral** descriptor that used to exist
(`delegation_model`, which rode the now-retired identity surface) is no longer a
projected surface — FR-202 M4 re-homed the delegation mechanism into the
harness-specific context layer (`core/os/harness-specific/<harness>.md`), which
the Boot stage loads and the compile/drift engine never touches.

> **FR-202 M3 — agents surface: KEEP confirmed, no centralization needed.** The
> per-harness agent frontmatter field-maps are **already single-sourced**, NOT
> scattered. They live in exactly ONE compile-side assembler,
> `assemble_agent_harness_into_loadout` (which holds `CLAUDE_TO_GEMINI_TOOLS`
> and `CLAUDE_TO_OPENCODE_TOOLS` inline); the `compile_md_agent_target` dispatch
> wrapper named in the agents row above carries no field-map of its own — it just
> routes to that assembler (or to `assemble_codex_harness_into_loadout`, which
> emits TOML and translates no tools). The ONLY "copy" of these maps is the
> deliberate, test-pinned §18.1 bash↔TS dual-impl (the TS twins
> `CLAUDE_TO_GEMINI_TOOLS` / `CLAUDE_TO_OPENCODE_TOOLS` in
> `cli/src/verbs/loadout.ts` serve the personal-agent vendor path; golden-fixture
> parity tests pin them byte-for-byte). The drift side carries **no frontmatter
> field-map at all** — `verify_agents` verdicts by symlink/hardlink-realpath +
> per-agent tree-hash, never by re-translating frontmatter. So the brief's
> "centralize the field-map tables" target does not exist (the post-FR-158/159/171
> code single-sourced each map the first time it was written) — KEEP the
> translator, the gemini hard-link (TD-208), and the §18.1 dual-impl verbatim. Do
> not re-chase a scatter that is not here.

### The membership gate (the rule, stated concretely)

A thing is a wiring surface **iff it can fill all four fields** — it has content
that is *declared once* (a `canonical`/`source`), *distributed* to the machine,
*projected* into a per-harness native shape (a `targets[]` array), and *verified*
by a drift verdict. If it cannot (no per-harness projection, no canonical
declaration, or no drift-checkable artifact) it is **NOT a wiring surface** — it
belongs in OS-core (`core/os/`), a skill (`core/skills/`), or the brain. The
schema enforces this structurally: every `surfaces.<x>[]` block requires a
`targets[]` array and a `source`/`canonical`, so a non-projectable concept
cannot be declared as a surface.

### The surface registry (single source of truth)

The ordered surface list lives in **ONE place** — `_common.sh`'s
`IGRIS_SURFACE_IDS` (the ids: `agents skills mcp hook`) plus the
positionally-aligned `IGRIS_SURFACE_LABELS` (the empty-match noun fragments).
Both top scripts source it. The `--surface` enum and the empty-match message are
*derived* from the registry; the dispatch loops iterate it, calling
`project_<surface>` / `verify_<surface>` by function-name composition (bash 3.2:
no associative arrays / namerefs — accumulators stay global).

### The extensibility test (the construction-time guarantee)

Adding a new wiring surface is, by construction:

1. a `$defs/<x>_surface` block + `_contract` metadata in `manifest.schema.json`
2. ONE entry in `IGRIS_SURFACE_IDS` / `IGRIS_SURFACE_LABELS` in `_common.sh`
3. a `project_<x>` plugin in `compile_harnesses.sh`
4. a `verify_<x>` plugin in `check_harness_drift.sh`

…and **ZERO change to the two top scripts' dispatch loops**. `--surface <x>`
then compiles and drift-checks the new surface with no core edit. (FR-202 M0
proved this with a throwaway `demo` surface, then reverted it.)

## Mirror obligation (TD-096)

Every file in this directory lives under `core/` and is part of the runtime
mirror set. After editing any file here in the repo, copy it to the matching
`~/.igris/core/scripts/cli-adapters/` path and verify with
`~/.igris/core/scripts/verify_mirror.sh`.
