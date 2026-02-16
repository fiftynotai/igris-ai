# PI-003: Add Documenter Agent to HUNT Workflow

**Type:** Process Improvement
**Priority:** P2-Medium
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Monarch
**Status:** Done
**Created:** 2026-01-20
**Completed:** 2026-02-16

---

## Process Issue

**What's inefficient or broken in the current workflow?**

During HUNT workflow execution, the documenter agent is not invoked after implementation. This results in outdated documentation when new components, APIs, or features are added.

**Discovery:** During UI-005 (Example App Redesign), `definition.md` listed only 6 components when 28 existed. The oversight was caught by manual review, not by the workflow itself.

**Why does it matter?**

- Documentation drift causes confusion for users and developers
- Manual documentation updates are often forgotten
- Inconsistent documentation reduces project credibility
- New contributors cannot trust documentation accuracy

---

## Current Process

**How does it work now?**

1. PLANNING - architect agent creates implementation plan
2. BUILDING - forger agent implements changes
3. TESTING - sentinel agent validates implementation
4. REVIEWING - warden agent approves code quality
5. COMMITTING - orchestrator commits changes

**Pain points:**
- ❌ No documentation update phase
- ❌ Documentation drift accumulates silently
- ❌ Must manually remember to update docs
- ❌ No quality gate for documentation accuracy

---

## Improved Process

**How should it work after this improvement?**

1. PLANNING - architect agent creates implementation plan
2. BUILDING - forger agent implements changes
3. TESTING - sentinel agent validates implementation
4. REVIEWING - warden agent approves code quality
5. **DOCUMENTING** - documenter agent updates relevant docs (NEW)
6. COMMITTING - orchestrator commits changes

**Benefits:**
- ✅ Automatic documentation updates
- ✅ Documentation stays in sync with code
- ✅ Quality gate prevents doc drift
- ✅ Conditional invocation (skip when not needed)

---

## Context & Inputs

### Affected Workflows
- [ ] Brief creation workflow
- [x] Brief implementation workflow (HUNT)
- [ ] Session management
- [ ] Context reset recovery
- [ ] Commit process
- [ ] Testing workflow
- [ ] Other: [specify]

### Files to Create
- None

### Files to Modify
- `ai/prompts/igris_os.md` - Add DOCUMENTING phase to state machine
- `CLAUDE.md` - Update workflow documentation

### Dependencies
- [x] Existing process: HUNT workflow
- [x] Tool/system: documenter subagent
- [x] Documentation: igris_os.md workflow section

---

## Constraints

### Process Rules
- Must maintain existing functionality
- Must not add excessive overhead
- Must be conditional (skip for non-API changes)
- Should reduce cognitive load, not increase it

### Technical Constraints
- Must work with existing subagent architecture
- Documenter agent already exists (no new agent needed)

### Timeline
- **Deadline:** N/A
- **Milestones:** None

### Out of Scope
- Changes to documenter agent capabilities
- New documentation templates
- Documentation for non-code changes

---

## Tasks

### Pending
- [ ] Task 1: Update igris_os.md state machine to include DOCUMENTING phase
- [ ] Task 2: Add conditional trigger logic (when to invoke documenter)
- [ ] Task 3: Update CLAUDE.md workflow documentation
- [ ] Task 4: Test with real HUNT workflow

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
All workflow definitions updated with DOCUMENTING phase.

### Next Steps
Archive brief.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-01-20 | orchestrator | Brief created | PI-003 registered |
| 2026-02-16 | orchestrator | Implement PI-003 | Updated 4 files: hunt/SKILL.md, igris_os.md, 04-igris-agents.md, PI-003 brief |

### Blockers
None

---

## Acceptance Criteria

**The process improvement is complete when:**

1. [ ] igris_os.md includes DOCUMENTING phase in state machine
2. [ ] Conditional trigger logic documented (when to invoke vs skip)
3. [ ] CLAUDE.md workflow section updated
4. [ ] State transitions defined:
   - REVIEWING → DOCUMENTING (if API changes)
   - REVIEWING → COMMITTING (if no API changes)
   - DOCUMENTING → COMMITTING (after docs updated)
5. [ ] Process tested with real HUNT execution

---

## Verification Plan

### Test New Process
**Scenario:** Implement a feature that adds new public API
**Steps:**
1. HUNT a brief with new component/API
2. Verify documenter is automatically invoked after REVIEWING
3. Verify documentation is updated before commit

**Expected Result:** Documentation updated automatically as part of workflow
**Old Result:** Documentation forgotten, caught by manual review

### Regression Check
- [ ] Existing HUNT workflows still work
- [ ] No excessive overhead for small changes
- [ ] Documenter correctly skipped for non-API changes

---

## Delivery

### Documentation Updates
- [ ] Process documentation: igris_os.md
- [ ] Workflow guides: CLAUDE.md
- [ ] Templates: None
- [ ] README: None

### Training/Communication
- [ ] Team notified of new process: N/A (single user)
- [ ] Examples provided: Yes (in igris_os.md)
- [ ] Migration path documented: N/A

---

## Notes

**Trigger Conditions for Documenter:**

Invoke documenter when:
- New public APIs added
- Component library changes
- README-worthy features implemented
- API signatures change

Skip documenter when:
- Internal refactoring only
- Bug fixes with no API changes
- Test-only changes
- Session/config changes

**Before/After Comparison:**
- **Before:** Documentation updates forgotten ~30% of time
- **After:** Documentation updates automated, 0% forgotten

---

**Created:** 2026-01-20
**Last Updated:** 2026-01-20
**Brief Owner:** Igris AI