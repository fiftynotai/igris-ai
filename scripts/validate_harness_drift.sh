#!/bin/bash
set -euo pipefail

# Description: Pre-commit / CI wrapper around the TD-021 harness drift guard
#   (core/scripts/cli-adapters/check_harness_drift.sh). Runs the guard ONCE
#   against igris-ai's repo-root harness manifest, which (post-FR-136) declares
#   ONLY the agents that belong in this repo (the Igris-core agents).
#
#   FR-136 removed the content-pipeline entries from the manifest and moved it
#   to the repo root, so the per-agent CORE_AGENTS loop (the FR-135 content-*
#   exclusion stopgap) is no longer needed - a single guard call against the
#   clean manifest is sufficient.
#
# Usage: validate_harness_drift.sh
#   No arguments. Resolves the repo root via git and invokes the guard with
#   --project-root pointed at it.
#
# Dependencies: bash (3.2 — the pre-commit hook invokes this), git, python3
#   (transitively via the guard + _common.sh).
# Exit codes (TD-396 — the FAIL-CLOSED FLOOR below is the rule these follow):
#   0 - The guard exited 0, OR every failure it counted is a classified block
#       this wrapper DOWNGRADED with a printed NOTICE. There are exactly two
#       downgrades, each printed on every run it fires:
#         * MISSING on a home/absolute-path target -> out-of-scope NOTICE
#           (FR-138, SCOPING below);
#         * DRIFTED on an `mcp/*` build-artifact path key while >=1 live
#           SIBLING worktree exists -> WORKTREE NOTICE (TD-388, MULTI-WORKTREE
#           below).
#   0 - (clean skip) the guard or manifest FILE is absent — see fail-open below.
#   1 - Anything else the guard failed on. Every class that applies prints its
#       own FATAL section, then the script exits once:
#         DRIFTED (outside the TD-388 exemption), MISSING on a project-relative
#         target (you forgot to compile), DRIFT-WARN, SCHEMA-INVALID, PARITY,
#         and the UNATTRIBUTED floor — a failure the guard counted (or an exit
#         status it returned) that no verdict line explains.
#   1 - The classifier itself crashed, or printed malformed output (TD-188).
#
# Environment:
#   IGRIS_DRIFT_STRICT_WORKTREE - set to any non-empty value (conventionally 1)
#       to DISABLE the multi-worktree exemption entirely: every DRIFTED verdict
#       is fatal again. For CI, /release, or an operator who wants the raw
#       verdict. Single-worktree machines are unaffected either way.
#   IGRIS_DRIFT_GUARD_RC - NOT a caller knob. This script sets it on the
#       classifier's command line to the guard's exit status (the floor's
#       input); a value inherited from the caller is overwritten.
#
# =========================================================================
# VERDICT VOCABULARY (TD-396): the guard's FULL output grammar, beside the
# classifier's `verdict_re` alternation
# -------------------------------------------------------------------------
#   verdict_re: MATCH|DRIFTED|MISSING|DRIFT-WARN|SCHEMA-INVALID|PARITY|NOTE|SKIP
#
#   guard line            guard counter    this wrapper
#   [name] MATCH          MATCH            no action
#   [name] DRIFTED        DRIFT            FATAL; ONE downgrade (TD-388 NOTICE)
#   [name] MISSING        DRIFT            FATAL if project-relative, else the
#                                          FR-138 out-of-scope NOTICE
#   [name] DRIFT-WARN     DRIFT            FATAL, never downgraded
#   [name] SCHEMA-INVALID SCHEMA_INVALID   FATAL
#   [name] PARITY         PARITY           FATAL (TD-451; argued below)
#   [name] NOTE / SKIP    none             informational; ends the previous
#                                          block's continuation scan
#   (no verdict line)     DRIFT or exit 1  FATAL, UNNAMED ("not attributable"):
#     - the skills-delegate re-check failure: `DRIFT skills (delegate) — …`
#       on stderr, DRIFT++ with no block;
#     - the early `exit 1`s before any verdict: a bad --project-root, a
#       missing or schema-invalid manifest, a missing or invalid overlay, an
#       overlay merge collision;
#     - any `set -e` abort mid-run.
# A token the guard gains that is NOT in verdict_re is FATAL but unnamed,
# never invisible: its failure still counts toward the guard's summary and
# exit status, and the floor refuses a count no verdict line explains.
#
# INTRODUCTION POINT (measured with `git log -S`, not inherited): the
# `MATCH|DRIFTED|MISSING` alternation arrived in cdb4997 (FR-138, 2026-05-21),
# complete for the guard of that day. The guard then gained DRIFT-WARN in
# ef6f11d (TD-208, 2026-06-01), PARITY in 87f2b75 (FR-217, agents arm) and
# 30658c2 (TD-281, mcp + hook arms), both 2026-06-30, and SCHEMA-INVALID in
# 2d7302b (TD-230, 2026-07-01). The alternation never followed, and until
# TD-396 the guard's exit status was discarded, so each of those classes
# passed the commit gate while the guard itself exited 1.
# =========================================================================
#
# =========================================================================
# FAIL-CLOSED FLOOR (TD-396): trust the guard's exit status, reconciled
# against the guard's own counters
# -------------------------------------------------------------------------
# THE RULE. The wrapper may DOWNGRADE a failure (the two NOTICEs above) but
# never silently UPGRADE a non-zero guard exit to 0. Mechanism: the guard's
# exit status reaches the classifier as IGRIS_DRIFT_GUARD_RC, and the
# classifier parses the guard's summary counters —
#     `N targets — M in sync, K drifted/missing`
#     `P parity violation(s) …`         (only when P > 0)
#     `S schema-invalid target(s) …`    (only when S > 0)
# — then counts the failures NO verdict line explains:
#     unattributed = max(0, K − #DRIFTED − #MISSING − #DRIFT-WARN)
#                  + max(0, P − #PARITY) + max(0, S − #SCHEMA-INVALID)
# plus: no summary line and a non-zero exit -> 1 ("exited before rendering a
# summary"); an exit other than 0/1, or an unreadable one -> at least 1; and a
# belt — a non-zero exit with nothing fatal and nothing downgraded -> 1.
# A SURPLUS of blocks over counters is not unattributed: each such block is
# already FATAL (or NOTICE'd) by its own class. With no summary and exit 0 (the
# guard's "No … targets matched" path) the result is 0, as before.
#
# REJECTED: widen `verdict_re` ALONE. Its failure mode is that every guard
# failure that is not a `[name] VERDICT` line stays invisible, and three such
# classes exist TODAY (the no-verdict-line rows of the vocabulary table). It
# would also reopen the hole the next time the guard gains a token — the
# TD-289 -> TD-340 shape: the alternation was complete at cdb4997 and fell
# behind three times. `verdict_re` IS widened here, but only so a FATAL line
# can NAME the class; the floor is what makes the gate fail closed.
#
# REJECTED: a bare "non-zero exit and no NOTICE -> FATAL". It is disarmed
# whenever ANY downgrade fires in the same run: a home-path MISSING NOTICE is
# routine on every machine that never projected gemini, so an unclassified
# failure beside it would still pass on exactly those machines. Reconciling
# the COUNT is what makes a stray NOTICE unable to satisfy the floor (pinned
# by R4 in test/harness_drift_gate.test.bash).
#
# COUPLING, stated: the floor reads the summary lines' wording. A change to
# that wording must update the classifier's summary regexes in the same
# commit; otherwise every downgrade-only run turns FATAL (loud, not silent).
# The MAINTAINING.md verdict-protocol row records the change procedure.
# =========================================================================
#
# =========================================================================
# PARITY AT THE GATE (TD-451): FATAL, and WARN was argued and rejected
# -------------------------------------------------------------------------
# * The guard already exits 1 on PARITY (FR-217 M4); a WARN would be a
#   downgrade, and every downgrade needs a reason that holds.
# * PARITY is a property of the COMMITTED manifest (a trigger path since
#   TD-389), not machine state: every checkout reproduces it and the committer
#   can fix it in the same commit — the opposite of home-path MISSING, which
#   is why MISSING is downgraded.
# * MAINTAINING.md already states the invariant (keep the real manifest at 0
#   PARITY); this makes the gate enforce it.
# * The rejected WARN's failure mode: a manifest edit that drops a projected
#   harness from one block commits with a line scrolled past in a long report,
#   and the next compile silently projects that block to fewer harnesses —
#   the dropped harness never gets the entry and nothing fails (TD-228).
# * Caveat: PARITY is computed on the MERGED manifest (base + personal
#   overlay), so a partial block in the overlay trips it too.
# TD-388 INTERACTION: an mcp-arm PARITY block is named `mcp/<name>/<harness>`
# (condition 2 would hold), but it prints no `config :` line (path empty,
# condition 3 fails) and no `differing key(s):` clause (condition 4 fails).
# More fundamentally, PARITY is classified in its OWN branch and never
# reaches the DRIFTED branch, so the exemption is never consulted: PARITY is
# FATAL beside a live sibling worktree (pinned by P1).
# =========================================================================
#
# =========================================================================
# SCOPING: MISSING is FATAL for project-relative targets (FR-138)
# -------------------------------------------------------------------------
# The guard (check_harness_drift.sh) is STRICT by contract: MISSING -> exit 1,
# DRIFTED -> exit 1. That contract is the source of truth and is UNCHANGED.
#
# FR-135 added a STOPGAP here that tolerated MISSING-only (exit 0) because the
# 7 core-agent codex targets were gated on Decision D1 and never compiled, so
# every one reported MISSING — a false positive, not "you forgot to recompile".
#
# FR-138 un-gated codex (Decision D1 RESOLVED — REIMPLEMENT) and now compiles
# the .codex/agents/*.toml harnesses. A MISSING project-relative target now
# genuinely means "you forgot to compile" and MUST be fatal again. So this
# wrapper flips MISSING -> FATAL — BUT only for PROJECT-RELATIVE targets.
#
# Why scope to project-relative:
#   This wrapper runs the guard over EVERY surface (it passes no --surface
#   flag). The skills surface includes a HOME-PATH gemini target
#   (~/.gemini/commands, declared in surfaces-manifest.json). That target is
#   MISSING on any machine (incl. CI) that never projected gemini TOMLs.
#   Hard-failing the commit gate on a home-path skills target the developer
#   may legitimately not have projected would be a false positive everywhere.
#   The gate enforces what THIS repo commits-as-canonical: the project-relative
#   targets (.codex/agents/*.toml, AGENTS.md). Home/absolute-path targets are
#   out of the gate's scope and only surfaced as a NOTICE.
#
# Discrimination rule applied below (per target's RESOLVED path):
#   - DRIFTED (any path)            -> FATAL (exit 1). Existing-but-diverged is
#                                      real drift; never tolerated. ONE narrow
#                                      exemption — see MULTI-WORKTREE below.
#   - MISSING, project-relative     -> FATAL (exit 1). You forgot to compile.
#   - MISSING, home/absolute path   -> NON-BLOCKING NOTICE (exit 0, out of scope).
#   - all in-scope targets MATCH    -> pass (exit 0).
#   (DRIFT-WARN, SCHEMA-INVALID, PARITY and unattributed failures are FATAL on
#   any path — VERDICT VOCABULARY and FAIL-CLOSED FLOOR above.)
# RESOLUTION (TD-188): "project-relative" is decided on the RESOLVED path.
#   is_project_relative() realpaths BOTH the candidate and REPO_ROOT before the
#   commonpath test, so a project-relative target that is a symlink escaping
#   REPO_ROOT classifies as OUT of scope (MISSING -> NOTICE, not FATAL), and
#   macOS `/tmp` -> `/private/tmp` compares equal. is_out_of_repo() (TD-388)
#   applies the same realpath rule.
# =========================================================================
#
# =========================================================================
# MULTI-WORKTREE: the sibling-worktree MCP exemption (TD-388)
# -------------------------------------------------------------------------
# THE MECHANISM. The global `igris` binary on a dev box is an `npm link` into a
# CHECKOUT, not an install, so the projected MCP entry must name a build
# artifact inside SOME checkout — e.g. `args[0] = <checkout>/cli/dist/index.js`.
# The harness configs it is written into (~/.claude.json, ~/.codex/config.toml,
# …) are HOME-anchored and therefore SHARED by every worktree of this repo.
# With N worktrees checked out, whichever one compiled LAST owns the shared
# config, and the other N-1 each see `mcp/igris-brain/<harness>` DRIFTED with
# `differing key(s): args`. The gate's own remedy (`igris harness compile`)
# would rewrite that shared config and re-point the OTHER worktree's live
# session at this one — the fix is more destructive than the finding.
#
# THE RULE. A DRIFTED verdict is reclassified as a non-fatal WORKTREE NOTICE
# iff ALL FOUR of these hold:
#   1. >=1 LIVE sibling worktree exists — a `git worktree list --porcelain`
#      entry whose directory EXISTS on disk and whose realpath != REPO_ROOT's.
#      (The isdir test also covers the half-removed/prunable state.)
#   2. The verdict block is an `mcp/*` block.
#   3. The block's resolved config path is NON-EMPTY, ABSOLUTE and NOT under
#      REPO_ROOT.
#   4. The reason line's `differing key(s): …` list is a NON-EMPTY SUBSET of
#      {args, command} — the two keys that can carry a build-artifact PATH.
#      (`command` because an `add-mcp "node <path>"` registration fuses the
#      path into `command`; opencode's native shape does the same.)
# Anything else stays FATAL: any `env.*`/`type`/`enabled` divergence, any
# unlisted key, and EVERY DRIFTED whose reason carries no `differing key(s):`
# clause at all (`config unparseable`, `internal compare error`,
# `MISSING_SECRET`, and every agent/skills symlink/hardlink/schema reason).
#
# WHY IT IS KEYED ON WORKTREE LIVENESS + PATH-KEY-ONLY DIVERGENCE, AND NOT ON
# THE PATH ANCHOR. "The path is under $HOME" was the tempting proxy for "outside
# this repo's control", and it is WRONG for most of the set. Measured from
# `harness-manifest.json` `agents[].targets[].path`: 18 of the 27 agent target
# rows are home-anchored (gemini x9, opencode x9) against 9 repo-relative
# (codex x9). Those 18 are verdicted by inode/symlink identity against the
# SHARED ~/.igris/loadout/, so BOTH worktrees compute the SAME expected value —
# a DRIFTED there means a broken hard link, a hand-edited harness, a
# cp-replaced link or a non-loadout symlink. Every one of those is a real
# correctness failure and none of them is per-checkout. That census — 18 of 27
# rows, 66.7%, home-anchored yet fully worktree-invariant — is the whole
# argument on its own: "under $HOME" does not mean "varies per checkout".
#
# DESIGN REASONING, NOT MEASUREMENT: the rejected option — excuse DRIFTED by
# path anchor ALONE, which has no condition-4 analogue — keys on WHERE the file
# lives, and the census above measures that this property is not the one that
# matters. HOW MANY rows it would actually disarm is NOT measured and is not
# derivable from the 18: that count depends on how such a variant resolves an
# agent block's path, and under THIS classifier an agent block resolves path=""
# (agent verdicts print only `target :` / `expected :` / `symlink target:`,
# none of which pathline_re matches), so a literal path-anchor variant of this
# code would disarm zero. No count is claimed here. Hence conditions 2-4, which
# describe WHY the value varies rather than WHERE the file lives.
#
# WHAT KEEPS THE AGENT SURFACE FATAL — a SUFFICIENCY LATTICE, not one guard.
# Two earlier drafts of this block each named a single condition and each was
# refuted. The measured answer:
#
#     conditions turned off   agent surface (W5/W5b)
#     {2}   {3}   {4}                GREEN
#     {2,3} {2,4} {3,4}              GREEN
#     {2,3,4}                        RED
#
# **Conditions 2, 3 and 4 are EACH INDEPENDENTLY SUFFICIENT** to hold the agent
# surface, because an agent DRIFTED block fails all three at once:
#   * cond 2 — the block is named `<agent>/<harness>` (e.g. `forger/claude`),
#     so it has no `mcp/` prefix;
#   * cond 3 — it prints `target :` / `expected :` / `symlink target:`, labels
#     pathline_re does not match, so it classifies with path="" and
#     is_out_of_repo("") is False;
#   * cond 4 — no agent/skills reason carries a `differing key(s):` clause.
#     The `DRIFTED:*)` arm of `verify_mcp_entry_drift` in
#     check_harness_drift.sh is the only site in core/, scripts/ or cli/src
#     that emits that phrase (measured).
# It takes ALL THREE off to break it. Do not replace this with a fourth
# exclusive attribution.
#
# THE METHOD NOTE THAT MATTERS, because it is why two drafts got this wrong:
# **in a conjunction, single-condition mutation cannot, on its own, establish
# which condition guards a property.** When MORE THAN ONE condition is
# independently sufficient — as all three are here — NO singleton can red the
# test, so every singleton looks harmless and the exclusive story built from
# that is false. (With exactly one sufficient condition the singleton DOES red,
# and does attribute; you cannot know which case you are in without measuring.)
# Attribution needs the SUBSET LATTICE. Singletons plus one triple will fit an
# exclusive story that is false.
#
# Each condition still earns its keep on a DIFFERENT population, and that is
# what the tests pin:
#   * Condition 3 — an in-repo config path (W9) and a relative config path
#     (W9b). Turning it off reds both; those are its own population, not the
#     agent surface.
#   * Condition 4 — the mcp shape divergences: env-only (W4a), args+env (W4b),
#     and a reason with no key list at all (W6). Deleting the whole condition
#     reds W4a/W4b/W6 and leaves W5/W5b green.
#   * Condition 2 — no reachable red state today; turning it off alone reds
#     NOTHING. Kept as defence-in-depth against a FUTURE surface that starts
#     printing `differing key(s)`. It cannot be pinned until such an emitter
#     exists, and it must not be described as the protection.
#
# WHAT THIS DELIBERATELY STOPS CATCHING (the residual gap, stated plainly).
# While >=2 live worktrees exist, an `args`/`command`-only MCP drift naming a
# path in NEITHER worktree is also exempted at commit time. Compensating
# surface: `igris doctor` reports it as drift class `mcp-unregistered` via
# `inspectMcpRegistration`'s `pathExists` check. TWO SCOPE QUALIFIERS ON THAT
# CLAIM, both measured, both easy to over-read — and the second one leaves a
# member of the exempted class covered by NEITHER surface:
#   * CLAUDE-ONLY. `inspectMcpRegistration` performs exactly one config read —
#     `opts?.claudeJsonPath ?? claudeJsonPath()` — and no gemini/codex/opencode/
#     antigravity reader appears in it or in doctor's `mcp-unregistered` branch.
#     For every OTHER harness that declares an `mcp` block in the descriptor,
#     this case is visible in the WORKTREE NOTICE on every commit and is fatal
#     nowhere.
#     (retired: until BR-103, `--fix` discounted this class; `runDoctor` now
#     re-probes it through `reprobe()` in `cli/src/verbs/doctor.ts`, so `--fix`
#     exits 1 when the row did not clear)
#   * PATH-ABSENT-ONLY — the qualifier that matters, because it is the one case
#     the sentence above covers that NOTHING detects. Doctor's row is the
#     `mcp-unregistered` push in `classifyDriftAll` (cli/src/verbs/doctor.ts),
#     guarded by `!mcp.registered || !mcp.pathExists`, and `pathExists` is
#     `inspectMcpRegistration`'s `existsSync(entryPath)`
#     (cli/src/lib/mcp-register.ts), so doctor reports the named path only
#     when that path is ABSENT. "A path in NEITHER worktree" is a wider class
#     than that: nothing constrains an
#     out-of-repo path to sit inside a git worktree, so the class also contains
#     paths that EXIST (a second clone, a checkout dropped from `git worktree
#     list` but still on disk, a ~/.igris-resident build). For those, the
#     wrapper exempts — the config is out-of-repo, `differing key(s): args`, a
#     live sibling exists, and this classifier never inspects the args VALUE by
#     design (it parses key NAMES out of the reason line, and the `DRIFTED:*)`
#     arm of `verify_mcp_entry_drift` prints "no values shown" rather than the
#     value) — while inspectMcpRegistration returns
#     `{registered: true, pathExists: true}` and doctor emits no row. Stated
#     plainly: an `args`/`command`-only drift naming an EXISTING out-of-repo
#     path is reported by neither the commit gate nor doctor. NOTE the
#     per-harness `pathExists` sweep named below does NOT cover this member
#     either — it widens the row to non-claude configs but stays an existence
#     test. Reporting an existing-but-wrong path would need the entry path
#     COMPARED against the expected artifact, and doctor.ts never reads
#     `entryPath` at all (measured: `grep -n entryPath cli/src/verbs/doctor.ts`
#     -> 0 hits; the identifier DOES occur elsewhere in cli/src — tarball.ts
#     and init.ts use it for an unrelated tar-entry path — so the scope of
#     this claim is doctor.ts, not the tree). The field is already returned
#     (`McpInspectResult.entryPath`), so such a check needs a comparison, not
#     new plumbing.
# Closing the gap here would require this wrapper to read the config VALUES,
# i.e. a second copy of the per-harness MCP shape grammar that
# `normalize_mcp_shape` owns (§18.1 / §18.4) — a worse trade than the stated
# limit. A per-harness `pathExists` sweep in doctor is the legitimate follow-up
# for the CLAUDE-ONLY qualifier; it does not address PATH-ABSENT-ONLY.
#
# HARNESS COVERAGE OF THE EXEMPTION ITSELF. The predicate reads only the block
# NAME prefix, the config path and the reason text, so it is harness-agnostic BY
# CONSTRUCTION — but every fixture in the suite, and the live gate on this
# machine, exercise the CLAUDE path. No non-claude harness has been driven
# through the exemption. Stated as a coverage limit, not implied as coverage.
#
# Escape hatch: IGRIS_DRIFT_STRICT_WORKTREE=1 disables the exemption entirely.
# Single-worktree machines — every consumer, and CI — behave as they did before
# TD-388. That conclusion needs BOTH of TD-388's changes accounted for, because
# only ONE of them is gated on condition 1:
#   * The EXEMPTION cannot fire: condition 1 (>=1 live sibling) is false, so
#     every DRIFTED takes the fatal branch exactly as before.
#   * Teaching pathline_re the `config` label (the classifier's `pathline_re`)
#     is gated on NOTHING.
#     It gives mcp/* blocks a non-empty `path`, and that variable's other
#     consumer is `is_project_relative(path)` on the MISSING branch, which
#     condition 1 does not guard. It is a no-op there for any config OUTSIDE
#     the repo: before, an mcp/* MISSING classified with path="" and
#     is_project_relative("") is False -> oos_missing; after, it classifies
#     with the resolved config path, still not under REPO_ROOT -> still
#     oos_missing. W8 measures exactly that. The no-op is scoped to out-of-repo
#     configs, which is every config a real checkout has: all 6 `mcp.config_path`
#     values in harness-manifest.json are `~`-anchored (measured). An IN-REPO
#     mcp config is reachable only through the IGRIS_MCP_*_CONFIG test seam
#     (read-only, drift-side: compile refuses its MCP pass under it — TD-390).
# =========================================================================
#
# Fail-open on a fresh clone WITHOUT the adapter layer:
#   If check_harness_drift.sh or the manifest is missing (e.g. a partial
#   checkout, or a project that never installed the cli-adapters), this wrapper
#   exits 0 with an explanatory message rather than hard-crashing the commit
#   hook. The guard's MISSING/DRIFTED verdict is only authoritative when the
#   guard itself is present to render it.

