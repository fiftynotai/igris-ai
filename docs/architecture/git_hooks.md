# Git Hooks

Igris ships local git hooks that catch drift between the brain stewardship doc (`core/prompts/brain_stewardship.md`), the brain MCP schema (`brain-mcp-server/src/engine/components/memory/index.ts`), and the workspace lockfile. Hooks run **only when relevant files are staged**, so unrelated commits stay fast.

**Canonical location (FR-243): `core/git-hooks/{pre-commit,commit-msg}`.** `scripts/git-hooks/*` are tracked symlinks to them (kept so every existing `scripts/git-hooks/pre-commit:NNN` citation and `scripts/install_git_hooks.sh` still resolve). Living under `core/` means the two files ride the core channel — `igris refresh` lands them at `~/.igris/core/git-hooks/` on every machine at zero packed bytes — which is what lets a consumer project install them (see "Consumer projects" below).

## What's installed

Two hook types:

- A `pre-commit` dispatcher (`core/git-hooks/pre-commit`) that conditionally invokes its validators based on which files are in the staging area, and prints one **layers line** on every run (below).
- A `commit-msg` hook (`core/git-hooks/commit-msg`) carrying five independent checks. This is a distinct hook TYPE from the pre-commit validators — it was added per the §Extending recipe below (drop the script under `scripts/git-hooks/`, no installer change).
  1. **Summary length (TD-180).** Hard-fails any commit whose summary (first non-comment, non-blank line) exceeds 72 characters. The limit matches `core/os/standards.md` and `core/templates/commit_message.md`.
  1b. **AI-signature gate (TD-470).** Hard-fails ANY commit (closing or not) whose message carries, at column 0 and case-insensitive, a `Co-authored-by:` line in the last paragraph, a `Co-authored-by: … <user@host>` line anywhere, an emoji-led `Generated with ` line, or a line that is entirely `Generated with [name](url)`: `core/os/standards.md` "No AI signatures". Every co-author trailer is refused, a human pair's included. Matching runs after git's scissors cut and its col-0 `#` strip, so an indented or quoted signature in a body passes. It exits 1 immediately (before the closing-commit prelude, whose fail-open `exit 0`s would swallow a deferred verdict) and is silent on pass. Bypass this check only with `IGRIS_BYPASS_SIGNATURE_GATE=1`; the AC/event bypasses never silence it, nor it them (`test/commit_signature_gate.test.bash` SB1-SB5). Shown red-first on a real signed igris-ai commit — see `test/fixtures/signature-gate/README.md` and `core/enforcement/no-ai-signatures.md`.
  2. **Acceptance-criteria gate (TD-325).** Hard-fails a CLOSING commit — one carrying a `closes #<BRIEF_ID>` footer (or `fixes #`; the id may carry one lowercase letter for a sub-brief, `FR-003e`, gated as itself and never as `FR-003`; a comma-separated list closes several — TD-468) — when that brief still has an unticked acceptance criterion, or a `- [~]` deferral with no `DEFERRED` reason or no follow-up brief. It reads `brief_files.content` read-only from the brain and delegates the verdict to `core/scripts/brief_ac_check.sh`, the one shared parser. **This hook, and not `pre-commit`, is where the gate belongs:** the closing commit is *defined* by that footer, so the check needs no phase heuristic and a WIP commit is untouched; and `pre-commit`'s phase-guard block is wrapped in `IGRIS_BYPASS_PHASE_GUARD != 1`, a one-shot flag a closing commit may carry, which would skip a check placed there. Fail-open at every tier (no brain DB, no `sqlite3`, no stored content, no parser → silent exit 0). Bypass this check only with `IGRIS_BYPASS_AC_GATE=1`.
  3. **Agent-event coverage gate (FR-267).** On the same closing footer, hard-fails when a role the brief's Agent Log names has no recorded agent event — no `agent_events` row with `event_type` start/stop/error for that brief (and that project, NULL-project legacy rows counting). The roles come from `core/scripts/brief_agent_log_roles.sh`, the one Agent-Log parser; a role with a start but no stop/error is a `WARN unpaired` line, not a refusal. Same fail-open tiers as check 2, plus: no `agent_events` table (a brain older than FR-267) → skip; a bullet-list Agent Log (the v4 template) parses to no roles → nothing demanded. Bypass this check only with `IGRIS_BYPASS_EVENT_GATE=1`. Checks 2 and 3 share the footer parse and the brain access but each has its own section skip, so a bypass of one never silences the other (`test/agent_event_gate.test.bash` G6 pins both directions). Shown red-first on a real omission — see `test/fixtures/event-gate/README.md`.
  4. **Review-model gate (FR-277).** On the same closing footer, refuses the commit when warden's recorded model equals the author's (forger or orchestrator) on a provider compile projects (anthropic today); an equal pair on another provider is reported (`EQUAL_UNPROJECTED`), an unknown model is printed as `UNKNOWN` and never passes, and a brief with no warden row is silent. The checker is `core/scripts/cli-adapters/model_tier.sh review`. Fail-open tiers: no checker, no `python3`, no `agent_events` table. Bypass this check only with `IGRIS_BYPASS_REVIEW_MODEL_GATE=1`.

  Bypass all five with `git commit --no-verify`.

