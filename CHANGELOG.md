# Changelog

All notable changes to Igris AI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.0] - 2025-10-25

### BREAKING CHANGES

**Complete rebrand from Blueprint AI to Igris AI**

This is a major version bump due to comprehensive rebranding affecting all aspects of the project:

### Changed

- **Project Name:** Blueprint AI → Igris AI
- **Repository:** blueprint-ai → igris-ai (https://github.com/Fifty50ai/igris-ai)
- **Scripts:**
  - `blueprint_init.sh` → `igris_init.sh`
  - `blueprint_update.sh` → `igris_update.sh`
  - All script references updated
- **Version Files:** `.blueprint_version` → `.igris_version`
- **Backup Directories:** `.blueprint_backup` → `.igris_backup`
- **Environment Variables:** `BLUEPRINT_*` → `IGRIS_*`
- **All Documentation:** Comprehensive updates across 36+ files

### Branding Updates

- New identity: Igris AI - Shadow Knight brand
- Updated all references in:
  - README.md and all documentation
  - All prompts and templates
  - Scripts and configuration files
  - Session files and briefs
  - Plugin system references
  - CLAUDE.md template

### Migration from 1.x

**For existing projects:**

1. Update your Igris AI installation:
   ```bash
   # If you have Blueprint AI installed
   git pull  # In the igris-ai repo
   ```

2. Projects initialized with Blueprint AI will continue to work, but to fully migrate:
   - Version tracking file will be `.blueprint_version` (legacy)
   - Run `igris_init.sh --force` to regenerate with new branding
   - Or manually rename `.blueprint_version` to `.igris_version` and update contents

**Breaking:** Script names changed. Update any automation:
- `blueprint_init.sh` → `igris_init.sh`
- `blueprint_update.sh` → `igris_update.sh`

### Compatibility

- Core functionality unchanged - all features work identically
- Existing briefs, sessions, and context files compatible
- Plugin system unchanged (works with both old and new plugins)
- CLAUDE.md format unchanged (content updated only)

---

## [1.0.5] - 2025-10-25

### Added

- **Plugin Hook System** - Enable plugins to inject content into core prompts (TD-003)
  - Added `{{PERSONA_INJECTION}}` hook to CLAUDE.md.template
  - Plugins can now define `hooks` in plugin.json
  - Hook resolution in igris_init.sh (resolves to empty string if no plugin)
  - Automatic CLAUDE.md regeneration when plugin with hooks is installed
  - Documented hook system in PLUGIN_DEVELOPMENT.md
  - Enables upcoming persona packs plugin and future enhancement plugins

### Changed

- **Plugin System Enhancement**
  - plugin_install.sh now reads and stores hooks from plugin.json
  - installed.json now includes hooks field for plugins that provide them
  - CLAUDE.md regenerates automatically after plugin installation if hooks present

### Fixed

- **Multi-line Hook Injection** - Fixed sed newline handling bug
  - igris_init.sh now uses perl for multi-line PERSONA_INJECTION replacement
  - Enables proper persona plugin installation and mask switching
  - Hook content with newlines now correctly injected into CLAUDE.md
  - No impact on plugins without hooks

### Technical Details

**Purpose:** Extend plugin system to support content injection, enabling enhancement-type plugins like persona packs.

**Implementation:**
- Template now includes `{{PERSONA_INJECTION}}` placeholder
- Init and install scripts resolve hooks from installed.json
- Hook content injected as raw markdown
- Backward compatible - plugins without hooks work normally

**Use Cases:**
- Persona systems (modify Claude's tone/voice)
- Team-specific conventions (inject company guidelines)
- Custom workflows (add specialized instructions)
- Branding (add company context)

### Breaking Changes

None - fully backward compatible with v1.0.4

### Migration from v1.0.4

```bash
./scripts/igris_update.sh
```

No action required. Existing projects and plugins continue working normally.

---

## [1.0.4] - 2025-10-15

### Enhanced

- **Workflow Enforcement** - Based on production testing feedback
  - Added mandatory first action protocol to CLAUDE.md (prevents skipped initialization)
  - Added context reset detection (treats all resets as new conversations)
  - Added session state validation checklist (5 items to verify before work)
  - Added checkpoint system to claude_bootstrap.md (5 explicit checkpoints)
  - Clarified TodoWrite vs CURRENT_SESSION.md relationship (both required)
  - Specified exact brief status update timing (immediately after completion)
  - Session management now enforced as critical path, not optional documentation

### Added

- **session_protocol.md** - Quick reference guide for checkpoint protocols
  - Checkpoint 1: Before Starting Work (validation checklist)
  - Checkpoint 2: After Starting TodoWrite Task (update session state)
  - Checkpoint 3: After Completing TodoWrite Task (update session + brief if done)
  - Checkpoint 4: After Brief Completion (IMMEDIATE status update)
  - Checkpoint 5: Before Ending Conversation (save final state)
  - Examples of correct usage and common mistakes to avoid
  - Mental model shift explanation (session = critical path)

- **README.md Session Management Section** - Documents automatic recovery and progress tracking
  - Automatic recovery after context resets
  - Continuous progress tracking
  - Context preservation via "Next Steps When Resuming"
  - Blocker tracking

### Technical Details

**Problem:** Real production testing revealed Claude skipped Igris AI protocols:
- Initialization not executed on context resets
- Session files not updated continuously
- Brief statuses not updated after completion
- Pattern-matched to standard workflow instead of Igris AI workflow

**Root Cause:** Session management felt optional (not critical path)

**Solution:** Made it "in your face":
```
CLAUDE.md:
- Mandatory first action (top of file, unmissable)
- Context reset detection (specific signals to watch for)
- Validation checklist (verify before starting work)

claude_bootstrap.md:
- Critical mental model section (session IS the work)
- TodoWrite + CURRENT_SESSION.md clarification (both required)
- 5-checkpoint system (explicit WHEN/THEN protocols)

session_protocol.md:
- Quick reference for all 5 checkpoints
- Examples and anti-patterns
```

**User Experience:**

Context resets now ALWAYS trigger re-initialization:
```
User: "continue with phase 2"
Claude: [Detects context reset]
Claude: [Reads CURRENT_SESSION.md FIRST]
Claude: "📊 Current Session Status: Active"
Claude: "📋 Next Steps When Resuming: Update CHANGELOG.md"
Claude: "✅ Igris AI initialized. Ready for your command!"
Claude: [THEN proceeds with user's request]
```

Task completion now updates BOTH TodoWrite AND session files immediately.

### Breaking Changes

None - fully backwards compatible with v1.0.3

### Migration from v1.0.3

Run update script to get enhanced workflow enforcement:
```bash
./scripts/igris_update.sh
```

The new protocols take effect immediately in next Claude conversation.

---

## [1.0.3] - 2025-10-14

### Fixed

- **True Zero-Configuration Startup** - Complete reimplementation using Claude Code CLI hooks
  - Now uses `.claude/hooks/startup.sh` for automatic initialization
  - Welcome message displays BEFORE any user input (true auto-execution)
  - Uses `CLAUDE.md` for context (correct Claude Code CLI convention)
  - Removed `.claude/prompt.md` creation (incorrect approach from v1.0.2)
  - Added detection mechanism ("Is Igris AI loaded?" responds with confirmation)

- **Script Installation** - Fixed incomplete script copying during initialization
  - `igris_update.sh` now copied (update Igris AI core)
  - `plugin_update.sh` now copied (update installed plugins)
  - `install_shell_integration.sh` now copied (optional shell notifications)
  - All 6 user-facing scripts now installed correctly

### Changed

- Startup behavior now truly automatic via hooks system
- `CLAUDE.md` provides context on first message
- Hooks are shipped via git (committed to repo, work for all users automatically)
- Project structure updated to show `.claude/hooks/` and `CLAUDE.md`

### Technical Details

**Hooks Architecture:**
```
.claude/
  hooks/
    startup.sh          # Auto-runs when CLI starts
CLAUDE.md              # Context loaded with first message
```

**User Experience:**
```bash
$ claude

🚀 Welcome to Igris AI on Claude Code

📊 Project Status
────────────────
Briefs: None yet (ready for first task)
Blockers: 0

Ready for your command!
```

Welcome message appears BEFORE user types anything. No manual configuration required.

### Migration from v1.0.2

Run update script to get hooks:
```bash
./scripts/igris_update.sh
```

Or re-initialize (if no briefs/work created yet):
```bash
/path/to/igris-ai/scripts/igris_init.sh .
```

### Breaking Changes

None - fully backwards compatible with v1.0.2

---

## [1.0.2] - 2025-10-14

### Added

- **Automatic Claude Code Integration** - Zero-configuration startup for Claude Code CLI
  - `.claude/prompt.md` automatically created during `igris_init.sh`
  - Claude automatically loads Igris AI configuration on every session start
  - Auto-displays project summary (briefs, blockers, status)
  - Auto-recommends next task based on priority
  - Completely automatic - no user action required
  - **Perfect for "safe vibe coding"** - architecture enforcement from day one

- **Optional Shell Integration** - Terminal notifications for Igris AI projects
  - New script: `scripts/install_shell_integration.sh`
  - Shows notification when entering Igris AI projects
  - Displays Igris AI version in terminal
  - Visual context awareness across multiple projects
  - **User controlled** - choose to install via script or manually
  - **Security conscious** - never modifies shell without explicit permission
  - Supports bash and zsh
  - Provides backup before modification
  - Option to view code or install manually

### Improved

- **igris_init.sh Enhanced**
  - Now creates `.claude/prompt.md` for automatic loading
  - Updated success message with Claude Code integration status
  - Added instructions for optional shell integration
  - Better getting started guidance

- **README.md Updated**
  - Added "Start Using Claude (Automatic!)" section
  - Documented zero-configuration experience
  - Added "Optional: Shell Integration" section
  - Clear security messaging about shell modifications
  - Improved Quick Start flow

### User Experience

**Before v1.0.2:**
```bash
$ claude
User: "Use ai/prompts/claude_bootstrap.md and implement BR-001"
```

**After v1.0.2:**
```bash
$ claude

🚀 Welcome to Igris AI on Claude Code
Project: my-project
[Auto-loaded, ready to work]
Ready for your command!

User: "Implement BR-001"
```

**Result:** Zero manual steps. Perfect developer experience.

### Philosophy

This release completes the vision of "safe vibe coding" by:
1. **Eliminating friction** - No manual bootstrap loading
2. **Enforcing quality** - Architecture rules load automatically
3. **Maintaining security** - User controls shell integration
4. **Providing visibility** - Clear project status on startup

### Breaking Changes

None - fully backwards compatible with v1.0.1

---

## [1.0.1] - 2025-10-14

### Added

- **Update System** - Comprehensive update mechanism for Igris AI core and plugins
  - `igris_update.sh` script for updating core to latest version
  - `plugin_update.sh` script for updating individual plugins
  - Version tracking via `.igris_version` JSON file
  - Automatic backup creation in `.igris_backup/` before updates
  - Dry-run mode (`--dry-run`) to preview changes without applying
  - Force mode (`--force`) to re-download files even if versions match
  - Selective updates: system files updated, user data preserved
  - UPDATE_GUIDE.md documentation (535 lines)
  - Update instructions in main README

- **Version Tracking** - Track Igris AI and plugin versions in user projects
  - `version.txt` files in both core and plugin repositories
  - `.igris_version` file created during initialization
  - Automatic version updates during plugin installation
  - Timestamp tracking for installations and updates

- **Example Project** - Complete working reference implementation
  - Repository: https://github.com/Mohamed50/igris_ai_flutter_example
  - Example briefs: BR-001 (bug), FR-001 (feature), TD-001 (technical debt)
  - Conventional commits demonstrating workflow
  - Complete Fastlane setup for iOS and Android
  - Firebase App Distribution configuration
  - Comprehensive 450+ line README
  - Real commit history showing Igris AI in action

### Fixed

- **Plugin Registration Bug** - Plugin installation now correctly updates `ai/plugins/installed.json`
  - Issue: Python script had shell escaping problems with inline format
  - Solution: Changed to heredoc format for reliable execution
  - Affected: `scripts/plugin_install.sh`
  - Commit: 58b4add (core), 10ac302 (fix commit)

- **Release Notes Content Bug** - Release notes now show actual commit messages
  - Issue: Hardcoded template text from previous project (opaala)
  - Solution: Improved JSON parsing using sed regex instead of cut
  - Affected: `scripts/generate_release_notes.sh` in distribution plugin
  - Commit: 6a194d6 (plugin)

- **plugin_update.sh Directory Bug** - Plugin update script now correctly identifies project directory
  - Issue: `PROJECT_DIR` was set after changing to temp directory
  - Solution: Save project directory before changing directories
  - Commit: e6c1d03

### Improved

- **Troubleshooting Documentation** - Enhanced error resolution guide
  - Added Firebase CLI "appdistribution not supported" error section
  - Detailed solutions for common setup issues
  - Better Firebase App Distribution setup instructions
  - Location: `docs/TROUBLESHOOTING.md` in distribution plugin

- **Documentation Updates**
  - Updated README with update system section
  - Added UPDATE_GUIDE.md with comprehensive update instructions
  - Updated ROADMAP.md to reflect completed work
  - Improved example project documentation

### Testing

- End-to-end testing completed in fresh Flutter project
- Found and fixed 2 bugs during testing
- Update system tested: core update (1.0.0 → 1.0.1)
- Update system tested: plugin update (1.0.0 → 1.0.1)
- Test report: `/test_distribution_demo/TEST_REPORT.md`
- Success rate: 100% after fixes (was 85% before fixes)

### Changed

- `igris_init.sh` now creates `.igris_version` file during initialization
- `plugin_install.sh` now updates `.igris_version` with plugin information
- Modified scripts to support version tracking system

---

## [1.0.0] - 2025-10-13

### Added

- **Core Brief Management System**
  - Brief types: BR (Bug Report), MG (Migration), TD (Technical Debt), TS (Testing)
  - Brief templates with structured format
  - Brief lifecycle: Draft → Ready → In Progress → In Review → Done → Archived
  - Priority levels: P0 (Critical), P1 (High), P2 (Medium), P3 (Low)

- **Session Tracking System**
  - CURRENT_SESSION.md for active work tracking
  - BLOCKERS.md for blocking issues
  - DECISIONS.md for architectural decisions
  - LEARNINGS.md for discovered patterns
  - Session archive system with date-based naming

- **Plugin Architecture**
  - Plugin installation system via `plugin_install.sh`
  - Plugin uninstallation via `plugin_uninstall.sh`
  - Plugin listing via `plugin_list.sh`
  - Plugin registry in `ai/plugins/installed.json`
  - Plugin metadata system via `plugin.json`

- **Distribution Plugin for Flutter**
  - Repository: https://github.com/Fifty50ai/igris-ai-distribution-flutter
  - Automated version bumping based on conventional commits
  - Semantic versioning (MAJOR.MINOR.PATCH+BUILD)
  - Release notes generation from commit history
  - Firebase App Distribution integration
  - Fastlane automation for iOS and Android
  - Build script generation
  - Slack notifications support
  - Multi-platform support (iOS, Android, both)

- **Initialization System**
  - `igris_init.sh` for project setup
  - Automatic directory structure creation
  - Template copying and configuration
  - Plugin system setup

- **AI Prompts**
  - Bug workflow prompts (`ai/prompts/bug_prompts.md`)
  - Feature workflow prompts (`ai/prompts/feature_prompts.md`)
  - Architecture documentation generation (`ai/prompts/generate_architecture_docs.md`)
  - Migration analysis (`ai/prompts/migration_analysis.md`)
  - Claude bootstrap prompt (`ai/prompts/claude_bootstrap.md`)

- **Documentation** (2,750+ lines total)
  - Main README.md with quick start guide
  - SETUP_GUIDE.md for installation
  - MIGRATION_GUIDE.md for onboarding existing projects
  - PLUGIN_DEVELOPMENT.md for creating plugins
  - CONTRIBUTING.md for using Igris AI
  - TROUBLESHOOTING.md in distribution plugin
  - ROADMAP.md for future development

- **Templates**
  - Brief template (BR-TEMPLATE.md)
  - Commit message template
  - PR description template
  - Release notes template
  - Slack message template

- **Quality Assurance**
  - QA runbook checklist
  - Pre-distribution checks
  - Testing guidelines

### Features

- **Conventional Commit Support**
  - Automatic version bumping: feat → MINOR, fix → PATCH, etc.
  - Commit analysis and categorization
  - Release notes generation from commits
  - Breaking change detection

- **Automation Scripts**
  - Firebase initialization (`firebase_init.sh`)
  - Fastlane setup (`fastlane_init.sh`)
  - Build scripts for iOS and Android
  - Distribution scripts with environment support

- **Architecture Management**
  - Context directory for architecture documentation
  - Module catalog system
  - API pattern documentation
  - Coding guidelines management

### Documentation

- Comprehensive README with examples
- Complete setup and migration guides
- Plugin development guide
- Contributing guide for users
- Troubleshooting guide
- Roadmap for future development

### Initial Release

This is the first official release of Igris AI, built from production experience managing 210+ releases of a Flutter application. The system has been battle-tested in real-world scenarios and is ready for use by development teams.

**Core Repositories:**
- Igris AI Core: https://github.com/Fifty50ai/igris-ai
- Distribution Plugin: https://github.com/Fifty50ai/igris-ai-distribution-flutter

---

## Release Philosophy

Igris AI follows semantic versioning:

- **MAJOR** version: Incompatible API changes
- **MINOR** version: Backwards-compatible functionality additions
- **PATCH** version: Backwards-compatible bug fixes

### What's Tracked

- Core system changes (Igris AI)
- Plugin changes (tracked separately in plugin repositories)
- Documentation improvements
- Bug fixes
- New features

### Release Process

1. All changes documented in this CHANGELOG
2. Version updated in `version.txt`
3. Git tag created for version
4. GitHub release created with notes
5. Community announcement

---

## Contributing

Found a bug or have a feature request? Please open an issue on GitHub:
- Core: https://github.com/Fifty50ai/igris-ai/issues
- Plugins: Open issue in respective plugin repository

Want to contribute? See [CONTRIBUTING.md](ai/CONTRIBUTING.md) for guidelines.

---

## Links

- **GitHub Repository:** https://github.com/Fifty50ai/igris-ai
- **Example Project:** https://github.com/Mohamed50/igris_ai_flutter_example
- **Distribution Plugin:** https://github.com/Fifty50ai/igris-ai-distribution-flutter
- **Documentation:** See [README.md](README.md) and [docs/](docs/) directory

---

**Last Updated:** 2025-10-14
