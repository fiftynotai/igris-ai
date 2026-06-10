---
name: onboard-harness
description: "Onboard a new CLI harness to Igris across all five surfaces (agents, skills, MCP, hooks, identity) - walks the FR-171 contract step by step with self-verification"
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

# ONBOARD-HARNESS - Add a new CLI harness to Igris

Onboard a new CLI harness (`<NEW>`) as a first-class Igris target across the
**five surfaces** — agents, skills, MCP, hooks, orchestrator-identity. This is
the executable companion to the docs runbook at `docs/multi-cli.md` § "Add a New
Harness (the five-surface runbook)" — the doc is the *why*, this skill is the *do*.

Work top-to-bottom. Each step names the **authoritative file** (and a symbol or
section anchor — line numbers shift, so they are `(currently ~L…)` hints only)
and verifies itself where the check is cheap. **A dropped touchpoint is CAUGHT
by the verify, not assumed.** The worked example throughout is `opencode`
(FR-171, the most recent harness onboarded end-to-end).

## Arguments

`$ARGUMENTS` = the new harness name (lowercase, e.g. `cursor`, `windsurf`).
If empty, ask the operator which harness to onboard before proceeding.

## Phase 0 — PROBE the harness loader FIRST (non-destructive)

Before touching any source: **probe** the new harness's loader against a
**throwaway HOME** — never the real config. The emit primitive (symlink vs
hardlink) and the directory names are chosen FROM these probe results, not
assumed:

- **Agent dir** — `agent/` vs `agents/` (singular vs plural)? Does the loader
  **follow symlinks** (→ symlink primitive, like Claude/Codex/OpenCode) or NOT
  (→ hard-link primitive, like Gemini per TD-208)?
- **Command/skill dir** — what native surface does the harness read skills from?
- **Frontmatter key shape** — boolean tools-map? flow-list? PascalCase vs
  lowercase tool names?
- **MCP-permission key shape** — how does the harness reference an MCP server in
  agent frontmatter (e.g. `mcp__<server>__*`)?
- **Identity filename** — which context file does the harness **auto-read for
  orchestrator identity**, and is it project-root or home-level? Drop a unique
  marker into a candidate file (`CLAUDE.md`? `GEMINI.md`? `AGENTS.md`? a
  home-level path?), run a fresh headless `"who are you?"`, confirm the marker
  surfaces, then tear the temp file down (the TD-233 A/B method).

Probe by writing sentinel files under `HOME=$(mktemp -d)` and running the
harness's `agent list` / command-enumerate against it. See **FR-171 plan §1**
(`~/.igris/projects/igris-ai/plans/FR-171-plan.md`) for the exact probe scripts.
Record each finding — the table below shows which step consumes it.

| Probe finding | Feeds step |
|---------------|------------|
| Honored agent dir + symlink-vs-hardlink | Step 5 emit primitive + Step 3 manifest `path` |
| Honored command/skill dir | Step 4 surfaces target + Step 7 config + Step 8 drift path |
| Frontmatter + tools-map shape | Step 5 α-assembler / tool translator |
| MCP-permission key shape | Step 2 + Step 5 permission-block emission |
| Honored identity filename (project-root vs home-level) | Step 9 `os_identity` target (`filename`) + drift path |

## The 10-step checklist

Each step: **authoritative file**, the **per-harness branch point** (what you add
for `<NEW>`), and a **cheap self-verify** that fails loudly if the touchpoint was
dropped. Run the verify after each edit; do NOT batch-skip them.

### Step 1 — Type / CLI catalog

- **Authoritative file:** `cli/src/types.ts` — the `CLITarget` union
  `(currently ~L107)`. There is no symbol literally named `CLI_CATALOG`; the
  `CLITarget` union **is** the catalog.
- **Add:** `"<NEW>"` to the `CLITarget` union.
- **Self-verify:** `grep -q '"<NEW>"' cli/src/types.ts`

### Step 2 — MCP surface

- **Authoritative files:** `cli/src/lib/mcp-shape.ts` (`buildHarnessMcpEntry`),
  `cli/src/lib/mcp-register.ts` (`ALL_HARNESSES` `(currently ~L780)`,
  `registerBrainAcrossHarnesses` `(currently ~L809)`), `cli/src/lib/paths.ts`
  (the harness config-file path).
- **Add:** the harness's **native MCP entry shape** to `buildHarnessMcpEntry`;
  `"<NEW>"` to `ALL_HARNESSES`; its config-file path to `paths.ts`. The four
  native shapes already documented in `docs/multi-cli.md` § "four native
  per-harness shapes":
  - Claude `mcpServers.<name>` / `{type:"stdio", command, args[], env{}}` (`${VAR}`)
  - Gemini `mcpServers.<name>` / `{command, args[], env{}}` no-type (`${VAR}`)
  - OpenCode `mcp.<name>` / `{type:"local", command:[cmd,...args], enabled, environment{}}` — command+args **fused**, env key is `environment`, values `{env:VAR}`
  - Codex `[mcp_servers.<name>]` / `{command, args[], startup_timeout_sec?, [.env]}` — env values are **resolved literals** from `~/.igris/secrets.env`
