# CLI Adapters

Scripts that distribute Igris surfaces to non-Claude CLIs. Two distinct
families live here — do not conflate them.

## Skills adapters (FR-103 → FR-153)

Skill harness projection lives in `compile_harnesses.sh` (skills pass) — for
each `<name>/SKILL.md` under the source root, every consumer (claude/codex/
gemini) projects ONE per-skill registry-anchored symlink at `<target>/<name>`
→ `<source>/<name>` (FR-153). The legacy AGENTS.md aggregator + per-skill
TOML converter scripts (`md_to_agents_md.sh`, `md_to_gemini_toml.sh`) were
retired by FR-153 in favor of the unified symlink projection.

## Subagent adapters (TD-021 + FR-152 — unified harness projection)

Regenerate per-agent harness projections from a single canonical agent prompt.
Canonical (plus its FR-151 `frontmatter.md` sidecar) is the **sole source of
truth**; every claude/gemini `~/.claude/agents/<name>.md` /
`~/.gemini/agents/<name>.md` is an atomic symlink resolving to a registry-
resident `harness.md` assembled at compile/vendor time. Codex emits a 3-key
`.codex/agents/<name>.toml`. Editing a target file directly is a process error.

| Script | Contract | Output |
|--------|----------|--------|
| `compile_harnesses.sh` | `compile_harnesses.sh --project-root <dir> [--manifest <p>] [--filter <glob>] [--target claude\|codex\|gemini\|all]` | Orchestrates: reads the manifest. All three agent harnesses (claude/codex/gemini) α-project from registry-resident files (`harness.claude.md`, `harness.codex.toml`, `harness.gemini.md`). claude + codex emit via symlink; gemini emits via hard link (TD-208). Codex assembly is bash-side `assemble_codex_harness_into_registry` for core agents and TS-side `assembleCodexHarness` for vendor (FR-159). |
| `check_harness_drift.sh` | `check_harness_drift.sh --project-root <dir> [--manifest <p>] [--filter <glob>]` | CI-style guard — exit 1 if any claude/codex symlink target is non-registry-anchored, refuses-to-clobber a real-file target, or any gemini hard link has diverged (TD-208). All three agent harnesses use the per-harness registry-resident file as their verdict basis (FR-159 retired the codex body-sha verdict). |

