# Multi-CLI Support

**Briefs:** FR-103 (Skill Distribution), FR-104 (Hook Bridge Layer)
**Status:** Stable
**Last Updated:** 2026-05-24

Igris skills and hooks live canonically under `~/.igris/core/`. This document defines
how those surfaces are distributed to multiple CLI agents (Claude Code, OpenCode,
Gemini CLI, Codex CLI) via filesystem routing — no duplication, no drift.

Two independent axes of coverage:

- **Skills Distribution** (FR-103) — canonical skills in `~/.igris/core/skills/` shipped
  per-CLI via symlink / converter / compiler / none. See [Skills](#skills-distribution)
  below.
- **Hook Coverage** (FR-104) — shared bash hooks in `~/.igris/core/hooks/shared/`
  routed through per-CLI bridges. See [Hook Coverage](#hook-coverage) below.

Both axes use the same `cli_targets` block in `~/.igris/config.json` and the same
`--cli=<list>` flag. An orthogonal `--include=<list>` flag controls which surfaces
ship (defaults to `all`).

---

## Skills Distribution

---

## Supported CLIs

| CLI | Method | Target | Notes |
|-----|--------|--------|-------|
| Claude Code | `symlink` | `~/.claude/skills/` | Each registry-vendored skill (`~/.igris/registry/skills/<name>/`) becomes a symlink at `~/.claude/skills/<name>/`. The compiler emits the symlink from `<target_path>` to the registry-vendored copy — first-class projection on par with codex/gemini (FR-149, see L-519). Core skills live at `~/.igris/core/skills/` and follow the same mechanism. Full directory linked so nested assets (`scripts/`, `workflow-template.md`, `templates/*.md`) are available. |
| OpenCode | `none` | `~/.config/opencode/` | No-op. OpenCode reads `~/.claude/skills/` natively as a fallback; the Claude-side symlinks cover it. Flip `method: "symlink"` in `~/.igris/config.json` if a future OpenCode version stops falling back. |
| Gemini CLI | `symlink` | `~/.gemini/skills/` | Per-skill symlink at `~/.gemini/skills/<name>/` → registry-vendored canonical (FR-153 — unified onto the FR-149 claude/symlink primitive). Full directory linked. |
| Codex CLI | `symlink` | `~/.codex/skills/` | Per-skill symlink at `~/.codex/skills/<name>/` → registry-vendored canonical (FR-153 — unified onto the FR-149 claude/symlink primitive). Symlink target MUST be absolute (codex resolves relative-path symlinks from cwd). |

---

## Configuration

`~/.igris/config.json` has a top-level `cli_targets` block controlling distribution:

```json
{
  "cli_targets": {
    "claude":   { "method": "symlink", "target": "~/.claude/skills/" },
    "opencode": { "method": "none",    "target": "~/.config/opencode/" },
    "gemini":   { "method": "symlink", "target": "~/.gemini/skills/" },
    "codex":    { "method": "symlink", "target": "~/.codex/skills/" }
  }
}
```

Each entry supports:
- `method` — one of `symlink`, `none` (the legacy `converter` / `compiler`
  methods were retired by FR-153 along with their adapter scripts)
- `target` — output path (tilde-expanded, relative paths resolve from project root at sync time)
- `note` — human-readable intent, for maintainers

> **Scope of `cli_targets`:** this block governs **SKILLS distribution only** —
> turning `~/.igris/core/skills/` into per-CLI skill artifacts. It does **not**
> govern per-agent subagent prompts. Subagent distribution is a separate layer
> — see [Subagent Distribution](#subagent-distribution) below (TD-021). The
> optional `codex.agents` sub-block (added by TD-021) describes the subagent
> surface.

### Skills as a `surfaces.skills` manifest declaration (FR-137 → FR-153)

As of FR-137 the skill projection logic lives inside the FR-136 manifest-driven
harness engine as first-class `surfaces.skills` targets — projected (and
drift-checked) by `igris harness compile` / `igris harness drift`, exactly the
way per-agent harnesses are. **FR-153** then unified all three harnesses
(claude/codex/gemini) onto the same per-skill registry-anchored symlink
projection that FR-149 established for claude, and **retired** the legacy
`md_to_agents_md.sh` (AGENTS.md aggregator) + `md_to_gemini_toml.sh` (per-skill
TOML converter) scripts entirely.

The core skills surface is declared once, globally, in the core-owned
`core/scripts/cli-adapters/surfaces-manifest.json`:

```json
{
  "version": 1,
  "agents": [],
  "surfaces": {
    "skills": [
      {
        "source": "~/.igris/core/skills",
        "layer": "core",
        "targets": [
          { "type": "claude", "method": "symlink", "path": "~/.claude/skills" },
          { "type": "codex",  "method": "symlink", "path": "~/.codex/skills" },
          { "type": "gemini", "method": "symlink", "path": "~/.gemini/skills" }
        ]
      }
    ]
  }
}
```

The compiler walks each `<skill>/SKILL.md` under `source` and emits one symlink
per skill at `<path>/<name>` → `<source>/<name>` — same shape for claude,
codex, and gemini.

Post-TD-191 `surfaces.skills` is an ARRAY of `{source, layer, targets}` blocks
(was a single object pre-TD-191; legacy single-object manifests normalize to a
1-element array on read — no schema version bump). Each block compiles its own
source independently; personal blocks coexist alongside core. See L-519
(Igris-owned topology — per-harness compilers inside Igris OS project each
block to its own targets) and the array schema at
`core/scripts/cli-adapters/manifest.schema.json`.

- `source` — skills root (`{name}/SKILL.md` entries). `~`/absolute paths are
  used verbatim; a relative path resolves from `--project-root`.
- `targets[].method` — post-FR-153 the only valid `(type, method)` pairs are
  `claude/symlink`, `codex/symlink`, `gemini/symlink`. All three are
  first-class projection targets — the symlink IS the projection, anchored
  at the registry-vendored copy (FR-149/FR-153). An invalid pair (e.g.
  `claude/compiler`, `codex/compiler`, `gemini/converter`) is rejected at
  schema validation.
- **Codex absolute-path enforcement (FR-153 D2):** codex resolves relative-
  path symlinks from cwd (POSIX-incorrect — observed behavior). The
  compiler hard-fails when a codex symlink target would be relative;
  drift-verify flags any literal-relative codex symlink as DRIFTED.
- The drift guard verdicts each per-skill symlink by realpath against the
  registry-vendored canonical (L-515 containment), pairing line-for-line
  with the compile-side branch (L-519 §18.1). No more date-stamped marker
  stripping — the symlink IS the projection, so date drift is impossible.
- `igris harness compile --surface skills` projects only the skills surface;
  `--target codex|gemini|claude` narrows to one harness.

The core `surfaces-manifest.json` declares **global Layer-1** skills and is only
unioned when the project being compiled owns it (its realpath is under
`--project-root`) — so core skills never leak into an unrelated project's
projection. A project may also carry its own `surfaces.skills` in its
`harness-manifest.json` for project-specific skills.

**FR-139 overlay seam (post-TD-191).** A consumer's **personal** skills arrive
via the FR-139 overlay (`~/.igris/registry/harness-manifest.personal.json`),
which carries its own `surfaces.skills` array — typically one block per
personal-skill source written by `igris registry add-skill` (per L-516,
copy-vendored to `~/.igris/registry/skills/<name>/`; per L-517, typed
subfolder layout). `merge_overlay_manifest` **concatenates** the base
`surfaces.skills[]` with the overlay `surfaces.skills[]` — overlay blocks
coexist alongside base blocks (NOT merged into a single base block; the
pre-TD-191 "additive merge into base" semantics is superseded). A
**cross-block target-path collision** between any pair of blocks (base-vs-base,
base-vs-overlay, or overlay-vs-overlay) is a **hard error** — a personal
customization must not silently shadow a core skill (and the writer-side
`runAddSkill` mirrors the same guard at write time). See L-519 (Igris-owned
topology — each per-harness compiler inside Igris OS reads every block's
canonical content from the registry, regardless of which block it came from).

---

## Portability Convention

Skills are authored for Claude Code first. To mark CLI-specific frontmatter, use the
optional `platform_overrides` block:

```yaml
---
name: scan
description: Show system status report
disable-model-invocation: false
platform_overrides:
  claude:
    allowed-tools:
      - Read
      - Grep
      - Glob
      - Bash
      - mcp__igris-brain__igris_project_status
    triggers:
      - "SCAN"
      - "REPORT"
---
```

> **Note (post-FR-153):** the legacy `platform_overrides.codex.include: false`
> opt-out is **no longer load-bearing** for the skill projection. Every
> `SKILL.md` under the source tree gets a per-skill symlink under every
> consumer's skills dir — there is no exclusion step. Authors targeting only
> Claude can omit the codex/gemini blocks entirely; co-installed Claude-only
> skills appear as inert reference docs in `~/.codex/skills/` /
> `~/.gemini/skills/` rather than being skipped at compile time. The
> `is_claude_only` helper in `_common.sh` remains defined for back-compat but
> is no longer called by the live compile path.

### Frontmatter Handling Per CLI

| CLI | Behavior |
|-----|----------|
| Claude | Reads `SKILL.md` natively via per-skill directory symlink. Full frontmatter preserved verbatim (all keys including `platform_overrides.claude`). |
| Gemini | Reads `SKILL.md` natively via per-skill directory symlink (FR-153 — unified onto the claude/symlink primitive). Full frontmatter preserved verbatim. Pre-FR-153 only `description` was extracted into a per-skill TOML; the converter (`md_to_gemini_toml.sh`) has been retired. |
| Codex | Reads `SKILL.md` natively via per-skill directory symlink (FR-153 — unified onto the claude/symlink primitive). Full frontmatter preserved verbatim. Pre-FR-153 the entire frontmatter was stripped and the body concatenated into a single `AGENTS.md` under a 32 KB cap; the aggregator (`md_to_agents_md.sh`) has been retired. |

### Flat Frontmatter (Current Default)

Existing skills use flat Claude-specific keys (`allowed-tools`, `triggers`,
`disable-model-invocation`) at the top level. Adapters continue to tolerate flat
frontmatter as a fallback — migration to `platform_overrides` is **optional**, not
required.

---

## Claude-Only Skill Detection — RETIRED

**Pre-FR-153** the codex compiler excluded skills that were Claude-only. A
skill was considered Claude-only when **either** signal was present:

1. `platform_overrides.codex.include: false` in frontmatter (explicit opt-out).
2. The body contained `Agent(...)` or `Skill(...)` invocation patterns — a
   heuristic for orchestration skills that assume Claude's subagent API.

Excluded skills were logged to stderr and listed in a trailing `<!-- -->`
comment inside the generated `AGENTS.md`.

**Post-FR-153 the entire mechanism is dead.** The symlink projection has no
exclusion step — every `SKILL.md` under the source tree gets a per-skill
symlink in every consumer's skills dir. Consumers that can't execute
Claude-orchestration skills will see them as inert reference docs rather than
active commands. The `is_claude_only` helper in `_common.sh` is preserved as
defence-in-depth back-compat but is no longer called by the live compile path.

---

## Nested Skill Files

Post-FR-153, all three harnesses (claude/codex/gemini) project each skill as a
**directory symlink** to the registry-vendored `<source>/<name>/` tree — so
nested files like `scripts/*.sh`, `workflow-template.md`, and
`register/templates/*.md` are visible to every consumer that follows symlinks.

The `find -mindepth 2 -maxdepth 2 -name 'SKILL.md'` walk used by the compiler
only enumerates each skill's top-level `SKILL.md` to identify which symlinks to
emit — but the symlinks themselves point at the full directory, so consumers
that read sibling files (e.g. claude reading `scripts/`) see them automatically.

---

## Nested Agent Files (FR-156)

Personal-overlay agents are vendored as **full directory trees** into
`~/.igris/registry/agents/<name>/` — the same shape as skills (symmetric
topology with FR-149 + TD-191, L-519 §18.1). An agent's `system-prompt-vN.md`
body can reference siblings like `routing/_routing.md`, `registry/types.md`,
or `archetypes/ARCH-*.md` and `igris registry add` / `igris registry update`
will vendor the entire source dir alongside the body. This closes the L-516
violation where pre-FR-156 only the frontmatter + chosen body file were
copied — supporting files lived in the operator's source dir only, so the
registry copy was not self-sufficient.

**Reference convention** — bodies SHOULD cite siblings via the absolute
registry path:

```
See ~/.igris/registry/agents/deck/routing/_routing.md for the routing rules.
```

NOT a relative path. Igris does **not** rewrite operator-authored body text;
the body you author is the body the harness reads. (See TD-197 for the
content-pipeline migration that converts the in-tree DECK/DESIGNER bodies
to this convention.)

**Vendor skip-list** excludes operator-author noise from the registry copy:

- `MAINTAINING.md` — internal-author-only doc
- `.DS_Store` — macOS filesystem cruft
- `.git*` — VCS metadata (matches `.git`, `.gitignore`, `.gitkeep`, `.github`)
- `node_modules/`, `.venv/`, `__pycache__/` — language deps + caches
- `*.pyc` — compiled python
- `harness.md` — FR-152 α-assembled output (derived, not source)
- `REGISTRY-NOTICE.md` — TD-202 sidecar (vendored-copy notice, not source)

The skip-list is fixed (per-agent `.igrisignore` overrides are deferred —
add as a fast-follow if a real case appears post-ship).

**Drift detection** — `check_harness_drift.sh` runs a per-agent tree-hash
pre-check (`[<name>/tree] MATCH/DRIFTED`) BEFORE the per-target FR-152
symlink check. The two verdicts are orthogonal (tree-match doesn't imply
symlink-correct, and vice versa) so both fire so the summary count is
honest. A DRIFTED verdict locates up to 5 differing relpaths in a sub-line
(architect-chosen Decision 2 — strict single tree verdict + file-list diff,
NOT per-file fan-out).

**`igris registry update <name>`** re-vendors the whole tree from the
recorded path origin. A change ANYWHERE in the source tree (content,
addition, removal) flips the recorded hash → status=changed. Update
semantics widened with FR-156: pre-FR-156 a sibling unrelated file added to
the source dir was IGNORED; post-FR-156 it's vendored on next update. This
is BY DESIGN (closes L-516). Author-only files belong in the skip-list or
outside the agent dir.

---

## Editing Vendored Content (TD-202)

Personal-overlay skills and agents are copy-vendored from operator source dirs
into `~/.igris/registry/{skills,agents}/<name>/`. The registry-vendored copy is
what runtime harnesses load (claude/codex/gemini all read from the same
registry-anchored symlinks per FR-152/FR-153/FR-156). **The registry is not the
editing surface** — direct edits there are silently overwritten on the next
`igris registry update` or `add` cycle.

**Editing flow:**

```bash
# 1. Find the source dir (recorded at vendor time):
cat ~/.igris/registry/origins.json | jq '."skill:content-pipeline"'
# { "type": "path", "dir": "/Users/me/automation/content/skills/content-pipeline", "hash": "..." }

# 2. Edit at source:
$EDITOR /Users/me/automation/content/skills/content-pipeline/SKILL.md

# 3. Re-vendor:
igris registry update content-pipeline
# →   content-pipeline: changed
# →
# →   Reminder: edits to vendored surfaces must happen at the SOURCE path,
# →   not under ~/.igris/registry/. Re-run `igris registry update <name>`
# →   after editing the source. See TD-202 / coding_guidelines.md §18.5.
```

**In-band notice.** Every vendored tree carries a `REGISTRY-NOTICE.md` sidecar
(emitted by `igris registry add` / `add-skill` / `update`) naming the source
path. Editors who open the registry-vendored copy see the notice next to the
file they were about to mutate. The sidecar is excluded from the FR-156 vendor
skip-list (hash basis stays in sync with the operator's source tree that has
no such file).

**Detection.** If the registry copy diverges from the recorded source tree,
`check_harness_drift.sh` reports `[<name>/tree] DRIFTED` with up to 5
differing relpaths (FR-156 for agents; TD-201 extended to skills). The
verdict pairs the registry sha + source sha so the operator can locate the
divergence without re-deriving the diff.

**Github-origin caveat.** Surfaces vendored from `github:owner/repo@ref` have
no on-disk source path — the `Source:` line in `REGISTRY-NOTICE.md` is the
`github:owner/repo@ref` URI. Edit upstream, tag a new release, then
`igris registry update` picks up the newer tag.

See `coding_guidelines.md` §18.5 and TD-202 for the full rationale.

---

## 32KB Cap (Codex) — RETIRED

Pre-FR-153 the codex skill surface was an aggregated `AGENTS.md` under a 32KB
size cap. FR-153 retired that aggregator in favor of the per-skill symlink
projection (consumer-natural directory traversal — no cap, no Claude-only
heuristic). The legacy `md_to_agents_md.sh` script is deleted.

---

## How to Add a New CLI Adapter

1. Pick a method: `symlink` or `none` (the legacy `converter` / `compiler`
   methods were retired by FR-153).
2. Add an entry to `cli_targets` in `~/.igris/config.json`.
3. For `symlink`, no adapter script is needed — the skills pass inside
   `compile_harnesses.sh` walks each `<name>/SKILL.md` under the source root
   and emits one symlink per skill at `<target>/<name>` → `<source>/<name>`.
4. Source `scripts/cli-adapters/_common.sh` for shared helpers
   (`parse_frontmatter`, `strip_frontmatter`, `is_claude_only`, `toml_escape`).
5. Add a vitest case in `cli/src/__tests__/bridges.test.ts` (or a bats fixture
   in `cli/tests/integration/install-symlinks.bats`) exercising the new adapter.

---

## Invocation

- **Bootstrap-time:** `igris init --cli-bridge=claude,gemini,codex` (or the
  default auto-detect, which probes PATH + config dirs).
- **Install-time:** `igris install <project-dir>` — bridges already wired
  during init are propagated to the project automatically.
- **Runtime refresh:** `igris refresh` re-fetches `~/.igris/core/` and
  re-runs the bridge materialization step.

`--cli-bridge=auto` (the default) expands to every CLI detected on
PATH AND with a config dir present. `--cli-bridge=none` opts out of
all bridges.

---

## Subagent Distribution

**Brief:** TD-021 (parent FR-006)

Skills distribution (above) and subagent distribution are **two separate
concerns**. The `cli_targets` block + the skills pass inside
`compile_harnesses.sh` handle SKILLS — projecting `~/.igris/core/skills/` as
per-skill symlinks under each consumer's skills dir (`~/.claude/skills/`,
`~/.codex/skills/`, `~/.gemini/skills/`). Agent *subagent prompts* are
different: each agent has one canonical prompt that must be regenerated into
per-CLI harness files (`.claude/agents/<name>.md`, `.codex/agents/<name>.toml`).
Conflating the two is a known drift trap — the skills surface is NOT a
subagent generator.

### Canonical is the sole source of truth

Each agent has exactly one canonical prompt. Every harness file is a GENERATED
artifact derived from it. **Editing a harness file directly is a process
error** — the next compile run will overwrite it. Two canonical conventions
coexist:

- **Content-pipeline agents** — versioned canonical:
  `agents/<name>/system-prompt-v<X.Y>.md`. The compiler resolves the newest
  version via `latest_canonical`.
- **Igris-core agents** — unversioned canonical: `core/agents/<name>.md`.

### Components

| File | Role |
|------|------|
| `scripts/cli-adapters/harness-manifest.json` | Declarative manifest: per agent, the canonical source (dir + glob/file + `versioned` flag) and the set of harness targets. Handles both canonical conventions. |
| `scripts/cli-adapters/sync_codex_agents.sh` | Per-target adapter — `<frontmatter-md> <body-md>` → `.codex/agents/<name>.toml` (3-key TOML: `description`, `developer_instructions`, `name`). Live emit path (D1 RESOLVED — REIMPLEMENT, FR-138; signature refactored FR-152). |
| `scripts/cli-adapters/compile_harnesses.sh` | Orchestrator — reads the manifest, calls the per-target adapter for every agent/target. `--project-root`, `--filter`, `--target` flags. |
| `scripts/cli-adapters/check_harness_drift.sh` | CI-style drift guard — exits non-zero if any harness body sha or version marker has diverged from canonical. |
| `scripts/cli-adapters/body-exceptions/*.json` | Documented intentional body divergences (see below). |

### Manifest schema

```json
{
  "agents": [
    {
      "name": "content-deck",
      "canonical": { "dir": "agents/deck", "glob": "system-prompt-v*.md", "versioned": true },
      "targets": [
        { "type": "claude", "path": ".claude/agents/content-deck.md" },
        { "type": "codex",  "path": ".codex/agents/content-deck.toml" }
      ]
    },
    {
      "name": "forger",
      "canonical": { "dir": "core/agents", "file": "forger.md", "versioned": false },
      "targets": [
        { "type": "codex", "path": ".codex/agents/forger.toml" }
      ]
    }
  ]
}
```

- `canonical.dir` / `glob` / `file` resolve relative to `--project-root`.
- `versioned: true` → adapter uses `latest_canonical` on `glob`;
  `versioned: false` → adapter uses `file` verbatim.
- An optional `body_exception` key names a sidecar in `body-exceptions/` —
  see below.

### Body exceptions

A harness body is normally byte-equal to the canonical body (minus
frontmatter). One documented exception exists: DESIGNER's `.claude/agents`
harness carries one extra paragraph (the harness-skill invocation note). The
manifest entry sets `"body_exception": "designer-harness-skill-para"`, and the
sidecar `body-exceptions/designer-harness-skill-para.json` declares a unique
`anchor` line plus the `insert` paragraph. The appendix is applied at
ASSEMBLY time (FR-152) — baked into the registry-resident `harness.md` by both
the TS vendor primitive and the bash `compile_harnesses.sh` assembly helper —
and `check_harness_drift.sh` verifies registry-anchored containment of the
symlink, so the exception is not flagged as drift and is not silently lost on
recompile.

### Decision D1 — codex wrap vs reimplement (RESOLVED — REIMPLEMENT, FR-138)

`sync_codex_agents.sh` could either WRAP the codex CLI's native agent-import
command or REIMPLEMENT the TOML emit. FR-138 **resolved D1 in favor of
REIMPLEMENT**: the script emits the fully-specified 3-key codex subagent TOML
directly, as the live default path — no opt-in flag, no env gate. The 7 Igris-
core agents now distribute to `.codex/agents/*.toml` by default whenever
`compile_harnesses.sh --target codex` (or `--target all`) runs. The former
`--d1-reimplement` flag and `IGRIS_CODEX_D1=reimplement` env opt-in are retained
only as deprecated, accepted no-ops for back-compat with any caller still
passing them. A WRAP variant remains possible behind a future `--d1-wrap` flag
if the `codex` CLI's native import is ever found to be scriptable + idempotent.

### `cli_targets.codex.agents` sub-block

The runtime `~/.igris/config.json` `cli_targets.codex` entry carries an
`agents` sub-block (TD-021) describing the subagent surface — its `compiler`,
`orchestrator`, `manifest`, `drift_guard`, and `target`. This is distinct from
the sibling skills surface (post-FR-153: symlink-projected). The two are no
longer conflated under one mechanism.

### Invocation

```bash
# Regenerate every harness for a project (all targets; codex is live since FR-138):
bash ~/.igris/core/scripts/cli-adapters/compile_harnesses.sh \
  --project-root /path/to/project --filter 'content-*' --target all

# Check for drift (exit non-zero if any harness is stale):
bash ~/.igris/core/scripts/cli-adapters/check_harness_drift.sh \
  --project-root /path/to/project --filter 'content-*'
```

The content-pipeline wires this into its `install.sh` via a
`compile-harnesses.sh` step (see that project's `agents/MAINTAINING.md`).

---

## Hook Coverage

Igris hooks are the lifecycle integration layer: session start/end, pre/post tool use,
and pre/post compact. Before FR-104 these lived only as per-project Claude Code scripts
(`.claude/hooks/*.sh`). FR-104 extracts the six cross-CLI-portable events into a shared
bash layer and adds per-CLI bridges that route each CLI's native events into it.

### Portable Events

The following six events are CLI-portable — they have a semantically equivalent trigger
across all three supported CLIs (Claude, OpenCode, Codex):

| Igris event | Script | Purpose |
|-------------|--------|---------|
| `session_start` | `~/.igris/core/hooks/shared/session_start.sh` | Inject session state and active brief summary. |
| `session_end` | `~/.igris/core/hooks/shared/session_end.sh` | Flip CURRENT_SESSION.md to REST MODE; deregister instance from brain. |
| `pre_compact` | `~/.igris/core/hooks/shared/pre_compact.sh` | Emit recovery context before context compaction. |
| `post_compact` | `~/.igris/core/hooks/shared/post_compact.sh` | Log compact completion; future hook point. |
| `pre_tool_use` | `~/.igris/core/hooks/shared/pre_tool_use.sh` | Brief-first gate for Write/Edit tool calls. |
| `post_tool_use` | `~/.igris/core/hooks/shared/post_tool_use.sh` | Dispatcher for `post_tool_use.d/*.sh` handlers (currently: lint). |

### Per-CLI Coverage

| CLI | Wired events | Mechanism | Notes |
|-----|--------------|-----------|-------|
| Claude Code | All 6 portable + Claude-only (SubagentStop, Stop, TaskCompleted, TeammateIdle, Notification) | `.claude/settings.json` entries point directly at shared script paths | Claude-only events continue to use project-local `.claude/hooks/` since no other CLI has an equivalent. |
| OpenCode | All 6 portable | TypeScript plugin at `~/.config/opencode/plugins/igris-bridge.ts` | Auto-loaded by Bun at startup; raw `.ts` — no build step. |
| Codex CLI | `session_end` only | `notify` program wrapper at `~/.igris/core/hooks/bridges/codex-notify.sh` | Codex exposes only post-turn notification. The user's original `notify` program is backed up to `~/.igris/config.json → cli_targets.codex.user_notify_backup` and invoked first. |
| Gemini CLI | None | Not supported | Gemini CLI has no hook API. Igris hook layer is a no-op for Gemini. |

### Shared Script Input Contract

Every shared script accepts two input shapes. Bridges translate native events to the
unified shape before piping; legacy Claude-native shape is also accepted for backward
compatibility (direct `settings.json` invocation with no bridge).

**Unified shape (preferred, from bridges):**
```json
{
  "source": "claude" | "opencode" | "codex",
  "event":  "session_start",
  "project_dir": "/absolute/path",
  "payload": { /* CLI-specific fields */ }
}
```

**Native Claude shape (back-compat):**
```json
{ "tool_name": "Write", "tool_input": { "file_path": "/..." } }
```

**Environment variable fallback** (when stdin is empty):

| Variable | Meaning |
|----------|---------|
| `IGRIS_HOOK_SOURCE` | `claude` / `opencode` / `codex` |
| `IGRIS_HOOK_EVENT` | Matches filename: `session_start`, `pre_tool_use`, etc. |
| `IGRIS_PROJECT_DIR` | Absolute path to project root. |
| `IGRIS_TOOL_NAME` | Tool name for `pre_tool_use` / `post_tool_use`. |
| `IGRIS_FILE_PATH` | File path for Write/Edit operations. |

### Post-Tool-Use Dispatcher

`post_tool_use.sh` is a dispatcher — it reads the JSON input once, then fans out to every
executable file under `post_tool_use.d/` in lexicographic sort order. Each handler runs
in its own subshell with a 10s timeout (configurable via `IGRIS_POST_TOOL_USE_TIMEOUT`).
Handler failures are isolated: one crashing handler does not block the others.

Default handlers:

| File | Purpose |
|------|---------|
| `01-lint.sh` | Run shellcheck on modified `.sh` files. |

Add new handlers by dropping a `NN-name.sh` file into `~/.igris/core/hooks/shared/post_tool_use.d/`
and `chmod +x`. Disable without deletion via `chmod -x`.

### OpenCode-Specific Notes

OpenCode's plugin event model was verified end-to-end against `opencode 1.14.22` on
2026-04-24 (TD-044). Findings:

**Event-name drift vs. docs.** OpenCode's plugin docs list `session.created`, but in
headless `opencode run` mode it never fires — sessions come into existence via
`session.updated` / `session.status` on the same event bus. The bridge synthesises
`session_start` from the first `session.updated`/`session.status` per unique session id,
with an in-memory `seenSessions` set guarding against re-fire.

**End-event dedupe.** `session.idle` reliably fires in both run and TUI modes; the bridge
dedupes via an `endedSessions` set keyed by session id so `session_end` dispatches exactly
once per session. `server.instance.disposed` is a server-lifecycle event, **not** a
session-end signal — the bridge ignores it.

**Tool-hook coverage.** `tool.execute.before` / `tool.execute.after` subscriptions are
wired per OpenCode's documented API and compile clean, but exercising them depends on
the provider issuing tool calls. During TD-044 verification the Z.AI Coding Plan endpoint
(anthropic-compatible) returned clean sessions with zero tool invocations, so
write-tool flow through the bridge was not observed live. Re-test with a provider that
reliably emits tool calls before relying on that path.

**Trace flag for debugging.** Set `IGRIS_BRIDGE_TRACE=/path/to/trace.log` before launching
OpenCode to capture every event the bridge sees and every dispatch it fires. Zero impact
when unset.

**E2E script.** `test/e2e/opencode_bridge.sh` smoke-tests the session lifecycle path.
Skips with exit code 77 when `opencode`, `bun`, or `ZAI_API_KEY` are unavailable.

### Config Block

`~/.igris/config.json` extends `cli_targets.*` with a `hooks` sub-block:

```json
{
  "cli_targets": {
    "claude": {
      "hooks": {
        "settings_file": "$CLAUDE_PROJECT_DIR/.claude/settings.json",
        "events_covered": ["session_start","session_end","pre_tool_use","post_tool_use","pre_compact","post_compact"],
        "claude_only_events": ["SubagentStop","Stop","Notification","TaskCompleted","TeammateIdle"]
      }
    },
    "opencode": {
      "hooks": {
        "plugin_dir": "~/.config/opencode/plugins/",
        "plugin_file": "igris-bridge.ts",
        "events_covered": ["session_start","session_end","pre_tool_use","post_tool_use","pre_compact","post_compact"]
      }
    },
    "codex": {
      "hooks": {
        "notify_wrapper": "~/.igris/core/hooks/bridges/codex-notify.sh",
        "events_covered": ["session_end"]
      },
      "user_notify_backup": []
    },
    "gemini": {
      "hooks": {
        "events_covered": [],
        "note": "Gemini CLI has no hook API. Not supported."
      }
    }
  }
}
```

### Installation

Installation is controlled by `igris init` (bootstrap-time bridge
selection) and `igris install` (per-project propagation):

- `igris init --cli-bridge=<list>` — which CLIs to target during the
  one-time `~/.igris/` bootstrap (`claude,opencode,codex` or `none`).
  Defaults to auto-detect.
- `igris install <project-dir>` — propagates the wired bridges to the
  given project. No flag needed; the bridges already live in
  `~/.igris/config.json#cli_targets`.

Examples:

```bash
# Auto-detect bridges during bootstrap (default):
igris init

# Explicit set during bootstrap:
igris init --cli-bridge=claude,codex

# Opt out of all bridges (Claude-only):
igris init --cli-bridge=none

# Install in a project (uses whatever bridges are wired):
igris install /path/to/project
```

Runtime refresh:

```bash
# Re-fetch ~/.igris/core/ from the recorded channel and re-run bridge
# materialization. After init+refresh, no further runtime sync is needed —
# the brain serves all CLIs from a single source.
igris refresh
```

### Degradation on Gemini

Because Gemini has no hook API, these Igris behaviors are unavailable in a Gemini
session:

- No session_start context injection — Gemini will not see the active brief / session
  mode / blockers summary on session start.
- No `pre_tool_use` brief-first gate — Gemini can write files without requiring an
  active brief.
- No `post_tool_use` lint — file edits are not auto-linted on Gemini.
- No session_end REST MODE flip — CURRENT_SESSION.md remains at its last state until
  something else flips it.

All other Igris surfaces (skills, agents, rules) continue to work on Gemini
via the FR-153 symlink projection at `~/.gemini/skills/`.

### Testing

Hook coverage tests live at `test/igris_hooks_sync.test.bash`. Fixtures at
`test/fixtures/hooks/`:

- `settings_pristine.json` — user's Claude settings with no Igris entries.
- `settings_with_existing.json` — mixed user + stale-Igris entries (tests merge-replace).
- `codex_config_pristine.toml` — user's Codex config with a non-Igris `notify`.
- `codex_config_post_install.toml` — expected output after Igris wrap.

Run with `bats test/igris_hooks_sync.test.bash`. All tests should pass on macOS and
Linux.

---

## Agent-prompt harnesses (FR-136)

Agent prompts (the 7 Igris-core agents and any project agents) are projected to
per-CLI harness files (Codex `.toml`, Claude `.md`) by the TD-021 adapters under
`core/scripts/cli-adapters/`. FR-136 formalized this:

- **Schema** — `core/scripts/cli-adapters/manifest.schema.json` is the canonical
  contract. Core ships only the schema; **each project ships its own data
  manifest** validated against it.
- **Per-project manifest** — lives at the project's repo root
  (`<project-root>/harness-manifest.json`), NOT under `core/`. It declares each
  agent's canonical prompt source and the harness targets to regenerate. The
  adapters resolve `<project-root>/harness-manifest.json` by default (override
  with `--manifest <path>`).
- **Personal overlay (Layer-2)** — an OPTIONAL gitignored overlay at
  `~/.igris/registry/harness-manifest.personal.json` is auto-discovered and its
  `agents[]` merged into the base before flattening. A personal agent whose name
  collides with a core agent is a hard error (no shadowing). This is the FR-139
  customization-registry seam. Override with `--overlay <path>`.
- **`igris harness` verb** — `igris harness compile` regenerates harnesses;
  `igris harness check` runs the drift guard. Both shell out to the bash adapters
  (`compile_harnesses.sh` / `check_harness_drift.sh`) with exit-code passthrough.
  Flags: `--project-root`, `--manifest`, `--overlay`, `--target`, `--filter`.

### The three adapter naming families (reconciled — FR-138; middle family retired by FR-153)

Three naming families have lived under `core/scripts/cli-adapters/` since
FR-138. They are NOT interchangeable; each owns a distinct concern. FR-138
fixed the canonical disposition of each, and **FR-153 retired the middle
family** in favor of the unified symlink projection — only the first and
third families have live disposition today:

| Family | Concern | Disposition |
|--------|---------|-------------|
| `sync_<target>.sh` (+ `compile_harnesses.sh` / `check_harness_drift.sh`) | **Per-agent subagent prompts** (TD-021). One canonical `core/agents/<name>.md` → one harness per target. | **Canonical** for subagent harnesses. `sync_*` are the per-target emitters; `compile_harnesses.sh` orchestrates; `check_harness_drift.sh` guards. |
| `md_to_<surface>.sh` (`md_to_agents_md.sh`, `md_to_gemini_toml.sh`) | **Skills surfaces** (FR-103 / FR-137). The `~/.igris/core/skills/` tree → per-CLI skill artifacts. | **RETIRED by FR-153** — superseded by the symlink-based registry-anchored skill projection (`compile_harnesses.sh` skills pass + `_common.sh`'s pair allowlist). Both scripts deleted. |
| `<target>.sh` (e.g. `codex.sh`, `gemini.sh`) | The dormant FR-104-era bridge contract: `<target>.sh <project-path>`, invoked by `materializeBridges()` in `cli/src/lib/bridges.ts` during `igris init`. | **Superseded by the `igris harness` verb.** No `<target>.sh` script exists, so `materializeBridges` skips every target today (a silent no-op). The harness verb (`cli/src/verbs/harness.ts`) is the live seam — it shells out to `compile_harnesses.sh` / `check_harness_drift.sh` directly and deliberately never touches `bridges.ts`. The inert `bridges.ts` contract is left in place for a follow-up cleanup brief (no code change in FR-138); do not build `<target>.sh` scripts against it. |

### Add a New Harness (target type)

To add a new per-CLI subagent target type (say `cursor`):

1. **Manifest schema** — add the new type to the `targets[].type` enum in
   `core/scripts/cli-adapters/manifest.schema.json` (currently
   `["claude", "codex", "gemini"]`). If the surface is also a skills surface,
   add it to `surfaces.skills.targets[].type` too (currently
   `["codex", "gemini", "claude"]`), and add the new `(type, method)` pair
   to the `oneOf` constraint on the skills target item. Post-FR-153 only
   `symlink` participates in valid pairs; the method enum still includes
   `["compiler", "converter", "symlink"]` solely for clearer
   pair-allowlist error messages — for any new harness, the chosen method
   should usually be `symlink` (and a new value would need adding to both
   the enum AND the pair allowlist). Mirror the same pair in `valid_pairs`
   inside `_common.sh validate_manifest` and in `VALID_SKILL_TYPE_METHOD_PAIRS`
   inside `cli/src/verbs/registry.ts`.
2. **Per-agent adapter** — write `sync_cursor.sh` with the contract
   `sync_cursor.sh <canonical-md> <output> [agent-name]`. Exit `0` success /
   `1` error / `2` usage. Source `_common.sh`. Emit the output file
   **atomically** (write to a `mktemp`, then `mv`). Strip the canonical
   frontmatter via `strip_frontmatter` and reuse the `toml_escape*` /
   body helpers as appropriate for the target format.
3. **Dispatch arm** — add a `cursor)` case arm to the agents-surface dispatch
   `case "$ttype" in` block in `compile_harnesses.sh` (next to `claude)` /
   `codex)`), invoking `bash "$ADAPTER_DIR/sync_cursor.sh" ...`.
4. **Drift-guard body extraction** — teach `check_harness_drift.sh` how to
   read the new target's comparable body: add a `cursor)` branch in the guard's
   actual-body resolution (mirroring `codex_body` for codex, or the
   `strip_frontmatter` path for claude) so it can render MATCH / DRIFTED /
   MISSING. The body extracted must be the canonical-equivalent body so the sha
   compare is meaningful.
5. **Declare targets** — add a `{ "type": "cursor", "path": "..." }` entry to
   each agent in the relevant `harness-manifest.json`, and (if a skills surface)
   to `surfaces-manifest.json`.
6. **Gate scope** — if the new target's path is **project-relative** it is
   automatically in scope for the `validate_harness_drift.sh` commit gate
   (MISSING → fatal). If it is a **home/absolute path** (like the gemini
   `~/.gemini/commands` skills target), it is automatically classified
   out-of-scope (MISSING → NOTICE, not fatal) — no gate change needed.
7. **Mirror + test** — `core/`-resident adapters are part of the TD-096 runtime
   mirror set: `cp` to `~/.igris/core/scripts/cli-adapters/` and verify with
   `verify_mirror.sh`. Add bats coverage in `test/harness_drift_gate.test.bash`.

A new skills-surface target type follows the same shape and is wired into the
FR-137 skills pass of `compile_harnesses.sh` (and the matching skills branch
of the drift guard) — post-FR-153 the canonical method is `symlink`, with the
compile branch calling `emit_skill_symlink <label> <link_path> <skill_dir>`.

---

## Overlay scope (FR-155)

Personal overlay entries (agents + skills declared in the Layer-2 customization
overlay, FR-139) carry an optional `scope` field that controls **which working
directories** the harness emits the entry into.

| Shape | Behavior |
|---|---|
| `scope` absent | Default: emit unconditionally (back-compat) |
| `{type: "global"}` | Emit unconditionally |
| `{type: "project", paths: [...]}` | Emit only when `--project-root`'s realpath ∈ realpath'd `paths[]` |

`paths[]` entries and `--project-root` are realpath'd before comparison on both
sides (handles macOS `/tmp` ↔ `/private/tmp`). Non-matching project-scoped
entries are silently skipped — neither counted in `TOTAL` nor flagged as drift.

### CLI semantics

```bash
# Global (default): targets emit as absolute paths (~/.claude/agents/<name>.md, etc.).
# Available to claude/codex/gemini from any working directory.
igris registry add --name X --from ./path/to/source

# Project-scoped: targets emit as project-relative paths. Only emits when
# compile/drift runs against the listed --project-root realpath.
igris registry add --name X --from ./source --project /abs/proj-a

# Multi-project additive: same name + --project again appends to scope.paths.
igris registry add --name X --project /abs/proj-b   # paths becomes [proj-a, proj-b]

# Idempotent: re-adding the same project on a project entry is a no-op.
igris registry add --name X --project /abs/proj-a   # already present; no change

# Conversion (explicit — silent auto-convert is refused):
igris registry add --name X --scope project --project /abs/proj-a   # global → project
igris registry add --name X --scope global                          # project → global (paths dropped)
```

Re-add with `--project P` against an existing **global** entry is refused with
an actionable hint pointing at `--scope project` for explicit conversion —
narrowing availability has downstream effects on every harness consumer, so
the conversion must be operator-acknowledged.

The same `--project` / `--scope` flags apply to `add-skill`.

On-disk shape: `scope` is OMITTED when global (schema treats absent as
global). Project-scoped entries write `scope: {type: "project", paths: [...]}`
with realpath'd absolute paths.

---

## Related

- Brief: FR-103 Multi-CLI Skill Distribution
- Brief: FR-104 Multi-CLI Hook Bridge Layer
- Brief: FR-136 Harness manifest schema + per-project model + `igris harness` verb
- Brief: FR-137 Skills surface folded into the harness manifest engine
- Brief: FR-138 Un-gate codex emit (D1 resolved) + drift-guard MISSING→FATAL scoping + add-a-harness contract
- Canonical skills: `~/.igris/core/skills/`
- Canonical shared hooks: `~/.igris/core/hooks/shared/`
- Bridges: `~/.igris/core/hooks/bridges/`
- Skill adapters: `scripts/cli-adapters/`
- Hook adapters: `scripts/hook-adapters/`
- Config: `~/.igris/config.json` → `cli_targets`
