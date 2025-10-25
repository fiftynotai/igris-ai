# Migration Analysis Prompt

This prompt guides Claude to analyze an existing codebase and generate categorized migration tasks as Igris AI briefs.

---

## Purpose

When bringing Igris AI into an existing project, analyze the codebase to:
1. Identify architecture violations
2. Find existing bugs
3. Detect technical debt
4. Identify testing gaps
5. Recommend enhancements
6. Generate actionable briefs for each finding

---

## Instructions for Claude

Please perform a comprehensive codebase analysis and generate briefs in these categories:

### Brief Categories

1. **MG-XXX (Migration)** - Code that must be refactored to meet architecture standards
2. **BR-XXX (Bugs)** - Existing bugs found during analysis
3. **TD-XXX (Technical Debt)** - Code that works but needs cleanup
4. **TS-XXX (Testing)** - Missing or inadequate test coverage
5. **EN-XXX (Enhancements)** - Recommended improvements (optional)

---

## Analysis Areas

### 1. Architecture Compliance

**Check for:**
- ❌ Layer violations (e.g., View calling Service directly, skipping ViewModel)
- ❌ UI logic in business logic layer (dialogs, navigation in ViewModels)
- ❌ Business logic in UI layer
- ❌ Missing abstraction layers (no Actions layer, no Services)
- ❌ Incorrect dependency injection (tight coupling, hard dependencies)
- ❌ State management violations (inconsistent patterns)

**Generate:**
- MG briefs for architecture violations
- Priority: P0 for critical violations, P1 for major, P2 for minor

**Example:**
```
MG-001: Refactor UserProfilePage to use Actions layer for navigation
Priority: P1
Effort: S-Small
Reason: Currently calls Get.to() directly, should use UserProfileAction.navigateToSettings()
```

### 2. Code Structure

**Check for:**
- ❌ Folder naming inconsistencies (e.g., data/service vs data/services)
- ❌ Missing required files (tests, models, bindings)
- ❌ Incorrect file naming conventions
- ❌ Module organization issues (files in wrong directories)
- ❌ Duplicate code across modules
- ❌ Circular dependencies

**Generate:**
- MG briefs for structural issues
- TD briefs for cleanup tasks
- Priority: P2 for most, P1 if blocking development

**Example:**
```
MG-002: Rename event/data/service/ to event/data/services/ (plural)
Priority: P2
Effort: S-Small
Reason: Inconsistent with other modules and best practices
```

### 3. Code Quality

**Check for:**
- ❌ Mutable models (non-final fields)
- ❌ Missing documentation comments
- ❌ Hardcoded strings (no internationalization)
- ❌ Magic numbers (unexplained constants)
- ❌ Long functions (>50 lines)
- ❌ Deep nesting (>4 levels)
- ❌ Code duplication
- ❌ Dead code (unused imports, variables, functions)
- ❌ Poor error handling (empty catch blocks, swallowing errors)

**Generate:**
- TD briefs for code quality issues
- Priority: P3 for most, P2 if impacting readability significantly

**Example:**
```
TD-001: Make EventModel immutable - add final to all fields
Priority: P2
Effort: S-Small
Reason: Currently has mutable fields which can cause bugs. Best practice is immutable models.
```

### 4. Testing

**Check for:**
- ❌ Missing unit tests (ViewModels without tests)
- ❌ Missing widget tests (critical UI components)
- ❌ Missing integration tests (key user flows)
- ❌ Low test coverage (<60%)
- ❌ Untestable code (hard dependencies, no DI)
- ❌ Flaky tests (time-dependent, random failures)

**Generate:**
- TS briefs for missing tests
- MG briefs for untestable code (needs refactoring first)
- Priority: P1 for critical flows, P2 for standard features

**Example:**
```
TS-001: Add unit tests for EventsViewModel
Priority: P1
Effort: M-Medium
Coverage: 0% currently, target 80%
Tests needed: fetchEvents(), refreshEvents(), filterByVenue()
```

### 5. Performance

