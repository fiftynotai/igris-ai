# TD-014: Prompts Directory Restructure - Subagent Integration

**Type:** Technical Debt
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2025-12-03
**Completed:** 2025-12-03

---

## What is the Technical Debt?

**Current situation:**

The `ai/prompts/` directory contains 9 prompt files, many of which are:
- Duplicated in `igris_os.md`
- Obsolete (persona loading moved to CLAUDE.md)
- Better suited as subagent capabilities

**Current structure:**
```
ai/prompts/
├── igris_os.md                     (925 lines - core system)
├── session_protocol.md             (133 lines - session management)
├── generate_coding_guidelines.md   (924 lines - standards generation)
├── generate_architecture_docs.md   (313 lines - architecture docs)
├── self_maintenance.md             (656 lines - 10 audit operations)
├── migration_analysis.md           (452 lines - migration analysis)
├── bug_prompts.md                  (531 lines - DUPLICATE)
├── feature_prompts.md              (613 lines - DUPLICATE)
└── persona_loader.md               (10 lines - OBSOLETE)
```

**Why is it technical debt?**

1. **Duplication:** bug_prompts.md and feature_prompts.md duplicate workflows in igris_os.md
2. **Obsolete:** persona_loader.md is 10 lines, functionality moved to CLAUDE.md init
3. **Wrong location:** Complex analysis prompts should be subagent capabilities, not standalone files
4. **Inconsistency:** Some prompts are "copy-paste templates", others are "agent instructions"
5. **v3.1 Architecture:** Multi-agent system should absorb these into agent definitions

---

## Why It Matters

**Consequences of not fixing:**

- [x] **Maintainability:** Updates needed in multiple places
- [x] **Readability:** Unclear which prompts are active vs legacy
- [x] **Developer Experience:** Confusion about prompt vs subagent
- [ ] **Performance:** N/A
- [ ] **Security:** N/A
- [ ] **Scalability:** Blocks clean subagent ecosystem

**Impact:** High

---

## Cleanup Steps

**How to pay off this debt:**

### Phase 1: Delete Obsolete/Duplicate Files (3 files)
1. [ ] Delete `ai/prompts/bug_prompts.md` (duplicate of igris_os.md workflow)
2. [ ] Delete `ai/prompts/feature_prompts.md` (duplicate of igris_os.md workflow)
3. [ ] Delete `ai/prompts/persona_loader.md` (obsolete - 10 lines, moved to CLAUDE.md)

### Phase 2: Create New Agents (2 agents)
4. [ ] Create `migrator` agent (PATHFINDER) - Tier 3 Maintenance
   - Absorb content from `migration_analysis.md`
   - Purpose: Migration analysis, roadmap generation
   - Trigger: `MIGRATE {project}` or `MIGRATE analyze`

5. [ ] Create `standardizer` agent (LAWKEEPER) - Tier 2 Docs
   - Absorb content from `generate_coding_guidelines.md`
   - Purpose: Generate coding_guidelines.md (4 modes)
   - Trigger: `STANDARDIZE {mode}`

### Phase 3: Enhance Existing Agents (5 agents)
6. [ ] Enhance INQUISITOR (auditor) with 7 operations from self_maintenance.md:
   - CODE_QUALITY_AUDIT
   - BUG_HUNT
   - STANDARDS_COMPLIANCE_CHECK
   - PROCESS_AUDIT
   - DEPENDENCY_AUDIT
   - PERFORMANCE_ANALYSIS
   - ARCHITECTURE_REVIEW

7. [ ] Enhance CHRONICLER (documenter) with architecture docs from generate_architecture_docs.md:
   - `CHRONICLE architecture` → Generate architecture_map.md, api_pattern.md, module_catalog.md

8. [ ] Enhance SENTINEL (tester) with TEST_COVERAGE_ANALYSIS from self_maintenance.md

9. [ ] Enhance ORACLE (ideator) with FEATURE_IDEATION from self_maintenance.md

10. [ ] Enhance ARCHITECT (planner) with BRIEF_ANALYSIS from self_maintenance.md

### Phase 4: Delete Absorbed Files (4 files)
11. [ ] Delete `ai/prompts/generate_coding_guidelines.md` (absorbed into LAWKEEPER)
12. [ ] Delete `ai/prompts/generate_architecture_docs.md` (absorbed into CHRONICLER)
13. [ ] Delete `ai/prompts/self_maintenance.md` (absorbed into multiple agents)
14. [ ] Delete `ai/prompts/migration_analysis.md` (absorbed into PATHFINDER)

### Phase 5: Update Documentation
15. [ ] Update manifest.yaml with 2 new agents
16. [ ] Update igris_os.md Multi-Agent Architecture section
17. [ ] Update CLAUDE.md agent references

---

## Tasks

### Pending
- [ ] Task 1: Delete 3 obsolete/duplicate files
- [ ] Task 2: Create PATHFINDER (migrator) agent definition
- [ ] Task 3: Create LAWKEEPER (standardizer) agent definition
- [ ] Task 4: Enhance INQUISITOR with 7 audit operations
- [ ] Task 5: Enhance CHRONICLER with architecture docs
- [ ] Task 6: Enhance SENTINEL with test coverage analysis
- [ ] Task 7: Enhance ORACLE with feature ideation
- [ ] Task 8: Enhance ARCHITECT with brief analysis
- [ ] Task 9: Delete 4 absorbed prompt files
- [ ] Task 10: Update manifest.yaml (12 agents total)
- [ ] Task 11: Update igris_os.md documentation
- [ ] Task 12: Update CLAUDE.md references

### In Progress
_(none)_

### Completed
_(none)_

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
All phases completed successfully.