- **Self-verify:** `grep -q '<NEW>' cli/src/lib/mcp-register.ts && npm --prefix cli run build`

### Step 3 — Manifest schema enums + manifests

- **Authoritative file:** `core/scripts/cli-adapters/manifest.schema.json`.
- **Add:**
  - `"<NEW>"` to the **agent** `targets[].type` enum `(currently ~L205)`.
  - `"<NEW>"` to the **skills** `targets[].type` enum `(currently ~L100)`.
  - a skills `oneOf` branch `{type:const <NEW>, method:const <chosen>}`
    `(currently ~L107–113)`.
  - the same `(type, method)` pair into `valid_pairs` in `_common.sh`
    `validate_manifest`, AND `VALID_SKILL_TYPE_METHOD_PAIRS` in
    `cli/src/verbs/registry.ts`.
  - Then **declare targets**: `harness-manifest.json` (7 core agents),
    `~/.igris/registry/harness-manifest.personal.json` (personal agents),
    `surfaces-manifest.json` (skills — see Step 4).
- **Self-verify:** `igris harness compile --surface all` (no schema-rejection),
  and `grep -c '"type": "<NEW>"' harness-manifest.json`.

### Step 4 — Core skills surface

- **Authoritative file:** `core/scripts/cli-adapters/surfaces-manifest.json` —
  the core skills block `targets[]` `(currently ~L11–14)`.
- **Add:** `{type:<NEW>, method:<chosen>, path:<dir>}` to the core block.
- **Self-verify:** `grep -q '<NEW>' core/scripts/cli-adapters/surfaces-manifest.json`

### Step 5 — Compiler passes (dual-implemented — §18.1 parity MANDATORY)

- **Authoritative files:** `core/scripts/cli-adapters/compile_harnesses.sh`
  **and** `cli/src/verbs/registry.ts`.
- **Add:**
  - (a) agent dispatch: a `<NEW>)` arm to `case "$ttype" in`
    `(currently ~L1360; model on the opencode arm ~L1385)`.
  - (b) skills dispatch: the `<NEW>/<method>)` arm to
    `case "$s_type/$s_method" in` (currently ~L1561; model on the
    `opencode/command` arm ~L1696).
  - (c) the per-harness agent **emit primitive** — **symlink** if the loader
    follows symlinks (Phase 0), else **hard-link** like Gemini.
  - (d) the **bash compile-side α-assembler** `assemble_<NEW>_harness_into_registry`
    (the CORE-agent path) + the inline `python3` frontmatter/tool translator.
  - (e) the **TS vendor-side α-assembler** `assemble<New>Harness` in
    `registry.ts` + `CLAUDE_TO_<NEW>_TOOLS`, wired into the 4 vendor sites (the
    PERSONAL-agent path).
  - (f) the bash translator and the TS translator are **§18.1 dual-impl** →
    **byte-identical**, pinned by a golden-fixture parity test.
- **Self-verify (after mirror):** `igris harness compile --target <NEW>` runs
  clean; `grep -q '<NEW>' ~/.igris/core/scripts/cli-adapters/compile_harnesses.sh`
  (proves the runtime mirror is fresh).

### Step 6 — Hooks / bridge