`sync_codex_agents.sh` was RETIRED by FR-159 — the codex TOML emit moved to
TS `assembleCodexHarness` in `cli/src/verbs/registry.ts` (vendor-side) with a
parallel bash `assemble_codex_harness_into_registry` in `compile_harnesses.sh`
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
`registry.ts`), baked into the registry-resident `harness.md`. Codex emitters
write the plain canonical body — the exception is claude/gemini-only via
assembly. Resolution is layer-keyed: personal-layer sidecars live under
`<brain>/registry/body-exceptions/<name>.json`; core-layer sidecars live next
to this adapter directory. Currently one exists: `designer-harness-skill-para`
(DESIGNER's harness-skill invocation note).

### Decision D1 — codex wrap vs reimplement (RESOLVED — REIMPLEMENT, FR-138)

The legacy `sync_codex_agents.sh` (retired by FR-159) once faced Decision D1:
whether to WRAP the codex CLI's native agent-import command or REIMPLEMENT
the TOML emit. FR-138 RESOLVED it in favor of REIMPLEMENT — the emit path
writes the fully-specified 3-key codex subagent TOML directly. FR-159 then
ported the emit to TS (`assembleCodexHarness`) + a parallel bash helper
(`assemble_codex_harness_into_registry`) for byte-equivalent compile-side
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
literal secret in the registry overlay or in any git-tracked file — the overlay
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
and the registry overlay stays `${VAR}`-only. The `.gitignore` entry for
`secrets.env` is defense-in-depth against a stray in-repo copy.

## Orchestrator-identity surface (os_identity — TD-233)

The fifth projected surface (after agents, skills, MCP, hooks): the
orchestrator-identity file each harness auto-reads at launch. Declared as
`surfaces.os_identity[]` in the repo-root `harness-manifest.json` (NOT
`surfaces-manifest.json`), with `method:"file"`, a per-target `filename`
(Gemini → `GEMINI.md`, Codex → `AGENTS.md`; Claude/OpenCode ride the rendered
`CLAUDE.md` and need no target), `version_source: cli/package.json`, and
project-root scope `{type:"project", paths:["."]}` (FR-155 — silent scope-skip
outside the igris-ai checkout).

- **Compile** (`compile_harnesses.sh`, narrows via `--surface identity`):
  renders the canonical `core/templates/identity.tmpl` (tokens
  `{{IGRIS_VERSION}}` + `{{HARNESS_SELF_NAME}}`, Model A) and **region-merges**
  it between the `IGRIS:OS_IDENTITY` BEGIN/END markers in the target file —
  user content outside the region is preserved; never a whole-file overwrite.
- **Drift** (`check_harness_drift.sh`): re-derives the expected region from the
  SAME shared shape helper (`_common.sh::normalize_identity_shape` — §18.1
  pair, byte-identical with the TS twin `cli/src/lib/identity-shape.ts`) and
  reports `MATCH` / `DRIFTED` / `MISSING` per `(harness, identity-file)`.
- The per-harness self-name map (`SELF_NAMES` in `_common.sh` /
  `HARNESS_SELF_NAMES` in `identity-shape.ts`) MUST stay byte-identical —
  golden-fixture parity tests pin the pair.
- **Adding an identity block (`igris add identity`, FR-180 D6):** the one-step
  add verb writes a `surfaces.os_identity[]` block (personal → the registry
  overlay; core → the repo-root `harness-manifest.json`) then projects + verifies
  it. FR-180 (D6) lifted the v1 "personal os_identity accepted but NOT merged"
  gate — `merge_overlay_manifest` now unions os_identity blocks (base ++ overlay)
  the same way it unions skills + mcp_servers, with a (type, filename) cross-block
  collision guard. The projection mechanics (`normalize_identity_shape`) are
  UNCHANGED, so the §18.1 golden parity is preserved.

The repo-root `GEMINI.md` + `AGENTS.md` are committed-as-canonical derived
artifacts: edit `identity.tmpl`, then recompile. Filename map + mechanism:
`docs/multi-cli.md` § "Orchestrator identity as a `surfaces.os_identity`
manifest declaration".

## Event-hook surface (hooks — FR-180 D7)

The sixth projected surface: event-hooks. FR-180 (D7, Option B) promoted hooks
to a first-class `surfaces.hooks[]` manifest surface so they ride the SAME
flatten → compile → drift scaffold as the other five. Each block declares a
`name`, an `event` (one of the six portable events), a `canonical.command` (the
hook script the harness runs, optionally `matcher`/`timeout`), and
per-harness `targets[{type ∈ {claude, opencode}, method:"merge"}]`.

- **Compile** (`compile_harnesses.sh`, narrows via `--surface hook`): for each
  `(hook, target)` row it dispatches to `igris registry project-hook`, which
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
  shape-parity contract** here the way identity/agents have (no bash hook-shaper
  twin) — `hook-shape.ts` shapes the projector's output and is pinned by a TS-only
  golden in `hook-shape.test.ts`.
- **R2 — refresh-overwrite safety.** A core hook's command lives under
  `$HOME/.igris/core/hooks/shared/`; a personal hook's under
  `$HOME/.igris/registry/hooks/`. `install`/`update`/`doctor --fix` re-merge the
  canonical hooks (`mergeCanonicalHooks` in `cli/src/lib/json-merge.ts`), which
  drops-then-re-applies CORE-prefix groups but PRESERVES the registry-prefix
  personal ones — so a personal hook is never clobbered by a refresh. The
  `IGRIS_PERSONAL_HOOK_CMD_PREFIX` carve-out in `isIgrisEntry` makes this an
  explicit, regression-tested contract (the R2 merge gate).
- **Adding a hook (`igris add hook`, FR-180 D7):** the one-step add verb writes
  the hook script + a `surfaces.hooks[]` block (personal → the registry overlay
  + `~/.igris/registry/hooks/<name>/`; core → `surfaces-manifest.json` +
  `core/hooks/shared/`) then projects + verifies it. `merge_overlay_manifest`
  unions hook blocks (base ++ overlay) with a `name` + `(event, target)` cell
  collision guard.

## Delegation-mechanism surface (boot-injection — TD-244)

The **sixth** adapter surface: the **delegation mechanism**. This is the one
piece of harness-specific behavior that previously had no surface, so it leaked
into a skill (the FR-183 dynamic-define recipe embedded in `/hunt`). TD-244
relocated it here, so skills delegate **abstractly** and the adapter owns the
*how*.

### The adapter boundary (what the adapter owns vs what skills/OS see)

The harness adapter owns every behavior that differs by harness; the OS core and
skills name only **abstract intents**, resolved to a harness-specific mechanism
via **declared manifest config**, never per-skill branching:

| Adapter-owned behavior | Declared in (config) | Compiled/drift-checked by | Abstract intent the skill/OS sees |
|---|---|---|---|
| projection (agents) | `harness-manifest.json` `agents[]` | agents pass | "the named agent's prompt is loadable" |
| skills | `surfaces.skills[]` | skills pass | "the skill is invocable" |
| MCP | `surfaces.mcp_servers[]` | mcp pass | "the brain MCP tools are callable" |
| identity | `surfaces.os_identity[]` | identity pass | "the harness greets as Igris AI" |
| hooks | `surfaces.hooks[]` | hook pass | "the portable event fires the shared script" |
| **delegation mechanism** | `harnesses.<type>.delegation_model` | identity pass (recipe rides the identity region) | **"delegate to role X" resolves on BOTH a native-static and a dynamic-define harness, ZERO per-skill branching** |

### The `delegation_model` descriptor + BI-3 mechanism

`harness-manifest.json` carries a top-level `harnesses` map keyed by harness
`type`, each with a `delegation_model` (`native-static` | `dynamic-define`):

- **`native-static`** (Claude/Codex/OpenCode) — the harness loads Igris agents
  statically; a skill's `subagent_type:<agent>` resolves directly. Nothing extra
  is projected; the identity region stays recipe-free.
- **`dynamic-define`** (Antigravity, and gemini-cli's `GEMINI.md` read-path) —
  the harness can only define subagents at runtime. The compile **identity pass**
  region-merges the canonical delegation recipe
  (`core/templates/delegation-recipe.tmpl`, the companion of `identity.tmpl`,
  living alongside it) into the harness's boot-read identity file, **gated
  strictly on `delegation_model=dynamic-define`**. So the orchestrator is taught
  the read→`define_subagent`→invoke recipe once per session, and a native-static
  harness's identity file (e.g. Codex's `AGENTS.md`) never receives a recipe it
  does not need.

The recipe rides the identity target keyed by `type`, so a harness that reads
another's identity file (Antigravity reads `GEMINI.md`, gemini's target) inherits
the right recipe for free. The mechanism (BI-3) was chosen by a live `agy` marker
probe (L-711): the recipe in `GEMINI.md` is honored at boot, so it rides the
existing identity projection rather than a new SessionStart channel.