# ---------------------------------------------------------------------------
# Resolve the repo root. Prefer git; fall back to walking up from this script.
# ---------------------------------------------------------------------------
if REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

# ---------------------------------------------------------------------------
# TD-388: discover every worktree git knows about (this one included). The
# classifier filters it down to LIVE SIBLINGS (dir exists on disk AND realpath
# != REPO_ROOT) — see the MULTI-WORKTREE block above.
#
# TD-345 / §3 NOTE: `awk` reads its input to EOF, so this is NOT a pipefail
# SIGPIPE short-circuit site. Do NOT "tidy" it into `grep -q` or `head` — a
# short-circuiting consumer here could orphan `printf` and report a false
# "no worktrees", which would silently make the exemption disappear.
# The `if` consumes git's exit status so a non-git invocation cannot trip
# `set -e` (fail-open, matching the guard/manifest checks below).
# ---------------------------------------------------------------------------
live_worktrees=""
if wt_raw="$(git worktree list --porcelain 2>/dev/null)"; then
  live_worktrees="$(printf '%s\n' "$wt_raw" | awk '/^worktree /{print substr($0,10)}')"
fi

GUARD="$REPO_ROOT/core/scripts/cli-adapters/check_harness_drift.sh"
# FR-136: the project manifest lives at the repo root (not under core/).
MANIFEST="$REPO_ROOT/harness-manifest.json"

