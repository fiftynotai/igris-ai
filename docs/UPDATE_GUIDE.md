# Blueprint AI Update Guide

**Keep Blueprint AI and its plugins up to date**

This guide explains how to update Blueprint AI core and its plugins to the latest versions.

---

## Table of Contents

- [Version Tracking](#version-tracking)
- [Checking Your Version](#checking-your-version)
- [Updating Blueprint AI Core](#updating-blueprint-ai-core)
- [Updating Plugins](#updating-plugins)
- [Backup and Safety](#backup-and-safety)
- [Rollback Instructions](#rollback-instructions)
- [Troubleshooting](#troubleshooting)
- [Best Practices](#best-practices)

---

## Version Tracking

Blueprint AI automatically tracks versions in your project using the `.blueprint_version` file:

```json
{
  "blueprint_ai_version": "1.0.1",
  "installed_at": "2025-10-14T07:39:23Z",
  "last_updated": "2025-10-14T07:39:23Z",
  "plugins": {
    "blueprint-ai-distribution-flutter": {
      "version": "1.0.1",
      "installed_at": "2025-10-14T07:39:23Z",
      "repo": "https://github.com/Mohamed50/blueprint-ai-distribution-flutter"
    }
  }
}
```

This file is automatically created during initialization and updated when you:
- Install Blueprint AI (`blueprint_init.sh`)
- Install plugins (`plugin_install.sh`)
- Update Blueprint AI (`blueprint_update.sh`)
- Update plugins (`plugin_update.sh`)

---

## Checking Your Version

### Check Blueprint AI Core Version

```bash
cat .blueprint_version | grep blueprint_ai_version
```

Or view the full version file:

```bash
cat .blueprint_version
```

### Check Installed Plugins

```bash
./scripts/plugin_list.sh
```

This shows all installed plugins with their versions:

```
🔌 Installed Blueprint AI Plugins
==================================

📦 blueprint-ai-distribution-flutter
   Version: 1.0.1
   Installed: 2025-10-14T07:39:23Z
   Repository: https://github.com/Mohamed50/blueprint-ai-distribution-flutter
   Capabilities: distribution, version-management, firebase
```

---

## Updating Blueprint AI Core

### Standard Update

Update to the latest version:

```bash
./scripts/blueprint_update.sh
```

**What happens:**
1. Checks current version against latest release
2. Shows what will be updated
3. Asks for confirmation
4. Creates backup in `.blueprint_backup/`
5. Updates system files (prompts, templates, checks, scripts)
6. Preserves your data (briefs, session, context, plugins)
7. Updates `.blueprint_version`

### Dry Run Mode

Preview what would be updated without making changes:

```bash
./scripts/blueprint_update.sh --dry-run
```

**Use this to:**
- See which files would be updated
- Check if there are new features
- Verify before committing to update

### Force Update

Force update even if versions are the same (useful for fixing corrupted files):

```bash
./scripts/blueprint_update.sh --force
```

### Example Update Session

```bash
$ ./scripts/blueprint_update.sh

🔄 Blueprint AI Update Manager
==============================

📦 Current version: 1.0.0

🌐 Checking for updates...
📡 Latest version: 1.0.1

📋 Update Summary:
  From: 1.0.0
  To:   1.0.1

📝 Files that will be updated:
  - ai/prompts/*.md (system prompts)
  - ai/templates/*.md (brief templates)
  - ai/checks/*.md (QA checklists)
  - ai/CONTRIBUTING.md (documentation)
  - scripts/plugin_*.sh (plugin management scripts)

🔒 Files that will be preserved:
  - ai/briefs/*.md (your work items)
  - ai/session/*.md (your session data)
  - ai/context/*.md (your architecture docs)
  - ai/plugins/installed.json (plugin registry)

Continue with update? [y/N]: y

📦 Starting update...

💾 Creating backup at .blueprint_backup/20251014_083045...
✅ Backup created

📝 Updating system files...
  - Updating prompts...
  - Updating templates...
  - Updating checks...
  - Updating CONTRIBUTING.md...
  - Updating plugin management scripts...
  - Updating version tracking...

✅ Blueprint AI updated successfully!

📦 Updated to version: 1.0.1
💾 Backup saved at: .blueprint_backup/20251014_083045

📝 What's new in 1.0.1:
  See CHANGELOG.md or visit:
  https://github.com/Mohamed50/blueprint-ai/releases

⚠️  Note: If you have plugins installed, update them separately:
  ./scripts/plugin_update.sh <plugin-name>
```

---

## Updating Plugins

### Update a Specific Plugin

```bash
./scripts/plugin_update.sh <plugin-name>
```

**Example:**

```bash
./scripts/plugin_update.sh blueprint-ai-distribution-flutter
```

### Dry Run Mode

Preview plugin update:

```bash
./scripts/plugin_update.sh blueprint-ai-distribution-flutter --dry-run
```

### Force Update

Force plugin update:

```bash
./scripts/plugin_update.sh blueprint-ai-distribution-flutter --force
```

### Example Plugin Update Session

```bash
$ ./scripts/plugin_update.sh blueprint-ai-distribution-flutter

🔄 Blueprint AI Plugin Updater
==============================

📦 Plugin: blueprint-ai-distribution-flutter
📍 Repository: https://github.com/Mohamed50/blueprint-ai-distribution-flutter
📌 Current version: 1.0.0

🌐 Checking for updates...
📡 Latest version: 1.0.1

📋 Update Summary:
  From: 1.0.0
  To:   1.0.1

Continue with update? [y/N]: y

📦 Starting plugin update...

💾 Creating backup at .blueprint_backup/plugins/20251014_083530_blueprint-ai-distribution-flutter...
✅ Backup created

🔧 Running plugin update...
[Plugin install script output]

📝 Updating plugin registry...

✅ Plugin updated successfully!

📦 Plugin: blueprint-ai-distribution-flutter
📌 Updated to version: 1.0.1
💾 Backup saved at: .blueprint_backup/plugins/20251014_083530_blueprint-ai-distribution-flutter

📝 What's new in 1.0.1:
  Check the plugin repository for changelog:
  https://github.com/Mohamed50/blueprint-ai-distribution-flutter
```

### Update All Plugins

Currently there's no "update all" command. To update all plugins:

```bash
# List installed plugins
./scripts/plugin_list.sh

# Update each one
./scripts/plugin_update.sh blueprint-ai-distribution-flutter
./scripts/plugin_update.sh other-plugin
```

---

## Backup and Safety

### Automatic Backups

Every update creates a timestamped backup:

```
.blueprint_backup/
├── 20251014_083045/              # Core update backup
│   ├── prompts/
│   ├── templates/
│   ├── checks/
│   ├── CONTRIBUTING.md
│   ├── plugin_*.sh
│   └── .blueprint_version
└── plugins/
    └── 20251014_083530_blueprint-ai-distribution-flutter/
        ├── installed.json
        └── .blueprint_version
```

### What Gets Backed Up

**Core Updates:**
- All files that will be modified
- System prompts (`ai/prompts/`)
- Templates (`ai/templates/`)
- Checks (`ai/checks/`)
- Documentation (`ai/CONTRIBUTING.md`)
- Plugin scripts (`scripts/plugin_*.sh`)
- Version file (`.blueprint_version`)

**Plugin Updates:**
- Plugin registry (`ai/plugins/installed.json`)
- Version file (`.blueprint_version`)
- Plugin-specific files (varies by plugin)

### What Never Gets Modified

These files are **always preserved** during updates:

- `ai/briefs/*.md` - Your work items (bugs, features, tasks)
- `ai/session/*.md` - Your session tracking
- `ai/context/*.md` - Your architecture documentation
- Custom files in `ai/context/` you've created
- Your project code and configuration

---

## Rollback Instructions

If an update causes issues, you can rollback using the backup.

### Rollback Blueprint AI Core

```bash
# Find your backup
ls -la .blueprint_backup/

# Example: Rollback to backup from Oct 14, 08:30:45
BACKUP=".blueprint_backup/20251014_083045"

# Restore files
cp -r "$BACKUP/prompts/"* ai/prompts/
cp -r "$BACKUP/templates/"* ai/templates/
cp -r "$BACKUP/checks/"* ai/checks/
cp "$BACKUP/CONTRIBUTING.md" ai/
cp "$BACKUP/plugin_"*.sh scripts/
cp "$BACKUP/.blueprint_version" .

echo "✅ Rollback complete"
```

### Rollback Plugin Update

```bash
# Find plugin backup
ls -la .blueprint_backup/plugins/

# Example: Rollback distribution plugin update
BACKUP=".blueprint_backup/plugins/20251014_083530_blueprint-ai-distribution-flutter"

# Restore registry
cp "$BACKUP/installed.json" ai/plugins/
cp "$BACKUP/.blueprint_version" .

# Re-run plugin uninstall and install with old version
./scripts/plugin_uninstall.sh blueprint-ai-distribution-flutter
./scripts/plugin_install.sh https://github.com/Mohamed50/blueprint-ai-distribution-flutter --version 1.0.0

echo "✅ Plugin rollback complete"
```

---

## Troubleshooting

### "Blueprint AI not initialized"

**Error:**
```
❌ Error: Blueprint AI not initialized in this directory
```

**Solution:**
You're not in a Blueprint AI project directory. Make sure:
1. You're in the correct project directory
2. Blueprint AI is initialized (`.blueprint_version` exists)
3. If not initialized, run `./scripts/blueprint_init.sh`

### "Could not fetch remote version"

**Error:**
```
❌ Error: Could not fetch remote version
```

**Possible causes:**
1. No internet connection
2. GitHub is down
3. Repository has been moved or deleted

**Solution:**
```bash
# Check internet connection
ping github.com

# Try accessing repository directly
curl -I https://github.com/Mohamed50/blueprint-ai

# Wait and retry
./scripts/blueprint_update.sh
```

### "Plugin is not installed"

**Error:**
```
❌ Error: Plugin 'xyz' is not installed
```

**Solution:**
```bash
# Check installed plugins
./scripts/plugin_list.sh

# Install the plugin first
./scripts/plugin_install.sh <plugin-repo-url>
```

### Update Script Fails Mid-Update

**Problem:** Update script crashed or was interrupted.

**Solution:**
1. Check backup exists: `ls .blueprint_backup/`
2. Rollback using instructions above
3. Check error message for specific issue
4. Try update again, or use `--dry-run` first

### Files Look Corrupted After Update

**Solution:**
```bash
# Use --force to re-download all files
./scripts/blueprint_update.sh --force
```

If still having issues, rollback and report the issue on GitHub.

---

## Best Practices

### Before Updating

1. **Commit your work:**
   ```bash
   git add .
   git commit -m "chore: save work before Blueprint AI update"
   ```

2. **Check what will change:**
   ```bash
   ./scripts/blueprint_update.sh --dry-run
   ```

3. **Read the changelog:**
   - Visit: https://github.com/Mohamed50/blueprint-ai/releases
   - Check breaking changes
   - Note new features

### Update Strategy

1. **Update core first:**
   ```bash
   ./scripts/blueprint_update.sh
   ```

2. **Then update plugins:**
   ```bash
   ./scripts/plugin_update.sh <plugin-name>
   ```

3. **Test after updating:**
   - Run your build: `flutter build`
   - Run tests: `flutter test`
   - Verify automation scripts still work

### Regular Updates

**Recommended:**
- Check for updates monthly
- Update before starting major features
- Update after Blueprint AI releases (watch GitHub)

**When NOT to update:**
- In the middle of critical features
- Right before a production release
- When you don't have time to test

### Version Pinning

If you need to stay on a specific version:

1. **Don't run update scripts**
2. **Document your version in README:**
   ```markdown
   ## Dependencies
   - Blueprint AI: 1.0.1 (pinned)
   ```

3. **Test thoroughly before updating**

---

## Staying Informed

### Watch for Updates

- **GitHub Releases:** https://github.com/Mohamed50/blueprint-ai/releases
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

- **Issues:** [GitHub Issues](https://github.com/Mohamed50/blueprint-ai/issues)
- **Discussions:** [GitHub Discussions](https://github.com/Mohamed50/blueprint-ai/discussions)
- **Documentation:** [Blueprint AI Docs](https://github.com/Mohamed50/blueprint-ai)

---

**Happy updating! 🚀**