### Next Steps
None - brief complete.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2025-12-03 | orchestrator | Created brief | Success |
| 2025-12-03 | orchestrator | Phase 1: Deleted 3 obsolete files | Success |
| 2025-12-03 | orchestrator | Phase 2: Created PATHFINDER agent | Success |
| 2025-12-03 | orchestrator | Phase 2: Created LAWKEEPER agent | Success |
| 2025-12-03 | orchestrator | Phase 3: Enhanced 5 agents | Success |
| 2025-12-03 | orchestrator | Phase 4: Deleted 4 absorbed files | Success |
| 2025-12-03 | orchestrator | Phase 5: Updated manifest + docs | Success |

### Blockers
None

---

## Benefits of Fixing

**What improves after cleanup:**

- ✅ Clean prompts directory (2 files instead of 9)
- ✅ All capabilities in proper subagent definitions
- ✅ No duplicate content
- ✅ Clear agent responsibilities
- ✅ 12 specialized agents with focused capabilities
- ✅ v3.1 multi-agent architecture complete

**Return on Investment:** High

---

## Affected Areas

### Files to DELETE (7)
- `ai/prompts/bug_prompts.md` - duplicate
- `ai/prompts/feature_prompts.md` - duplicate
- `ai/prompts/persona_loader.md` - obsolete
- `ai/prompts/generate_coding_guidelines.md` - absorbed into LAWKEEPER
- `ai/prompts/generate_architecture_docs.md` - absorbed into CHRONICLER
- `ai/prompts/self_maintenance.md` - absorbed into multiple agents
- `ai/prompts/migration_analysis.md` - absorbed into PATHFINDER

### Files to CREATE (2)
- `.claude/agents/migrator.md` - PATHFINDER agent
- `.claude/agents/standardizer.md` - LAWKEEPER agent

### Files to UPDATE (7+)
- `.claude/agents/manifest.yaml` - add 2 new agents
- `.claude/agents/auditor.md` - add 7 operations
- `.claude/agents/documenter.md` - add architecture docs
- `.claude/agents/tester.md` - add test coverage
- `.claude/agents/ideator.md` - add feature ideation
- `.claude/agents/planner.md` - add brief analysis
- `ai/prompts/igris_os.md` - update agent documentation
- `CLAUDE.md` - update agent references

### Count
**Total files to delete:** 7
**Total files to create:** 2
**Total files to update:** 7+

---

## Testing

### Regression Testing
- [ ] Existing agent definitions still work
- [ ] HUNT workflow still functions
- [ ] AUDIT operations work with enhanced INQUISITOR
- [ ] New agents (PATHFINDER, LAWKEEPER) respond correctly

### Verification
**How to verify cleanup is successful:**

1. `ls ai/prompts/` shows only igris_os.md and session_protocol.md
2. `DIGIVOLVE status` shows 12 agents
3. `MIGRATE analyze` triggers PATHFINDER
4. `STANDARDIZE project` triggers LAWKEEPER
5. `AUDIT code_quality` triggers INQUISITOR with new operations

---

## Acceptance Criteria

**The debt is paid off when:**

1. [ ] Only 2 files remain in ai/prompts/ (igris_os.md, session_protocol.md)
2. [ ] PATHFINDER agent created and functional
3. [ ] LAWKEEPER agent created and functional
4. [ ] INQUISITOR enhanced with 7 audit operations
5. [ ] CHRONICLER enhanced with architecture docs
6. [ ] SENTINEL, ORACLE, ARCHITECT enhanced with respective operations
7. [ ] manifest.yaml lists 12 agents
8. [ ] All new triggers work (MIGRATE, STANDARDIZE, AUDIT operations)
9. [ ] Documentation updated

---

## New Agent Specifications

### PATHFINDER (migrator) - Tier 3 Maintenance

```yaml
name: migrator
alias: PATHFINDER
tier: 3
purpose: Analyze codebases against standards, generate migration briefs and roadmaps
triggers:
  - MIGRATE {project}
  - MIGRATE analyze
capabilities:
  - Load coding_guidelines.md as comparison standard
  - Detect architecture violations
  - Find bugs, tech debt, testing gaps
  - Generate categorized briefs (MG/BR/TD/TS)
  - Create MIGRATION_ROADMAP.md
output:
  - ai/briefs/MG-XXX-*.md (migration briefs)
  - ai/session/MIGRATION_ROADMAP.md
```

### LAWKEEPER (standardizer) - Tier 2 Docs

```yaml
name: standardizer
alias: LAWKEEPER
tier: 2
purpose: Generate coding_guidelines.md from codebase/base repo analysis
triggers:
  - STANDARDIZE base-repo
  - STANDARDIZE project
  - STANDARDIZE merge
  - STANDARDIZE best-practices
capabilities:
  - Mode A: Extract from base architecture repo
  - Mode B: Infer from existing project
  - Mode C: Merge base repo + project
  - Mode D: Best practices fallback
output:
  - ai/context/coding_guidelines.md
```

---

## References

**Related Briefs:**
- MG-004-P9: Session & Workflow Restructure (completed)
- MG-004-P8: Cleanup & Documentation

**Architecture:**
- `.claude/agents/manifest.yaml` - Agent registry

---

## Notes

**Agent Count After Completion:**
- Current: 10 agents
- After: 12 agents (+PATHFINDER, +LAWKEEPER)

**Tiers Updated:**
- Tier 2 (Docs): CHRONICLER, HERALD, LAWKEEPER
- Tier 3 (Maintenance): INQUISITOR, MENDER, PATHFINDER

---

**Created:** 2025-12-03
**Last Updated:** 2025-12-03
**Brief Owner:** Fifty.ai