- **Authoritative dir:** `core/hooks/bridges/<NEW>/` (e.g. OpenCode's
  `opencode/igris-bridge.ts` TS plugin, Codex's `codex-notify.sh` wrapper).
- **Add:** the harness's event bridge routing the portable events to
  `~/.igris/core/hooks/shared/*.sh`. Some harnesses (Gemini) have **no hook
  API** → the bridge is a documented no-op, NOT a missing touchpoint.
- **Self-verify:** bridge file present + loadable; run
  `bash test/igris_hooks_sync.test.bash` if a fixture is added.

### Step 7 — Runtime config (DESCRIPTIVE only)

- **Authoritative file:** `~/.igris/config.json` → `cli_targets.<NEW>`.
- **Add:** `{method, target, note, hooks}`.
- **CRITICAL:** `target` and `method` here are **descriptive labels — NOT read
  by the projection.** The actual projection paths come from the manifests
  (Steps 3–4). `cli_targets` does not appear in the bash adapters at all; only
  `bridge-missing.ts` reads its **top-level keys** (presence-check). Keep the
  block honest for human readers, but never expect editing `.target` to change a
  projection path.
- **Self-verify:** `jq '.cli_targets.<NEW>' ~/.igris/config.json` parses.

### Step 8 — Drift checker (must mirror compile line-for-line — L-519 §18.1)

- **Authoritative file:** `core/scripts/cli-adapters/check_harness_drift.sh`.
- **Add:**
  - (a) `<NEW>` to the agent verdict gate `[ "$ttype" = ... ]` chain
    `(currently ~L966)`.
  - (b) the agent verdict per-harness `(currently ~L1714)`.
  - (c) the skills drift branch mirroring the compile arm
    (currently ~L1592, model on `opencode/command`).
  - Drift MUST mirror the compile emit (L-519 §18.1) — a divergence here means
    `check` reports DRIFTED immediately after a clean `compile`.
- **Self-verify (after mirror):** `igris harness check` is **drift-CLEAN**
  immediately after a `compile` — the definitive "no touchpoint dropped"
  assertion.

### Step 9 — Orchestrator-identity surface (os_identity — TD-233)

- **Authoritative files:** `harness-manifest.json` → `surfaces.os_identity[]`
  (the repo-root manifest, NOT `surfaces-manifest.json` — the identity block is
  gated on the runtime-mirror commonpath like agents), canonical template
  `core/templates/identity.tmpl`, and the §18.1 shape pair
  `_common.sh::normalize_identity_shape` ↔ `cli/src/lib/identity-shape.ts`.
- **Add:**
  - (a) the Phase-0-confirmed identity filename as a target:
    `{type:"<NEW>", method:"file", filename:"<probed>.md"}` in the
    `surfaces.os_identity[].targets` array. **If the probe shows the harness
    already auto-reads `CLAUDE.md`** (like OpenCode — A/B-proven by TD-233's
    Phase 0), add NO target: it rides the existing CLAUDE.md identity region.
    Record that finding instead.
  - (b) the harness's **Model-A self-name** (`{{HARNESS_SELF_NAME}}` token, e.g.
    `"opencode": "OpenCode"`) to **BOTH** the `SELF_NAMES` map in
    `_common.sh::normalize_identity_shape` AND `HARNESS_SELF_NAMES` in
    `cli/src/lib/identity-shape.ts` — they MUST stay byte-identical (§18.1;
    the golden-fixture parity test pins them).
  - The compile pass **region-merges** the rendered block between the
    `IGRIS:OS_IDENTITY` markers — user content outside the region is preserved;
    never whole-file-overwrite an identity file.
- **Self-verify:** `igris harness compile --surface identity` emits an
  `OK identity/<NEW>` row; `igris harness check` reports the identity artifact
  as MATCH; then prove it loads **LIVE in a fresh process** (L-256):
  `<NEW> -p "who are you?"` (or the harness's headless equivalent) answers as
  **Igris AI** — the GAP-3 probe. A harness that greets as itself means the
  filename or the self-name mapping is wrong; recheck the Phase-0 probe.

### Step 10 — Tests + docs

- **Authoritative files:** `test/harness_*.test.bash` (incl.
  `test/harness_identity.test.bash`),
  `cli/src/__tests__/harness-registry.test.ts`, `docs/multi-cli.md`.
- **Add:**
  - `<NEW>` to the 4→N-harness bats matrix (agent projection, skill/command
    projection, drift-clean-after-compile, tool-mapping bytes, count parity,
    refuse-to-clobber, schema validation, identity region-merge if Step 9
    added a target).
  - the vitest `assemble<New>Harness` + golden-fixture parity tests (and an
    identity-shape golden fixture if Step 9 added a self-name).
  - `<NEW>` to the `docs/multi-cli.md` Supported-CLIs + Subagent-Distribution
    tables + the per-harness method matrix in the "Add a New Harness" runbook.
- **Self-verify:** `npm --prefix cli test` + `bats test/harness_*.test.bash` green.

## Closing self-verify gate (the skill's payoff)

The single command that catches a dropped touchpoint across all surfaces:

```bash
# Drift-clean-after-compile is the definitive "nothing dropped" assertion:
igris harness compile && igris harness check   # must be drift-CLEAN

# Then prove the harness actually LOADS (fresh process — L-256):
<NEW> agent list   # or the harness's equivalent enumerate command

# And that the orchestrator identity landed (Step 9 — the GAP-3 probe):
<NEW> -p "who are you?"   # must greet as "Igris AI" (Model A)
```

- If `igris harness check` reports **DRIFTED / MISSING** after a clean compile,
  a step above was dropped — the verdict **names the harness + surface**, so
  trace it back to the matching checklist step.
- If the new harness's `agent list` is **missing agents**, recheck Step 5's emit
  primitive (symlink vs hard-link) against the Phase-0 probe — the most common
  failure is targeting a loader that does not follow symlinks with a symlink.

## Why this works

This skill is a **framework-dev skill** — project-scoped to the igris-ai repo via
a `scope.paths:["."]` block in `surfaces-manifest.json` (TD-224, FR-155), and it
projects to all four harnesses by the exact mechanism it documents WHEN compiled
from inside the igris-ai checkout. A self-demonstrating artifact: it emits only
where it is meaningful (the framework repo itself) and is a silent scope-skip
everywhere else.

**Cross-link:** `docs/multi-cli.md` § "Add a New Harness" is the canonical *why*
(the harness abstraction + the five-surface model). **FR-171** (OpenCode
agents+skills) is the worked reference — the most recent harness to walk this
exact contract end-to-end.
