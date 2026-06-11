---
name: onboard-harness
description: "Onboard a new CLI/IDE harness to Igris across all five surfaces (identity, agents, skills, MCP, hooks) - research how the harness consumes each, wire every integration point, then verify each is live (including that future igris add reaches it)"
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

Make a new harness (`<NEW>`) a **first-class Igris target** so it can use Igris,
and so that *everything Igris already has* — and everything added later via
`igris add` — reaches it automatically. Igris projects **five surfaces**:
**identity, agents, skills, MCP, hooks**. Your job is NOT to bend the harness to
a preset mold — it is to **research how THIS harness wants each surface, wire it,
and verify each is live.**

> ## The non-negotiable principle: research, prove, never assume
>
> Every harness is shaped differently — that is **expected**, not a problem. The
> skill is harness-agnostic; the *research* is what adapts it. So:
>
> 1. **Prove every read-path with a marker test before wiring it.** Do not infer
>    a path from another harness, from docs, or from "it shares a config root."
> 2. **Global scope ≠ project scope.** A surface may be read from one path
>    globally and a *different* path per-project. Determine BOTH for every surface.
> 3. **A shared config root does NOT mean a shared subpath — but Igris can bridge
>    the gap with an install-time symlink.** (Antigravity shares `~/.gemini/` with
>    Gemini, yet reads skills from `~/.gemini/antigravity-cli/skills/`, NOT Gemini's
>    path. Marker-proven (`agy` v1.0.7, 2026-06-11): that dir is NOT antigravity-
>    created, so `igris install` symlinks it → the **global** `~/.agents/skills`
>    (`linkAntigravitySkills`); global skills then DO resolve through the link —
>    FR-179.) The lesson: prove the read-path FIRST, then — if it differs from
>    where Igris already projects — bridge it with an install-time symlink rather
>    than assuming "shared root ⇒ it transfers." Skipping the marker test ships a
>    wrong-but-plausible read-path. Don't.
>
> A wrong-but-plausible read-path is the single most likely failure of this skill.
> The Phase-1 marker protocol exists to make it impossible.

## Arguments

`$ARGUMENTS` = the new harness name, lowercase (e.g. `cursor`, `windsurf`,
`antigravity`). If empty, ask the operator which harness to onboard.

---

## Phase 0 — Reconnaissance (non-destructive)

Establish the ground truth the rest depends on. **Branch early** — not every
harness is a clean headless CLI:

1. **Install + locate the binary.** How is `<NEW>` invoked? Where does its CLI
   live? Is it a standalone CLI, or an IDE with a CLI companion?
2. **Auth gate? (BRANCH — the operator may be required.)** Run a trivial command
   (`<NEW> models`, `<NEW> --version`). If it demands sign-in
   (e.g. interactive OAuth), **STOP and ask the operator to sign in** — you
   cannot complete an interactive login, and most surfaces (and the config root)
   don't materialize until first sign-in. Resume Phase 0 only after they confirm.
3. **Locate the config root(s).** After sign-in, find where `<NEW>` actually
   persists config — search `~/.<NEW>`, `~/.config/<NEW>`,
   `~/Library/Application Support/*`, and **watch for a SHARED root** (e.g. find
   what the first run just wrote: `find ~ -newer <marker> -name '*<NEW>*'`). A
   harness may live inside *another* harness's root with its own subdir.
4. **Headless mode (BRANCH — GUI-first harnesses).** Confirm a non-interactive
   invocation (`<NEW> -p "…"` / `--print` / `exec`). Close stdin (`</dev/null`)
   — some CLIs hang otherwise. If the harness is **IDE-only with no headless
   mode**, that is itself a finding: document how projection + verification work
   for a GUI-first harness (you may need the operator to drive the GUI for the
   live checks) before proceeding.

Phase 0 output: binary path, auth model, the config root(s), and the headless
invocation. Nothing is wired yet.

