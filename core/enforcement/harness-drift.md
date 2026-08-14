---
obligation: "Harness parity — committed per-harness artifacts must match the canonical sources"
mechanism: gate
status: shipped
lives_in: "scripts/validate_harness_drift.sh"
summary: "Pre-commit harness-drift validator fails when a staged harness artifact (skills/agents/identity/MCP projection) diverges from its canonical source — with ONE measured exemption since TD-388: an mcp/* entry whose only divergence is a build-artifact path key (args/command), in an out-of-repo config, while a live sibling git worktree exists, is a non-blocking WORKTREE NOTICE instead."
---

# Harness drift (FR-135 / TD-021)

When a commit touches harness-related surfaces, the pre-commit harness-drift
validator confirms the committed per-harness artifacts (generated identity files,
projected configs) still match their single canonical sources — the L-519
Igris-owned-topology guarantee. The compile-time companion verifier lives at
`core/scripts/cli-adapters/check_harness_drift.sh`.

## What the gate proves, and the one thing it deliberately no longer catches

**Proves.** Every DRIFTED verdict is fatal, and a MISSING project-relative
target is fatal. That is unconditional for the agents and skills surfaces —
including the 18 home-anchored agent target rows (gemini ×9, opencode ×9 of the
27 rows in `harness-manifest.json` `agents[].targets[]`), whose verdicts are
inode/symlink identity against the SHARED `~/.igris/loadout/` and therefore
identical in every worktree.

**Deliberately does not catch (TD-388).** The harness MCP configs
(`~/.claude.json`, and the native config of every other harness that declares
an `mcp` block in `harness-manifest.json`) are home-anchored and shared by every
worktree, while the entry they hold names a build artifact inside ONE checkout.
With N worktrees, N−1 could not commit at all — and the gate's own remedy,
`igris harness compile`, would rewrite the shared config and re-point the other
worktree's live session. So an `mcp/*` DRIFTED is downgraded to a non-blocking
**WORKTREE NOTICE** iff all four hold: ≥1 LIVE sibling worktree exists, the block
is `mcp/*`, its config path is non-empty/absolute/outside the repo, and the
reason's `differing key(s)` list is a non-empty subset of `{args, command}`.
`IGRIS_DRIFT_STRICT_WORKTREE=1` restores full strictness.

**The residual gap and its compensating surface.** While ≥2 live worktrees
exist, an `args`/`command`-only drift naming a path in NEITHER worktree is also
exempted at commit time. `igris doctor` catches PART of that class as drift
class `mcp-unregistered` (`inspectMcpRegistration`'s `pathExists` check) — under
**three** scope qualifiers, all easy to over-read, and the third leaves a member
of the class covered by neither surface:

- **Claude-only.** That reader opens `~/.claude.json` and no other harness
  config. For every OTHER harness that declares an `mcp` block in
  `harness-manifest.json`, the state is printed in the NOTICE on every commit
  and is fatal nowhere.
- **Default-run-only.** The exit-1 half holds for a plain `igris doctor`. Under
  `--fix`, `mcp-unregistered` is discounted from the non-clean set, so
  `igris doctor --fix` can exit 0 having reported the row.
- **Path-absent-only.** Doctor's row fires on
  `!mcp.registered || !mcp.pathExists` (`cli/src/verbs/doctor.ts:497`), and
  `pathExists` is `existsSync(entryPath)` (`cli/src/lib/mcp-register.ts:1630`)
  — so doctor reports the named path only when that path is **absent**. "A path
  in neither worktree" is a wider class: nothing constrains an out-of-repo path
  to sit inside a git worktree, so it also contains paths that **exist** (a
  second clone, a checkout dropped from `git worktree list` but still on disk, a
  `~/.igris`-resident build). For that member the gate exempts — the classifier
  never inspects the `args` VALUE by design, and `check_harness_drift.sh:845`
  prints `no values shown` — while `inspectMcpRegistration` returns
  `{registered: true, pathExists: true}` and doctor emits no row. Stated
  plainly: **an `args`/`command`-only drift naming an EXISTING out-of-repo path
  is reported by neither the commit gate nor `igris doctor`.** The per-harness
  `pathExists` sweep below does not cover it either — that widens the row to
  non-claude configs but stays an existence test; reporting an existing-but-wrong
  path needs the entry path COMPARED against the expected artifact, and
  `doctor.ts` never reads `entryPath` at all.

**Coverage limit of the exemption itself.** The predicate reads only the block
name, the config path and the reason text, so it is harness-agnostic by
construction — but every test fixture, and the live gate, exercise the claude
path only. No non-claude harness has been driven through it. A per-harness
`pathExists` sweep in doctor is the follow-up for the **claude-only** qualifier
(it does not address **path-absent-only**); the exemption's dependence on that
check is recorded as a contract row in `MAINTAINING.md`.
