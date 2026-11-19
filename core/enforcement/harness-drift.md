---
obligation: "Harness parity — committed per-harness artifacts must match the canonical sources"
mechanism: gate
status: shipped
lives_in: "scripts/validate_harness_drift.sh"
summary: "Pre-commit harness-drift validator, run when a projection input is staged (TD-389), fails when a harness artifact (skills/agents/identity/MCP projection) diverges from its canonical source. It fails CLOSED since TD-396: DRIFTED, project-relative MISSING, DRIFT-WARN, SCHEMA-INVALID and PARITY are named FATAL classes, and any guard failure no verdict line explains is FATAL. Two downgrades only, each a printed NOTICE: a home-path MISSING (FR-138), and an mcp/* entry whose only divergence is a build-artifact path key (args/command), in an out-of-repo config, while a live sibling git worktree exists (TD-388)."
---

# Harness drift (FR-135 / TD-021)

When a commit stages a projection input — a canonical agent prompt
(`core/agents/*.md`), the root descriptor `harness-manifest.json`, or
`core/scripts/cli-adapters/surfaces-manifest.json` /
`core/scripts/cli-adapters/manifest.schema.json` (TD-389; the full disposition
table is under "Trigger set" below) — the pre-commit harness-drift validator
confirms the per-harness artifacts (generated identity files, projected
configs) still match their single canonical sources — the L-519
Igris-owned-topology guarantee. The compile-time companion verifier lives at
`core/scripts/cli-adapters/check_harness_drift.sh`.

## Trigger set (TD-389)

The hook (`core/git-hooks/pre-commit`, the alternation that sets
`needs_harness_check`) keys on staged PROJECTION INPUTS, never on generated
paths: those are gitignored and never staged (OD-4). Until TD-389 two of its
three branches were dead — `core/rules/` was deleted by FR-187, and the
descriptor moved from `core/scripts/cli-adapters/` to the repo root in FR-136 —
so staging `harness-manifest.json` never ran the gate. Every input the guard
reads, with its disposition; T389-1 pins the in/out lists and T389-2 pins that
every branch of the alternation names a tracked path
(`test/harness_drift_gate.test.bash`):

| Input | Disposition | Reason |
|---|---|---|
| `harness-manifest.json` (repo root) | IN (re-pointed) | The descriptor: agents, surfaces and `harnesses.*`. Every projection derives from it, and PARITY is a property of this committed file. |
| `core/agents/*.md` | IN (kept) | `canonical.dir = core/agents` is project-relative, so repo edits are what the gate compares. |
| `core/scripts/cli-adapters/surfaces-manifest.json` | IN (new) | `CORE_SURFACES`: the core skills targets the guard verifies. |
| `core/scripts/cli-adapters/manifest.schema.json` | IN (new) | `validate_manifest` checks the real manifest against it; a schema edit that invalidates the manifest makes the guard exit 1 before any verdict, which the fail-closed floor turns FATAL at commit time. |
| `core/rules/*.md` | REMOVED | Directory deleted in 78a6d4f (FR-187); the branch could never match. |
| `core/scripts/cli-adapters/harness-manifest.json` | REMOVED | Path moved to the repo root by FR-136. |
| `~/.igris/loadout/harness-manifest.personal.json` | OUT | Lives in the runtime loadout and can never be staged. |
| `core/skills/*/SKILL.md` | OUT | The skills projection sources the RUNTIME mirror (`~/.igris/core/skills`, set in `surfaces-manifest.json`), so a repo edit cannot drift until TD-096 mirroring; and the skills arm re-projects through the igris CLI (a write) and would fire on most commits. |
| `core/scripts/cli-adapters/{check_harness_drift,compile_harnesses,_common}.sh`, `scripts/validate_harness_drift.sh` | OUT | Gate and compiler LOGIC, not projection input; pinned by the `test/harness_*` suites. A machine-state gate on logic edits would block adapter work on unrelated live drift. |
| `core/agents/manifest.yaml` | OUT | Not read by the guard or the compiler (no reference under `core/scripts`). |
| `core/scripts/cli-adapters/body-exceptions/*.json` | OUT | The directory does not exist and no core agent declares `body_exception`; add the branch when it exists (T389-2 rejects a branch matching no tracked path). |
| `.codex/`, `.gemini/`, `.claude/agents/` | OUT | Generated and gitignored (OD-4). |
| Hook command scripts (`core/hooks/**`) | OUT | Hook drift is presence-of-command-path only; script content is not verified. |

## What the gate proves, and the one thing it deliberately no longer catches

**Proves.** Every DRIFTED verdict is fatal, and a MISSING project-relative
target is fatal. That is unconditional for the agents and skills surfaces —
including the 18 home-anchored agent target rows (gemini ×9, opencode ×9 of the
27 rows in `harness-manifest.json` `agents[].targets[]`), whose verdicts are
inode/symlink identity against the SHARED `~/.igris/loadout/` and therefore
identical in every worktree. Since TD-396 the gate also fails CLOSED:
DRIFT-WARN, SCHEMA-INVALID and PARITY are named FATAL classes, and a guard
failure that no verdict line explains is FATAL (see "Fail-closed floor").

