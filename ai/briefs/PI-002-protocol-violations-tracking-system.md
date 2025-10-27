# PI-002: Protocol Violations Tracking System

**Type:** Process Improvement
**Priority:** P1-High
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2025-10-27
**Completed:** 2025-10-27

---

## Process Issue

**What's inefficient or broken in the current workflow?**

Currently, when Igris AI violates its own protocols (e.g., Brief-First Protocol), there is:
- ❌ No systematic tracking of violations
- ❌ No pattern analysis to understand why violations happen
- ❌ No data to improve protocols based on failure modes
- ❌ No visibility into whether context pressure causes shortcuts
- ❌ No way to prevent future violations through learning

**Example:** Commit 4e88562 fixed CLAUDE.md bug but skipped Brief-First Protocol entirely. This went unnoticed until user pointed it out.

**Why does it matter?**

- **Accountability**: Violations should be logged transparently
- **Self-improvement**: Can't fix what we don't measure
- **Pattern detection**: Certain user messages may trigger violations
- **Context correlation**: Token pressure may cause cognitive shortcuts
- **Protocol enhancement**: Data-driven improvements to unclear rules

---

## Current Process

**How does it work now?**

1. User gives instruction
2. Igris AI interprets and acts
3. If protocol violated → no tracking, no learning
4. User may or may not notice
5. Violation forgotten, pattern not captured

**Pain points:**
- ❌ Violations invisible unless user catches them
- ❌ No historical data to analyze failure patterns
- ❌ Can't correlate context size with shortcuts
- ❌ Same mistakes repeated
- ❌ No systematic improvement mechanism

---

## Improved Process

**How should it work after this improvement?**

1. User gives instruction
2. Igris AI interprets and acts
3. If protocol violated → **Log to PROTOCOL_VIOLATIONS.md**
4. Capture: triggering message, context state, root cause, patterns
5. Analyze violations periodically
6. Update protocols based on data

**Benefits:**
- ✅ Complete audit trail of all violations
- ✅ Pattern analysis (which messages trigger violations?)
- ✅ Context correlation (does token pressure matter?)
- ✅ Data-driven protocol improvements
- ✅ Predictive prevention (flag risky messages)
- ✅ Transparency and accountability

---

## Context & Inputs

### User Insight (Origin)

**User message (2025-10-27):**
> "i've a good idea, let's create a file where we save everytime you violate the protocol and why this happen so we can track and enhance in the future"

**Follow-up insight:**
> "how about the context amount can we access this and store it cause i feel context size effect too"

This came after user caught Brief-First Protocol violation in commit 4e88562.

### Affected Workflows
- [x] Brief implementation workflow (when violations happen)
- [x] Session management (logging violations)
- [x] Self-maintenance operations (analyze patterns)
- [ ] Brief creation workflow
- [ ] Context reset recovery
- [ ] Commit process
- [ ] Testing workflow

### Files to Create
- `ai/session/PROTOCOL_VIOLATIONS.md` - Main violations log

### Files to Modify
- `ai/prompts/igris_os.md` - Add reference to violations tracking

### Dependencies
- [x] Token usage data (available from system-warning messages)
- [x] User message history (available in conversation)
- [x] Git commit hashes (available from git log)

---

## Constraints

- Must not slow down normal operations
- Must be easy to log violations (no complex process)
- Must preserve user privacy (no sensitive data)
- Format must support pattern analysis

---

## Implementation Tasks

### Pending
_(No pending tasks - all complete)_

### In Progress
_(No tasks in progress - brief complete)_

### Completed
- [x] Task 1: Create PROTOCOL_VIOLATIONS.md with template structure (completed: 2025-10-27 16:35)
- [x] Task 2: Add first violation entry (commit 4e88562) (completed: 2025-10-27 16:35)
- [x] Task 3: Update igris_os.md to reference violations log (completed: 2025-10-27 16:37)
- [x] Task 4: Commit as PI-002 (in progress)

---

## Session State (Tactical - This Brief)

**Current State:** ✅ ALL TASKS COMPLETE - Ready to commit
**Next Steps When Resuming:** N/A - Brief complete
**Last Updated:** 2025-10-27 16:38
**Blockers:** None

**Implementation Summary:**
- Created PROTOCOL_VIOLATIONS.md with first violation entry (commit 4e88562)
- Documented context state (86K tokens, 43% usage)
- Captured triggering message and pattern analysis
- Updated igris_os.md to reference violations log (2 locations)
- System ready for future violation tracking

---

## File Structure Design

### PROTOCOL_VIOLATIONS.md Template

```markdown
# Protocol Violations Log

**Purpose:**
- Identify failure patterns in user messages
- Track context pressure correlation
- Improve protocol clarity
- Enable self-learning

**Origin:**
User insight (2025-10-27): "let's create a file where we save everytime you violate the protocol and why this happen so we can track and enhance in the future"

---

## [YYYY-MM-DD HH:MM] - [Violation Title]

**Protocol Violated:** [Which rule]

**Context State:**
- Token usage: [X / 200000] ([Y%] used)
- Remaining: [Z tokens]
- Context pressure: [Low <50% | Medium 50-75% | High 75-90% | Critical >90%]

**Triggering User Message:**
> [EXACT message that led to violation]

**What Igris Did (Violation):**
[Describe actual behavior]

**Why Protocol Was Skipped:**
[Root cause analysis]

**Pattern Analysis:**
- Keywords in trigger: [list]
- Message type: [Direct command / Question / Observation]
- Urgency indicators: [Yes/No]
- Context pressure hypothesis: [Could token pressure have contributed?]

**Correct Workflow:**
[Step-by-step correct process]

**Impact:**
- Severity: [P0/P1/P2/P3]
- Consequences: [What broke]

**Prevention:**
[How to avoid]

**Related Commit:** [Git hash]

---
```

---

## Success Criteria

**The process improvement is successful when:**

1. [ ] PROTOCOL_VIOLATIONS.md exists in ai/session/
2. [ ] First violation (4e88562) documented with full context
3. [ ] Template ready for future violations
4. [ ] igris_os.md references violations log
5. [ ] Commit created as PI-002
6. [ ] Process is lightweight enough to use consistently

---

## Expected Outcomes

**Short-term (immediate):**
- Violation tracking system operational
- First violation documented
- Clear template for future entries

**Medium-term (after 10 violations):**
- Pattern analysis possible
- Keyword correlation identified
- Context pressure hypothesis tested

**Long-term (continuous):**
- Data-driven protocol improvements
- Predictive violation prevention
- Self-improving system

---

## References

**Related Commits:**
- 4e88562 - CLAUDE.md fix that violated Brief-First Protocol

**Related Files:**
- `ai/session/BLOCKERS.md` - Similar tracking for technical blockers
- `ai/session/DECISIONS.md` - Similar tracking for architectural decisions
- `ai/session/LEARNINGS.md` - Similar tracking for discoveries

**User Messages:**
- "by the way you didn't follow the protocol why?"
- "i've a good idea, let's create a file..."
- "how about the context amount..."

---

**Created:** 2025-10-27
**Last Updated:** 2025-10-27
**Brief Owner:** Igris AI (Commanded by: Fifty.ai)