# ---------------------------------------------------------------------------
# Fail-open if the adapter layer is not present in this checkout.
# ---------------------------------------------------------------------------
if [ ! -f "$GUARD" ]; then
  echo "[harness-drift] guard not found: $GUARD"
  echo "[harness-drift] skipping drift check (adapter layer not installed)."
  exit 0
fi
if [ ! -f "$MANIFEST" ]; then
  echo "[harness-drift] manifest not found: $MANIFEST"
  echo "[harness-drift] skipping drift check (no harness manifest)."
  exit 0
fi

# ---------------------------------------------------------------------------
# Run the guard ONCE against the repo-root manifest (FR-136). The manifest now
# declares only the agents that belong in this repo, so no per-agent filtering
# is needed. We capture the self-evidencing report AND the guard's exit status,
# and classify each per-target verdict block (the full token set is the
# VERDICT VOCABULARY block above) by its class and resolved path: DRIFTED is
# fatal (with the ONE narrow TD-388 sibling-worktree exemption documented in
# the MULTI-WORKTREE block above); MISSING is fatal ONLY for project-relative
# targets (home/absolute-path targets are out of the gate's scope — see the
# SCOPING block above); DRIFT-WARN, SCHEMA-INVALID and PARITY are always fatal;
# and the FAIL-CLOSED FLOOR makes any failure the guard counted but no verdict
# line explains fatal too. This wrapper passes no --surface, so the
# project-relative classification is done HERE, from the resolved paths in the
# report.
# ---------------------------------------------------------------------------
# The `|| guard_rc=$?` keeps a non-zero exit from aborting under set -e before
# the report is classified — and, since TD-396, KEEPS that exit status: it is
# the floor's input (IGRIS_DRIFT_GUARD_RC below).
report=""
guard_rc=0
report="$(bash "$GUARD" --project-root "$REPO_ROOT" \
      --manifest "$MANIFEST" 2>&1)" || guard_rc=$?
