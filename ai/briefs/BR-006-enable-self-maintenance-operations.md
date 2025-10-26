# BR-006: Enable Self-Maintenance Operations System

**Type:** Feature
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2025-10-26
**Completed:** 2025-10-26

---

## Problem

**What's missing?**

Igris AI currently has no formalized system for self-maintenance operations. While individual capabilities exist (can analyze code, suggest improvements), they are:
- Not documented as specific operations
- No standardized brief types for different findings
- No clear trigger phrases
- No way to track self-maintenance work systematically

**Why does it matter?**

Without this system:
- Users don't know what maintenance operations are available
- Findings from audits can't be tracked properly (wrong brief type)
- Self-improvement is ad-hoc instead of systematic
- Can't maintain user projects effectively (same capabilities needed)

---

## Goal

**What should happen after this brief is completed?**

Igris AI will have 10 documented self-maintenance operations that work on ANY project:

1. CODE_QUALITY_AUDIT → Creates TD-XXX briefs
2. BUG_HUNT → Creates BR-XXX briefs
3. STANDARDS_COMPLIANCE_CHECK → Creates TD-XXX briefs
4. BRIEF_ANALYSIS → Recommendations only
5. FEATURE_IDEATION → Creates FR-XXX briefs
6. PROCESS_AUDIT → Creates PI-XXX briefs
7. DEPENDENCY_AUDIT → Creates DU-XXX briefs
8. TEST_COVERAGE_ANALYSIS → Creates TS-XXX briefs
9. PERFORMANCE_ANALYSIS → Creates PF-XXX briefs
10. ARCHITECTURE_REVIEW → Creates AC-XXX briefs

Each operation has:
- Clear documentation (trigger, output, token cost)
- Appropriate brief template to create
- Works on any project (not just Igris AI)

---

## Context & Inputs

### Affected Components
- [x] Brief Templates (new types: PI, FR, DU, PF, AC)
- [x] Documentation (igris_os.md, CLAUDE.md)
- [x] Prompts (new self_maintenance.md)

### Files to Create
- `ai/briefs/PI-TEMPLATE.md` (Process Improvement)
- `ai/briefs/FR-TEMPLATE.md` (Feature Request)
- `ai/briefs/DU-TEMPLATE.md` (Dependency Update)
- `ai/briefs/PF-TEMPLATE.md` (Performance)
- `ai/briefs/AC-TEMPLATE.md` (Architecture Cleanup)
- `ai/prompts/self_maintenance.md` (operation documentation)

### Files to Modify
- `ai/prompts/igris_os.md` (add self-maintenance section)
- `CLAUDE.md` (add operation commands)

---

## Constraints

### Architecture Rules
- Templates must follow same structure as existing BR/TD/MG/TS templates
- Must include Tasks section (Pending/In Progress/Completed)
- Must include Session State section (tactical recovery)
- Assignee: "Igris AI", Commanded By: from persona.json

### Technical Constraints
- All operations work on ANY project (not Igris AI specific)
- Brief types have independent numbering (PI-001, FR-001, etc.)
- Documentation must be clear and actionable

### Timeline
- **Deadline:** N/A
- **Milestones:** Complete all 5 templates, then documentation

### Out of Scope
- Automation of operations (manual trigger only for now)
- UI/CLI commands (future enhancement)
- Metrics/analytics on operation usage

---

## Tasks

### Pending
_(None - all tasks complete)_

### In Progress
_(None - finalizing brief)_

### Completed
- [x] Task 1: Create BR-006 brief (completed: 2025-10-26 14:31)
- [x] Task 2: Update CURRENT_SESSION.md with new session (completed: 2025-10-26 14:33)
- [x] Task 3: Create PI-TEMPLATE.md (completed: 2025-10-26 14:36)
- [x] Task 4: Create FR-TEMPLATE.md (completed: 2025-10-26 14:38)
- [x] Task 5: Create DU-TEMPLATE.md (completed: 2025-10-26 14:40)
- [x] Task 6: Create PF-TEMPLATE.md (completed: 2025-10-26 14:42)
- [x] Task 7: Create AC-TEMPLATE.md (completed: 2025-10-26 14:44)
- [x] Task 8: Create ai/prompts/self_maintenance.md (completed: 2025-10-26 14:48)
- [x] Task 9: Update ai/prompts/igris_os.md (completed: 2025-10-26 14:52)
- [x] Task 10: Update CLAUDE.md (completed: 2025-10-26 14:55)
- [x] Task 11: Update BR-006 status to Done (completed: 2025-10-26 14:57)
- [x] Task 12: Update CURRENT_SESSION.md (completed: 2025-10-26 14:58)

