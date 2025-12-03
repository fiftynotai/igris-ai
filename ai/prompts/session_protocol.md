# Session Management Protocol - Quick Reference

## Core Principle

**Project level tracks briefs. Brief level tracks everything else.**

---

## Two Levels (Simplified)

### Project Level: CURRENT_SESSION.md

Purpose: Track which briefs are active at the project level.

**Contains:**
- Active brief(s) - just IDs and titles
- Overall project status (Active / REST MODE)
- Resume point (which brief next)
- Last session summary

**Update when:**
- Starting a new brief → Add to Active Briefs
- Completing a brief → Remove from Active Briefs
- Session pause/end → Update status and resume point

**Does NOT contain:**
- Task details (that's in brief files)
- Workflow phase/agent info (that's in brief files)
- Detailed progress (that's in brief files)

---

### Brief Level: Brief Files

Purpose: Track all work happening within a specific brief.

**Contains:**
- Tasks (Pending/In Progress/Completed) with timestamps
- Workflow State section:
  - Phase: INIT → PLANNING → BUILDING → TESTING → REVIEWING → COMPLETE
  - Active Agent: none | planner | coder | tester | reviewer | etc.
  - Retry Count
  - Agent Log (timestamped history of subagent runs)
- Current Work description
- Next Steps for this brief
- Blockers specific to this brief

**Update when:**
- Task state changes → Move task, add timestamp
- Workflow phase changes → Update Phase
- Subagent invoked → Add to Agent Log, set Active Agent
- Subagent returns → Update Agent Log with result, clear Active Agent
- Any progress → Update Current Work and Next Steps

---

## Recovery Protocol

When context resets:

1. **Read `ai/session/CURRENT_SESSION.md`**
   → Get active brief ID(s)

2. **Read active brief file(s) in `ai/briefs/`**
   → Check Workflow State section
   → Phase tells you where you are
   → Agent Log shows what happened
   → Next Steps tells you what to do

3. **Resume from exact point**
   → Re-invoke agent if it was mid-work
   → Or continue to next phase if agent completed

---

## Checkpoints (Simplified)

### Before Starting Work
- [ ] Read CURRENT_SESSION.md (know active briefs)
- [ ] Read active brief file (know workflow state)
- [ ] Load coding_guidelines.md (know architecture)

### Before Invoking Subagent
- [ ] Update brief: Set Phase and Active Agent
- [ ] Add Agent Log entry: "Starting [agent]..."

### After Subagent Returns
- [ ] Update brief: Agent result in log
- [ ] Update brief: Phase (advance or retry)
- [ ] Update brief: Next Steps
- [ ] Clear Active Agent

### On Brief Completion
- [ ] Update brief: Status → Done
- [ ] Update CURRENT_SESSION.md: Remove from active, add to last session

### On Session End
- [ ] Update active brief(s): Next Steps
- [ ] Update CURRENT_SESSION.md: Status and resume point

---

## Common Mistakes

❌ Updating CURRENT_SESSION.md with task/agent details
✅ Keep task/agent details in brief file only

❌ Skipping brief update after subagent returns
✅ Always update Agent Log immediately

❌ Forgetting to set Active Agent before invoking
✅ Update brief BEFORE Task tool call

❌ Not updating Next Steps after each change
✅ Always keep Next Steps current for recovery

---

## File Reference

| File | Purpose | Update Frequency |
|------|---------|------------------|
| `CURRENT_SESSION.md` | Project-level brief tracking | When briefs start/complete |
| `Brief files` | All task/workflow state for that brief | Every task/agent change |
| `BLOCKERS.md` | Active blockers | When blocked |
| `DECISIONS.md` | Architectural decisions | When making decisions |
| `LEARNINGS.md` | Discoveries and patterns | When learning something |

---

**Last Updated:** 2025-12-03
**IGRIS Version:** 3.1.0
