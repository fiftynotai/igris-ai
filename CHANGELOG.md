# Changelog

All notable changes to Blueprint AI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.1] - 2025-10-14

### Added

- **Update System** - Comprehensive update mechanism for Blueprint AI core and plugins
  - `blueprint_update.sh` script for updating core to latest version
  - `plugin_update.sh` script for updating individual plugins
  - Version tracking via `.blueprint_version` JSON file
  - Automatic backup creation in `.blueprint_backup/` before updates
  - Dry-run mode (`--dry-run`) to preview changes without applying
  - Force mode (`--force`) to re-download files even if versions match
  - Selective updates: system files updated, user data preserved
  - UPDATE_GUIDE.md documentation (535 lines)
  - Update instructions in main README

- **Version Tracking** - Track Blueprint AI and plugin versions in user projects
  - `version.txt` files in both core and plugin repositories
  - `.blueprint_version` file created during initialization
  - Automatic version updates during plugin installation
  - Timestamp tracking for installations and updates

- **Example Project** - Complete working reference implementation
  - Repository: https://github.com/Mohamed50/blueprint_ai_flutter_example
  - Example briefs: BR-001 (bug), FR-001 (feature), TD-001 (technical debt)
  - Conventional commits demonstrating workflow
  - Complete Fastlane setup for iOS and Android
  - Firebase App Distribution configuration
  - Comprehensive 450+ line README
  - Real commit history showing Blueprint AI in action

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

- `blueprint_init.sh` now creates `.blueprint_version` file during initialization
- `plugin_install.sh` now updates `.blueprint_version` with plugin information
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
  - Repository: https://github.com/Mohamed50/blueprint-ai-distribution-flutter
  - Automated version bumping based on conventional commits
  - Semantic versioning (MAJOR.MINOR.PATCH+BUILD)
  - Release notes generation from commit history
  - Firebase App Distribution integration
  - Fastlane automation for iOS and Android
  - Build script generation
  - Slack notifications support
  - Multi-platform support (iOS, Android, both)

- **Initialization System**
  - `blueprint_init.sh` for project setup
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
  - CONTRIBUTING.md for using Blueprint AI
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

This is the first official release of Blueprint AI, built from production experience managing 210+ releases of a Flutter application. The system has been battle-tested in real-world scenarios and is ready for use by development teams.

**Core Repositories:**
- Blueprint AI Core: https://github.com/Mohamed50/blueprint-ai
- Distribution Plugin: https://github.com/Mohamed50/blueprint-ai-distribution-flutter

---

## Release Philosophy

Blueprint AI follows semantic versioning:

- **MAJOR** version: Incompatible API changes
- **MINOR** version: Backwards-compatible functionality additions
- **PATCH** version: Backwards-compatible bug fixes

### What's Tracked

- Core system changes (Blueprint AI)
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
- Core: https://github.com/Mohamed50/blueprint-ai/issues
- Plugins: Open issue in respective plugin repository

Want to contribute? See [CONTRIBUTING.md](ai/CONTRIBUTING.md) for guidelines.

---

## Links

- **GitHub Repository:** https://github.com/Mohamed50/blueprint-ai
- **Example Project:** https://github.com/Mohamed50/blueprint_ai_flutter_example
- **Distribution Plugin:** https://github.com/Mohamed50/blueprint-ai-distribution-flutter
- **Documentation:** See [README.md](README.md) and [docs/](docs/) directory

---

**Last Updated:** 2025-10-14
