# Self-Maintenance Operations

**Version:** 2.1.0
**Purpose:** Document all self-maintenance operations Igris AI can perform on any project

---

## Overview

Igris AI provides 10 maintenance operations that work on **ANY project** (not just Igris AI itself). Each operation analyzes the codebase, identifies issues, and creates appropriate briefs for tracking improvements.

**Key Principles:**
- All operations are **manual trigger only** (no automation for now)
- All operations work on the **active project** (whatever codebase Igris is working on)
- Operations create **specific brief types** based on findings
- Token costs are estimates (actual cost depends on codebase size)

---

## Operation Catalog

### 1. CODE_QUALITY_AUDIT

**Purpose:** Analyze codebase for technical debt and quality issues

**What it does:**
- Reads all source files in project
- Compares against `ai/context/coding_guidelines.md`
- Checks for anti-patterns (missing error handling, unquoted variables, etc.)
- Checks for inconsistencies (some files follow pattern X, others don't)
- Identifies security issues (hardcoded credentials, SQL injection risks)
- Identifies performance issues (N+1 queries, inefficient loops)

**Trigger phrases:**
- "Run code quality audit"
- "Analyze code quality"
- "Check for technical debt"
- "Audit the codebase"

**Creates:**
- TD-XXX briefs (Technical Debt) for each issue found

**Token cost:** ~15K (high - reads all code)

**When to run:**
- Before major releases
- After completing multiple features
- Monthly quality check
- When code feels messy

**Example output:**
```
📊 Code Quality Audit Complete

Issues Found: 6

Technical Debt Created:
- TD-011: Missing error handling in payment_service.dart
- TD-012: Inconsistent null safety across auth modules
- TD-013: No input validation in 5 API endpoints
- TD-014: Hardcoded API URLs in 3 files
- TD-015: Unquoted bash variables in deploy.sh
- TD-016: No logging in error paths

Recommend: Address TD-011 first (P0-Critical - payment failures)
```

---

### 2. BUG_HUNT

**Purpose:** Find potential bugs and logic errors before they manifest

**What it does:**
- Analyzes code logic flow
- Looks for potential runtime errors (null pointer, division by zero, etc.)
- Checks edge cases not handled (empty lists, negative numbers, etc.)
- Looks for race conditions
- Checks error handling paths
- Validates assumptions in code (comments saying "X always happens")

**Trigger phrases:**
- "Run bug hunt"
- "Find potential bugs"
- "Analyze for logic errors"
- "Hunt for bugs"

**Creates:**
- BR-XXX briefs (Bug) for real issues found

**Token cost:** ~10K (medium - analyzes logic, not just patterns)

**When to run:**
- Before major releases
- After major code changes
- After user bug reports (find similar issues)
- Before critical deployments

**Example output:**
```
🐛 Bug Hunt Complete

Potential Bugs Found: 3

Bugs Created:
- BR-007: Null pointer risk in event_list_page.dart:142
  (eventList can be null, no null check before .length)
- BR-008: Race condition in cache_manager.dart
  (concurrent writes not synchronized)
- BR-009: Division by zero in stats_calculator.dart:67
  (totalCount can be 0, no check before division)

Recommend: Fix BR-007 first (P1-High - crashes app)
```

---

### 3. STANDARDS_COMPLIANCE_CHECK

**Purpose:** Verify all code follows coding_guidelines.md standards

**What it does:**
- Reads `ai/context/coding_guidelines.md`
- Checks ALL files against guidelines
- Generates compliance report with percentage
- Lists specific violations with locations
- Creates improvement briefs if needed

**Trigger phrases:**
- "Check standards compliance"
- "Verify coding guidelines"
- "Generate compliance report"
- "Audit against standards"

**Creates:**
- Compliance report (no brief if 100% compliant)
- TD-XXX briefs for violations (if issues found)

**Token cost:** ~8K (medium - systematic checking)

**When to run:**
- Before releases
- After creating new modules
- After updating coding_guidelines.md
- Monthly compliance check

**Example output:**
```
📊 Standards Compliance Report

Overall: 85% compliant (17/20 modules fully compliant)

Violations Found:

lib/features/payment/:
- payment_service.dart:45 - Variable not quoted ($AMOUNT)
- payment_viewmodel.dart - Missing documentation comments (3 public methods)

lib/features/auth/:
- auth_service.dart:123 - Function too long (87 lines, max 50)

scripts/:
- deploy.sh - Missing Python3 validation
- backup.sh - Using deprecated flag --force

Technical Debt Created:
- TD-017: Add documentation to payment_viewmodel.dart
- TD-018: Refactor auth_service.dart:123 (split function)
- TD-019: Add Python3 validation to all scripts

Recommend: Address doc comments first (easy wins)
```

---

### 4. BRIEF_ANALYSIS

**Purpose:** Analyze all briefs and recommend next priorities

**What it does:**
- Lists all briefs (Ready, In Progress, Done)
- Analyzes patterns in completed briefs (common themes)
- Checks for related briefs that could be consolidated
- Recommends priorities based on current state (P0 bugs first, etc.)
- Identifies completion statistics

**Trigger phrases:**
- "Analyze briefs"
- "What should I do next?"
- "List priorities"
- "Review brief status"

**Creates:**
- Recommendations only (NO briefs created)

**Token cost:** ~5K (low - reads brief files only)

**When to run:**
- When deciding what to work on next
- After completing multiple briefs
- When planning sprint/phase

**Example output:**
```
📋 Brief Analysis Complete

Status Summary:
- Done: 10 briefs
- In Progress: 1 brief (BR-006)
- Ready: 2 briefs (TD-005, TD-008)

Patterns Observed:
- 3 briefs involved dependency validation → Consider shared validation library (AC-XXX)
- 2 briefs about performance → Run performance audit next?

Priority Recommendations:
1. TD-005 (Automated Testing) - P1-High, 3-5d
   Reason: Protects completed work, enables community contributions
2. TD-008 (Usage Metrics) - P3-Low, 1-2d
   Reason: Valuable long-term, not urgent now
3. Run ARCHITECTURE_REVIEW - Check for consolidation opportunities

Next Steps:
- Implement TD-005 now (testing foundation)
- Defer TD-008 (revisit when user base > 100)
```

---

### 5. FEATURE_IDEATION

**Purpose:** Imagine useful extensions and new features

**What it does:**
- Analyzes current capabilities
- Imagines useful extensions
- Looks at similar tools for inspiration
- Thinks about user pain points
- Proposes new features with value/effort estimates

**Trigger phrases:**
- "Suggest new features"
- "What can we improve?"
- "Brainstorm features"
- "Ideate improvements"

**Creates:**
- FR-XXX briefs (Feature Request) for each idea

**Token cost:** ~10K (medium - creative thinking)

**When to run:**
- When current work is done
- Quarterly innovation sprint
- After major milestone
- When users ask "what's next?"

**Example output:**
```
💡 Feature Ideation Complete

New Feature Ideas: 4

Features Created:
- FR-001: Persona Marketplace (P2-Medium, L-Large)
  Value: Users share/discover persona plugins
  Use case: Install community personas with one command

- FR-002: VS Code Extension (P1-High, XL-Extra Large)
  Value: Igris AI integrated into VS Code workflow
  Use case: Create briefs, track progress in VS Code

- FR-003: Interactive Brief Wizard (P3-Low, M-Medium)
  Value: Guided brief creation with prompts
  Use case: Users answer questions → brief auto-generated

- FR-004: Git Hook Integration (P2-Medium, S-Small)
  Value: Auto-run checks on commit
  Use case: Brief validation before commit

Recommend: FR-002 (VS Code Extension) highest value-add
```

---

### 6. PROCESS_AUDIT

**Purpose:** Check if Igris AI protocols are being followed effectively

**What it does:**
- Checks if brief workflow is effective
- Analyzes protocol compliance (are briefs created before implementation?)
- Identifies workflow bottlenecks
- Reviews documentation quality
- Checks session management effectiveness

**Trigger phrases:**
- "Audit our process"
- "Is workflow working?"
- "Check protocol compliance"
- "Review process effectiveness"

**Creates:**
- PI-XXX briefs (Process Improvement) for inefficiencies

**Token cost:** ~8K (medium - analyzes workflow files)

**When to run:**
- After protocol violations
- Quarterly process review
- When workflow feels broken
- After team feedback

**Example output:**
```
🔍 Process Audit Complete

Workflow Effectiveness: 85%

Findings:

Protocol Compliance:
- ✅ 10/11 briefs created before implementation (91%)
- ❌ 1 brief created retroactively (TD-009 - process failed)
- ✅ Session management: 100% completion rate
- ✅ Brief completion avg: 2 days

Bottlenecks Identified:
- Brief numbering is manual (prone to errors)
- No automated validation before implementation
- Context resets sometimes lose work

Process Improvements Created:
- PI-001: Automate brief numbering system
- PI-002: Add pre-implementation validation checkpoint
- PI-003: Enhance context reset recovery

Recommend: PI-002 first (prevents protocol violations)
```

---

### 7. DEPENDENCY_AUDIT

**Purpose:** Check external dependencies for updates, security, EOL

**What it does:**
- Lists all dependencies (packages, libraries, tools)
- Checks for updates available
- Checks for security vulnerabilities (CVEs)
- Checks for deprecated packages
- Validates all dependencies are documented

**Trigger phrases:**
- "Check dependencies"
- "Audit dependencies"
- "Check for updates"
- "Scan for vulnerabilities"

**Creates:**
- DU-XXX briefs (Dependency Update) for each update needed

**Token cost:** ~3K (low - reads package files)

**When to run:**
- Monthly
- Before major releases
- After security advisories
- Quarterly dependency review

**Example output:**
```
📦 Dependency Audit Complete

Dependencies Scanned: 47

Updates Available: 5
Security Issues: 1 (CRITICAL)

Dependency Updates Created:
- DU-001: Update openssl (CRITICAL SECURITY)
  Current: 1.1.1k, Target: 1.1.1w
  CVE: CVE-2023-XXXX (critical vulnerability)

- DU-002: Update Python 3.8 → 3.9+
  Reason: Python 3.8 EOL 2024-10

- DU-003: Update bats 1.8.0 → 1.10.0
  Reason: Bug fixes and new features

- DU-004: Update jq (optional)
  Current: Not installed, Recommended: 1.7

- DU-005: Update get_it 7.2.0 → 7.6.4
  Reason: Performance improvements

Recommend: DU-001 IMMEDIATELY (security critical)
```

---

### 8. TEST_COVERAGE_ANALYSIS

**Purpose:** Analyze test coverage and identify untested code

**Requires:** Tests must exist in project

**What it does:**
- Runs test suite
- Generates coverage report
- Identifies untested code paths
- Recommends new tests for critical uncovered code
- Checks coverage against targets

**Trigger phrases:**
- "Analyze test coverage"
- "Check test coverage"
- "Find untested code"
- "Generate coverage report"

**Creates:**
- TS-XXX briefs (Testing) for missing tests

**Token cost:** ~2K (low - reads test results)

**When to run:**
- After adding new code
- Before releases
- Weekly/CI pipeline
- When coverage drops

**Example output:**
```
🧪 Test Coverage Analysis Complete

Overall Coverage: 68% (target: 75%)

Uncovered Critical Paths:
- payment_service.dart:142-167 (0% coverage)
  → Handle payment failure scenario (CRITICAL)
- auth_service.dart:89-102 (0% coverage)
  → Token refresh logic (HIGH)
- event_repository.dart:45-78 (50% coverage)
  → Error handling paths untested

Testing Briefs Created:
- TS-001: Add tests for payment failure handling
- TS-002: Add tests for auth token refresh
- TS-003: Complete event_repository error handling tests

Coverage by Module:
- auth: 85% ✅
- payment: 45% ❌ (target: 75%)
- event: 72% ⚠️  (close to target)

Recommend: TS-001 first (payment is critical path)
```

---

### 9. PERFORMANCE_ANALYSIS

**Purpose:** Find performance bottlenecks and optimization opportunities

**What it does:**
- Analyzes script execution times
- Looks for inefficiencies (unnecessary subshells, file reads)
- Checks for scalability issues
- Benchmarks critical paths
- Identifies optimization opportunities

**Trigger phrases:**
- "Analyze performance"
- "Find bottlenecks"
- "Check performance"
- "Benchmark the code"

**Creates:**
- PF-XXX briefs (Performance) for each optimization

**Token cost:** ~7K (medium - analyzes execution patterns)

**When to run:**
- When code feels slow
- After major changes
- Before optimization sprints
- User complaints about speed

**Example output:**
```
⚡ Performance Analysis Complete

Bottlenecks Found: 3

Performance Issues Created:
- PF-001: Reduce igris_init.sh execution time
  Current: 3.2s, Target: < 2s, Gap: 1.2s
  Bottleneck: Template copying (80% of time)
  Approach: Cache templates to reduce init time

- PF-002: Optimize plugin_install.sh subshell usage
  Current: 12 subshells spawned
  Target: < 5 subshells
  Approach: Consolidate operations, reduce forks

- PF-003: Database query N+1 in event_repository.dart
  Current: 1 + N queries for event list
  Target: 2 queries total (1 + 1 join)
  Approach: Use JOIN instead of loop

Benchmark Results:
- igris_init.sh: 3.2s (slow)
- plugin_install.sh: 4.5s (acceptable)
- igris_update.sh: 2.1s (fast)

Recommend: PF-001 first (user-facing initialization)
```

---

### 10. ARCHITECTURE_REVIEW

**Purpose:** Find logical inconsistencies, redundancies, and unused code

**What it does:**
- Analyzes entire project structure
- Finds duplicate/redundant features
- Finds conflicting implementations
- Identifies unused files (dead code)
- Checks for logical inconsistencies
- Checks module boundaries make sense

**Trigger phrases:**
- "Review architecture"
- "Find redundancies"
- "Check for duplicates"
- "Find unused code"

**Creates:**
- AC-XXX briefs (Architecture Cleanup) for each issue

**Token cost:** ~8K (medium - analyzes structure)

**When to run:**
- Before major releases
- After adding many features
- Quarterly cleanup
- When codebase feels messy

**Example output:**
```
🏗️  Architecture Review Complete

Issues Found: 4

Architecture Cleanup Created:
- AC-001: Consolidate duplicate validation logic
  Found in: payment_service.dart, auth_service.dart, profile_service.dart
  Approach: Create shared validation module

- AC-002: Remove unused old_auth.dart
  Last modified: 2023-08-15
  References: 0 (verified with grep)
  Safe to delete: Yes

- AC-003: Fix inconsistent CLAUDE.md regeneration
  plugin_install.sh: DOES regenerate
  plugin_uninstall.sh: DOES NOT regenerate
  Approach: Make both consistent (always regenerate)

- AC-004: Consolidate two authentication approaches
  Approach A: JWT tokens (auth/)
  Approach B: Session cookies (old_auth/)
  Decision: Keep JWT (modern, secure), remove session-based

Redundancies: 3 instances of duplicate logic
Unused files: 1 (old_auth.dart)
Conflicts: 2 inconsistent implementations

Recommend: AC-001 first (affects 3 modules, easy consolidation)
```

---

## Operation Summary Table

| Operation | Brief Type | Token Cost | Frequency | Priority Use |
|-----------|-----------|------------|-----------|--------------|
| CODE_QUALITY_AUDIT | TD-XXX | ~15K | Monthly | Before releases |
| BUG_HUNT | BR-XXX | ~10K | Before releases | Critical deployments |
| STANDARDS_COMPLIANCE_CHECK | TD-XXX | ~8K | Monthly | After updates |
| BRIEF_ANALYSIS | Recommendations | ~5K | As needed | Planning |
| FEATURE_IDEATION | FR-XXX | ~10K | Quarterly | Innovation |
| PROCESS_AUDIT | PI-XXX | ~8K | Quarterly | Process issues |
| DEPENDENCY_AUDIT | DU-XXX | ~3K | Monthly | Security |
| TEST_COVERAGE_ANALYSIS | TS-XXX | ~2K | Weekly | Quality gates |
| PERFORMANCE_ANALYSIS | PF-XXX | ~7K | On demand | Optimization |
| ARCHITECTURE_REVIEW | AC-XXX | ~8K | Quarterly | Cleanup |

---

## Usage Guidelines

### When to Run Multiple Operations

**Before Major Release:**
1. DEPENDENCY_AUDIT (security first)
2. BUG_HUNT (find issues before users do)
3. CODE_QUALITY_AUDIT (technical debt check)
4. TEST_COVERAGE_ANALYSIS (quality gate)
5. STANDARDS_COMPLIANCE_CHECK (final polish)

**Quarterly Maintenance:**
1. PROCESS_AUDIT (workflow effectiveness)
2. ARCHITECTURE_REVIEW (cleanup opportunities)
3. FEATURE_IDEATION (innovation planning)

**Monthly Routine:**
1. DEPENDENCY_AUDIT (keep dependencies current)
2. CODE_QUALITY_AUDIT (prevent debt accumulation)
3. STANDARDS_COMPLIANCE_CHECK (maintain standards)

### Prioritizing Findings

**Priority order for briefs created:**
1. Security issues (DU with CVE) → P0-Critical
2. Critical bugs (BR with crash risk) → P0-Critical
3. High-value features (FR with clear user value) → P1-High
4. Technical debt (TD) → P1-High to P3-Low (depends on impact)
5. Performance issues (PF) → P2-Medium (unless user-facing)
6. Architecture cleanup (AC) → P2-Medium to P3-Low
7. Process improvements (PI) → P2-Medium
8. Testing briefs (TS) → P2-Medium

---

## Notes

**Design Philosophy:**
- Operations are **tools**, not autonomous agents
- User controls when to run (no surprise audits)
- All work tracked in briefs (no invisible changes)
- Token costs transparent (user knows expense)

**Future Enhancements:**
- Slash commands for operations (`/audit`, `/hunt-bugs`)
- Scheduled operations (monthly auto-audit with user approval)
- Operation result caching (avoid re-analyzing same code)
- Combined operations (run 3 audits in one pass)

---

**Version:** 2.1.0
**Last Updated:** 2025-10-26
**Maintained By:** Igris AI Core System
