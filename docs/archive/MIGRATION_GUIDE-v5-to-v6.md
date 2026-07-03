# Migration Guide

Guide for migrating between Igris AI versions and bringing existing projects up to architecture standards.

---

## Migrating from v5 to v6

### What Changed in v6.0

| Feature | v5 | v6 |
|---------|----|----|
| Project data | `~/.igris/cache/{project}/` | `~/.igris/projects/{project}/` |
| Rules | 5 files (01-05-igris-*.md, 25.7KB) | 1 file (00-igris-universal.md, 1.8KB) |
| Context loading | CLAUDE.md @imports 67.5KB into every agent | igris_tree.json routes context per actor |
| CLAUDE.md | 3 @import directives + inline docs | Slim pointer to tree (~2.5KB) |
| Persona | SOUL.md + masks (4 levels) | SOUL.md only (masks removed) |
| Agents | Copy-based, load full context | Symlink-based, self-routing via tree |
| Skills | Copy-based | Symlink-based |
| Igris files in repo | `ai/` folder (legacy v4) | None — `~/.igris/` is sole source |
| Install | `igris_init.sh` (copy-based, v3) | `igris_install.sh` (symlink-based, v6, retired in MG-014) → `igris install` (npm CLI, v7) |
| MCP tools | 67 tools, 13 components | 70 tools, 14 components (+context) |
| Context overhead | ~93KB per subagent | ~5-8KB per subagent |

### Automated Migration

Run the migration script from the igris-ai repository:

```bash
# Preview changes (no modifications)
cd /path/to/igris-ai
./scripts/archive/igris_migrate_v5_to_v6.sh --dry-run

# Run migration
./scripts/archive/igris_migrate_v5_to_v6.sh
```

The script automatically:
1. Moves `~/.igris/cache/` → `~/.igris/projects/` (creates backward-compat symlink)
2. Creates v6 subdirs for each project (context, plans, hooks, reference)
3. Removes old rules 01-05, installs `00-igris-universal.md`
4. Updates core files (igris_tree.json, agents, skills, prompts, templates, task-handlers)
5. Removes deprecated directories (staging, personas)
6. Updates `config.json` to v6.0.0
7. Updates DB project paths
8. Converts `.claude/` to symlinks for all registered projects

### Manual Steps After Migration

1. **Start a new Claude Code session** — rules reload on session start
2. **Delete `ai/` folder** from any project that still has it (v6 uses `~/.igris/` only)
3. **Delete `SOUL.md`** from project root if present (now at `~/.igris/core/SOUL.md`)
4. **Run `/scan`** to verify system status
5. **Run `/awaken`** to test full initialization

### Breaking Changes

- `ai/` folder no longer used — all content lives in `~/.igris/`
- Mask system removed — persona uses SOUL.md only, no mask levels
- v3-era shell `igris_init.sh` deprecated — use `igris install` (v7 CLI) for project registration
- `~/.igris/cache/` renamed to `~/.igris/projects/` (symlink preserves backward compat)
- `~/.igris/staging/` and `~/.igris/personas/` removed
- CLAUDE.md no longer uses `@import` directives
- 5 rule files replaced by 1 universal rule

### Post-Migration Verification

```bash
# Check v6 structure
ls ~/.igris/core/igris_tree.json     # Should exist
ls ~/.igris/core/rules/              # Should have ONLY 00-igris-universal.md
ls ~/.igris/projects/                # Should have project dirs
cat ~/.igris/config.json | grep version  # Should show 6.0.0

# Check symlinks in project
ls -la .claude/agents/   # Should show symlinks → ~/.igris/core/agents/
ls -la .claude/rules/    # Should show symlink → ~/.igris/core/rules/

# Run validation
./scripts/validate_agent.sh ~/.igris/core/agents/architect.md

# In Claude Code: /scan
```

---

## Migrating from v3 (or earlier)

v3-era projects predate the centralized brain (`~/.igris/`) and the
native CLI. The v3→v4 migration script (`scripts/igris_migrate_to_v4.sh`)
was retired in v7.x.0 — it referenced two scripts (`igris_brain_init.sh`,
`igris_brain_refresh.sh`) that were themselves deleted in M5, so the
migration path had been functionally broken at runtime for some time.

Reinstall instead:

```bash
# 1. Initialize a fresh brain
igris init

# 2. Install Igris in your project
igris install /path/to/project
```

Existing per-project briefs and session files lived in `ai/` in v3-v4
and are not auto-migrated. Recreate any unfinished work as fresh
briefs (`/register` or `igris_brief_create`) post-install.

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
igris install .

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
2. Compares against architecture standards (from `~/.igris/projects/{project}/context/`)
3. Identifies violations, bugs, debt, and testing gaps
4. Generates categorized briefs
5. Creates `~/.igris/projects/{project}/session/MIGRATION_ROADMAP.md`

**Expected output:**
```
📊 Codebase Analysis Complete

Found 47 issues across 5 categories:
- Migration (MG): 12 tasks
- Bugs (BR): 8 issues
- Technical Debt (TD): 15 items
- Testing (TS): 7 gaps
- Enhancements (EN): 5 recommendations

Created 47 briefs in brain DB
Created migration roadmap in ~/.igris/projects/{project}/session/MIGRATION_ROADMAP.md

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
cat ~/.igris/projects/{project}/session/MIGRATION_ROADMAP.md
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
igris install .

# Generate docs (30 min) - in Claude Code:
# /document architecture

# Analyze codebase (45 min) - in Claude Code:
# /migrate-analyze

# Review results (30 min)
cat ~/.igris/projects/{project}/session/MIGRATION_ROADMAP.md
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