---

## Phase 1 — Per-surface empirical read-path discovery (the rigorous core)

For **each** of the five surfaces, PROVE — by marker test — where `<NEW>` reads
it from, **at both global and project scope**, and in what format. This is the
table that drives every wiring decision in Phase 2. **Do not skip a surface
because you "know" the answer from another harness.**

### The marker protocol (apply per surface, per scope)

1. **Enumerate candidate paths** for this surface at this scope (global: the
   config root, `~/.agents/*`, home-level files; project: the project root,
   `<proj>/.<NEW>/*`, project-root context files).
2. **Drop a uniquely-named marker artifact** in each candidate (a skill named
   `igrisprobeXXXX`, an agent, an MCP server, a hook, or an identity line with a
   unique token).
3. **Run `<NEW>` headless** and observe which candidate it actually loaded —
   enumerate (`<NEW> agent list` / plugin list) or elicit (`<NEW> -p "what are
   your custom rules / available tools / subagents?"`; for identity, the TD-233
   A/B: `-p "who are you?"` and check the token surfaces).
4. **Record the winning path + format. Tear the marker down.**
5. **Repeat at the other scope** — never assume global and project share a path.

### The five surfaces to resolve

| Surface | What you must prove (global AND project) | Format to capture |
|---|---|---|
| **Identity** | which context file is auto-read for orchestrator identity (project-root? home-level "global customizations root"?) | filename + region-merge vs whole-file |
| **Agents** | does it read a subagent/agent dir? does the loader **follow symlinks** (→ symlink primitive) or NOT (→ hard-link, like Gemini)? | dir name (singular/plural), frontmatter shape, tool-name map |
| **Skills** | the native command/skill dir it loads from (often differs global vs project) | dir + format (file? command wrapper? plugin?) |
| **MCP** | the MCP config file it reads + the native entry shape | path + entry shape (see Phase-2 #5 for the 4 known shapes) |
| **Hooks** | is there an event/hook API at all? (some harnesses have none — that's a documented N/A, not a gap) | event names + bridge mechanism, or "none" |

Phase 1 output: a **proven read-path + format table** for all five surfaces, at
both scopes. If a surface is genuinely unsupported, record it as a deliberate
**documented N/A** (the Gemini-has-no-hooks precedent), not a silent gap.

---

## Phase 2 — Wire the 10 integration points

A harness is only "connected" when it is a member at **every** point below — not
just the five projections. Each names the **authoritative file** (line numbers
drift → `(currently ~L…)` hints) and a **cheap self-verify**. The worked
reference is `opencode` (FR-171); the auth-gated / shared-root reference is
`antigravity`. **Each wiring decision is driven by the Phase-1 proven table — never by assumption.**

### 1 — CLI catalog
`cli/src/types.ts` — add `"<NEW>"` to the `CLITarget` union (the union *is* the
catalog; there is no `CLI_CATALOG` symbol). Verify: `grep -q '"<NEW>"' cli/src/types.ts`.

### 2 — Surface targets (manifest)
`core/scripts/cli-adapters/manifest.schema.json` — add `"<NEW>"` to the agent +
skills `targets[].type` enums and a skills `oneOf {type,method}` branch; mirror
the `(type, method)` pair into `_common.sh validate_manifest` `valid_pairs` AND
`cli/src/verbs/registry.ts` `VALID_SKILL_TYPE_METHOD_PAIRS`. Then **declare the
targets** at the Phase-1-proven paths: agents → `harness-manifest.json`
(core) + the personal overlay; skills/mcp/identity → `surfaces-manifest.json` /
`harness-manifest.json` per surface. Verify: `igris harness compile --surface all`
does not schema-reject.

### 3 — Compile + drift arms (§18.1 dual-impl — parity MANDATORY)
`compile_harnesses.sh` **and** `check_harness_drift.sh` (and the TS halves in
`registry.ts`): add the `<NEW>` agent + skills dispatch arms; the agent **emit
primitive** (symlink if the Phase-1 loader follows symlinks, else hard-link); the
bash `assemble_<NEW>_harness_into_registry` α-assembler + python translator AND
the TS `assemble<New>Harness` + `CLAUDE_TO_<NEW>_TOOLS` — **byte-identical**,
pinned by a golden-fixture parity test. **Every compile branch gets a matching
drift branch** (a divergence means `check` reports DRIFTED right after a clean
`compile`). TD-096-mirror every `core/` file. Verify: `igris harness compile --target <NEW>`
then `igris harness check` is **drift-CLEAN**.

### 4 — `igris add` participation (the future-proofing — VERIFY, don't assume)
There is **no separate step** to wire `<NEW>` into `igris add` — it is an
*automatic consequence* of #2 + #3, because `igris add <surface>` runs
`harness compile --surface <surface>` over every declared target. **But it must
be verified** (the old skill never did): once `<NEW>` is a target + arm, a future
`igris add skill foo` projects `foo` to it. The Phase-3 future-add loop proves
this. If it doesn't reach `<NEW>`, a target (#2) or arm (#3) is missing.

### 5 — MCP registration
`cli/src/lib/mcp-shape.ts` (`buildHarnessMcpEntry`), `mcp-register.ts`
(`ALL_HARNESSES`), `paths.ts` (the harness's MCP config path from Phase 1). Add
the harness's native MCP entry shape — the four known shapes:
- Claude `mcpServers.<n>` / `{type:"stdio", command, args[], env{}}` (`${VAR}`)
- Gemini `mcpServers.<n>` / `{command, args[], env{}}` no-type (`${VAR}`)
- OpenCode `mcp.<n>` / `{type:"local", command:[cmd,...args], enabled, environment{}}` (env `{env:VAR}`)
- Codex `[mcp_servers.<n>]` / `{command, args[], startup_timeout_sec?, [.env]}` (env = resolved literals)

So `igris install` registers the brain MCP for `<NEW>`. Verify:
`grep -q '<NEW>' cli/src/lib/mcp-register.ts && npm --prefix cli run build`.

### 6 — Install / materialize path
`cli/src/verbs/init.ts` / `install.ts` — ensure `igris install <project>`
materializes `<NEW>`'s per-project artifacts (identity file, per-project links)
at the Phase-1-proven project-scope paths. Verify: a fresh `igris install` into a
scratch project lands `<NEW>`'s artifacts.

### 7 — Runtime config (DESCRIPTIVE only)
`~/.igris/config.json` → `cli_targets.<NEW>` = `{method, target, note, hooks}`.
**`target`/`method` are human-readable labels — NOT read by projection** (only
`bridge-missing.ts` presence-checks the top-level key). Verify:
`jq '.cli_targets.<NEW>' ~/.igris/config.json` parses.

### 8 — Hooks bridge
`core/hooks/bridges/<NEW>/` — route the harness's event API (Phase 1) to
`~/.igris/core/hooks/shared/*.sh`. If Phase 1 found **no hook API**, this is a
documented N/A (the Gemini precedent) — record it, don't fake it.

### 9 — Orchestrator identity (os_identity — TD-233)
`harness-manifest.json` → `surfaces.os_identity[]`, `core/templates/identity.tmpl`,
and the §18.1 shape pair `_common.sh::normalize_identity_shape` ↔
`cli/src/lib/identity-shape.ts`. Add the Phase-1-proven identity target
`{type:"<NEW>", method:"file", filename:"<proven>.md"}`. **If `<NEW>` already
reads a file another harness writes** (e.g. Antigravity reads project-root
`AGENTS.md` — same as Codex), add **NO new target**: it rides the existing one
for free — record that finding. Add the harness's Model-A `{{HARNESS_SELF_NAME}}`
to **both** `SELF_NAMES` (bash) and `HARNESS_SELF_NAMES` (TS), byte-identical. The
compile pass **region-merges** between the `IGRIS:OS_IDENTITY` markers — never
whole-file-overwrite. Verify: `igris harness compile --surface identity` →
`OK identity/<NEW>`; `check` → MATCH; **live**: `<NEW> -p "who are you?"` → "Igris AI".

### 10 — Permissions (OPERATOR-GATED — Igris cannot self-apply)
The harness must let the operator call the Igris MCP tools without a per-call
prompt — but **the harness security model correctly forbids an agent from
editing its own permission allow-list** (proven: Claude's classifier blocks it as
self-modification). So this step is **operator-applied, never silent**: identify
the harness's permission mechanism (Phase 1) — Claude `settings.json
permissions.allow` (`mcp__igris-brain__*`, `mcp__igris-ai__*`); others have
`--dangerously-skip-permissions` / their own allow config — and either (a) have
`igris install` write it *as part of the install the user consents to*, or
(b) **emit the exact change for the operator to apply** (`/permissions`, or the
file edit). Verify: an Igris MCP call on `<NEW>` does not prompt.

### Tests + docs (spans the above)
`test/harness_*.test.bash`, `cli/src/__tests__/harness-registry.test.ts`,
`docs/multi-cli.md` (Supported-CLIs + Subagent-Distribution tables + the method
matrix). Add `<NEW>` to the N-harness bats matrix + the golden-parity vitest
(+ identity-shape golden if #9 added a self-name). Verify:
`npm --prefix cli test` + `bats test/harness_*.test.bash` green.

---

## Phase 3 — Verify (per-surface live + the future-add guarantee)

Two gates. The first proves *today's* surfaces reach `<NEW>`; the second proves
*tomorrow's* do.

```bash
# (A) Nothing dropped + everything LOADS (fresh process — L-256):
igris harness compile && igris harness check        # must be drift-CLEAN
<NEW> agent list                                    # Igris agents present (or harness equivalent)
<NEW> -p "who are you?"                              # greets as "Igris AI" (the GAP-3 identity proof)

# (B) The future-add guarantee — the thing the old skill lacked:
for s in skill agent mcp identity hook; do
  igris add "$s" "igrisprobe_$s"        # add a throwaway surface
  # → assert it landed in <NEW>'s Phase-1-proven read-path for that surface
  igris archive/remove "igrisprobe_$s"  # teardown
done
```

- `check` DRIFTED/MISSING after a clean compile → a Phase-2 point was dropped; the
  verdict names the harness + surface → trace it back.
- `agent list` missing agents → recheck #3's emit primitive (symlink vs hard-link)
  against the Phase-1 loader finding (the classic failure: a symlink into a loader
  that doesn't follow symlinks).
- The future-add loop fails to reach `<NEW>` → #2 (target) or #3 (arm) is incomplete.

Onboarding is **done** only when both gates pass and every Phase-1 N/A is
documented in `docs/multi-cli.md`.

---

## Why this works

This skill is a **standard core skill** under `core/skills/`, projected to all
harnesses via the single core skills block in `surfaces-manifest.json` — a
self-demonstrating artifact: it reaches each harness by the exact mechanism it
documents. It is **research-first by design**: the harness-specific shape is an
*input* to Phase 1, never an assumption baked into the steps — which is what lets
it onboard a clean CLI (opencode), an auth-gated GUI-first harness on a shared
config root (antigravity), or whatever comes next, without "breaking."

**Cross-links:** `docs/multi-cli.md` § "Add a New Harness" is the canonical *why*
(the harness abstraction + five-surface model). **FR-171** (OpenCode) and
**FR-179** (Antigravity — auth-gated, shared `~/.gemini` root, AGENTS.md identity
ride) are the worked references. The unified one-step `igris add <surface>` front
door (#4) is documented in `core/docs/ADD-SURFACES.md`.