The `pre-commit` dispatcher's validators:

| Validator | What it asserts | Brief |
|---|---|---|
| `scripts/validate_brain_stewardship_enums.sh` | Every enum value declared on `memory_store` (`category`, `scope`, `provenance`) appears in backticks somewhere inside the `<!-- SECTION: brain_stewardship -->` region of `core/prompts/brain_stewardship.md`. Also asserts schema-shrinkage: enum-shaped backticked tokens in the docs must still exist in the schema. Overridable via `SCHEMA_FILE` / `PROMPT_FILE` env vars. | TD-070 / DRIFT-1, TD-072, TD-092 (renamed in TD-148) |
| `scripts/validate_lockfile_in_sync.sh` | `npm ci --dry-run --ignore-scripts` from repo root succeeds (workspace-aware lockfile is in sync with all `package.json` files). Catches the drift class where a workspace package was renamed or version-bumped without regenerating `package-lock.json`. | TD-134 |
| `scripts/validate_hunt_agent_event_sites.sh` | Every `igris_agent_event` call site in `core/skills/hunt/SKILL.md` names `instance_id`, `agent`, `event_type` and `model_requested` as arguments; no site passes `duration_ms` or `round` (the brain computes both); the start sites cover architect/forger/sentinel/warden/document/mender; at least 13 sites exist. Triggers when the hunt skill or the instances component (where the tool's `required` list lives) is staged. HARD-fails. | FR-267 |
| `gitleaks protect --staged [--config .gitleaks.toml]` | No secret-shaped string reaches a commit (public IP outside RFC-1918/loopback, API-key shapes, SSH/cloud keys, the operator-VPS-IP family). **Runs unconditionally** (gitleaks scans the staged set itself — no file trigger). `--config .gitleaks.toml` is passed only when the repo carries that file (igris-ai does; its `[extend] useDefault = true` keeps the built-ins); otherwise gitleaks runs its built-in ruleset — FR-243 removed the `[ -f .gitleaks.toml ]` condition that used to skip the scan, silently, in every consumer repo. HARD-fails on any finding; if `gitleaks` is absent the commit proceeds (TD-159 posture) but LOUDLY: a `SECRET SCAN DISARMED` box on every commit, `secret-scan=DISARMED` in the layers line, and a persistent `secret-scan-disarmed` row in `igris doctor`. Full guide: [`docs/operations/secret-scanning.md`](../operations/secret-scanning.md). | TD-159 / FR-243 |

> The full validator roster lives in the dispatcher's header comment
> (`core/git-hooks/pre-commit`); this table summarizes the load-bearing
> ones. Several validators (TD-219 SKILL.md YAML, TD-248 harness-leak, FR-135
> harness drift, FR-186 contract consumers, TD-257 brief-state reconciliation,
> TD-325 AC completion, TD-324 required args, TD-367 harness-tier claims,
> TD-240 error-fingerprint loop) are wired in addition to the rows above.

Both core validators are also runnable standalone:

```bash
bash scripts/validate_brain_stewardship_enums.sh
bash scripts/validate_lockfile_in_sync.sh
```

Each prints `OK: ...` on success or a precise drift report on failure.

## Trigger matrix

The pre-commit dispatcher only runs validators whose tracked files are staged. Validators not listed for a staged file do not run.

| Staged file | Enum validator | Lockfile validator |
|---|---|---|
| `core/prompts/brain_stewardship.md` | yes | no |
| `brain-mcp-server/src/engine/components/memory/index.ts` | yes | no |
| `package.json` (root) | no | yes |
| `package-lock.json` | no | yes |
| `cli/package.json` | no | yes |
| `brain-mcp-server/package.json` | no | yes |
| anything else | no | no |

If no validator triggers, the hook exits 0 after the layers line — there is no per-commit overhead for unrelated work.

## The layers line (FR-243)

Every `pre-commit` run prints exactly one line stating which of its three layers is active — because a silent exit 0 is byte-for-byte what a disarmed gate looks like (the failure the brief measured in `moca-ai-agent`: two live API keys staged, `exit 0`, no output). Grammar is a contract (MAINTAINING.md, "git-level gate projection contract"; pinned by `test/git_hooks_consumer.test.bash`):

```
[pre-commit] layers: phase-guard=<v> secret-scan=<v> repo-validators=<v>
```

Three fixed keys in that order; each value is one token plus at most one parenthetical reason.

| Key | Values | Meaning |
|---|---|---|
| `phase-guard` | `active` · `off (no brain db)` · `off (no sqlite3)` · `bypassed (IGRIS_BYPASS_PHASE_GUARD=1)` | The PI-004 guard needs `sqlite3` and `~/.igris/memory/knowledge.db`; it stays fail-open without them (a consumer that does not run `/hunt` must still commit) but now says so. |
| `secret-scan` | `active (repo config)` · `active (gitleaks defaults)` · `DISARMED (gitleaks not installed)` | `(repo config)` = `--config .gitleaks.toml`; `(gitleaks defaults)` = the built-in ruleset (consumer repos); `DISARMED` = the box above is printed and the commit is NOT scanned. |
| `repo-validators` | `active (igris-ai)` · `n/a (not the igris-ai checkout)` | The 27 igris-ai-internal validator sites are wrapped in ONE inert region keyed on `IGRIS_REPO_INTERNAL`, which is 1 only when the repo carries **all** of `harness-manifest.json`, `brain-mcp-server/` and `scripts/git-hooks/`. A consumer never has all three (decision AC-4: whole script, one inert region, stated — not a projected subset that would duplicate the phase guard and the scan into a second file to drift). |

`commit-msg` prints NO sibling status line: an optional `[commit-msg] gates:` echo was tried in FR-243 and dropped because ten pinned "exit 0, silent" cases — five in `test/brief_ac_gate.test.bash` (F1–F5) and five in `test/agent_event_gate.test.bash` (G2, G7a–G7d), counted 2026-09-07 with `grep -c 'exit 0, silent'` — pin a passing closing commit: nine of them assert an EMPTY output and (F5) asserts only exit 0 (its sandboxed-`sqlite3` probe hand-rolls the invocation), so any unconditional echo would red the nine. The TD-470 signature section (§1b) is silent on pass for the same reason — `test/commit_signature_gate.test.bash` adds ten tests (16 messages) that assert an EMPTY output on pass (counted 2026-09-24). Its §1 length check is pure bash and cannot degrade; its fail-open exits are silent by design — the `pre-commit` layers line is the one unconditional per-run signal.

## The phase guard (PI-004, TD-494)

`pre-commit` refuses a commit while the committing session's own brief is in BUILDING or TESTING. It reads the brain read-only, and without `sqlite3` or the brain DB it fails open (the layers line says so). Bypass one commit with `IGRIS_BYPASS_PHASE_GUARD=1`.

**Project (TD-359).** Both hooks resolve the project slug with `igris_resolve_project` from `core/hooks/shared/_gate.sh`, the same function the shared harness hooks use. `igris detect` and the CLI defaults use its TypeScript twin, `cli/src/lib/project-identity.ts`, and `test/project_slug_parity.test.bash` pins the two to one answer per directory. The precedence is:

1. A `.igris-project` marker file holding the slug.
2. The registry row of the deepest registered ancestor. A linked worktree is looked up at the matching path in its main checkout.
3. The main checkout's directory name.
4. The directory's own name, as the last resort.

A worktree named `wt-td359` of the `igris-ai` checkout therefore gates as `igris-ai`, and `commit-msg` runs its AC and event gates under that slug too.

**Session.** Among this project's active instances on this machine (the BR-100 machine filter), the guard identifies the committing session in this order:

| Tier | The committing session is | If the tier fails |
|---|---|---|
| S1 `IGRIS_INSTANCE_ID` | The active instance with that id. `/hunt` sets it as a one-shot prefix on its close commit. Never `export` it. | An unparseable value falls through to S2. A well-formed id that names no such instance leaves the commit unidentified and does **not** fall through: the guard never swaps in a guessed session for one the caller named. |
| S2 owner process | The instance whose `owner_pid` is an ancestor of the hook (up to 16 hops) and whose `owner_started_at` equals that process's `ps -o lstart=` start time. The start-time match rules out a reused pid. The nearest ancestor wins. | Falls through to S3. Skipped when the instances table has no owner columns. |
| S3 worktree root | The one live instance whose `project_path` is the commit's worktree root (the realpath of `git rev-parse --show-toplevel`, or its `~/` form). Live means an unexpired lease or a verified owner process. `igris session register` stores that root. | No live instance there, or more than one: unidentified. |

No tier falls back to the most recently active instance, and no tier reads a session file.

**Unidentified: fail open with a notice (decision D1).** The commit goes through. When the project has at least one active instance on this machine, the hook prints exactly one line naming the reason:

```
[pre-commit] phase-guard: committing session not identified (<reason>) — commit not gated
```

A project with no active instance, such as a plain-git consumer, stays silent. In a shared checkout, a session is identified only by S1, by S2 (Claude sessions), or by being the only live instance there. A per-session worktree makes S3 exact for every harness.

**No brief.** The identified instance's `current_brief` is trimmed and lower-cased. `''`, NULL and `none` all mean no brief, and the commit is allowed. `/hunt` writes `''` at COMPLETE and `/rest` writes it at session end.

**Refusal.** The message keeps the `PI-004 phase guard: refusing commit` line. It then names the session and how it was identified, the project slug and its source, the brief and its phase, and the bypass. It names no workflow role, so it reads the same under any mode.

**`_gate.sh` is a hook dependency.** Each git hook follows its own symlink chain (at most 16 hops) and sources `../hooks/shared/_gate.sh` next to the real hook directory: the repo `core/` on the igris-ai checkout, or the runtime mirror `~/.igris/core/` for a consumer's FR-243 symlink. Failing that, it sources `~/.igris/core/hooks/shared/_gate.sh`. When neither exists, the hook uses the worktree's directory name as the slug, which was the behaviour before TD-359. A core with the new hooks and an old `_gate.sh` therefore degrades instead of erroring. `igris refresh` lands the hooks and `_gate.sh` together.

## Consumer projects (FR-243)

The git-level gates are a **property of being a registered Igris project**, not an `igris add` surface (they target a per-clone `.git/hooks/`, not a harness — the surface contract in MAINTAINING.md needs a harness axis). The supported path:

```bash
igris refresh                # once per machine: lands ~/.igris/core/git-hooks/
                             # (from the RECORDED source — a `release` record is pinned to its tag,
                             #  so a released machine gets these at the next tag: BR-103 O-3)
igris install /path/to/repo  # step 7b symlinks .git/hooks/{pre-commit,commit-msg} -> ~/.igris/core/git-hooks/<name>
```

`igris install` is idempotent (re-run it on an already-registered project); `--no-git-hooks` opts out. Rules the installer keeps: a pre-existing non-symlink hook is backed up as `<hook>.pre-igris.bak.<epoch>` before it is replaced; with `core.hooksPath` set (husky / lefthook) it REFUSES — a hook in `.git/hooks/` would never run — and tells you to add the two files to that pipeline; with `.git` a file (worktree / submodule) it refuses (install in the main checkout); with the mirror absent it refuses with "run `igris refresh`". A symlink means a later `igris refresh` updates every registered project at once.

The installed hooks also need the mirror's `hooks/shared/_gate.sh` (see "The phase guard" above), which `igris refresh` lands in the same pass. A linked worktree of an installed clone runs the main checkout's hooks, because git reads hooks from the shared git directory, so it needs no install of its own; since TD-359 it resolves to the main checkout's project. One exception was measured and predates this change: with a relative `core.hooksPath`, git skips the hooks in linked worktrees without saying so.

`igris doctor` reports two classes: `git-hooks-missing` (per project — hooks absent, foreign, dangling, **not executable** (git ignores such a hook with one `hint:` line and commits anyway), or bypassed by `core.hooksPath`; `--fix` runs the same installer, `chmod +x` only on a file under `~/.igris/`) and `secret-scan-disarmed` (brain-level, informational — an installed pre-commit exists and `gitleaks` is not on PATH; never auto-fixed). A project registered by `igris register-project` (row only) shows `git-hooks-missing` until `igris doctor --fix` or `igris install`.

`.gitleaks.toml` is deliberately **not** projected: it embeds an operator-private IP family. Consumers scan on gitleaks' built-in ruleset (verified to catch the moca keys); a consumer wanting the public Igris custom rules copies them by hand — see `docs/operations/secret-scanning.md`.

## Install (one-time, igris-ai contributors)

```bash
bash scripts/install_git_hooks.sh
```

The installer symlinks `scripts/git-hooks/pre-commit` into `.git/hooks/pre-commit`, which chains through the tracked symlink to `core/git-hooks/pre-commit`. Symlink (not copy) means future updates to the committed hook script propagate to every developer on the next `git pull` — no re-install needed unless a brand-new hook type is added. It refuses when `core.hooksPath` is set (same reason as the consumer installer). On the igris-ai checkout `igris install .` prefers the repo copy over the runtime mirror (repo-first, like `commit-msg` resolves its parser), so a mid-edit hook gates the commit as edited.

Note: Git tracks the executable bit on `core/git-hooks/pre-commit`, so `git pull` preserves it across machines. The `chmod +x "$hook"` call in `install_git_hooks.sh` acts as belt-and-suspenders for fresh checkouts on environments that drop the executable bit (Windows, untarred archives, `cp -r` from non-Git source). Windows checkouts with `core.symlinks=false` materialise `scripts/git-hooks/*` as text files holding the link path — set `git config core.symlinks true` before checkout (the CI matrix is ubuntu + macos).

The installer is idempotent: re-running it replaces existing symlinks/files in `.git/hooks/` with the current committed version.

## Bypass

To skip the hook on a single commit:

```bash
git commit --no-verify
```

Use sparingly. The hook exists because past warden reviews caught real drift between schema and docs. If you need to bypass it, leave a note in the commit body explaining why, and follow up with a fix commit.

## Extending

To add a new validator:

1. Drop the script under `scripts/` (`.sh` or `.py`).
2. Make it executable (`chmod +x`).
3. Make it return exit `0` on success, `1` on drift, `2` on tooling/parse errors. Print a clear diagnostic on non-zero exits.
4. Wire it into `core/git-hooks/pre-commit` INSIDE the `IGRIS_REPO_INTERNAL` region (it is an igris-ai-internal validator), behind a `git diff --cached --name-only` filter so it only runs when its tracked files are staged.
5. Add a row to the trigger matrix above and a row to the validators table.

To add a new hook type (e.g., `commit-msg`, `pre-push`):

1. Drop the script under `core/git-hooks/<hook-name>` with the standard hook semantics, and add a tracked symlink `scripts/git-hooks/<hook-name> -> ../../core/git-hooks/<hook-name>`; add the name to `GIT_HOOK_NAMES` in `cli/src/lib/git-hooks.ts` so consumers get it too.
2. Make it executable.
3. The installer (`install_git_hooks.sh`) will symlink any file in `scripts/git-hooks/` into `.git/hooks/` — no installer changes needed.
4. Document the new hook in this file.

The `commit-msg` hook (TD-180) was added via exactly this recipe: dropped at `scripts/git-hooks/commit-msg` (executable; since FR-243 the file is `core/git-hooks/commit-msg` behind the symlink), auto-symlinked by `install_git_hooks.sh` with zero installer change, and documented in "What's installed" above. Adding a brand-new hook TYPE does require contributors to re-run `install_git_hooks.sh` once (the symlink for a new hook name doesn't exist yet); subsequent script updates propagate through the existing symlink.

## Why local hooks (not Husky / pre-commit framework)

The repo had zero pre-commit infrastructure before TD-070. Adopting Husky or the `pre-commit` framework would have required a top-level `package.json` (the only existing one lives under `brain-mcp-server/`) plus a devDependency, just to wire two shell-scripts. A bash installer that symlinks committed hooks is the smallest delta that achieves the same on-commit gating without dragging in tooling.

If a future brief adds CI checks, the same validator scripts run unchanged in CI — the hook is the local pre-flight, not the only line of defense.
