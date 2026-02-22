# Migration Guide

Guide for migrating between Igris AI versions and bringing existing projects up to architecture standards.

---

## Migrating from v3 to v4

### What Changed in v4.0

| Feature | v3 | v4 |
|---------|----|----|
| Core Files | Copied per-project | Symlinked from ~/.igris/ brain |
| Memory | Per-project only | Centralized SQLite + cross-project |
| Agents | LangChain hooks | Native Claude Code subagents |
| Persona | Plugin-based (persona.json + personas/) | SOUL.md + USER.md |
| Plugins | 4 scripts + registry | Removed (native skills replace all) |
| Dashboard | None | Extracted to separate project |
| MCP | None | 27 brain tools |
| Skills | None | 21 native Claude Code skills |
| Brief Types | BR, MG, TD, TS | BR, FR, TD, MG, TS, PI, DU, PF, AC (9 types) |

### Migration Steps

1. **Install the brain:**
   ```bash
   cd /path/to/igris-ai
   ./scripts/igris_brain_init.sh
   ```

2. **Migrate existing projects:**
   ```bash
   cd /path/to/your-project
   /path/to/igris-ai/scripts/igris_migrate_to_v4.sh
   ```
   Or use the symlink installer for a fresh install:
   ```bash
   /path/to/igris-ai/scripts/igris_install.sh .
   ```

3. **Remove deprecated files:**
   - Delete `ai/plugins/` directory
   - Delete `ai/persona.json` (replaced by SOUL.md + USER.md)
   - Delete `ai/personas/` directory
   - Delete `ai/checks/` directory
   - Delete `scripts/plugin_*.sh`
   - Delete `scripts/persona_*.sh`

4. **Optional: Set up MCP server:**
   ```bash
   cd /path/to/igris-ai/mcp-server
   npm install && npm run build
   ```

### Breaking Changes

- Plugin system completely removed (use native skills instead)
- Persona system replaced with SOUL.md + USER.md
- `.igris_version` format updated (now includes `install_mode` and `brain_path`)
- Brain required for cross-project features (portfolio, dashboard, projects)
- `ai/checks/` directory removed (QA handled by warden agent)
- Agent definitions moved from LangChain hooks to `.claude/agents/*.md`
- Rules moved to `.claude/rules/*.md` (modular, auto-loaded by Claude Code)
- Skills defined in `.claude/skills/*/SKILL.md`

### Post-Migration Verification

After migrating, verify the installation:

```bash
# Check v4 structure exists
ls .claude/agents/    # Should show 7 agent files
ls .claude/rules/     # Should show 5 rule files
ls .claude/skills/    # Should show 21 skill directories

# Check brain connectivity
sqlite3 ~/.igris/memory/knowledge.db "SELECT slug FROM projects;"

# Run a scan to verify
# In Claude Code: /scan
```

---

## Migrating Existing Codebases to Architecture Standards

### Overview

When you have an existing codebase that doesn't follow your architecture standards, Igris AI helps you:

1. **Analyze** - Identify all violations and issues
2. **Plan** - Create a prioritized migration roadmap
3. **Execute** - Systematically fix issues one brief at a time
4. **Track** - Monitor progress toward full compliance

---

## Migration Process

### Phase 0: Setup Igris AI

```bash
# Initialize Igris AI (see SETUP_GUIDE.md for full instructions)
# Brain-first (recommended):
/path/to/igris-ai/scripts/igris_brain_init.sh
/path/to/igris-ai/scripts/igris_install.sh .

# Or standalone:
/path/to/igris-ai/scripts/igris_init.sh .

# Generate architecture documentation
# In Claude Code: /document architecture
```

This creates your architecture baseline.

### Phase 1: Analysis

**Run codebase analysis:**

```
/migrate-analyze
```

**What IGRIS does:**
1. Scans all source files
2. Compares against architecture standards (from `ai/context/`)
3. Identifies violations, bugs, debt, and testing gaps
4. Generates categorized briefs
5. Creates `ai/session/MIGRATION_ROADMAP.md`

**Expected output:**
```
📊 Codebase Analysis Complete

Found 47 issues across 5 categories:
- Migration (MG): 12 tasks
- Bugs (BR): 8 issues
- Technical Debt (TD): 15 items
- Testing (TS): 7 gaps
- Enhancements (EN): 5 recommendations

Created 47 briefs in ai/briefs/
Created migration roadmap in ai/session/MIGRATION_ROADMAP.md

Estimated migration time: 4-5 weeks
```

### Phase 2: Review & Prioritize

