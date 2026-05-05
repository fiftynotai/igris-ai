# Git Hooks

Igris ships local git hooks that catch drift between the actor-facing prompt (`core/prompts/igris_os.md`), the routing tree (`core/igris_tree.json`), and the brain MCP schema (`brain-mcp-server/src/engine/components/memory/index.ts`). Hooks run **only when relevant files are staged**, so unrelated commits stay fast.

## What's installed

A single `pre-commit` dispatcher (`scripts/git-hooks/pre-commit`) that conditionally invokes two validators based on which files are in the staging area.

| Validator | What it asserts | Brief |
|---|---|---|
| `scripts/validate_memory_agency_enums.sh` | Every enum value declared on `memory_store` (`category`, `scope`, `provenance`) appears in backticks somewhere inside the `<!-- SECTION: brain_stewardship -->` region of `core/prompts/brain_stewardship.md`. Also asserts schema-shrinkage: enum-shaped backticked tokens in the docs must still exist in the schema. Overridable via `SCHEMA_FILE` / `PROMPT_FILE` env vars. | TD-070 / DRIFT-1, TD-072 |
| `scripts/validate_igris_tree_lineranges.py` | Every section declared in `igris_tree.json` has a matching `<!-- SECTION: <name> -->` marker at the declared start line and a `<!-- /SECTION: <name> -->` marker at the declared end line in `igris_os.md`. | TD-070 / DRIFT-3 |

Both validators are also runnable standalone:

```bash
bash scripts/validate_memory_agency_enums.sh
python3 scripts/validate_igris_tree_lineranges.py
```

Each prints `OK: ...` on success or a precise drift report on failure.

## Trigger matrix

The pre-commit dispatcher only runs validators whose tracked files are staged. Validators not listed for a staged file do not run.

| Staged file | Enum validator | Line-range validator |
|---|---|---|
| `core/prompts/igris_os.md` | yes | yes |
| `core/igris_tree.json` | no | yes |
| `brain-mcp-server/src/engine/components/memory/index.ts` | yes | no |
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

## Why local hooks (not Husky / pre-commit framework)

The repo had zero pre-commit infrastructure before TD-070. Adopting Husky or the `pre-commit` framework would have required a top-level `package.json` (the only existing one lives under `brain-mcp-server/`) plus a devDependency, just to wire two shell-scripts. A bash installer that symlinks committed hooks is the smallest delta that achieves the same on-commit gating without dragging in tooling.

If a future brief adds CI checks, the same validator scripts run unchanged in CI — the hook is the local pre-flight, not the only line of defense.