- **Compile** (`compile_harnesses.sh`, identity pass): `flatten_identity_rows`
  resolves `delegation_model` per identity-target `type` and emits it as a column;
  `normalize_identity_shape <tmpl> <harness> <version> <delegation_model>
  <recipe>` appends the recipe when `dynamic-define`. A missing recipe template
  for a dynamic-define target is an observable FAIL (L-232), never a silent
  identity-only fallback (that would strand the harness).
- **Drift** (`check_harness_drift.sh`): the SAME identity drift branch re-derives
  the recipe-carrying region via `normalize_identity_shape` and byte-compares — a
  stripped or diverged recipe surfaces as DRIFTED (§17 paired branch).
- **§18.1 parity:** the bash `normalize_identity_shape` dynamic-define branch ↔
  the TS `buildHarnessIdentityFile(..., "dynamic-define", recipeRaw)` /
  `appendDelegationRecipe` (`cli/src/lib/identity-shape.ts`) MUST stay
  byte-identical — the golden `cli/src/__tests__/fixtures/
  td244-identity-golden-gemini-dynamic.md` + the bats `#parity` test pin the two
  (L-554).
- A harness absent from the `harnesses` map defaults to `native-static`
  (identity-only — pre-TD-244 back-compat; existing golden fixtures unchanged).

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

### The two surface kinds (proven against real code)

| Surface | kind | distribution | projection | verification (existing fn) |
|---------|------|--------------|------------|----------------------------|
| **agents** | material | portable-format | **shape-emit** — formats genuinely diverge (Claude MD / Gemini MD / OpenCode MD / Codex TOML); `compile_md_agent_target` translates each | `verify_agents` — per-agent tree-hash + symlink/hardlink-realpath verdict |
| **skills** | material | portable-format | place-in-standard-dir | `verify_skills` — per-skill tree-hash + symlink/wrapper presence |
| **mcp** | material | npx | merge-region | `verify_mcp` — secret-safe per-(mcp,target) compare (`verify_mcp_entry_drift`) |
| **hooks** | material | native-add | merge-region | `verify_hook` — `verify_hook_entry_present` (presence-based MATCH/MISSING) |
| **identity** | material | portable-format | merge-region | `verify_identity` — re-derive via `normalize_identity_shape` + byte-compare the Igris-managed identity region |
| **delegation_model** | **behavioral** | n-a | **inject-at-boot** — the recipe region-merged into the identity file when `dynamic-define` | re-derive via `normalize_identity_shape` + byte-compare (the identity drift branch in `verify_identity`) |

The first five are the **material** shapes (content projected into a per-harness
config/file); the `delegation_model` descriptor is the **behavioral** kind — no
content is distributed, a per-harness behavior is injected at boot. It rides the
same identity pass but is a distinct descriptor — it proves the "two surface
kinds" requirement is real and already in the code, not aspirational.

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
`IGRIS_SURFACE_IDS` (the ids: `agents skills mcp identity hook`) plus the
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
