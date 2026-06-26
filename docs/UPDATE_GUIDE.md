# Igris AI Update Guide

**Keep Igris AI up to date**

This guide explains how to update Igris AI to the latest version (v7.0+).

---

## Table of Contents

- [Version Tracking](#version-tracking)
- [Checking Your Version](#checking-your-version)
- [Update Models](#update-models)
- [Updating Igris AI Core](#updating-igris-ai-core)
- [Backup and Safety](#backup-and-safety)
- [Rollback Instructions](#rollback-instructions)
- [Troubleshooting](#troubleshooting)
- [Best Practices](#best-practices)

---

## Version Tracking

> **FR-212d:** the per-project `.igris_version` marker was RETIRED (`igris install`
> is register-only — it writes no files into the project repo). Upgrade detection
> now keys on the brain-side `installed_features.json` (content hashes of the
> canonical agents/skills/hooks) at `~/.igris/projects/<slug>/installed_features.json`.

Igris AI (v7.0+) tracks per-project install state in
`~/.igris/projects/<slug>/installed_features.json` (NOT in the project repo):

```json
{
  "schema_version": 2,
  "cli_version": "7.0.0",
  "brain_channel": "main",
  "brain_ref": "v7.0.0",
  "hooks_version": "<sha>",
  "agents_version": "<sha>",
  "skills_version": "<sha>",
  "installed_at": "2026-02-16T07:37:48Z",
  "updated_at": "2026-02-22T10:00:00Z"
}
```

**Fields:**
- `cli_version` - The CLI version that registered the project
- `*_version` - Content hashes of the canonical agents/skills/hooks; `igris update`
  re-runs the register-only install when these diverge from the current canonical
- `installed_at` / `updated_at` - First registration + last refresh timestamps

This file is automatically written by:
- `igris install <path>` (register-only — writes the registry row + this features file)
- `igris update` (re-stamps it + refreshes the GLOBAL surfaces)

---

## Checking Your Version

### Check Igris AI Version

```bash
# Per-project install state (FR-212d: brain-side, not in the repo):
cat ~/.igris/projects/<slug>/installed_features.json
```

Or check the source repository version:

```bash
node -p "require('/path/to/igris-ai/package.json').version"
```

### Check Brain Status

```bash
# Verify brain exists
ls ~/.igris/

# Check brain database
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA integrity_check;"

# List registered projects
sqlite3 ~/.igris/memory/knowledge.db "SELECT slug, path, status FROM projects;"
```

---

## Update Models

> **FR-212d (global projection):** every surface (skills/agents/MCP/hooks) projects
> GLOBALLY at `igris init` — there is no per-project `.claude/` symlink layer to
> auto-update. A single `igris init` (or `igris refresh`) re-projects the global
> surfaces; ALL registered projects immediately see the change (they share the one
> global store + the one global hooks block). `igris install` is register-only.

### Global Surfaces (the live model)

Surfaces live globally: skills in `~/.claude/skills` + `~/.agents/skills` (placed by
the `skills` CLI delegate), agents in the global harness agent dirs, the Igris hooks
in `~/.claude/settings.json`. Re-project them with:

```bash
# Update the source repository
cd /path/to/igris-ai
git pull origin main

# Re-initialize the brain — re-projects the GLOBAL surfaces (new agents/skills/hooks)
igris init

# Or refresh the brain core from the configured channel:
igris refresh

# Re-stamp each project's features file + refresh the global hooks:
igris update --all
```

Because the surfaces are global, every registered project sees the updated agents/
skills/hooks immediately after the re-projection — no per-project re-link needed.

### Copy-Based Projects (Manual Update)

Projects set up with the old v3-era copy-based installer have copied (not symlinked) files. These require manual updates:

```bash
# Update the source repository
cd /path/to/igris-ai
git pull origin main

# Re-run the update script for each project
cd /path/to/your-project
igris update --all
```

---

## Updating Igris AI Core

### Standard Update

```bash
igris update --all
```

**What happens:**
1. Checks current version against latest release
2. Shows what will be updated
3. Asks for confirmation
4. Re-stamps each registered project's `installed_features.json`
5. Re-projects the GLOBAL surfaces (agents, skills, hooks) — see below
6. Preserves your data (briefs, session, context)

### What Gets Updated (global surfaces — FR-212d)

`igris update` re-stamps each project's `installed_features.json` and refreshes
the GLOBAL Igris hooks (`~/.claude/settings.json`). The brain CONTENT (agents,
skills, prompts) is updated by re-fetching `~/.igris/core/` (`igris refresh`)
and re-projecting it globally (`igris init`):

- `~/.igris/core/agents/*.md` - Agent definitions (projected to the global harness agent dirs)
- `~/.igris/core/skills/*` - Skills (projected to the universal store `~/.claude/skills` + `~/.agents/skills`)
- `~/.claude/settings.json` - The GLOBAL Igris hooks block
- `~/.igris/core/prompts/*.md` - System prompts

There is no per-project `.claude/` layer to update — every surface is global.

### Files That Will Be Preserved

- `~/.igris/projects/{project}/briefs/*.md` - Your work items (briefs also in brain DB)
- `~/.igris/projects/{project}/session/*.md` - Your session tracking
- `~/.igris/projects/{project}/context/*.md` - Your architecture documentation
- `SOUL.md` - Your persona identity
- `~/.igris/USER.md` - Your user configuration
- Your project code and configuration

### Dry Run Mode

Preview what would be updated without making changes:

```bash
igris update --all --dry-run
```

### Force Update

Force update even if versions are the same:

```bash
igris update --all --force
```

---

## Backup and Safety

### Brain core backup (`igris refresh`)

`igris refresh` swaps `~/.igris/core/` atomically — the prior core is preserved
as `~/.igris/core.bak.<timestamp>` so a bad refresh can be rolled back by
reverting the source repo and re-running `igris init` (see Rollback below). The
GLOBAL `~/.claude/settings.json` hooks merge keeps a single `.bak.<timestamp>` of
the prior file (unless `IGRIS_KEEP_BAK=0`).

### What Gets Backed Up

- The prior `~/.igris/core/` (agents, skills, prompts) as `~/.igris/core.bak.<timestamp>`
- The prior GLOBAL `~/.claude/settings.json` (one `.bak.<timestamp>`)

> FR-212d: there is no per-project `.claude/` layer and no `.igris_version`
> marker to back up — `igris install` is register-only.

### What Never Gets Modified

These files are **always preserved** during updates:

- `~/.igris/projects/{project}/briefs/*.md` - Your work items (briefs also in brain DB)
- `~/.igris/projects/{project}/session/*.md` - Your session tracking
- `~/.igris/projects/{project}/context/*.md` - Your architecture documentation
- `SOUL.md` - Your persona identity
- `~/.igris/USER.md` - Your user configuration
- Custom files you've created
- Your project code

---

## Rollback Instructions

If an update causes issues, roll back by reverting the brain SOURCE and
re-projecting the GLOBAL surfaces. Because every surface is global (FR-212d),
there is no per-project layer to restore — one rollback fixes every registered
project at once.

### Rollback the brain core + global surfaces

```bash
# 1. Revert the source repository to the last-good commit
cd /path/to/igris-ai
git log --oneline -5    # find the commit to revert to
git checkout <commit-hash>

# 2. Re-fetch the brain core from the reverted source + re-project globally
igris init --from-source .    # swaps ~/.igris/core/ and re-projects skills/agents/MCP/hooks
```

`igris refresh` keeps the prior core as `~/.igris/core.bak.<timestamp>`; if you
only need to undo a `refresh` (not a source change), point `igris init` /
`igris refresh` back at the previous channel/ref. The GLOBAL
`~/.claude/settings.json` keeps a `.bak.<timestamp>` of the prior hooks block.

---

## Troubleshooting

### "Igris AI not initialized"

**Error:**
```
Error: Igris AI not initialized in this directory
```

**Solution:**
The project isn't registered with the brain. Make sure:
1. You're in the correct project directory
2. The brain is initialized (`ls ~/.igris/core/`) — run `igris init` if not
3. The project is registered — run `igris install .` (register-only)

### "Could not fetch remote version"

**Error:**
```
Error: Could not fetch remote version
```

**Possible causes:**
1. No internet connection
2. GitHub is down
3. Repository has been moved

**Solution:**
```bash
# Check internet connection
ping github.com

# Try accessing repository directly
curl -I https://github.com/fiftynotai/igris-ai

# Wait and retry
igris update --all
```

### Update Script Fails Mid-Update

**Problem:** Update script crashed or was interrupted.

**Solution:**
1. Check backup exists: `ls .igris_backup/`
2. Rollback using instructions above
3. Check error message for specific issue
4. Try update again, or use `--dry-run` first

### Global surfaces stale or missing

**Problem:** The global skills/agents/hooks point at a moved or deleted brain
directory, or look out of date.

**Solution:**
```bash
# Check the global skill/agent stores + the global hooks
ls -la ~/.claude/skills ~/.agents/skills
ls -la ~/.claude/settings.json

# Re-project the GLOBAL surfaces (skills, agents, MCP, hooks)
igris init
```

### Brain Database Corrupted

**Problem:** SQLite database integrity check fails.

**Solution:**
```bash
# Check integrity
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA integrity_check;"

# If corrupted, re-initialize the brain
# WARNING: This resets brain data (learnings, cross-project data)
cd /path/to/igris-ai && igris init
```

### Files Look Corrupted After Update

**Solution:**
```bash
# Re-fetch the brain core + re-project the global surfaces
igris refresh && igris init

# Force re-stamp every registered project's features file
igris update --all --force
```

If still having issues, rollback and report the issue on GitHub.

---

## Best Practices

### Before Updating

1. **Commit your work:**
   ```bash
   git add .
   git commit -m "chore: save work before Igris AI update"
   ```

2. **Check what will change:**
   ```bash
   igris update --all --dry-run
   ```

3. **Read the changelog:**
   - Visit: https://github.com/fiftynotai/igris-ai/releases
   - Check breaking changes
   - Note new features

### Update Strategy

1. **Update source repository first:**
   ```bash
   cd /path/to/igris-ai
   git pull origin main
   ```

2. **Re-project the GLOBAL surfaces:**
   ```bash
   igris init        # re-projects skills/agents/MCP/hooks globally
   ```

3. **Re-stamp registered projects' features files:**
   ```bash
   igris update --all
   ```

4. **Test after updating:**
   - Run `/scan` in Claude Code to verify
   - Check that agents and skills are available
   - Verify brain connectivity

### Regular Updates

**Recommended:**
- Check for updates monthly
- Update before starting major features
- Update after Igris AI releases (watch GitHub)

**When NOT to update:**
- In the middle of critical features
- Right before a production release
- When you don't have time to test

### Brain Maintenance

Periodically check brain health:

```bash
# Check database integrity
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA integrity_check;"

# Check journal mode
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA journal_mode;"

# Check registered projects
sqlite3 ~/.igris/memory/knowledge.db "SELECT slug, path, status FROM projects;"
```

### Version Pinning

If you need to stay on a specific version:

1. Don't run update scripts
2. Document your version in README:
   ```markdown
   ## Dependencies
   - Igris AI: 7.0.0 (pinned)
   ```
3. Test thoroughly before updating

---

## Staying Informed

### Watch for Updates

- **GitHub Releases:** https://github.com/fiftynotai/igris-ai/releases
- **Star the repo** to get notifications
- **Watch releases** to get emails about new versions

### Release Notes

Each release includes:
- Version number (semantic versioning)
- Release date
- Features added
- Bugs fixed
- Breaking changes
- Migration instructions (if needed)

---

## Need Help?

- **Issues:** [GitHub Issues](https://github.com/fiftynotai/igris-ai/issues)
- **Discussions:** [GitHub Discussions](https://github.com/fiftynotai/igris-ai/discussions)
- **Documentation:** [Igris AI Docs](https://github.com/fiftynotai/igris-ai)
