# CLI Adapters

Scripts that distribute Igris surfaces to non-Claude CLIs. Two distinct
families live here — do not conflate them.

## Skills adapters (FR-103)

Turn `~/.igris/core/skills/` into per-CLI skill artifacts.

| Script | Contract | Output |
|--------|----------|--------|
| `md_to_agents_md.sh` | `md_to_agents_md.sh <output-agents-md> [skills-root]` | One aggregated `AGENTS.md` for Codex (32KB cap). |
| `md_to_gemini_toml.sh` | `md_to_gemini_toml.sh <input-skill-md> <output-toml>` | One per-skill Gemini command TOML. |

Adapter contract for new skills adapters: see
`docs/multi-cli.md` § "How to Add a New CLI Adapter".

## Subagent adapters (TD-021)

Regenerate per-agent harness files from a single canonical agent prompt.
Canonical is the **sole source of truth**; every harness file is GENERATED —
editing one directly is a process error.

| Script | Contract | Output |
|--------|----------|--------|
| `sync_claude_agents.sh` | `sync_claude_agents.sh <canonical-md> <output-harness-md> [body-exception-json]` | A `.claude/agents/<name>.md` whose body is the canonical body; harness frontmatter is preserved. The harness file must already exist. |
| `sync_codex_agents.sh` | `sync_codex_agents.sh <canonical-md> <output-toml> [agent-name]` | A `.codex/agents/<name>.toml` (3 keys: `description`, `developer_instructions`, `name`). Live emit path (D1 RESOLVED — REIMPLEMENT, FR-138). `--d1-reimplement` is a deprecated, accepted no-op. |
| `compile_harnesses.sh` | `compile_harnesses.sh --project-root <dir> [--manifest <p>] [--filter <glob>] [--target claude\|codex\|all]` | Orchestrates: reads the manifest, runs the per-target adapter for every agent/target. |
| `check_harness_drift.sh` | `check_harness_drift.sh --project-root <dir> [--manifest <p>] [--filter <glob>]` | CI-style guard — exit 1 if any harness body sha / version marker has drifted from canonical. |

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
between a harness body and the canonical body — an `anchor` line plus an
`insert` paragraph list. A manifest entry opts in via `"body_exception":
"<name>"`. Both `sync_claude_agents.sh` and `check_harness_drift.sh` honor it.
Currently one exists: `designer-harness-skill-para` (DESIGNER's harness-skill
invocation note).

### Decision D1 — codex wrap vs reimplement (RESOLVED — REIMPLEMENT, FR-138)

`sync_codex_agents.sh` once faced Decision D1: whether to WRAP the codex CLI's
native agent-import command or REIMPLEMENT the TOML emit. FR-138 RESOLVED it in
favor of REIMPLEMENT — the script emits the fully-specified 3-key codex
subagent TOML directly, as the live default path (no opt-in flag required). The
former `--d1-reimplement` flag / `IGRIS_CODEX_D1=reimplement` env opt-in are
retained only as deprecated, accepted no-ops for back-compat. A WRAP variant
remains possible behind a future `--d1-wrap` flag if codex's import is ever
found scriptable + idempotent.

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
