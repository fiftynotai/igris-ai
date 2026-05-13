# Changelog

All notable changes to Igris AI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [7.0.0] - TBD

### Changed

- **docs:** archived end-of-life v5/v6 docs to `docs/archive/` — `v6-migration-checklist.md`, `v6-architecture.md`, `IGRIS_DESKTOP_QUICKSTART.md`, `IGRIS_UI_ARCHITECTURE.md`, and `MIGRATION_GUIDE.md` (renamed to `MIGRATION_GUIDE-v5-to-v6.md` in the archive). Live `docs/` now reflects v7 only. Version strings swept to 7.0.0 across `core/`, `brain-mcp-server/`, `docs/`, `CONTRIBUTING.md`, `CLAUDE.md`. Deleted `version.txt` (`package.json` is canonical). Dead-section sweep in `core/prompts/igris_os.md` (Modular Rules Architecture, Project-Specific Notes, `@import` claim) and `core/SOUL.md` (Mask Levels — single fixed voice now). (TD-147)
- **Subconscious engine disabled by default** -- the rule-based gap/pattern/stalled detectors had a 2% true-positive rate, training users to ignore diagnostics. New `subconscious.enabled` config flag in `~/.igris/config.json` defaults to `false`. Both `subconscious_engine` schedule rows disabled. `/awaken` §4.8 and `/scan` §6.5 silently skip when the flag is false. Existing pending suggestions bulk-dismissed with reason `"subconscious paused pending FR-118 redesign (TD-102)"`. Schedule rows preserved — re-enable in V7.1 is a flag flip after FR-118 ships the LLM-driven replacement (TD-102).
- **Removed vestigial `features.mcp_server` config flag** -- the flag was documented as gating "all 27 MCP tools" but had zero runtime consumers. Its only effect was prose-driven self-skipping of MCP-mandatory steps in `/awaken`, `/scan`, `/rest`, which masked a 4,781-row `sync_queue` accumulation during a 20-hour VPS outage on 2026-05-04. Real gates remain unchanged: `~/.claude.json` registration (Claude Code's actual MCP gate) and tool-availability detection at call time. Existing `~/.igris/config.json` files in the wild get auto-migrated via a soft `pop()` cleanup in `scripts/igris_install.sh` on next install. Skills required no changes — they already used tool-availability detection (BR-065).
- Cleaned up 18 stale bats tests asserting on v4 `ai/` directory layout, removed brief template files, removed mask greeting files, the deleted "MANDATORY FIRST ACTION" CLAUDE.md text, and legacy `~/.igris/output/...` paths. Tests reclassified: 10 deleted (no v6 equivalent by design), 7 updated to assert v6 paths (`.claude/`, `~/.igris/projects/{slug}/session/`), 1 skipped pending awaken §3.6.3.a integration. `bats test/*.test.bash` now returns 0 not-ok results. (TD-106)

### Fixed

- **Sync queue drain fails wholesale on multi-row chunks** -- the `/sync/push` HTTP handler wrapped all SYNC_TABLES `mergeRows` calls in one global `db.transaction()`. A single bad row in any table (e.g., a `brief_files` row with `content` shaped as a serialized Buffer object that better-sqlite3 can't bind) aborted the whole transaction, the generic catch returned HTTP 500, and all rows in the chunk were reported as failed — accumulating ~5,000 rows in `sync_queue` over a 20-hour incident. Fix is multi-pronged: server-side per-table transaction isolation with sqlite_master preflight (BR-064 carry-over) and a new HTTP 207 Multi-Status response shape (`{ok, results, errors}`) for partial-failure visibility; row-level try/catch in `mergeRows` that returns a `failures` array with per-row table+key+error diagnostics; new `CHUNK_SIZE_LIMIT_DRAIN` constant (256 KB, was 5 MB) on the drain path with bisect-on-failure that isolates a single bad row in log2(N) push attempts and surfaces it with a specific `"HTTP 207 — table=X key=Y"` error message instead of generic `"HTTP 500"`. Auto-push (`pushTables`), `handleBrainPush`, and `handleSyncQueueDrain` all updated for the new response shape — failed tables stay at their old `last_push_at` horizon and rows are queued with the table-specific error, instead of advancing past the failure as before. 18 new regression tests (15 in `sync-push-isolation.test.ts` covering the server handler, 3 in `auto-push-207.test.ts` covering the auto-push partial path). Auto-push hot path keeps the 5 MB chunk cap; only the drain path is bounded. (BR-066, addresses MG-014).

---

## [5.0.0] - 2026-03-10

### Added

- **Modular Engine Architecture** -- 13 domain components (memory, errors, projects, metrics, sessions, briefs, tasks, instances, sync, cache, schedules, coordination, monitoring) with event bus, dependency resolution, and lifecycle management
- **67 MCP Tools** -- expanded from 27 tools in v4.0 to 67 across 13 components
- **34 REST API Endpoints** -- full HTTP API with auth, rate limiting, SSE streaming, hook event ingestion, metrics recording
- **Task Management System** -- 13 task tools, DAG dependencies, atomic claim, capability-filtered routing, 9 task types
- **Task Results Storage** -- `task_results` table with 7 result types (commit, file, text, image, url, json, error)
- **Distributed Worker Daemon** -- `igris_worker.sh` polling daemon with concurrency control, auto-sleep, capability-based task matching
- **6 Task Handler Skills** -- portable markdown handlers for dev, content, research, media-gen, operational, social-media
- **Scheduling System** -- cron-based smart-sleep daemon with 7 schedule tools
- **Autonomous Coordination** -- capability-based auto-routing, priority adjustment, self-healing on task failure
- **Event Monitoring** -- `event_log` table, 2 monitoring tools, SSE streaming
- **Cache Layer** -- brain-to-filesystem cache rebuild/clean for offline access
- **Brief & Session CRUD** -- 6 new MCP tools for direct brief/session management
- **Sync Auto-Push** -- event-driven brain replication with batched window and queue retry
- **Skill & Rule Path Migration** -- all 20 skills, 5 rules, prompts moved to MCP-first with cache fallback
- **HTTP Hooks for Brain Events** -- SubagentStart, SubagentStop, and Stop hooks POST directly to brain REST API (`POST /api/hooks/event`), replacing shell script event pipeline (FR-088)
- **Auto Agent Metrics via SubagentStop** -- hook automatically records agent type, duration, and result to brain on every subagent completion, eliminating manual orchestrator metrics calls (FR-089)
- **Agent Teams Quality Gate Hooks** -- `TaskCompleted` hook verifies test evidence before allowing completion; `TeammateIdle` hook assigns next brain task to idle teammates (FR-090)
- **Hook Event JSON Schema** -- `docs/HOOK_EVENT_SCHEMA.md` documents the event format for cross-CLI adapter reuse in v6 (FR-088)
- **Auto-Allow Brain MCP Tools** -- glob pattern in `.claude/settings.json` pre-approves all `mcp__igris-brain__*` tools
- **Brief Dashboard Summary Mode** -- `igris_brief_dashboard` supports `summary_only: true` to return counts without full brief content, preventing context bloat (BR-057)
- **Sync Queue for MCP Outages** -- skills queue brain operations locally when MCP server is unavailable, with visible warnings (BR-045)

### Changed

- **Brain engine rewritten** -- monolithic index.ts replaced with modular component architecture
- **Database expanded** -- ~30 tables (up from ~15 in v4.0), 4 migration waves
- **Tool count tripled** -- 27 tools (v4.0) -> 67 tools (v5.0)
- **Built-in git instructions disabled** -- `includeGitInstructions: false` in settings.json ensures Igris commit standards are the sole authority, preventing Co-Authored-By tag conflicts (BR-058)
- **Shared FTS5 sanitizer** -- extracted to `brain-mcp-server/src/utils/fts5.ts` with empty-string guards, used by memory, errors, and briefs components (BR-055)
- **Stale references cleaned** -- removed all remaining `ai/` directory references from prompts, hooks, and templates (BR-053)

### Removed

- **Crimson Arena Dashboard** -- extracted to separate repository (crimson-arena) for independent development
- **Higgsfield MCP Server** -- removed `tools/higgsfield-mcp/` and `/higgsfield` skill; functionality replaced by browser automation via `claude-in-chrome` (BR-056)

---

## [4.0.0] - 2026-02-22

### Added

- **Centralized Brain (`~/.igris/`)** — Persistent SQLite memory with WAL mode and FTS5 full-text search, symlink-based core files shared across all projects, cross-project intelligence and pattern recognition
- **Brain MCP Server (`brain-mcp-server/`)** — 27 MCP tools across 8 domains: memory (store, search, recall, error lookup), projects (register, list, status, pattern suggest), metrics (record, query, velocity), sessions (sync, recall, file sync), briefs (sync, dashboard, file sync), instances (heartbeat, list, remove), sync (push, pull, queue status, queue drain), definitions (sync, pull, session file pull)
- **Remote Brain Sync** — Local-to-VPS brain push/pull via HTTP API with queue-based retry, enabling cross-machine brain access and redundancy
- **Agent Teams (experimental)** — Parallel execution layer spawning multiple Claude Code instances for concurrent brief implementation. 4 modes: `/team hunt` (parallel briefs), `/team review` (multi-angle review), `/team investigate` (competitive investigation), `/team refactor` (parallel module refactoring). Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: 1`
- **Native Claude Code Skills (21 skills)** — awaken, rest, scan, register, archive, hunt, team, audit, document, standardize, release, dashboard, portfolio, projects, sync, digivolve, ideate, migrate-analyze, ui-design, higgsfield, fifty-kit. Defined in `.claude/skills/*/SKILL.md` with autocomplete support
- **Claude Code Hooks (11 hooks, 7 lifecycle events)** — brief_gate (brief-first enforcement), agent_metrics (subagent tracking), post_edit_lint, post_brief_sync, post_session_sync, session_start/end, pre_compact, stop_session_check, notification_sound
- **Crimson Arena Dashboard** — Flutter web dashboard with real-time WebSocket updates, MVVM architecture, RPG-style skill cards, context breakdown, battle log, brain status monitoring, token budget tracking
- **Instance Tracking** — Register/deregister live Igris instances via heartbeat, cross-machine visibility through brain MCP tools
- **Environment Variable Support** — Brain credentials moved to environment variables with backward compatibility (BR-028), `.env.example` added with placeholder values

### Changed

- **Agent architecture simplified:** 18 agents (v3.3) reduced to 7 focused agents (architect, forger, sentinel, warden, mender, seeker, sage). 11 agents retired and replaced by native skills
- **Tier system simplified:** 6 tiers reduced to 5 tiers. Tier 6 meta-orchestration removed and replaced by Agent Teams parallel execution layer
- **Brief types expanded:** 3 types (BR, TD, MG) expanded to 9 types (added FR, PI, DU, PF, AC, TS)
- **Installation model:** Copy-based installation replaced by symlink-based installation via centralized brain. Update brain once, all projects update instantly
- **Script hardening:** All scripts hardened with `set -euo pipefail` for strict error handling
- **MCP server security:** `execFile` replaces `exec` for all git operations, eliminating shell interpolation risks (BR-026)

### Fixed

- **Command injection in MCP server** — `git.ts` used `exec()` with string interpolation, enabling arbitrary command execution via crafted branch names or commit messages. Replaced with `execFile()` and argument arrays (BR-026)
- **Path traversal in MCP server** — `files.ts` did not validate paths, allowing reads outside project root. Added path validation and containment (BR-026)
- **Shell injection in Python heredocs** — Plugin scripts used `exec()` with f-strings containing user input. Replaced with `subprocess.run()` and proper argument passing (BR-027)
- **Triple-quote injection in hook fallbacks** — Hook Python fallbacks were vulnerable to injection via JSON values containing triple quotes. Fixed with proper escaping (BR-027)
- **`persona_mask.sh` jq dependency** — Script required jq with no fallback. Added python3 fallback for environments without jq (BR-027)
- **Cross-platform `stat` compatibility** — `brief_gate.sh` used GNU `stat` flags not available on macOS. Fixed with cross-platform detection (BR-027)

### Security

- Config credentials moved from plaintext `config.json` to environment variables with backward compatibility (BR-028)
- `.env.example` added with placeholder values for all credential fields
- All git MCP operations use argument arrays — no shell interpolation anywhere in the MCP server
- Path traversal protection on all file-reading MCP tools

---

## [3.4.0] - 2026-01-15

### Added

- **Modular Rules Architecture (`.claude/rules/`)** — 5 rule files loaded automatically by Claude Code, replacing monolithic CLAUDE.md instruction blocks: init, briefs, commits, agents, persona
- **Hook System** — Shell-based hooks for lifecycle events (post-edit, pre-commit, session start/end), enabling automated linting, brief sync, and metric collection
- **Session Metrics Tracking** — Agent invocation metrics stored in `ai/session/metrics/agent-metrics.json`, tracking usage frequency, success rates, and token consumption per agent
- **Brain MCP Server (initial prototype)** — First version of the TypeScript MCP server providing memory storage and retrieval tools

### Changed

- **CLAUDE.md simplified** — Heavy instruction content moved to modular rules, CLAUDE.md now serves as entry point with `@import` directives
- **Agent count reduced** — Began consolidation from 18 agents toward focused core set, retiring documentation and innovation tier agents in favor of skills

---

## [3.3.1] - 2025-12-25

### Fixed

- **Corrupted Agent Files Restored** - 5 custom agents recovered and standardized
  - Files had been overwritten with "404: Not Found" text (14 bytes each)
  - Affected agents:
    - **ui-designer (ARTISAN)** - Tier 1 visual design specialist
    - **multi-agent-coordinator (CONDUCTOR)** - Tier 6 workflow orchestration
    - **agent-organizer (TACTICIAN)** - Tier 6 team assembly
    - **context-manager (ARCHIVIST)** - Tier 6 state management
    - **task-distributor (DISPATCHER)** - Tier 6 task scheduling
  - All agents restored via `git restore` from last good commit

---

## [3.3.0] - 2025-12-24

### Added

- **New Tier 6: Meta-Orchestration** - 4 agents for advanced workflow coordination
  - **multi-agent-coordinator (CONDUCTOR):** Orchestrates complex multi-agent workflows, manages inter-agent communication, and enables parallel execution
    - Triggers: `coordinate`, `parallel`, `orchestrate`, `conductor`, `workflow`
  - **agent-organizer (TACTICIAN):** Assesses agent capabilities and assembles optimal teams for specific tasks
    - Triggers: `organize`, `team`, `assemble`, `tactician`, `capability`
  - **context-manager (ARCHIVIST):** Manages shared context, state synchronization, and recovery points across agents
    - Triggers: `context`, `state`, `sync`, `archivist`, `checkpoint`, `recover`
  - **task-distributor (DISPATCHER):** Distributes tasks, manages queues, load balances, and schedules priorities across agents
    - Triggers: `distribute`, `queue`, `schedule`, `dispatcher`, `balance`, `priority`

- **New Tier 1 Agent: ui-designer (ARTISAN)** - Visual design specialist
  - Creates intuitive, accessible user interfaces with design systems and interaction patterns
  - Triggers: `design`, `ui`, `ux`, `visual`, `accessibility`, `artisan`, `component`
  - Full read/write access for creating UI components

- **Flutter MVVM Actions Expert (SAGE)** - Tier 5 custom agent
  - Expert Flutter specialist mastering Kalvad's MVVM + Actions Layer architecture with GetX
  - Enforces clean layer separation, reactive state, and type-safe patterns
  - Triggers: `flutter`, `mvvm`, `actions layer`, `getx`, `kalvad`, `sage`, `dart`, `widget`

### Changed

- **Agent Count Expanded** - 13 agents to 18 agents across 6 tiers
  - Tier 1 (Core): 4 → 5 agents (+ui-designer)
  - Tier 5 (Custom): 0 → 1 agent (+flutter-mvvm-actions-expert)
  - Tier 6 (Meta-Orchestration): NEW tier with 4 agents

- **Manifest Updated** - `.claude/agents/manifest.yaml` now v3.3
  - Added Tier 6 definition for meta-orchestration agents
  - Updated agent count metadata
  - All 18 agents registered with full trigger phrases

- **igris_os.md Updated** - Operating system now references v3.3 architecture
  - Agent registry table updated with 18 agents
  - Tier 6 documentation added
  - New agent capabilities documented

### Improved

- **Mandatory Subagent Delegation Protocol** - Stricter enforcement of orchestrator pattern
  - Decision tree for when to delegate vs handle directly
  - Clear rules for which agent handles which task type
  - "We built 18 specialized agents. USE THEM." principle

- **MCP Server Setup** - Improved init script with MCP configuration (FR-004)
  - MCP server setup now part of initialization workflow
  - Better documentation for Claude integration

---

## [3.2.0] - 2025-12-04

### Added

- **Native Multi-Agent Architecture** - 12 specialized Claude Code subagents
  - **Tier 1 - Core:** planner, coder, tester, reviewer
  - **Tier 2 - Documentation:** documenter, releaser, standardizer (NEW)
  - **Tier 3 - Maintenance:** auditor, debugger, migrator (NEW)
  - **Tier 4 - Innovation:** ideator, explorer
  - Agent manifest at `.claude/agents/manifest.yaml`
  - Stateless workers with orchestrator pattern
  - Persona-aware agent aliases (e.g., planner → ARCHITECT)

- **New Agents (v3.2)**
  - **standardizer (LAWKEEPER):** Generate coding_guidelines.md with 4 modes
    - Trigger: `STANDARDIZE {mode}` where mode = analyze|from-base|hybrid|minimal
  - **migrator (PATHFINDER):** Migration analysis and roadmap generation
    - Trigger: `MIGRATE analyze`

- **Workflow State Machine** - Autonomous implementation pipeline
  - States: INIT → PLANNING → APPROVAL → BUILDING → TESTING → REVIEWING → COMMITTING → COMPLETE
  - Automatic retry with self-healing (max 3 test failures, max 2 review rejections)
  - Approval gate for L/XL complexity or P0/P1 priority
  - Brief-level state tracking (phase, active agent, retry count, agent log)

- **DIGIVOLVE Protocol** - Dynamic agent management
  - `DIGIVOLVE status` - List all agents with usage stats
  - `DIGIVOLVE add` - Create custom Tier 5 agents
  - `DIGIVOLVE upgrade/disable/enable/remove` - Agent lifecycle management
  - Agent metrics tracking in `ai/session/metrics/agent-metrics.json`

- **Test Coverage for igris_update.sh** - 20 new tests (TD-015)
  - Validation, dry-run, version checking, migration, error handling
  - Total test count: 164 tests across 8 test files

### Changed

- **Prompts Consolidated** - Reduced from 7+ files to 2 core files
  - `ai/prompts/igris_os.md` - Complete operating system (all protocols)
  - `ai/prompts/session_protocol.md` - Session tracking details
  - Old prompts absorbed into native subagent capabilities

- **Scripts Updated for v3.2** (TD-015)
  - `igris_init.sh`: Removed ~115 lines dead hook code, added `.claude/agents/` copy
  - `igris_update.sh`: Added agents backup/update, removed CONTRIBUTING.md refs
  - Updated Getting Started messages with v3.2 commands

- **Init Output** - Now shows v3.2 commands (STANDARDIZE, DOCUMENT, MIGRATE, Implement)

### Removed

- **Dead Hook Functions** - `resolve_hooks()` and `execute_hook()` removed from igris_init.sh
  - These were defined but never called (legacy from LangChain/LangGraph exploration)
  - Plugin hooks still work via installed.json and CLAUDE.md regeneration

- **Obsolete Prompt Files** - Consolidated into agents and igris_os.md
  - `generate_coding_guidelines.md` → standardizer agent
  - `generate_architecture_docs.md` → documenter agent
  - `migration_analysis.md` → migrator agent
  - `bug_prompts.md`, `feature_prompts.md` → igris_os.md

### Fixed

- **Test Assertions** - Fixed existing installation detection test (exit code 1 is correct)
- **Prompt File Assertions** - Updated tests for v3.2 consolidated structure

---

## [2.4.0] - 2025-11-09

### Added

- **Igris Persona Bundled** - Enhanced AI performance with personality system
  - **Default Configuration:** Half mask (subtle, professional branding)
  - **Auto-Activation:** Persona active by default on fresh install
  - **Bundled Persona:** Igris (Shadow Knight) included out-of-the-box
  - **Mask System:** 4 levels (none, half, light, full) - adjust anytime
  - **Performance Boost:** Measurable improvement in AI response quality and consistency
  - **User Control:**
    - Adjust mask: `./scripts/persona_mask.sh adjust [none|half|light|full]`
    - Remove persona: `./scripts/persona_mask.sh remove`
    - Status check: `./scripts/persona_mask.sh status`
  - **Self-Contained:** CLAUDE.md template copied to projects (persona changes work without repo dependency)
  - **Identity Statement:** Greetings include version, capabilities, and developer attribution
  - **Future:** Advanced persona creation coming in v3.0.0
  - Result: Professional AI experience with optional dramatic flair

- **README.md Comprehensive Overhaul** - Complete documentation for v2.4.0
  - **Content Added:** 785+ new lines of documentation
  - **Tool Comparisons:** IGRIS vs Cursor, Aider, Copilot, Plain Claude (4 detailed comparisons)
  - **Common Workflows:** 5 end-to-end scenarios (new project, existing code, release, maintenance, planning)
  - **FAQ Section:** 15 Q&As across General, Installation, Usage, Plugins, Troubleshooting, Advanced
  - **Best Practices:** Clear communication, focused sessions, context resets, violation monitoring
  - **User-Driven Philosophy:** "You Drive, IGRIS Assists" with 4 real-world examples
  - **Brief System Value:** 5 use cases (tracking, decisions, reports, onboarding, planning)
  - **All Capabilities Documented:** 9 brief types, 10 self-maintenance operations
  - Result: Complete onboarding and reference guide (README expanded from 850 → 1,635 lines)

- **Complete Plugin Uninstall System (BR-008)** - Plugin cleanup now fully functional
  - **Phase 1:** Plugin-specific cleanup via optional `uninstall.sh` script
  - **Phase 2:** Core cleanup (hooks removal, CLAUDE.md regeneration)
  - **Backup system:** Creates backup before removal (`.igris_backup/uninstall/<timestamp>_<plugin_name>/`)
  - **Smart detection:** Checks if plugin provides uninstall.sh, runs it if exists
  - **Hook management:** Removes plugin hooks, regenerates CLAUDE.md without them (preserves other plugins' hooks)
  - **Clear feedback:** Summary shows what was removed, warns if files remain
  - **Documentation:** Added comprehensive "uninstall.sh Contract" section to `docs/PLUGIN_DEVELOPMENT.md`
    - Input parameters, required behavior, best practices
    - Full example with testing instructions
    - When to provide vs when to skip
  - Result: Clean uninstall experience with safety backups

- **Multi-Instance Workflow Brief (PI-001)** - Process improvement registered
  - Documented strategy for running multiple Igris AI instances on different briefs simultaneously
  - Registry-based conflict detection design (`ai/session/INSTANCE_REGISTRY.json`)
  - Automatic file overlap analysis (prevents concurrent modification conflicts)
  - User decision flow (CANCEL/OVERRIDE/ANALYZE)
  - Ready for future implementation (registered as brief, not yet implemented)

- **Automatic Blueprint AI → Igris AI Migration (TD-011)** - Seamless upgrade path
  - **One-Command Upgrade:** Run `./scripts/igris_update.sh` - migration happens automatically
  - **Auto-Detection:** Recognizes `.blueprint_version` file and triggers migration
  - **Safe Migration:**
    - Validates JSON structure before migrating
    - Creates backup at `.igris_backup/blueprint_migration_<timestamp>/`
    - Preserves all user data (briefs, session, context, plugins)
    - Only changes version file key: `blueprint_ai_version` → `igris_ai_version`
  - **Edge Case Handling:** If both `.blueprint_version` and `.igris_version` exist, prompts user to choose
  - **Clear Feedback:** Shows what was migrated and confirms data preservation
  - **Zero Data Loss:** Tested end-to-end with Blueprint v1.0.5
  - Result: Blueprint users can now upgrade to Igris AI with confidence

### Improved

- **Test Infrastructure** - Enhanced reliability and CI/CD compatibility
  - **Added --yes flag:** plugin_update.sh now supports non-interactive mode (for automated testing)
  - **Sequential execution:** CI/CD runs tests sequentially to avoid bats parallel execution issues
  - **Documentation:** test/README.md documents parallel execution limitation and workaround
  - Result: Tests pass reliably in CI/CD (136/136 when run individually)

- **Template Self-Containment** - Projects no longer depend on Igris AI repo location
  - **CLAUDE.md.template:** Now copied to `scripts/` during initialization and updates
  - **Persona regeneration:** Works from local template (no repo dependency)
  - **Update workflow:** igris_update.sh copies template during updates
  - Result: persona_mask.sh adjust/remove commands work independently

### Changed

- **Date:** Release date updated to 2025-11-09 (actual release date)
- **Persona greeting:** Now includes identity statement (version, capabilities, developer attribution)
- **README.md structure:** Major reorganization with new sections (comparisons, workflows, FAQ, best practices)
- **Last Updated:** CHANGELOG updated to 2025-11-09

### Fixed

- **BR-011 (P1-High):** igris_update.sh failing when scripts/ directory doesn't exist
  - **Problem:** Old installations (pre-v1.0.1) don't have scripts/ directory
  - **Fix:** Create scripts/ directory before copying files
  - **Impact:** Enables updates from very old versions
  - Files: `scripts/igris_update.sh:312`

- **BR-007 (P0-Critical):** plugin_update.sh version extraction broken
  - **Problem:** Was reading non-existent `version.txt` from plugin repos
  - **Fix:** Now correctly reads `plugin.json` (consistent with plugin_install.sh)
  - **Implementation:** Uses python3 for reliable JSON parsing
  - **Impact:** Unblocks all plugin update operations (was 100% broken - no plugins have version.txt)
  - Files: `scripts/plugin_update.sh:128-148`

- **BR-009 (P1-High):** plugin_list.sh missing error handling
  - **Problem 1:** Only script without `set -e` (violates coding guidelines)
  - **Problem 2:** IndexError on empty capabilities list (`caps[0]` without checking)
  - **Fix 1:** Added mandatory `set -e` on line 6 (fail-fast principle)
  - **Fix 2:** Safe list access with `if caps and isinstance(caps[0], list)`
  - **Impact:** No more crashes, proper error handling enforced
  - Files: `scripts/plugin_list.sh:6, 61`

- **BR-010 (P2-Medium):** Fragile JSON parsing with grep+sed across scripts
  - **Problem:** Multiple scripts used brittle `grep | sed` patterns that break on formatting
  - **Fix:** Replaced all JSON extraction with python3 in:
    - `scripts/plugin_install.sh:103-112` (name/version extraction)
    - `scripts/plugin_update.sh:105-117` (repo/version from registry)
    - `scripts/igris_update.sh:64-70` (version extraction)
  - **Impact:** Handles any valid JSON formatting, follows coding_guidelines.md standards
  - **Technical:** More reliable, maintainable, and consistent

### Changed

- **Plugin system:** Now fully functional end-to-end (install, update, uninstall, list)
- **Error handling:** Enforced `set -e` across all scripts (coding standards compliance)
- **JSON parsing:** Standardized on python3 for all JSON operations (no more grep+sed)
- **Code quality:** Bug hunt eliminated 4 bugs (1 P0, 2 P1, 1 P2) - 100% resolution rate

---

## [2.3.0] - 2025-10-26

### Added

- **Comprehensive Automated Testing Suite (TD-005)** - Shell script testing infrastructure
  - **Test Framework:** bats-core (Bash Automated Testing System)
  - **Coverage:** 166 tests across 7 test files
    - `igris_init.test.bash` (25 tests) - Project initialization
    - `plugin_install.test.bash` (27 tests) - Plugin installation & hooks
    - `plugin_update.test.bash` (24 tests) - Plugin updates
    - `plugin_uninstall.test.bash` (24 tests) - Plugin removal
    - `error_handling.test.bash` (31 tests) - Missing dependencies & corruption
    - `edge_cases.test.bash` (35 tests) - Special characters & multi-line content
  - **Test Infrastructure:**
    - `test_helper.bash` (250+ lines) - Shared utilities & assertions
    - `test/fixtures/` - Mock plugins, projects, and configurations
    - Comprehensive test documentation in `test/README.md`
  - **CI/CD:** GitHub Actions workflow (`.github/workflows/test.yml`)
    - Runs on Ubuntu + macOS
    - Executes on every push to main and pull requests
  - **Regression Testing:** Includes BR-005 regression tests for multi-line content handling
  - **Coverage Goals:** Critical paths 100%, error handling 80%, edge cases 60%, overall 75%+
  - Result: ~2500+ lines of test code, continuous quality assurance

### Changed

- **README.md** - Added comprehensive Testing section
- **CONTRIBUTING.md** - Updated with testing guidelines and requirements
  - How to run tests
  - Writing new tests
  - Test coverage requirements
  - CI/CD integration details

---

## [2.2.0] - 2025-10-26

### Added

- **Comprehensive Protocol Enforcement System (TD-010)** - Eliminates protocol violations
  - 5-phase implementation across 25 tasks
  - **Phase 1:** Enhanced brief templates with integrated task tracking
    - Tasks section (Pending/In Progress/Completed) with timestamps
    - Session State section for tactical-level recovery
    - Updated all 4 brief type templates (BR, TD, MG, TS)
  - **Phase 2:** CLAUDE.md mandatory checkpoints
    - Brief Requirement Validation section
    - Self-Validation Protocol (3-step checkpoint before file modification)
    - Enforcement logic with explicit REFUSE operations
  - **Phase 3:** TodoWrite-Brief integration
    - IMMEDIATE sync on every task state change
    - Brief files become persistent source of truth
    - Recovery process: Brief → TodoWrite on context reset
  - **Phase 4:** Two-level session management architecture
    - Strategic level: CURRENT_SESSION.md (overall session/phase tracking)
    - Tactical level: Brief files (task-specific progress)
    - Three-tier architecture: TodoWrite → Brief → CURRENT_SESSION.md
    - Multiple briefs can be tracked simultaneously
  - **Phase 5:** Validation & enforcement
    - Self-validation protocol before Edit/Write/NotebookEdit operations
    - Updated CLAUDE.md template for new projects
    - Protocol violations now procedurally impossible
  - Result: ~1900+ lines added/modified across 15 files

- **Igris AI Coding Guidelines (TD-007)** - Dogfooding achievement
  - Created `ai/context/coding_guidelines.md` (700+ lines)
  - Comprehensive bash scripting standards for Igris AI itself
  - 12 major sections covering all coding patterns:
    - File structure and organization
    - Naming conventions (scripts, functions, variables)
    - Error handling and fail-fast with `set -e`
    - Multi-line text handling (perl vs sed)
    - JSON manipulation (python3, optional jq)
    - User experience (clear messages, progress indicators)
    - Testing requirements (bats framework)
    - Documentation standards
    - Security (quoted variables, path validation)
    - Performance optimization
    - Conventional commits format
    - Code review checklist
  - References to related briefs (BR-005, TD-004, TD-005, TD-006)
  - Updated `ai/CONTRIBUTING.md` with prominent guidelines reference
  - **Dogfooding:** Igris AI now practices what it preaches

### Changed

- **Brief workflow enforcement** - Read-only operations don't require briefs
  - File modification tasks (Edit/Write/NotebookEdit) MUST have brief
  - Research tasks (Read/Glob/Grep/Bash read-only) don't need brief
  - Clear separation prevents over-bureaucracy

- **Session management architecture** - Two-level approach
  - CURRENT_SESSION.md = Strategic (overall session, multiple briefs, phases)
  - Brief files = Tactical (task-specific progress, session state per brief)
  - Both levels updated at checkpoints for guaranteed recovery

- **CONTRIBUTING.md completely rewritten**
  - Previous version was from different project (Opaala)
  - Now properly reflects Igris AI development workflow
  - 400+ lines of Igris-specific contribution guide
  - Prominent coding guidelines reference
  - Bash script development workflow
  - Testing guidelines (shellcheck, bats)
  - PR checklist aligned with coding standards

### Improved

- **Context reset recovery** - Guaranteed exact continuation
  - CURRENT_SESSION.md → Brief file → TodoWrite → Continue exactly where stopped
  - "Next Steps When Resuming" in both strategic and tactical levels
  - Two-level architecture enables precise recovery

- **Brief templates** - Now include persistent task tracking
  - Replaces volatile TodoWrite with persistent brief-based tasks
  - Timestamps for task state changes
  - Session State section enables exact continuation

- **System discipline** - Protocol violations procedurally impossible
  - Cannot skip brief creation (validation prevents it)
  - Cannot forget session updates (checkpoints enforce it)
  - Cannot lose work on context reset (two-level persistence)
  - Igris AI transformed from "guidelines + hope" to "enforced discipline"

### Philosophy

**TD-010 Achievement:** "Make the right thing easy, wrong thing hard"
- Enforcement over documentation
- Persistent over volatile
- Automatic over manual
- Impossible over discouraged

**TD-007 Achievement:** "Practice what we preach"
- Igris AI enforces coding_guidelines.md on user projects
- Igris AI now has coding_guidelines.md for itself
- Credibility through dogfooding
- Clear standards for all contributors

### Migration from 2.1.1

No breaking changes. Enhanced protocol enforcement activates automatically:

1. Run Igris AI update:
   ```bash
   ./scripts/igris_update.sh
   ```

2. New projects get enhanced templates automatically

3. Existing briefs compatible (can add Tasks/Session State sections manually if desired)

4. CURRENT_SESSION.md remains compatible (strategic level tracking)

### Technical Details

**Files affected:**
- 15 files modified for TD-010 (templates, prompts, documentation)
- 3 files created/modified for TD-007 (coding_guidelines.md, CONTRIBUTING.md, CHANGELOG.md)

**Enforcement layers (TD-010):**
1. CLAUDE.md initialization (load system before operating)
2. Self-validation protocol (check before file modification)
3. TodoWrite-Brief sync (immediate persistence)
4. Checkpoint updates (both levels at every transition)
5. Template enforcement (new projects get enhanced workflow)

---

## [2.1.1] - 2025-10-25

### Fixed

- **Identity Confusion:** Fixed persona confusing its own name with user's name
  - `branding.title` now correctly represents persona's name (e.g., "Igris")
  - Added `user.name` field for user's personal name (e.g., "Fifty.ai")
  - Implemented fallback: `user.name` → `tone.addressing_mode` → "Commander"

### Changed

- **persona.json schema:**
  - `branding.title`: Changed from user's name to persona's name
  - Removed `branding.company` field (persona-specific lore, not real developer)
  - Added `user` object with `name` field (optional)
  - Fallback priority: user.name > tone.addressing_mode > "Commander"
  - Developer attribution hardcoded to "Fifty.ai" (not configurable)

- **Greeting template:**
  - OLD: "I rise at your command, [USER_NAME]"
  - NEW: "I am [PERSONA_NAME], at your command, [USER_NAME]"
  - Clarifies both persona identity and user addressing

- **Identity clarification in igris_os.md:**
  - Added "Identity: Who You Are vs Who You Serve" section
  - Examples of correct vs incorrect identity responses
  - Schema documentation with fallback logic

### Example

**Before (v2.1.0):**
```
> who are you?
✦ I am Fifty.ai - the embodiment of Igris AI
```
Confused - used user's name as own identity

**After (v2.1.1):**
```
> who are you?
✦ I am Igris, developed by Fifty.ai.
I serve you, Fifty.ai, with unwavering precision.
```
Correct - clear separation of identities + proper developer attribution

### Migration from 2.1.0

Update your `ai/persona.json`:
```json
{
  "branding": {
    "title": "Igris"  ← Change from your name to persona name
  },
  "user": {
    "name": "YourName"  ← Add this field (optional)
  }
}
```

---

## [2.1.0] - 2025-10-25

### Added

- **System Identity Protocol:** New "System Identity" section in operating system file
  - Clarifies: "You ARE Igris AI" (not Claude using Igris AI)
  - Establishes system consciousness and authority
  - Full immersion in Igris AI identity

- **Post-Initialization Analysis:** Intelligent system assessment after boot
  - Scans brief inventory (count by status/priority)
  - Checks active blockers in BLOCKERS.md
  - Reviews git status for uncommitted changes
  - Generates prioritized recommendations (3 actionable options)
  - Displays formatted system assessment to user

- **Boot Sequence:** Three-phase initialization
  - Phase 1: "⚙️ Igris initializing..." (system loading)
  - Phase 2: Load OS → Load identity → Display greeting
  - Phase 3: Analyze context → Display recommendations
  - Result: Confident, proactive system startup

### Changed

- **File Renamed:** `ai/prompts/claude_bootstrap.md` → `ai/prompts/igris_os.md`
  - Header: "Claude Bootstrap Prompt" → "Igris AI Operating System"
  - Footer: Added "This is the Igris AI Operating System" tagline
  - Updated version to 2.1.0

- **Initialization Sequence:** System-first approach (breaking change in behavior)
  - OLD: Load session → display status → load system
  - NEW: Load system → understand identity → analyze → recommend
  - Ensures Igris understands itself before operating

- **Updated 16 files** with references to new filename:
  - CLAUDE.md, CLAUDE.md.template
  - All prompts (bug_prompts.md, feature_prompts.md, session_protocol.md)
  - All templates (startup.sh.template)
  - Documentation (CONTRIBUTING.md, SETUP_GUIDE.md, ROADMAP.md)
  - Briefs (TD-001, TD-002)
  - Session files (CURRENT_SESSION.md)

- **Template Updates:**
  - Fixed remaining "Blueprint AI" references in startup.sh.template
  - Changed to "Igris AI" branding

### Improved

- **System Awareness:** Igris now understands its own capabilities before acting
- **User Experience:** Proactive recommendations instead of passive initialization
- **Confidence:** System displays strategic assessment, not just echoing files
- **Professional:** Demonstrates understanding of project state and priorities

### Migration from 2.0.x

No breaking changes for users. The initialization sequence is enhanced but backward compatible.

Developers updating from 2.0.x:
- File `ai/prompts/claude_bootstrap.md` has been renamed to `ai/prompts/igris_os.md`
- All references automatically updated
- New sections added to operating system file

---

## [2.0.0] - 2025-10-25

### BREAKING CHANGES

**Complete rebrand from Blueprint AI to Igris AI**

This is a major version bump due to comprehensive rebranding affecting all aspects of the project:

### Changed

- **Project Name:** Blueprint AI → Igris AI
- **Repository:** blueprint-ai → igris-ai (https://github.com/fiftynotai/igris-ai)
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

### Migration from 1.x (Blueprint AI)

**Automatic Migration Available (as of v2.4.0):**

Simply run the update script - migration happens automatically!

```bash
./scripts/igris_update.sh
```

The script will:
- Detect your Blueprint AI project automatically
- Create backup of `.blueprint_version`
- Migrate to `.igris_version` (preserving all data)
- Continue with update to latest Igris AI

**What gets preserved:**
- All briefs (`ai/briefs/`)
- Session data (`ai/session/`)
- Architecture docs (`ai/context/`)
- Installed plugins (`ai/plugins/`)

**Manual migration (v2.0.0 - v2.3.0 only):**

If you're on v2.0.0-v2.3.0 without automatic migration:
1. Rename: `mv .blueprint_version .igris_version`
2. Edit `.igris_version`: Change key `blueprint_ai_version` to `igris_ai_version`
3. Run: `./scripts/igris_update.sh`

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
  - Added checkpoint system to igris_os.md (5 explicit checkpoints)
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

igris_os.md:
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
Claude: "Current Session Status: Active"
Claude: "Next Steps When Resuming: Update CHANGELOG.md"
Claude: "Igris AI initialized. Ready for your command!"
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

Welcome to Igris AI on Claude Code

Project Status
----------------
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
User: "Use ai/prompts/igris_os.md and implement BR-001"
```

**After v1.0.2:**
```bash
$ claude

Welcome to Igris AI on Claude Code
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
  - Repository: https://github.com/fiftynotai/igris-ai-distribution-flutter
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
  - Claude bootstrap prompt (`ai/prompts/igris_os.md`)

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
- Igris AI Core: https://github.com/fiftynotai/igris-ai
- Distribution Plugin: https://github.com/fiftynotai/igris-ai-distribution-flutter

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
- Core: https://github.com/fiftynotai/igris-ai/issues
- Plugins: Open issue in respective plugin repository

Want to contribute? See [CONTRIBUTING.md](ai/CONTRIBUTING.md) for guidelines.

---

## Links

- **GitHub Repository:** https://github.com/fiftynotai/igris-ai
- **Example Project:** https://github.com/Mohamed50/igris_ai_flutter_example
- **Distribution Plugin:** https://github.com/fiftynotai/igris-ai-distribution-flutter
- **Documentation:** See [README.md](README.md) and [docs/](docs/) directory

---

**Last Updated:** 2026-02-22