# Echo the guard's self-evidencing report through so the surface stays
# auditable.
printf '%s\n' "$report"

# Classify verdicts via python3 (python3 is a guaranteed dependency). For each
# `[name] VERDICT` block we resolve the target's on-disk path from the block's
# path line (harness/artifact/artifact dir/config) and decide:
#   - DRIFTED, mcp/*, out-of-repo config, ONLY args|command differ,
#     and >=1 live sibling worktree  -> WORKTREE NOTICE (not fatal).
#   - DRIFTED (anything else)        -> always fatal.
#   - MISSING, path under REPO_ROOT  -> fatal (you forgot to compile).
#   - MISSING, home/absolute path    -> out-of-scope NOTICE (not fatal).
#   - DRIFT-WARN / SCHEMA-INVALID / PARITY -> always fatal, named.
#   - MATCH / NOTE / SKIP            -> no action (NOTE/SKIP end a block).
#   - then the FAIL-CLOSED FLOOR reconciliation (header) -> `unattributed`.
# OUTPUT PROTOCOL (TD-396) — the classifier prints SEVEN LINES:
#   1. eight integers: <fatal_drifted> <fatal_missing> <fatal_driftwarn>
#      <fatal_schema> <fatal_parity> <oos_missing> <oos_worktree> <unattributed>
#   2. `;`-joined config path(s) of the worktree-exempted blocks (may be empty)
#   3. `;`-joined live SIBLING worktree paths (may be empty)
#   4. the unattributed reason, one line (empty when unattributed = 0)
#   5. `;`-joined DRIFT-WARN block names (e.g. `forger/gemini`)
#   6. `;`-joined SCHEMA-INVALID block names
#   7. `;`-joined PARITY block names (e.g. `mcp/<name>/<harness>`)
# Lines 2-3 carry PATHS ONLY — never a key list, and never a config VALUE.
# Lines 5-7 carry block NAMES only. The bash side validates line 1 as exactly
# eight non-negative integers; anything else is a TD-188 FATAL, never a pass.
# The classifier is written to a temp script and run as `python3 <file>` so the
# heredoc (which contains parens and apostrophes) is NOT nested inside a `$(...)`
# command substitution — bash's command-substitution tokenizer mis-parses such
# nesting (SC2259-adjacent), causing "unexpected EOF". The report is passed via
# an env var to avoid stdin/heredoc collisions.
CLASSIFIER="$(mktemp "${TMPDIR:-/tmp}/igris_drift_classify.XXXXXX.py")"
trap 'rm -f "$CLASSIFIER"' EXIT
cat > "$CLASSIFIER" <<'PY'
import os
import re
import sys

