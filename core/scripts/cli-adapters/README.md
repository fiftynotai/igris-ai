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

## Mirror obligation (TD-096)

Every file in this directory lives under `core/` and is part of the runtime
mirror set. After editing any file here in the repo, copy it to the matching
`~/.igris/core/scripts/cli-adapters/` path and verify with
`~/.igris/core/scripts/verify_mirror.sh`.