**Review generated briefs:**

```bash
List all migration briefs
List all P0 bugs
Show migration roadmap
```

**Adjust priorities if needed:**

```bash
Change MG-005 to P0   # Critical for release
Change TD-003 to P3   # Can wait
```

**Review the roadmap:**

```bash
cat ai/session/MIGRATION_ROADMAP.md
```

Example roadmap structure:
```markdown
## Phase 1: Critical Fixes (Week 1)
- BR-001: Memory leak (P0)
- BR-003: Security issue (P0)

## Phase 2: Architecture Migration (Weeks 2-3)
- MG-001: Refactor to Actions layer (P1)
- MG-005: Make models immutable (P1)

## Phase 3: Technical Debt (Week 4)
- TD-001: Remove magic numbers (P2)
- TD-005: Add doc comments (P2)

## Phase 4: Testing (Week 5)
- TS-001: Add ViewModel tests (P1)
- TS-003: Add integration tests (P2)
```

### Phase 3: Execute Migration

**Work in phases, one brief at a time:**

```bash
# Week 1: Critical fixes
Implement BR-001   # Fix memory leak
Implement BR-003   # Fix security issue

# Week 2-3: Architecture migration
Implement MG-001   # Refactor to Actions
Implement MG-005   # Immutable models

# Week 4: Technical debt
Implement TD-001   # Remove magic numbers
Implement TD-005   # Add doc comments

# Week 5: Testing
Implement TS-001   # Add unit tests
```

**Track progress:**

```bash
Show migration status
How many P0/P1 briefs remain?
```

### Phase 4: Verification

**After completing each phase:**

1. **Run tests:**
   ```bash
   # Run your project's test command
   # Examples: bats test/, npm test, flutter test, pytest
   ```

2. **Run linter:**
   ```bash
   # Run your project's linter
   # Examples: shellcheck scripts/*.sh, npm run lint, flutter analyze
   ```

3. **Manual verification:**
   - Check key user flows still work
   - Verify performance hasn't regressed
   - Test on multiple devices/platforms

4. **Update roadmap:**
   ```bash
   # Mark phase complete in MIGRATION_ROADMAP.md
   ```

---

## Understanding Brief Categories

### MG-XXX: Migration Tasks

**What:** Code that violates architecture but works

**Examples:**
- `MG-001: Refactor UserPage to use Actions layer for navigation`
- `MG-005: Move business logic from View to ViewModel`
- `MG-008: Rename folder data/service to data/services`

**Priority guide:**
- **P0:** Blocking new development
- **P1:** Major violations, affects multiple modules
- **P2:** Standard migrations
- **P3:** Nice-to-have, cosmetic

**When to do:** After fixing P0 bugs, before adding new features

### BR-XXX: Bugs Found

**What:** Actual bugs discovered during analysis

**Examples:**
- `BR-001: Memory leak - socket not closed`
- `BR-003: Null pointer exception in event list`
- `BR-005: Race condition in auth flow`

**Priority guide:**
- **P0:** Crashes, data loss, security issues
- **P1:** Major features broken
- **P2:** Minor features broken, workaround exists
- **P3:** Edge cases

**When to do:** Immediately (P0/P1), scheduled (P2/P3)

### TD-XXX: Technical Debt

**What:** Code that works but needs cleanup

**Examples:**
- `TD-001: Remove magic numbers, use constants`
- `TD-003: Extract duplicate code into shared function`
- `TD-007: Add missing documentation comments`

**Priority guide:**
- **P0:** Rarely (unless blocking development)
- **P1:** High-impact debt (major duplication, security)
- **P2:** Standard debt
- **P3:** Minor polish

**When to do:** Dedicated cleanup sprints, between features

### TS-XXX: Testing Gaps

**What:** Missing or inadequate tests

**Examples:**
- `TS-001: Add unit tests for EventsViewModel`
- `TS-003: Add widget tests for LoginPage`
- `TS-005: Add integration test for checkout flow`

**Priority guide:**
- **P0:** Rarely (unless critical feature has 0% coverage)
- **P1:** Core features, complex business logic
- **P2:** Standard features
- **P3:** Edge cases, UI-only components

**When to do:** Alongside related feature work, dedicated test sprints

---

## Migration Strategies

### Strategy 1: Big Bang (Not Recommended)

❌ Fix everything before any new features

**Problems:**
- Long time before seeing value
- High risk of breaking existing functionality
- Team frustration

**When to use:** Very small codebases (<5K lines)

### Strategy 2: Incremental by Module (Recommended)

