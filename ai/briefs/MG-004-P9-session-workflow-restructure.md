# MG-004-P9: Session & Workflow Restructure

**ID:** MG-004-P9
**Type:** Migration
**Status:** Done
**Priority:** P0-Critical
**Created:** 2025-12-03
**Updated:** 2025-12-03
**Effort:** M-Medium (1-2 days)
**Parent:** MG-004 (IGRIS v3.1 Migration)
**Phase:** 9 of 9

---

## Summary

Restructure session management and brief system for IGRIS v3.1 multi-agent architecture. Clean separation between project-level tracking (CURRENT_SESSION.md) and brief-level tracking (brief files with Workflow State).

---

## Problem

Current system has issues:
1. CURRENT_SESSION.md tries to track both project AND task details
2. Brief files have "Session State" that duplicates CURRENT_SESSION.md
3. igris_os.md and CLAUDE.md have overlapping content
4. Two-level tracking concept creates too much syncing overhead
5. No clear place to track subagent workflow state

---

## Goal

Clean separation of concerns:
1. **Project level (CURRENT_SESSION.md):** Which briefs active, resume point
2. **Brief level (Brief files):** Tasks, workflow state, agent tracking
3. **Subagents:** Stateless workers, main agent handles all state
4. Simplified protocols with less redundancy

---

## Deliverables

### 1. New CURRENT_SESSION.md Template (Simplified)
- Remove task details (brief handles this)
- Remove workflow phase/agent info (brief handles this)
- Keep only: active briefs, status, resume point

### 2. New Workflow State Section for Briefs
- Phase: INIT → PLANNING → BUILDING → TESTING → REVIEWING → COMPLETE
- Active Agent: none | planner | coder | tester | reviewer | etc.
- Retry Count
- Agent Log (timestamped history)
- Current Work + Next Steps

### 3. Updated igris_os.md
- Remove old session management sections
- Add new Multi-Agent Architecture section
- Simplify remaining sections

### 4. Rewritten session_protocol.md
- Simplified to ~100 lines
- Clear two-level model
- Simple recovery protocol

### 5. Updated CLAUDE.md
- Remove duplicated content
- Keep initialization, persona, quick reference
- Point to igris_os.md for full protocols

### 6. Updated Brief Templates (9 files)
- Replace "Session State" with "Workflow State"

---

## Tasks

### Pending
- [ ] Update all 9 brief templates with Workflow State section
- [ ] Rewrite igris_os.md with multi-agent architecture
- [ ] Rewrite session_protocol.md (simplified)
- [ ] Update CLAUDE.md (remove duplication)
- [ ] Update MG-004-P8 status to Done

### In Progress
- [x] Create this brief (MG-004-P9)
- [ ] Update CURRENT_SESSION.md template

### Completed
_(none yet)_

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
All tasks completed.

### Next Steps
None - brief complete.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2025-12-03 | orchestrator | Created brief | Success |
| 2025-12-03 | orchestrator | Updated CURRENT_SESSION.md | Success |
| 2025-12-03 | orchestrator | Updated 10 brief templates | Success |
| 2025-12-03 | orchestrator | Rewrote igris_os.md | Success |
| 2025-12-03 | orchestrator | Rewrote session_protocol.md | Success |
| 2025-12-03 | orchestrator | Updated CLAUDE.md | Success |

### Blockers
None

---

## Acceptance Criteria

- [ ] CURRENT_SESSION.md is simplified (tracks briefs only)
- [ ] All 9 brief templates have Workflow State section
- [ ] igris_os.md has Multi-Agent Architecture section
- [ ] Old session management removed from igris_os.md
- [ ] session_protocol.md is simplified (~100 lines)
- [ ] CLAUDE.md has no duplicated content
- [ ] Recovery protocol works (session → brief → workflow state)

---

## Dependencies

- **Depends on:** MG-004-P1 through P8 (agent foundation)
- **Blocks:** Nothing (final restructure)

---

## History

- 2025-12-03: Brief created

---

🔥 **CLEAN HOUSE. SHIP IT.** 🔥
