# Igris AI Update Guide

**Keep Igris AI up to date**

This guide explains how to update Igris AI v4.0 to the latest version.

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

Igris AI v4.0 tracks versions in the `.igris_version` file in each installed project:

```json
{
  "igris_ai_version": "5.0.0",
  "install_mode": "symlink",
  "brain_path": "/Users/you/.igris",
  "installed_at": "2026-02-16T07:37:48Z",
  "last_updated": "2026-02-22T10:00:00Z"
}
```

**Fields:**
- `igris_ai_version` - The installed Igris AI version
- `install_mode` - Either `"symlink"` (brain-first) or `"copy"` (standalone)
- `brain_path` - Path to the centralized brain (symlink mode only)
- `installed_at` - When Igris AI was first installed in this project
- `last_updated` - When the installation was last updated

This file is automatically created during initialization and updated by:
- `igris_init.sh` (copy-based install)
- `igris_install.sh` (symlink-based install)
- `igris_update.sh` (update script)

---

## Checking Your Version

### Check Igris AI Version

```bash
cat .igris_version
```

Or check the source repository version:

```bash
cat /path/to/igris-ai/version.txt
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

Igris AI v4.0 has two update models depending on your install mode.

### Symlink-Based Projects (Auto-Update)

Projects installed with `igris_install.sh` use symlinks to the brain at `~/.igris/`. These projects **automatically receive updates** when you update the source repository:

```bash
# Update the source repository
cd /path/to/igris-ai
git pull origin main

# Re-initialize the brain (picks up new agents, rules, skills)
./scripts/igris_brain_init.sh
```

Since `.claude/agents/`, `.claude/rules/`, and `.claude/skills/` are symlinked, all linked projects immediately see the updated files.

### Copy-Based Projects (Manual Update)

Projects installed with `igris_init.sh` have copied files. These require manual updates:

```bash
# Update the source repository
cd /path/to/igris-ai
git pull origin main

# Re-run the update script for each project
cd /path/to/your-project
/path/to/igris-ai/scripts/igris_update.sh
```

---

## Updating Igris AI Core

### Standard Update

```bash
./scripts/igris_update.sh
```

**What happens:**
1. Checks current version against latest release
2. Shows what will be updated
3. Asks for confirmation
4. Creates backup in `.igris_backup/`
5. Updates system files (agents, rules, skills, prompts, templates)
6. Preserves your data (briefs, session, context)
7. Updates `.igris_version`

### Files That Will Be Updated

- `.claude/agents/*.md` - Agent definitions (7 agents)
- `.claude/rules/*.md` - Modular rules (5 rules)
- `.claude/skills/` - Skills (21 skills)
- `.claude/hooks/` - Hook scripts
- `~/.igris/core/prompts/*.md` - System prompts
- `~/.igris/core/templates/*.md` - Brief and PR templates
- `scripts/igris_*.sh` - Core scripts
- `CLAUDE.md` - Claude Code instructions

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
./scripts/igris_update.sh --dry-run
```

### Force Update

Force update even if versions are the same:

```bash
./scripts/igris_update.sh --force
```

---

## Backup and Safety

### Automatic Backups

Every update creates a timestamped backup:

```
.igris_backup/
├── 20260222_100000/              # Update backup
│   ├── agents/
│   ├── rules/
│   ├── skills/
│   ├── prompts/
│   ├── templates/
│   └── .igris_version
```

### What Gets Backed Up

- All files that will be modified during the update
- Agent definitions (`.claude/agents/`)
- Rule files (`.claude/rules/`)
- System prompts (`~/.igris/core/prompts/`)
- Templates (`~/.igris/core/templates/`)
- Version file (`.igris_version`)

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

If an update causes issues, you can roll back using the backup.

### Rollback Igris AI Core

```bash
# Find your backup
ls -la .igris_backup/

# Example: Rollback to backup from Feb 22
BACKUP=".igris_backup/20260222_100000"

# Restore files
cp -r "$BACKUP/agents/"* .claude/agents/
cp -r "$BACKUP/rules/"* .claude/rules/
cp -r "$BACKUP/prompts/"* ~/.igris/core/prompts/
cp -r "$BACKUP/templates/"* ~/.igris/core/templates/
cp "$BACKUP/.igris_version" .

echo "Rollback complete"
```

### Rollback Brain (Symlink Mode)

For symlink-based installations, rollback by reverting the source repository:

```bash
cd /path/to/igris-ai
git log --oneline -5  # Find the commit to revert to
git checkout <commit-hash>

# Re-initialize brain from the reverted state
./scripts/igris_brain_init.sh
```

---

## Troubleshooting

### "Igris AI not initialized"

**Error:**
```
Error: Igris AI not initialized in this directory
```

**Solution:**
You're not in an Igris AI project directory. Make sure:
1. You're in the correct project directory
2. Igris AI is initialized (`.igris_version` exists)
3. If not initialized, run the appropriate install script

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
./scripts/igris_update.sh
```

### Update Script Fails Mid-Update

**Problem:** Update script crashed or was interrupted.

**Solution:**
1. Check backup exists: `ls .igris_backup/`
2. Rollback using instructions above
3. Check error message for specific issue
4. Try update again, or use `--dry-run` first

### Symlinks Broken

**Problem:** Symlinks point to a moved or deleted brain directory.

**Solution:**
```bash
# Check where symlinks point
ls -la .claude/agents

# Re-run the install script to recreate symlinks
/path/to/igris-ai/scripts/igris_install.sh .
```

### Brain Database Corrupted

**Problem:** SQLite database integrity check fails.

**Solution:**
```bash
# Check integrity
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA integrity_check;"

# If corrupted, re-initialize the brain
# WARNING: This resets brain data (learnings, cross-project data)
/path/to/igris-ai/scripts/igris_brain_init.sh
```

### Files Look Corrupted After Update

**Solution:**
```bash
# Use --force to re-copy all files
./scripts/igris_update.sh --force
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
   ./scripts/igris_update.sh --dry-run
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

2. **Re-initialize brain (symlink mode):**
   ```bash
   ./scripts/igris_brain_init.sh
   ```

3. **Run update for copy-based projects:**
   ```bash
   cd /path/to/your-project
   /path/to/igris-ai/scripts/igris_update.sh
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
   - Igris AI: 5.0.0 (pinned)
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