repo_root = os.path.realpath(sys.argv[1])
report = os.environ.get("IGRIS_DRIFT_REPORT", "").splitlines()

# TD-396: the guard's exit status — the floor's input. An unreadable value is
# None, which the floor treats as a failure it cannot attribute, never as 0.
_rc_raw = os.environ.get("IGRIS_DRIFT_GUARD_RC", "")
guard_rc = int(_rc_raw) if re.fullmatch(r"[0-9]+", _rc_raw) else None

# TD-388 inputs. STRICT (any non-empty value) disables the exemption outright.
strict_worktree = os.environ.get("IGRIS_DRIFT_STRICT_WORKTREE", "") != ""
worktrees_raw = os.environ.get("IGRIS_DRIFT_WORKTREES", "")

# The ONLY keys a worktree-exempt divergence may name. Both can carry a
# build-artifact PATH: `args` in the claude/gemini/codex shape, `command` when
# an `add-mcp "node <path>"` registration fuses the path into it (opencode's
# native shape does the same). Anything else — env.*, type, enabled, an
# unlisted key — is a SHAPE divergence and stays fatal.
PATH_KEYS = frozenset(("args", "command"))

# TD-396: the guard's FULL token set (the VERDICT VOCABULARY header block). A
# token missing here still fails closed through the floor, but unnamed.
verdict_re = re.compile(
    r"^\s*\[(?P<name>[^\]]+)\]\s+"
    r"(?P<verdict>MATCH|DRIFTED|MISSING|DRIFT-WARN|SCHEMA-INVALID|PARITY|NOTE|SKIP)\b"
    r"(?:\s+\S+\s+(?P<rest>.*))?$"
)
# TD-396: the guard's summary counters (printed after "  ----"). Matched on the
# digits and the fixed words, NOT on the em-dash, so a locale that mangles the
# dash cannot silently drop the counters. The wording is a contract: see the
# COUPLING note in the FAIL-CLOSED FLOOR header block.
summary_re = re.compile(
    r"^\s*(?P<total>[0-9]+) targets \S+ (?P<match>[0-9]+) in sync, "
    r"(?P<drift>[0-9]+) drifted/missing\s*$"
)
parity_count_re = re.compile(r"^\s*(?P<n>[0-9]+) parity violation\(s\)")
schema_count_re = re.compile(r"^\s*(?P<n>[0-9]+) schema-invalid target\(s\)")
# The one no-verdict-line failure the guard names on stderr (named in the
# unattributed reason so the FATAL line points at it).
delegate_fail_re = re.compile(r"^DRIFT skills \(delegate\)")
# TD-388 added `config` (the label verify_mcp_entry_drift prints). Before that
# every mcp/* block classified with path="" — see the W8 no-op regression test.
# `target` is deliberately NOT here: agent blocks must keep path="" so they can
# never satisfy is_out_of_repo() below.
pathline_re = re.compile(
    r"^\s*(?P<label>harness|artifact dir|artifact|config)\s*:\s*(?P<path>\S.*)$"
)
reason_re = re.compile(r"^\s*reason\s*:\s*(?P<reason>\S.*)$")
# `… differing key(s): args,command — run `igris harness compile` …`
# The em-dash-delimited hint after the list is not part of the key list.
diffkeys_re = re.compile(
    "differing key\\(s\\):\\s*(?P<keys>.+?)(?:\\s+—\\s+|$)"
)