**Check for:**
- ❌ Memory leaks (unclosed streams, sockets, subscriptions)
- ❌ Inefficient algorithms (O(n²) where O(n) possible)
- ❌ Unnecessary rebuilds (missing const, no memoization)
- ❌ Large objects without pagination
- ❌ Blocking operations on main thread
- ❌ Unnecessary network calls (missing caching)

**Generate:**
- BR briefs for memory leaks (bugs)
- EN briefs for performance optimizations
- Priority: P0 for leaks, P2-P3 for optimizations

**Example:**
```
BR-001: Memory leak - Socket not closed in EventsViewModel.onClose()
Priority: P0
Effort: S-Small
Impact: App memory grows over time, eventually crashes
Fix: Add _socket.close() in onClose() method
```

### 6. Security & Best Practices

**Check for:**
- ❌ Hardcoded credentials or API keys
- ❌ Insecure data storage (sensitive data in plain text)
- ❌ Missing input validation
- ❌ SQL injection vulnerabilities
- ❌ Exposed debug endpoints in production
- ❌ Missing authentication checks

**Generate:**
- BR briefs for security issues
- Priority: P0 for critical security issues

---

## Scanning Process

### Step 0: Load Coding Standards (Recommended)

Before analyzing the codebase, establish the standards to compare against.

**Check for existing coding guidelines:**
```bash
ls ai/context/coding_guidelines.md
```

#### If coding_guidelines.md EXISTS:
✅ Load and use these guidelines as the comparison standard
- Read `ai/context/coding_guidelines.md`
- Use defined architecture patterns, naming conventions, and best practices
- Briefs will reference specific guideline sections
- Proceed to Step 1

#### If coding_guidelines.md DOES NOT EXIST:
⚠️ **Recommended:** Generate coding guidelines first for more accurate analysis

**Ask user:**
```
I notice you don't have coding guidelines defined yet.

For the most accurate migration analysis, I recommend generating
coding guidelines first. This will:
- Define your architecture standards
- Establish naming conventions
- Set code quality benchmarks
- Provide specific targets for migration

Would you like to generate coding guidelines first?

Options:
1. Yes - Generate guidelines now (recommended)
   → Use: ai/prompts/generate_coding_guidelines.md

2. No - Proceed with best practices mode
   → I'll use general platform best practices
   → Analysis will be less specific to your standards

3. I have guidelines elsewhere
   → Please provide the file path or URL
```

**User Response Handling:**

**If "Yes" (Generate guidelines):**
1. Run `ai/prompts/generate_coding_guidelines.md` prompt
2. This will create `ai/context/coding_guidelines.md`
3. Once generated, return to this migration analysis
4. Proceed to Step 1 with guidelines loaded

**If "No" (Best practices mode):**
1. Inform user: "I'll use general best practices for [detected platform]"
2. Detect platform (Flutter/React/Web/etc.) from project structure
3. Use platform-specific best practices as standards
4. Note in all briefs: "Based on industry best practices"
5. Recommend creating guidelines after migration
6. Proceed to Step 1

**If "I have guidelines elsewhere":**
1. Ask for file path or URL
2. Read the provided guidelines
3. Proceed to Step 1 with those guidelines

---

### Step 1: Quick Scan
1. Use Glob to list all source files
2. Count total files, modules, tests
3. Identify file types and structure

### Step 2: Deep Analysis
1. Read coding guidelines (loaded in Step 0)
2. Read architecture_map.md (if exists in ai/context/)
3. Use guidelines as comparison standard
4. Sample 3-5 modules for detailed review
5. Check key infrastructure files
6. Review test files

### Step 3: Pattern Detection
1. Identify common violations
2. Find patterns in good code vs bad code
3. Prioritize by frequency and impact

### Step 4: Brief Generation
1. Create briefs for each finding
2. Group related issues
3. Assign priorities and efforts
4. Add clear descriptions and fix steps
5. **Include guideline references:**
   - Link to specific sections in `ai/context/coding_guidelines.md`
   - Quote relevant standards being violated
   - Show code examples from guidelines (if available)
   - Note if using "industry best practices" (when no guidelines exist)

