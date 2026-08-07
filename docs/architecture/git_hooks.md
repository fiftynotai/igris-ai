# Git Hooks

Igris ships local git hooks that catch drift between the brain stewardship doc (`core/prompts/brain_stewardship.md`), the brain MCP schema (`brain-mcp-server/src/engine/components/memory/index.ts`), and the workspace lockfile. Hooks run **only when relevant files are staged**, so unrelated commits stay fast.

## What's installed

Two hook types:

- A `pre-commit` dispatcher (`scripts/git-hooks/pre-commit`) that conditionally invokes its validators based on which files are in the staging area.
- A `commit-msg` hook (`scripts/git-hooks/commit-msg`) carrying two independent checks. This is a distinct hook TYPE from the pre-commit validators — it was added per the §Extending recipe below (drop the script under `scripts/git-hooks/`, no installer change).
  1. **Summary length (TD-180).** Hard-fails any commit whose summary (first non-comment, non-blank line) exceeds 72 characters. The limit matches `core/os/standards.md` and `core/templates/commit_message.md`.
  2. **Acceptance-criteria gate (TD-325).** Hard-fails a CLOSING commit — one carrying a `closes #<BRIEF_ID>` footer — when that brief still has an unticked acceptance criterion, or a `- [~]` deferral with no `DEFERRED` reason or no follow-up brief. It reads `brief_files.content` read-only from the brain and delegates the verdict to `core/scripts/brief_ac_check.sh`, the one shared parser. **This hook, and not `pre-commit`, is where the gate belongs:** the closing commit is *defined* by that footer, so the check needs no phase heuristic and a WIP commit is untouched; and `pre-commit`'s phase-guard block is wrapped in `IGRIS_BYPASS_PHASE_GUARD != 1`, a flag `/hunt` sets on the exact commit that must be gated. Fail-open at every tier (no brain DB, no `sqlite3`, no stored content, no parser → silent exit 0). Bypass this half only with `IGRIS_BYPASS_AC_GATE=1`.

  Bypass both with `git commit --no-verify`.

The `pre-commit` dispatcher's validators:

| Validator | What it asserts | Brief |
|---|---|---|
| `scripts/validate_brain_stewardship_enums.sh` | Every enum value declared on `memory_store` (`category`, `scope`, `provenance`) appears in backticks somewhere inside the `<!-- SECTION: brain_stewardship -->` region of `core/prompts/brain_stewardship.md`. Also asserts schema-shrinkage: enum-shaped backticked tokens in the docs must still exist in the schema. Overridable via `SCHEMA_FILE` / `PROMPT_FILE` env vars. | TD-070 / DRIFT-1, TD-072, TD-092 (renamed in TD-148) |
| `scripts/validate_lockfile_in_sync.sh` | `npm ci --dry-run --ignore-scripts` from repo root succeeds (workspace-aware lockfile is in sync with all `package.json` files). Catches the drift class where a workspace package was renamed or version-bumped without regenerating `package-lock.json`. | TD-134 |
| `gitleaks protect --staged --config .gitleaks.toml` | No secret-shaped string reaches a commit (public IP outside RFC-1918/loopback, API-key shapes, SSH/cloud keys, the operator-VPS-IP family). **Runs unconditionally** (gitleaks scans the staged set itself — no file trigger). HARD-fails on any finding; degrades gracefully (WARN + skip) if `gitleaks` is absent so a contributor without it isn't blocked. Full guide: [`docs/operations/secret-scanning.md`](../operations/secret-scanning.md). | TD-159 |

> The full validator roster lives in the dispatcher's header comment
> (`scripts/git-hooks/pre-commit`); this table summarizes the load-bearing
> ones. Several validators (TD-219 SKILL.md YAML, TD-248 harness-leak, FR-135
> harness drift, FR-186 contract consumers, TD-257 brief-state reconciliation,
> TD-325 AC completion) are wired in addition to the rows above.

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

If no validator triggers, the hook exits 0 silently — there is no per-commit overhead for unrelated work.

## Install (one-time)

```bash
bash scripts/install_git_hooks.sh
```

The installer symlinks `scripts/git-hooks/pre-commit` into `.git/hooks/pre-commit`. Symlink (not copy) means future updates to the committed hook script propagate to every developer on the next `git pull` — no re-install needed unless a brand-new hook type is added.

Note: Git tracks the executable bit on `scripts/git-hooks/pre-commit`, so `git pull` preserves it across machines. The `chmod +x "$hook"` call in `install_git_hooks.sh` (line 29) acts as belt-and-suspenders for fresh checkouts on environments that drop the executable bit (Windows, untarred archives, `cp -r` from non-Git source).

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
4. Wire it into `scripts/git-hooks/pre-commit` behind a `git diff --cached --name-only` filter so it only runs when its tracked files are staged.
5. Add a row to the trigger matrix above and a row to the validators table.

To add a new hook type (e.g., `commit-msg`, `pre-push`):

1. Drop the script under `scripts/git-hooks/<hook-name>` with the standard hook semantics.
2. Make it executable.
3. The installer (`install_git_hooks.sh`) will symlink any file in `scripts/git-hooks/` into `.git/hooks/` — no installer changes needed.
4. Document the new hook in this file.

The `commit-msg` hook (TD-180) was added via exactly this recipe: dropped at `scripts/git-hooks/commit-msg` (executable), auto-symlinked by `install_git_hooks.sh` with zero installer change, and documented in "What's installed" above. Adding a brand-new hook TYPE does require contributors to re-run `install_git_hooks.sh` once (the symlink for a new hook name doesn't exist yet); subsequent script updates propagate through the existing symlink.

## Why local hooks (not Husky / pre-commit framework)

The repo had zero pre-commit infrastructure before TD-070. Adopting Husky or the `pre-commit` framework would have required a top-level `package.json` (the only existing one lives under `brain-mcp-server/`) plus a devDependency, just to wire two shell-scripts. A bash installer that symlinks committed hooks is the smallest delta that achieves the same on-commit gating without dragging in tooling.

If a future brief adds CI checks, the same validator scripts run unchanged in CI — the hook is the local pre-flight, not the only line of defense.