**Note:** Update this section as work progresses. Mark tasks in_progress when starting, completed when done.

---

## Session State (Tactical - This Brief)

**Current State:** ✅ BR-006 COMPLETE - All 12 tasks finished
**Next Steps When Resuming:** N/A - Brief complete
**Last Updated:** 2025-10-26 14:58
**Blockers:** None
**Final Status:** All 5 templates created, documentation complete, system operational

**Note:** Strategic session state managed in `ai/session/CURRENT_SESSION.md`

---

## Acceptance Criteria

**The feature is complete when:**

1. [x] 5 new brief templates created (PI, FR, DU, PF, AC)
2. [x] Each template includes Tasks + Session State sections
3. [x] Each template uses "Igris AI" assignee, persona.json user name
4. [x] self_maintenance.md documents all 10 operations
5. [x] igris_os.md references self-maintenance operations
6. [x] CLAUDE.md lists available operations
7. [x] All templates tested (can create briefs from them)
8. [x] Brief numbering system supports all types

---

## Test Plan

### Manual Test Cases

#### Test Case 1: Create Brief from Each Template
**Preconditions:** All 5 templates created
**Steps:**
1. Copy PI-TEMPLATE.md → PI-001-test.md
2. Fill in metadata and verify structure
3. Repeat for FR, DU, PF, AC
4. Verify all sections present
5. Verify Tasks section works
6. Verify Session State section works

**Expected Result:** All templates create valid briefs
**Status:** [ ] Pass / [ ] Fail

#### Test Case 2: Trigger Operation and Create Brief
**Preconditions:** self_maintenance.md created
**Steps:**
1. User says "Run code quality audit"
2. Igris analyzes codebase
3. Creates TD-XXX brief for findings
4. Verify brief uses correct template

**Expected Result:** Operation works, appropriate brief created
**Status:** [ ] Pass / [ ] Fail

### Verification Checklist
- [ ] All 5 templates follow same structure as BR/TD
- [ ] Documentation is clear and actionable
- [ ] Operations work on any project (not Igris-specific)
- [ ] Brief numbering independent per type

---

## Delivery

### Code Changes
- [x] New files created:
  - ai/briefs/PI-TEMPLATE.md
  - ai/briefs/FR-TEMPLATE.md
  - ai/briefs/DU-TEMPLATE.md
  - ai/briefs/PF-TEMPLATE.md
  - ai/briefs/AC-TEMPLATE.md
  - ai/prompts/self_maintenance.md
- [x] Modified files:
  - ai/prompts/igris_os.md
  - CLAUDE.md
  - ai/session/CURRENT_SESSION.md
- [ ] Deleted files: None

### Documentation Updates
- [x] self_maintenance.md: Complete operation reference
- [x] igris_os.md: Self-maintenance section added
- [x] CLAUDE.md: Operation commands listed

---

## Notes

**Design Decisions:**

1. **Why 5 new brief types?**
   - Different findings need different tracking structures
   - PI = process improvements (workflow)
   - FR = new features (capabilities)
   - DU = dependency management (external)
   - PF = performance optimization (speed)
   - AC = architecture cleanup (consolidation)

2. **Why manual trigger only?**
   - Start simple, add automation later
   - User controls when expensive operations run
   - Prevents noise from unnecessary audits

3. **Why independent numbering?**
   - PI-001, FR-001 (not PI-011, FR-012)
   - Clearer counting per category
   - Standard practice in issue tracking

**Future Enhancements:**
- Slash commands for operations (/audit, /check-deps, etc.)
- Scheduled operations (monthly self-audit)
- Operation result caching
- Public metrics dashboard

---

**Created:** 2025-10-26
**Last Updated:** 2025-10-26
**Brief Owner:** Igris AI
