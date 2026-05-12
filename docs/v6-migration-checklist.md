# v5 to v6 Migration Checklist

Step-by-step checklist for migrating an Igris AI installation from v5 to v6.

For a detailed explanation of what changed and why, see [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md).

---

## Table of Contents

1. [Pre-Migration Checklist](#1-pre-migration-checklist)
2. [Migration Steps](#2-migration-steps)
3. [Post-Migration Verification](#3-post-migration-verification)
4. [Rollback Instructions](#4-rollback-instructions)
5. [FAQ](#5-faq)

---

## 1. Pre-Migration Checklist

Complete every item before starting the migration.

### 1.1 Backup

- [ ] **Back up the brain directory:**
  ```bash
  cp -r ~/.igris ~/.igris-v5-backup
  ```
- [ ] **Back up the brain database separately** (most critical asset):
  ```bash
  cp ~/.igris/memory/knowledge.db ~/.igris/memory/knowledge-v5-backup.db
  ```
- [ ] **Back up project `ai/` folders** if they contain local briefs or context you want to preserve:
  ```bash
  # Run from each project root that has an ai/ directory
  tar czf ai-backup-$(date +%Y%m%d).tar.gz ai/
  ```
- [ ] **Commit or stash any uncommitted work** in project repositories.

### 1.2 Verify Brain Exists

- [ ] **Confirm `~/.igris/` exists:**
  ```bash
  ls -la ~/.igris/
  ```
  If the directory does not exist, you need a fresh v6 install, not a migration.
  Run `igris init` followed by `igris install .` instead.

- [ ] **Verify brain database health:**
  ```bash
  sqlite3 ~/.igris/memory/knowledge.db "PRAGMA integrity_check; PRAGMA journal_mode;"
  ```
  Expected output: `ok` and `wal`. If the integrity check fails, restore from a known-good backup before proceeding.

### 1.3 Verify Dependencies

- [ ] **sqlite3** is installed:
  ```bash
  command -v sqlite3
  ```
- [ ] **python3** is installed:
  ```bash
  command -v python3
  ```
- [ ] **The igris-ai source repo** is available locally and up to date:
  ```bash
  cd /path/to/igris-ai && git pull origin develop
  ```

### 1.4 Review Current State

- [ ] **Check current version:**
  ```bash
  cat ~/.igris/config.json | python3 -c "import json,sys; print(json.load(sys.stdin).get('version','unknown'))"
  ```
- [ ] **List registered projects** (to verify none are lost during migration):
  ```bash
  sqlite3 ~/.igris/memory/knowledge.db "SELECT slug, path, status FROM projects;"
  ```
  Save this output for comparison after migration.

---

## 2. Migration Steps

### 2.1 Dry Run (Recommended)

Preview what the migration script will do without making any changes.

- [ ] **Run the migration in dry-run mode:**
  ```bash
  cd /path/to/igris-ai
  bash scripts/archive/igris_migrate_v5_to_v6.sh --dry-run
  ```
- [ ] **Review the output.** Every action is prefixed with `[dry-run] Would:`. Confirm nothing unexpected appears.

### 2.2 Run the Automated Migration

- [ ] **Execute the migration script:**
  ```bash
  cd /path/to/igris-ai
  bash scripts/archive/igris_migrate_v5_to_v6.sh
  ```
  The script will prompt for confirmation before making changes. Use `--force` to skip prompts if running in an automated pipeline.

  The script performs these steps automatically:
  1. Migrates `~/.igris/cache/` to `~/.igris/projects/` (creates backward-compat symlink)
  2. Creates v6 subdirectories for each project (`context`, `session`, `briefs`, `plans`, `hooks`, `reference`)
  3. Removes old rules 01-05, installs `00-igris-universal.md`
  4. Updates core files (`igris_tree.json`, agents, skills, prompts, templates, `SOUL.md`)
  5. Removes deprecated directories (`staging`, `personas`)
  6. Updates `config.json` to version 6.0.0
  7. Updates database project paths (`cache/` references become `projects/`)
  8. Converts `.claude/` contents to symlinks pointing to `~/.igris/core/` for all registered projects
  9. Imports briefs from `ai/briefs/` into the brain database
  10. Runs verification checks

- [ ] **Confirm the script reports "Migration to v6.0.0 complete!"** with zero errors.

### 2.3 Delete the `ai/` Folder from Project Repos

In v6, all Igris data lives in `~/.igris/`. The `ai/` folder inside project repositories is legacy (v4/v5) and should be removed.

- [ ] **For each project that has an `ai/` directory:**
  ```bash
  cd /path/to/your-project
  rm -rf ai/
  ```
- [ ] **Also remove `SOUL.md` from the project root** if present (persona now lives at `~/.igris/core/SOUL.md`):
  ```bash
  rm -f SOUL.md
  ```
- [ ] **Commit the removal:**
  ```bash
  git add -A && git commit -m "chore(v6): remove legacy ai/ folder and project-root SOUL.md"
  ```

### 2.4 Verify `.claude/` Symlinks

- [ ] **Check that `.claude/agents/` files are symlinks to `~/.igris/core/agents/`:**
  ```bash
  ls -la .claude/agents/
  ```
  Every `.md` file should show `->` pointing to `~/.igris/core/agents/`.

- [ ] **Check that `.claude/rules/` contains only `00-igris-universal.md` as a symlink:**
  ```bash
  ls -la .claude/rules/
  ```
  Should show one file: `00-igris-universal.md -> ~/.igris/core/rules/00-igris-universal.md`.

- [ ] **Check that `.claude/skills/` directories are symlinks:**
  ```bash
  ls -la .claude/skills/
  ```
  Each skill directory should point to `~/.igris/core/skills/`.

### 2.5 Verify CLAUDE.md

- [ ] **Confirm CLAUDE.md is small** (under 5KB, no `@import` directives):
  ```bash
  wc -c CLAUDE.md
  ```
  v6 CLAUDE.md should be roughly 2-3KB. If it is 60KB or more, it still has v5 `@import` bloat.

- [ ] **Confirm CLAUDE.md references `igris_tree.json`** as its context routing mechanism:
  ```bash
  grep "igris_tree.json" CLAUDE.md
  ```
  Should return at least one match.

### 2.6 Re-Register the Project (if needed)

If the migration script did not update symlinks for a specific project, or if you want a clean re-registration:

- [ ] **Run the install script from the project directory:**
  ```bash
  cd /path/to/your-project
  bash igris install .
  ```

- [ ] **Verify brain database registration:**
  ```bash
  sqlite3 ~/.igris/memory/knowledge.db "SELECT slug, path, igris_version FROM projects WHERE slug = 'your-project-slug';"
  ```
  The `igris_version` column should show `6.0.0`.

---

## 3. Post-Migration Verification

### 3.1 Run the Verification

- [ ] **Verify each project from its directory** (the standalone `v6_verify.sh` script was removed in v7 — use the CLI doctor instead):
  ```bash
  cd /path/to/your-project
  igris doctor
  ```
  Expected output: no drift reported.

  Things to confirm post-migration (these are the invariants the old
  `v6_verify.sh` checked; `igris doctor` covers the same ground):
  1. `~/.igris/core/igris_tree.json` exists and is valid JSON
  2. `CLAUDE.md` is under 5KB (no `@import` bloat)
  3. `.claude/agents/` files are symlinks to `~/.igris/core/agents/`
  4. `.claude/rules/00-igris-universal.md` is symlinked to `~/.igris/core/rules/`
  5. `.claude/skills/` has 15+ symlinked skill directories

### 3.2 Test `/awaken` in Claude Code

- [ ] **Start a new Claude Code session** (rules and symlinks are loaded on session start):
  ```bash
  claude
  ```
- [ ] **Run `/awaken`** and confirm it loads context from `~/.igris/` (not from a local `ai/` folder).
- [ ] **Run `/scan`** and verify the system status report shows v6.0.0 with no warnings.

### 3.3 Verify Brain Database

- [ ] **Confirm all projects are registered:**
  ```bash
  sqlite3 ~/.igris/memory/knowledge.db "SELECT slug, igris_version, status FROM projects;"
  ```
  All active projects should show `igris_version = 6.0.0`.

- [ ] **Confirm no stale `cache/` paths remain:**
  ```bash
  sqlite3 ~/.igris/memory/knowledge.db "SELECT slug, path FROM projects WHERE path LIKE '%/cache/%';"
  ```
  This query should return zero rows.

- [ ] **Compare project list to the pre-migration snapshot** (from step 1.4) to verify no projects were lost.

### 3.4 Verify Core Structure

- [ ] **`~/.igris/projects/` exists** and contains your project directories:
  ```bash
  ls ~/.igris/projects/
  ```
- [ ] **`~/.igris/cache` is a symlink** to `~/.igris/projects/` (backward compatibility):
  ```bash
  readlink ~/.igris/cache
  ```
- [ ] **`~/.igris/core/igris_tree.json` exists:**
  ```bash
  ls ~/.igris/core/igris_tree.json
  ```
- [ ] **Only `00-igris-universal.md` in rules** (no old 01-05 files):
  ```bash
  ls ~/.igris/core/rules/
  ```
- [ ] **`config.json` shows v6.0.0:**
  ```bash
  cat ~/.igris/config.json | python3 -c "import json,sys; print(json.load(sys.stdin).get('version','unknown'))"
  ```
- [ ] **No deprecated directories:**
  ```bash
  # These should NOT exist:
  ls ~/.igris/staging/ 2>/dev/null && echo "WARNING: staging/ still exists" || echo "OK: no staging/"
  ls ~/.igris/personas/ 2>/dev/null && echo "WARNING: personas/ still exists" || echo "OK: no personas/"
  ```

---

## 4. Rollback Instructions

If something goes wrong during or after migration, use these steps to restore v5.

### 4.1 Restore from Backup

```bash
# Stop any running Claude Code sessions first

# Remove the broken v6 brain
rm -rf ~/.igris

# Restore the v5 backup
cp -r ~/.igris-v5-backup ~/.igris

# Verify the database is intact
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA integrity_check;"
```

### 4.2 Restore Only the Database

If the migration partially completed and you only need the database back:

```bash
cp ~/.igris/memory/knowledge-v5-backup.db ~/.igris/memory/knowledge.db
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA integrity_check;"
```

### 4.3 Restore the `ai/` Folder

If you deleted the `ai/` folder and need it back:

```bash
# If you created a tar backup (step 1.1):
cd /path/to/your-project
tar xzf ai-backup-YYYYMMDD.tar.gz

# Or use git to restore:
git checkout HEAD -- ai/
```

### 4.4 Re-run Migration After Fixing Issues

Once you have resolved the root cause:

```bash
# Force re-run (skips the "already v6" check):
bash scripts/archive/igris_migrate_v5_to_v6.sh --force
```

### 4.5 Clean Up Backups

After confirming v6 is stable (give it a few days):

```bash
rm -rf ~/.igris-v5-backup
rm -f ~/.igris/memory/knowledge-v5-backup.db
```

---

## 5. FAQ

### Q: The migration script says "Already running v6.0.0 with intact structure."

The brain has already been migrated. If you want to re-run anyway (for example, to pick up new core files from the source repo), use:

```bash
bash scripts/archive/igris_migrate_v5_to_v6.sh --force
```

### Q: My `.claude/agents/` files are regular files, not symlinks.

Re-register the project to convert them:

```bash
cd /path/to/your-project
bash igris install .
```

This will recreate the symlinks without affecting other project data.

### Q: `/awaken` still tries to read from `ai/` instead of `~/.igris/`.

1. Confirm CLAUDE.md references `igris_tree.json` (not `@import` directives).
2. Start a **new** Claude Code session. Rules and CLAUDE.md are loaded once at session start; an existing session will use stale data.
3. Verify the tree file exists: `ls ~/.igris/core/igris_tree.json`

### Q: Some briefs are missing after migration.

The migration script imports briefs from `ai/briefs/` into the brain database. Check whether they were imported:

```bash
sqlite3 ~/.igris/memory/knowledge.db "SELECT brief_id, title FROM brief_status WHERE project = 'your-slug';"
```

If they are missing, you can manually import from a backup:

```bash
# Re-run just the brief import step by restoring ai/briefs/ temporarily:
tar xzf ai-backup-YYYYMMDD.tar.gz ai/briefs/
bash scripts/archive/igris_migrate_v5_to_v6.sh --force
rm -rf ai/
```

### Q: `igris doctor` reports failures (this section also covered the removed `v6_verify.sh` script).

Address each failure type:

| Failure | Fix |
|---------|-----|
| `igris_tree.json does not exist` | Re-run the migration script with `--force`, or copy manually: `cp /path/to/igris-ai/core/igris_tree.json ~/.igris/core/` |
| `CLAUDE.md is >= 5KB` | Regenerate it by running `bash igris install .` from the project directory |
| `Agent not a symlink` | Re-register the project: `bash igris install .` |
| `00-igris-universal.md not a symlink` | Re-register the project: `bash igris install .` |
| `Fewer than 15 skill directories` | Ensure `~/.igris/core/skills/` has all skills, then re-register |

### Q: I have multiple projects. Do I need to migrate each one separately?

No. The migration script (`igris_migrate_v5_to_v6.sh`) operates on the **brain** (`~/.igris/`), which is shared across all projects. It automatically updates symlinks for every project registered in the brain database.

After the brain migration completes, you still need to **delete the `ai/` folder** from each individual project repo (step 2.3) and verify symlinks (step 2.4).

### Q: What happened to the mask system (persona levels)?

Masks were removed in v6. The persona is now defined solely by `~/.igris/core/SOUL.md`. If you had custom masks, their content is no longer loaded. Transfer any important persona customizations into `~/.igris/USER.md` instead.

### Q: What happened to `~/.igris/cache/`?

It was renamed to `~/.igris/projects/`. A backward-compatibility symlink (`~/.igris/cache -> ~/.igris/projects`) is created automatically by the migration script. Existing code that references `cache/` will continue to work.

### Q: Can I run the migration on a remote/VPS brain?

The migration script operates on the local `~/.igris/` directory. For a VPS brain, SSH into the server and run the script there. Then use `/sync` from Claude Code to push the updated state.

### Q: What if the v5 brain bootstrap was never run?

You do not have a v5 brain to migrate. Instead, do a fresh v7 install:

```bash
cd /path/to/igris-ai
igris init
igris install /path/to/your-project
```

---

## Quick Reference: Key Paths

| What | v5 Location | v6 Location |
|------|-------------|-------------|
| Project data | `~/.igris/cache/{project}/` | `~/.igris/projects/{project}/` |
| Rules | `~/.igris/core/rules/01-05-*.md` (5 files) | `~/.igris/core/rules/00-igris-universal.md` (1 file) |
| Context routing | CLAUDE.md `@import` directives (67.5KB) | `~/.igris/core/igris_tree.json` (~3KB) |
| Persona | `SOUL.md` + masks (4 levels) | `~/.igris/core/SOUL.md` only |
| Agents in project | `.claude/agents/*.md` (copies) | `.claude/agents/*.md` (symlinks to `~/.igris/core/agents/`) |
| Skills in project | `.claude/skills/` (copies) | `.claude/skills/` (symlinks to `~/.igris/core/skills/`) |
| Briefs | `ai/briefs/` in project repo | Brain DB + `~/.igris/projects/{project}/briefs/` |
| Deprecated dirs | `~/.igris/staging/`, `~/.igris/personas/` | Removed |

---

## Quick Reference: Key Commands

```bash
# Pre-migration backup
cp -r ~/.igris ~/.igris-v5-backup

# Dry run
bash scripts/archive/igris_migrate_v5_to_v6.sh --dry-run

# Run migration
bash scripts/archive/igris_migrate_v5_to_v6.sh

# Verify (from project directory; v6_verify.sh removed in v7)
igris doctor

# Re-register a project
bash igris install .

# Check brain DB
sqlite3 ~/.igris/memory/knowledge.db "SELECT slug, igris_version FROM projects;"

# Rollback
rm -rf ~/.igris && cp -r ~/.igris-v5-backup ~/.igris
```