def is_project_relative(path):
    """True if the resolved path lives under the repo root."""
    if not path:
        return False
    rp = os.path.realpath(path)
    try:
        return os.path.commonpath([rp, repo_root]) == repo_root
    except ValueError:
        return False


def is_out_of_repo(path):
    """True only for a NON-EMPTY, ABSOLUTE path that is outside the repo root.

    NOT the inverse of is_project_relative(): is_project_relative("") is False,
    so `not is_project_relative(path)` reads every PATH-LESS block as
    out-of-repo, and every AGENT DRIFTED block is path-less here (
    verify_md_agent_symlink_drift prints `target :` / `expected :`, labels
    pathline_re does not match).

    THIS IS NOT WHAT HOLDS THE AGENT SURFACE — and neither is any other single
    condition. See the SUFFICIENCY LATTICE in the MULTI-WORKTREE header block:
    conditions 2, 3 and 4 are each independently sufficient to reject an agent
    DRIFTED block, so turning any ONE of them off (this one included) leaves
    W5/W5b GREEN, and it takes all three off to red them. Two earlier drafts of
    this docstring named a single guard; both were refuted by mutation. Do not
    write a third.

    WHAT THIS FUNCTION DOES GUARD — its own population, in two halves, each
    with its own behavioural pair:
      * "outside REPO_ROOT" — a config living INSIDE the repo. Same args-only
        drift, same live sibling, only the config LOCATION varies: real wrapper
        exits 1 FATAL, a cond-3-disabled wrapper exits 0 with a NOTICE. Test W9.
      * "ABSOLUTE" — the clause that actually separates this function from
        `not is_project_relative(path)`, since the two agree on every absolute
        path. A relative config path that resolves outside the repo is an
        ACCEPTED INPUT to the guard (IGRIS_MCP_CLAUDE_CONFIG is read as given;
        every default is absolute, and it is documented only as the test-sandbox
        seam — so this is an input class, not an observed operator practice). It
        is deliberately NOT trusted: a path that cannot be resolved
        independently of the caller's cwd stays FATAL, where the naive inversion
        resolves it against cwd and exempts it. Test W9b.
    Turning this condition off reds W9 and W9b and nothing else — that is the
    accurate statement of its contribution.
    """
    if not path:
        return False
    if not os.path.isabs(path):
        return False
    rp = os.path.realpath(path)
    try:
        return os.path.commonpath([rp, repo_root]) != repo_root
    except ValueError:
        # Different roots entirely — outside by definition.
        return True


def live_sibling_worktrees():
    """Registered worktrees that EXIST on disk and are not this repo root.

    The isdir test (not the porcelain `prunable` field) is what makes a
    half-removed worktree stop counting, so a stale registration cannot keep
    the exemption alive forever.
    """
    out = []
    seen = set()
    for line in worktrees_raw.splitlines():
        if not line or not os.path.isdir(line):
            continue
        rp = os.path.realpath(line)
        if rp == repo_root or rp in seen:
            continue
        seen.add(rp)
        out.append(rp)
    return out


def parse_differing_keys(reason):
    """The reason line's `differing key(s):` list, or None when it has none.

    None (no such clause) is NOT the empty set — it means the DRIFTED has a
    reason this exemption cannot reason about (unparseable config, internal
    compare error, MISSING_SECRET, every agent/skills reason), so it stays
    fatal.
    """
    if not reason:
        return None
    m = diffkeys_re.search(reason)
    if not m:
        return None
    keys = [k.strip() for k in m.group("keys").split(",")]
    keys = [k for k in keys if k]
    return keys or None


SIBLING_WORKTREES = live_sibling_worktrees()


def strip_paren(text):
    return re.sub(r"\s*\(.*\)\s*$", "", text).strip()


def extract_inline_path(rest):
    # Some MISSING reasons inline the path after a colon, e.g.
    # "canonical file absent: /abs/path".
    if rest and ":" in rest:
        cand = strip_paren(rest.rsplit(":", 1)[1].strip())
        if cand.startswith(("/", "~")):
            return os.path.expanduser(cand)
    return ""


fatal_drifted = 0
fatal_missing = 0
fatal_driftwarn = 0
fatal_schema = 0
fatal_parity = 0
oos_missing = 0
oos_worktree = 0
worktree_configs = []
driftwarn_names = []
schema_names = []
parity_names = []

# TD-396: the guard's own counters. They print after every block, so they are
# read in a separate pass. Absent -> None (summary) / 0 (P and S only print
# when non-zero).
summary_drift = None
parity_total = 0
schema_total = 0
delegate_failures = 0
for line in report:
    sm = summary_re.match(line)
    if sm:
        summary_drift = int(sm.group("drift"))
    pm = parity_count_re.match(line)
    if pm:
        parity_total = int(pm.group("n"))
    xm = schema_count_re.match(line)
    if xm:
        schema_total = int(xm.group("n"))
    if delegate_fail_re.match(line):
        delegate_failures += 1

i = 0
n = len(report)
while i < n:
    m = verdict_re.match(report[i])
    if not m:
        i += 1
        continue
    name = m.group("name")
    verdict = m.group("verdict")
    rest = m.group("rest") or ""
    # Resolve this block's path: prefer an inline path in the verdict line,
    # else scan following indented path lines until the next verdict block.
    # The same scan captures the block's `reason` line (TD-388 condition 4).
    # Since TD-396 a PARITY / NOTE / SKIP / DRIFT-WARN line also ENDS the
    # previous block (they match verdict_re); a block keeps its FIRST reason,
    # so no later block's key clause can move into a DRIFTED block.
    path = extract_inline_path(rest)
    reason = ""
    j = i + 1
    while j < n and not verdict_re.match(report[j]):
        pm = pathline_re.match(report[j])
        if pm and not path:
            path = os.path.expanduser(strip_paren(pm.group("path").strip()))
        rm = reason_re.match(report[j])
        if rm and not reason:
            reason = rm.group("reason").strip()
        j += 1

    if verdict == "DRIFTED":
        # TD-388: the sibling-worktree exemption. All four conditions, in the
        # order they are documented in the MULTI-WORKTREE header block.
        keys = parse_differing_keys(reason)
        if (
            not strict_worktree
            and SIBLING_WORKTREES                       # 1. live sibling
            and name.startswith("mcp/")                 # 2. mcp block
            and is_out_of_repo(path)                    # 3. out-of-repo config
            and keys is not None                        # 4. path keys only
            and set(keys) <= PATH_KEYS
        ):
            oos_worktree += 1
            if path not in worktree_configs:
                worktree_configs.append(path)
        else:
            fatal_drifted += 1
    elif verdict == "MISSING":
        if is_project_relative(path):
            fatal_missing += 1
        else:
            oos_missing += 1
    elif verdict == "DRIFT-WARN":
        # A real-file copy of a hard-linked target: never downgraded.
        fatal_driftwarn += 1
        driftwarn_names.append(name)
    elif verdict == "SCHEMA-INVALID":
        fatal_schema += 1
        schema_names.append(name)
    elif verdict == "PARITY":
        # TD-451: its OWN branch — it never reaches the DRIFTED branch, so the
        # TD-388 exemption is never consulted for it.
        fatal_parity += 1
        parity_names.append(name)
    # MATCH / NOTE / SKIP: no action.
    i = j