**Proves, since BR-099 (2026-09-04).** The mcp surface also proves that no
TEST-FIXTURE MCP server is registered in any harness config the drift reader
opens for the brain block (claude `~/.claude.json`, gemini
`~/.gemini/settings.json`, opencode `~/.config/opencode/opencode.json`, codex
`~/.codex/config.toml` — or the `IGRIS_MCP_<HARNESS>_CONFIG` seam file, which
this arm reads exactly like the per-entry arm). A fixture is an entry whose
name is on the literal list `IGRIS_MCP_FIXTURE_NAMES` (`demo-mcp personal-mcp
core-mcp evil`) or carries the `igris-fixture-` prefix — unless the project's
own manifest declares that name FOR THAT HARNESS (the exemption is scoped to
the declaring block's `targets[]`: a test manifest projecting `demo-mcp` to
claude exempts the claude config only, and the same name in the gemini config
is still flagged; the igris-ai manifest and personal overlay declare only
`igris-brain`) — or whose launch tokens are `npx -y evil` / `evil` (the
add-mcp npx-wrap of the collision fixture's bare-word command; never exempt).
The verdict is `[mcp-fixture/<name>/<harness>] DRIFTED` with a `config :` line
and a reason that carries NO `differing key(s)` clause, so the TD-388
exemption below cannot apply to it: it is fatal at the commit gate even beside
a live sibling worktree (`test/harness_drift_gate.test.bash` W10). The arm is
silent and count-neutral on a clean config, gated on the brain MCP being in
scope and on `FILTER='*'` (an `igris add/remove mcp` verify runs `--filter
<name>` and must not false-fail on a pre-existing fixture entry). Limits: the
antigravity file is not a brain-MCP target and is not scanned; only the configs
of harnesses some brain-block targets are scanned; the list is the names the
fixture files construct today, so a renamed fixture must update it (the
`igris-fixture-` prefix is the forward convention); and within a harness a
block DOES target, a fixture name that block declares is indistinguishable from
its own projection, so the name rules stay silent there (the command rule still
fires). Why it exists: three
fixture entries sat in the operator's real `~/.claude.json` for weeks — the
delegate MCP writer (add-mcp, `homedir()` at module load) ran under a real HOME
from a vitest suite whose only sandbox was a `configPath` the delegate never
reads. Gate: `test/harness_mcp_fixture_guard.test.bash`.

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
**two** scope qualifiers, both easy to over-read, and the second leaves a member
of the class covered by neither surface:

- **Claude-only.** That reader opens `~/.claude.json` and no other harness
  config. For every OTHER harness that declares an `mcp` block in
  `harness-manifest.json`, the state is printed in the NOTICE on every commit
  and is fatal nowhere.
  (retired: until BR-103, `--fix` discounted this class; `runDoctor` now
  re-probes it through `reprobe()` in `cli/src/verbs/doctor.ts`, so `--fix`
  exits 1 when the row did not clear)
- **Path-absent-only.** Doctor's row is the `mcp-unregistered` push in
  `classifyDriftAll` (`cli/src/verbs/doctor.ts`), guarded by
  `!mcp.registered || !mcp.pathExists`, and `pathExists` is
  `inspectMcpRegistration`'s `existsSync(entryPath)` in
  `cli/src/lib/mcp-register.ts`
  — so doctor reports the named path only when that path is **absent**. "A path
  in neither worktree" is a wider class: nothing constrains an out-of-repo path
  to sit inside a git worktree, so it also contains paths that **exist** (a
  second clone, a checkout dropped from `git worktree list` but still on disk, a
  `~/.igris`-resident build). For that member the gate exempts — the classifier
  never inspects the `args` VALUE by design, and the `DRIFTED:*)` arm of
  `verify_mcp_entry_drift` prints `no values shown` — while `inspectMcpRegistration` returns
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

## Fail-closed floor (TD-396)

Until TD-396 the wrapper classified only `MATCH`, `DRIFTED` and `MISSING`
lines and discarded the guard's exit status, so a guard that exited 1 on any
other class passed the commit gate. Measured with `git log -S`: that
alternation arrived complete for its day in cdb4997 (FR-138); the guard then
gained DRIFT-WARN (ef6f11d, TD-208), PARITY (87f2b75, FR-217; 30658c2, TD-281)
and SCHEMA-INVALID (2d7302b, TD-230), and the alternation never followed.

**The rule.** The wrapper may downgrade a failure only with a printed NOTICE,
and never turns a non-zero guard exit into 0. It passes the guard's exit status
to its classifier (`IGRIS_DRIFT_GUARD_RC`), parses the guard's summary counters
(`N targets — M in sync, K drifted/missing`, plus the parity and schema-invalid
lines when they print), and reconciles them against the verdict blocks it
classified. A counted failure that no verdict line explains — or a non-zero
exit with no summary, or an exit other than 0 or 1 — is FATAL:
`[harness-drift] FATAL: guard exited <rc> — N failure(s) not attributable to a
verdict line (<reason>)`. Every applicable FATAL section prints before the one
exit.

| Guard line | Guard counter | Gate |
|---|---|---|
| `[name] MATCH` | MATCH | no action |
| `[name] DRIFTED` | DRIFT | FATAL; the one downgrade is the TD-388 WORKTREE NOTICE |
| `[name] MISSING` | DRIFT | FATAL if project-relative; else the FR-138 out-of-scope NOTICE |
| `[name] DRIFT-WARN` | DRIFT | FATAL, never downgraded; one targeted re-link command printed per block |
| `[name] SCHEMA-INVALID` | SCHEMA_INVALID | FATAL |
| `[name] PARITY` | PARITY | FATAL (see "PARITY at the gate") |
| `[name] NOTE`, `[name] SKIP` | none | informational |
| no verdict line: the skills-delegate re-check failure (`DRIFT skills (delegate)` on stderr), an early `exit 1` before any verdict (bad root, missing or schema-invalid manifest, missing or invalid overlay, overlay merge collision), a `set -e` abort | DRIFT, or the exit alone | FATAL, unnamed |

A verdict token the guard gains before the classifier knows it is FATAL but
unnamed — never invisible.

**Why trust the exit status, and not only widen the regex.** Widening the
alternation alone leaves every failure that is not a `[name] VERDICT` line
invisible (three such classes exist today, the last table row), and reopens
the hole the next time the guard gains a token — it fell behind three times.
The alternation IS widened, but only so a FATAL line can name its class.

**Why reconcile, and not "non-zero exit and no NOTICE".** That simpler floor is
disarmed whenever any downgrade fires in the same run. A home-path MISSING
NOTICE is routine on every machine that never projected gemini, so an
unclassified failure beside it would still pass on exactly those machines.
Reconciling the COUNT means a stray NOTICE cannot satisfy the floor (pinned by
R4 in `test/harness_drift_gate.test.bash`).

**Classifier failures (TD-188).** A classifier crash prints
`[harness-drift] FATAL: classifier failed to parse guard report (python3 exit
N)`; a first output line that is not exactly eight non-negative integers
prints `… classifier produced malformed counts`. Before, a crash exited 1 with
only a Python traceback, and an EMPTY classification exited 0.

**Coupling.** The floor reads the guard's summary-line wording. A wording change
must update the classifier's summary regexes in the same commit, or every
downgrade-only run turns FATAL (loud, not silent). The `MAINTAINING.md`
verdict-protocol row carries the change procedure.

## PARITY at the gate (TD-451)

**Disposition: FATAL. WARN was argued and rejected.** The guard already exits 1
on PARITY (FR-217 M4), so a WARN would be a downgrade, and a downgrade needs a
reason that holds. PARITY is a property of the COMMITTED manifest — a trigger
input since TD-389 — not machine state: every checkout reproduces it, and the
committer can fix it in the same commit. That is the opposite of home-path
MISSING, which is why MISSING is downgraded. The rejected WARN's failure mode:
a manifest edit that drops a projected harness from one block commits with a
line scrolled past in a long report, and the next compile silently projects
that block to fewer harnesses (the TD-228 class). Caveat: PARITY is computed on
the MERGED manifest, so a partial block in the operator's personal overlay trips
it too.

**TD-388 interaction.** An mcp-arm PARITY block is named `mcp/<name>/<harness>`,
so the exemption's `mcp/*` condition would hold, but it prints no `config :`
line and no `differing key(s):` clause, so two other conditions fail. More
fundamentally, PARITY is classified in its own branch and never reaches the
DRIFTED branch, so the exemption is never consulted: PARITY is FATAL beside a
live sibling worktree (P1). All three PARITY shapes — `[<agent>/<harness>]`,
`[mcp/…]` and `[hook/…]` — are matched by the verdict token, not the name shape.

## The live DRIFT-WARN, stated (2026-09-28)

A read-only census of the operator's machine on 2026-09-28 (`IGRIS_CLI=true`,
personal overlay merged) shows `[content-designer/gemini] DRIFT-WARN`: that
gemini target is a real-file copy of its loadout source. Under TD-396 it is
**genuinely FATAL**. This hunt did NOT recompile it — recompiling the
environment out from under the finding would have made the gate green for the
wrong reason. The remedy is the operator's call: the wrapper prints the
targeted command `bash core/scripts/cli-adapters/compile_harnesses.sh
--project-root . --surface agents --target gemini --filter content-designer`
(R1b verifies that this shape re-links one target alone); never a full
`igris harness compile` while a sibling worktree is live. The same census also
showed two `/tree` DRIFTED rows (`content-deck`, `content-designer`: the
vendored loadout tree diverged from its path-origin source; the guard's remedy
is `igris loadout update <agent>`). Those were already FATAL before TD-396, so
re-linking the DRIFT-WARN alone does not unblock a trigger-path commit on that
machine.