### Step 5: Roadmap Creation
1. Create MIGRATION_ROADMAP.md
2. Organize briefs into phases
3. Calculate total effort
4. Suggest order of execution

---

## Output Format

### Generate Briefs

For each finding, create a brief file in `ai/briefs/`:

**Filename:** `[TYPE]-[NUMBER]-[slug].md`

**Example:** `MG-001-refactor-user-profile-actions.md`

Use the appropriate template:
- MG-TEMPLATE.md for migrations
- BR-TEMPLATE.md for bugs
- TD-TEMPLATE.md for technical debt
- TS-TEMPLATE.md for testing

### Generate Migration Roadmap

Create `ai/session/MIGRATION_ROADMAP.md`:

```markdown
# Migration Roadmap

**Project:** [Name]
**Analysis Date:** [Date]
**Total Issues Found:** [Count]

---

## Summary

- **Critical (P0):** [count] issues
- **High (P1):** [count] issues
- **Medium (P2):** [count] issues
- **Low (P3):** [count] issues

**Estimated Total Effort:** [X weeks/days]

---

## Phase 1: Critical Fixes (Week 1)

Focus: P0 bugs and security issues

- BR-001: Memory leak in EventsViewModel
- BR-003: Hardcoded API key in auth service
- ...

**Effort:** [X days]

---

## Phase 2: Architecture Migration (Weeks 2-3)

Focus: P0-P1 migrations

- MG-001: Refactor to use Actions layer
- MG-005: Make all models immutable
- ...

**Effort:** [X days]

---

## Phase 3: Technical Debt (Week 4)

Focus: P2 technical debt

- TD-001: Remove magic numbers
- TD-003: Add doc comments
- ...

**Effort:** [X days]

---

## Phase 4: Testing (Week 5)

Focus: P1-P2 test coverage

- TS-001: Add unit tests for ViewModels
- TS-005: Add integration tests
- ...

**Effort:** [X days]

---

## Progress Tracking

- [ ] Phase 1: 0/5 complete
- [ ] Phase 2: 0/12 complete
- [ ] Phase 3: 0/8 complete
- [ ] Phase 4: 0/6 complete

**Overall:** 0/31 complete (0%)
```

### Generate Metrics Report

Print a summary to console:

```
📊 Codebase Analysis Complete

Found 31 issues across 5 categories:

🔴 Critical (P0): 2 issues
  - 2 security/bug issues

🟠 High (P1): 8 issues
  - 5 migration tasks
  - 3 testing gaps

🟡 Medium (P2): 15 issues
  - 7 technical debt items
  - 8 migration tasks

🟢 Low (P3): 6 issues
  - 6 enhancements

---

📁 Briefs Created:
  - ai/briefs/BR-001-memory-leak-events.md
  - ai/briefs/MG-001-refactor-actions-layer.md
  - ... (29 more)

📋 Migration Roadmap:
  - ai/session/MIGRATION_ROADMAP.md

---

🎯 Recommended Next Steps:

1. Review generated briefs: "List all briefs"
2. Prioritize critical issues: "Show P0 briefs"
3. Start with Phase 1: "Implement BR-001"

---

Estimated migration time: 4-5 weeks
```

---

## Example Usage

```
User: Please analyze this codebase and generate migration briefs

Claude: I'll perform a comprehensive codebase analysis using the migration_analysis.md prompt.

[Scans project structure]
[Analyzes key files]
[Detects patterns and violations]

Analysis complete! Found 31 issues:

🔴 2 Critical (P0)
🟠 8 High (P1)
🟡 15 Medium (P2)
🟢 6 Low (P3)

I've created:
- 31 briefs in ai/briefs/
- Migration roadmap in ai/session/MIGRATION_ROADMAP.md

[Displays metrics report]

Ready to start migration. Recommend beginning with Phase 1 (critical fixes).
```

---

**Last Updated:** 2025-10-14
**Version:** 1.0.1