# ---- TD-396: the FAIL-CLOSED FLOOR (argued in the header block) ------------
unattributed = 0
reasons = []
if guard_rc is None:
    rc_text = "an unreadable status"
else:
    rc_text = str(guard_rc)
if summary_drift is not None:
    attributed = (fatal_drifted + oos_worktree) + (fatal_missing + oos_missing) \
        + fatal_driftwarn
    gap = max(0, summary_drift - attributed)
    if gap:
        unattributed += gap
        why = f"{gap} drifted/missing count(s) with no DRIFTED, MISSING or DRIFT-WARN line"
        if delegate_failures:
            why += (f"; {delegate_failures} 'DRIFT skills (delegate)' re-check "
                    "failure(s) in the guard output")
        reasons.append(why)
    gap = max(0, parity_total - fatal_parity)
    if gap:
        unattributed += gap
        reasons.append(f"{gap} parity violation(s) with no PARITY line")
    gap = max(0, schema_total - fatal_schema)
    if gap:
        unattributed += gap
        reasons.append(f"{gap} schema-invalid target(s) with no SCHEMA-INVALID line")
elif guard_rc != 0:
    unattributed += 1
    reasons.append(f"guard exited {rc_text} before rendering a summary")
if guard_rc is None or guard_rc not in (0, 1):
    if unattributed == 0:
        unattributed = 1
    reasons.append(f"guard exit {rc_text} is not a verdict exit (0 or 1)")
# Belt: a non-zero exit with nothing fatal and nothing downgraded.
fatal_total = fatal_drifted + fatal_missing + fatal_driftwarn + fatal_schema \
    + fatal_parity
if guard_rc != 0 and fatal_total == 0 and oos_missing + oos_worktree == 0 \
        and unattributed == 0:
    unattributed = 1
    reasons.append(f"guard exited {rc_text} with no failing verdict line")

print(f"{fatal_drifted} {fatal_missing} {fatal_driftwarn} {fatal_schema} "
      f"{fatal_parity} {oos_missing} {oos_worktree} {unattributed}")
print(";".join(worktree_configs))
print(";".join(SIBLING_WORKTREES))
print(" ".join("; ".join(reasons).split()))
print(";".join(driftwarn_names))
print(";".join(schema_names))
print(";".join(parity_names))
PY

# TD-388: the worktree list goes through a dedicated ENV VAR (newline-joined),
# never argv, so a path containing spaces survives intact. TD-396: the guard's
# exit status rides the same way (IGRIS_DRIFT_GUARD_RC, set HERE so a value
# inherited from the caller can never reach the floor).
# TD-188: a classifier crash (traceback on stderr, non-zero exit) used to abort
# under set -e with no gate-tagged line; it now names itself. The `||` keeps
# set -e from firing first; `$?` inside the group is python3's exit status.
classification="$(IGRIS_DRIFT_REPORT="$report" \
  IGRIS_DRIFT_GUARD_RC="$guard_rc" \
  IGRIS_DRIFT_WORKTREES="$live_worktrees" \
  IGRIS_DRIFT_STRICT_WORKTREE="${IGRIS_DRIFT_STRICT_WORKTREE:-}" \
  python3 "$CLASSIFIER" "$REPO_ROOT")" || {
  classifier_rc=$?
  echo ""
  echo "[harness-drift] FATAL: classifier failed to parse guard report (python3 exit $classifier_rc)"
  exit 1
}
rm -f "$CLASSIFIER"
trap - EXIT
# Seven lines out — the OUTPUT PROTOCOL documented above the heredoc.
# (bash 3.2 — no mapfile; a grouped read is the portable form.)
counts_line=""
worktree_configs=""
worktree_siblings=""
unattributed_reason=""
driftwarn_names=""
schema_names=""
parity_names=""
{
  IFS= read -r counts_line || true
  IFS= read -r worktree_configs || true
  IFS= read -r worktree_siblings || true
  IFS= read -r unattributed_reason || true
  IFS= read -r driftwarn_names || true
  IFS= read -r schema_names || true
  IFS= read -r parity_names || true
} <<< "$classification"
fatal_drifted=""
fatal_missing=""
fatal_driftwarn=""
fatal_schema=""
fatal_parity=""
oos_missing=""
oos_worktree=""
unattributed=""
counts_extra=""
read -r fatal_drifted fatal_missing fatal_driftwarn fatal_schema fatal_parity \
  oos_missing oos_worktree unattributed counts_extra <<< "$counts_line" || true

# TD-188: exactly eight non-negative integers, or FATAL. Before this, an EMPTY
# classification (a classifier that exited 0 having printed nothing) reached
# `[ "" -gt 0 ]`, which is false with an "integer expression expected"
# message, so every section below was skipped and the gate exited 0.
# bash 3.2: `case` globs, no `[[ =~ ]]` needed.
for _count in "$fatal_drifted" "$fatal_missing" "$fatal_driftwarn" \
    "$fatal_schema" "$fatal_parity" "$oos_missing" "$oos_worktree" \
    "$unattributed"; do
  case "$_count" in
    ''|*[!0-9]*)
      echo ""
      echo "[harness-drift] FATAL: classifier produced malformed counts (line 1: '$counts_line')"
      exit 1
      ;;
  esac
done
if [ -n "$counts_extra" ]; then
  echo ""
  echo "[harness-drift] FATAL: classifier produced malformed counts (line 1: '$counts_line')"
  exit 1
fi

# print_named <;-joined names> <verdict> — one indented line per block name.
# `tr` + `while read` (not an unquoted `for`), so a name is never globbed.
print_named() {
  local _names="$1" _verdict="$2" _nm
  while IFS= read -r _nm; do
    [ -n "$_nm" ] || continue
    echo "[harness-drift]   [$_nm] $_verdict"
  done <<< "$(printf '%s' "$_names" | tr ';' '\n')"
}