✅ Migrate one module at a time to completion

**Process:**
1. Pick a module (start with least dependencies)
2. Fix all briefs for that module
3. Mark module as "migrated"
4. Move to next module

**Benefits:**
- Clear progress (Module X is 100% compliant)
- Isolated risk
- Can deploy after each module

**When to use:** Medium projects (5-50K lines)

### Strategy 3: Incremental by Priority (Recommended)

✅ Fix all P0, then all P1, then P2, etc.

**Process:**
1. Complete all P0 briefs across all modules
2. Complete all P1 briefs across all modules
3. Continue with P2, P3 as time allows

**Benefits:**
- Highest value work done first
- Can stop at any priority level
- Continuous improvement

**When to use:** Large projects (>50K lines), ongoing projects

### Strategy 4: Hybrid (Best for Most)

✅ Combine module-based and priority-based

**Process:**
1. Fix all P0/P1 across entire codebase (safety)
2. Migrate modules incrementally (auth → user → checkout)
3. Address P2/P3 as you work in each module

**Benefits:**
- Critical issues fixed immediately
- Clear module boundaries
- Sustainable pace

---

## Example: Full Migration

### Week 0: Setup & Analysis

```bash
# Initialize Igris AI (see SETUP_GUIDE.md)
/path/to/igris-ai/scripts/igris_install.sh .

# Generate docs (30 min) - in Claude Code:
# /document architecture

# Analyze codebase (45 min) - in Claude Code:
# /migrate-analyze

# Review results (30 min)
cat ai/session/MIGRATION_ROADMAP.md
```

**Output:** 35 briefs created, 4-week estimate

### Week 1: Critical Fixes

**Monday:**
```bash
List P0 bugs
# Found: BR-001 (memory leak), BR-003 (security)

Implement BR-001
# 2 hours, fixed, tested, committed
```

**Tuesday-Friday:**
```bash
# Implement BR-003, BR-005, BR-007
# All P0 bugs resolved
```

**End of week:** No critical bugs remaining ✅

### Week 2-3: Architecture Migration

**Week 2:**
```bash
# Migrate "auth" module
List all MG briefs for auth module
# Found: MG-001, MG-003, MG-005

# Implement each one
# End of week: Auth module 100% compliant ✅
```

**Week 3:**
```bash
# Migrate "user" and "settings" modules
# Same process as auth module
# End of week: 3 modules 100% compliant ✅
```

### Week 4: Technical Debt

```bash
List all TD briefs P1-P2
# Implement top 10 debt items
# End of week: Major debt paid off ✅
```

### Week 5: Testing

```bash
List all TS briefs P1
# Add tests for critical ViewModels
# End of week: Core modules have 80%+ coverage ✅
```

### Results

**Before:**
- 35 issues
- 45% architecture compliance
- 30% test coverage
- Frequent bugs

**After:**
- 0 P0/P1 issues (35 resolved)
- 90% architecture compliance
- 80% test coverage for core modules
- Stable codebase

---

## Common Challenges

### Challenge: "Too many briefs"

**Solution:** Focus on P0/P1 only
```bash
# Ask Claude: "Archive all P3 briefs"
# Deal with polish later
```

### Challenge: "Breaking changes during migration"

**Solution:** Use feature flags
```dart
if (useNewArchitecture) {
  // New Actions-based code
} else {
  // Old code (fallback)
}
```

### Challenge: "Team wants to add features during migration"

**Solution:** Set a migration sprint
- Week 1: Migration only
- Week 2: Feature work
- Alternate as needed

### Challenge: "Tests failing after migration"

**Solution:** Update tests alongside code
- MG briefs should include test updates
- Test changes are part of the migration

---

## Verification Checklist

After migration is complete:

- [ ] All P0/P1 briefs resolved
- [ ] Linter passes with zero issues
- [ ] Test coverage meets target (e.g., >60%)
- [ ] All critical user flows tested manually
- [ ] No performance regressions
- [ ] Documentation updated (README, architecture docs)
- [ ] Team trained on new patterns
- [ ] Migration roadmap archived

---

## Maintaining Standards

After initial migration:

1. **Enforce standards:** Add linter rules, pre-commit hooks
2. **Regular audits:** Run analysis monthly
3. **New work follows patterns:** Brief all new work
4. **No regressions:** Code review catches violations
5. **Pay debt continuously:** Reserve 20% of sprint for debt

---

**Ready to migrate?**

```
# Start your migration journey (in Claude Code)
/migrate-analyze
```

Good luck!