# ---------------------------------------------------------------------------
# Verdict aggregation. NOTICEs first; then EVERY FATAL section that applies
# (TD-396: the script used to exit after the first one), then ONE exit.
# ---------------------------------------------------------------------------
fatal_any=0

if [ "$oos_missing" -gt 0 ]; then
  # Home/absolute-path targets (e.g. the gemini skills ~/.gemini/commands
  # surface) that are MISSING are out of the gate's scope — surface as a NOTICE
  # so they are never silently forgotten, but do NOT block the commit.
  echo ""
  echo "[harness-drift] NOTICE: $oos_missing out-of-scope (home/absolute-path) harness target(s) MISSING — not projected on this machine. These are excluded from the commit gate (e.g. the gemini ~/.gemini/commands skills surface)."
fi

if [ "$oos_worktree" -gt 0 ]; then
  # TD-388: an MCP entry whose ONLY divergence is a build-artifact path key,
  # in a config OUTSIDE this repo, while >=1 live sibling worktree exists.
  # Non-blocking, but printed on EVERY commit so the state is never invisible.
  echo ""
  echo "[harness-drift] WORKTREE NOTICE: $oos_worktree MCP entry/entries DRIFTED on a build-artifact path key only (args/command) — NOT fatal."
  echo "[harness-drift]   config(s)       : ${worktree_configs//;/, }"
  echo "[harness-drift]   live worktree(s): ${worktree_siblings//;/, }"
  echo "[harness-drift]   this worktree   : $REPO_ROOT"
  echo "[harness-drift] These configs are HOME-anchored and SHARED by every worktree, so the MCP server is served from whichever worktree wrote this config last."
  echo "[harness-drift] DO NOT run \`igris harness compile --project-root .\` to 'fix' this: it re-points the shared config at THIS worktree and will move the MCP server away from the other session."
  echo "[harness-drift] What this does not leave uncovered: a config naming a path that no longer exists. This gate excuses that too — \`igris doctor\` is what reports it, as \`mcp-unregistered\` (claude configs only, and only when the path is ABSENT; see the MULTI-WORKTREE block in this script for both stated limits)."
  echo "[harness-drift] Set IGRIS_DRIFT_STRICT_WORKTREE=1 to make these fatal again."
fi

if [ "$fatal_drifted" -gt 0 ]; then
  # DRIFTED is always fatal — a harness exists but its body diverged.
  echo ""
  echo "[harness-drift] FATAL: $fatal_drifted harness(es) DRIFTED from canonical."
  echo "[harness-drift] A harness body diverged from its canonical prompt. Regenerate:"
  echo "[harness-drift]   igris harness compile --project-root ."
  echo "[harness-drift]   (or bash core/scripts/cli-adapters/compile_harnesses.sh --project-root .), then re-stage."
  fatal_any=1
fi

if [ "$fatal_missing" -gt 0 ]; then
  # FR-138: MISSING for a project-relative target is fatal again — codex is
  # un-gated, so a missing .codex/agents/*.toml means you forgot to compile.
  echo ""
  echo "[harness-drift] FATAL: $fatal_missing project-relative harness(es) MISSING — you forgot to compile. Regenerate:"
  echo "[harness-drift]   igris harness compile --project-root ."
  echo "[harness-drift]   (or bash core/scripts/cli-adapters/compile_harnesses.sh --project-root .), then re-stage."
  fatal_any=1
fi

if [ "$fatal_driftwarn" -gt 0 ]; then
  # TD-396: a hard-linked harness target replaced by a real-file copy. The
  # content matches the loadout TODAY, but the copy stops tracking it at the
  # next re-vendor — never downgraded. The remedy re-links ONE target through
  # the agents surface only; it touches no MCP, skills or hook config.
  echo ""
  echo "[harness-drift] FATAL: $fatal_driftwarn DRIFT-WARN — a hard-linked harness target is a real-file COPY (content matches the loadout, but it no longer tracks it)."
  while IFS= read -r _nm; do
    [ -n "$_nm" ] || continue
    echo "[harness-drift]   [$_nm] DRIFT-WARN — re-link that target alone:"
    case "$_nm" in
      */*) echo "[harness-drift]     bash core/scripts/cli-adapters/compile_harnesses.sh --project-root . --surface agents --target ${_nm##*/} --filter ${_nm%/*}" ;;
      *)   echo "[harness-drift]     (no <agent>/<harness> name to build a targeted command from; see the block above)" ;;
    esac
  done <<< "$(printf '%s' "$driftwarn_names" | tr ';' '\n')"
  echo "[harness-drift] Do NOT run a full \`igris harness compile\` for this while a sibling worktree is live: it rewrites the SHARED home-anchored configs and moves the other session's MCP server (TD-388)."
  fatal_any=1
fi

if [ "$fatal_schema" -gt 0 ]; then
  # TD-396: present + drift-clean, but the target harness refuses to load it.
  echo ""
  echo "[harness-drift] FATAL: $fatal_schema SCHEMA-INVALID — a projected harness file its harness refuses to load:"
  print_named "$schema_names" "SCHEMA-INVALID"
  echo "[harness-drift] Fix what each block's reason names (its fix line gives the override), then re-stage."
  fatal_any=1
fi

if [ "$fatal_parity" -gt 0 ]; then
  # TD-451: a property of the committed manifest (or the personal overlay),
  # not of this machine — FATAL, argued in the PARITY AT THE GATE block.
  echo ""
  echo "[harness-drift] FATAL: $fatal_parity PARITY — a descriptor block dropped a projected harness its sibling blocks declare (FR-217 M4):"
  print_named "$parity_names" "PARITY"
  echo "[harness-drift] Add the missing harness to that block's targets[] in harness-manifest.json (or the personal overlay), then re-stage. Every checkout reproduces this; it is not machine state."
  fatal_any=1
fi

if [ "$unattributed" -gt 0 ]; then
  # TD-396: the FAIL-CLOSED FLOOR. The guard counted (or exited on) a failure
  # that no verdict line explains — never passed, even beside a NOTICE.
  echo ""
  echo "[harness-drift] FATAL: guard exited $guard_rc — $unattributed failure(s) not attributable to a verdict line ($unattributed_reason)."
  echo "[harness-drift] The gate fails closed (TD-396): read the guard output above for the failure it did not render as a verdict."
  fatal_any=1
fi

if [ "$fatal_any" -eq 1 ]; then
  exit 1
fi
exit 0
