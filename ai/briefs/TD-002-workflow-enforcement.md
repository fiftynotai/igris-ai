# TD-002: Enhance Blueprint AI Workflow Enforcement

**Type:** Technical Debt
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** AI Assistant
**Status:** In Progress

---

## What is the Technical Debt?

**Current situation:**

v1.0.3 implements Blueprint AI workflow with session management and context loading, but:
- Initialization sequence buried in CLAUDE.md (easy to miss)
- No detection for context resets (Claude doesn't re-initialize)
- Session updates feel optional (no checkpoints trigger updates)
- TodoWrite vs CURRENT_SESSION.md relationship unclear
- Brief status update timing not specified
- Critical instructions mixed with general information

**Why is it technical debt?**

Real-world production testing revealed Claude pattern-matches to standard Claude Code workflow instead of Blueprint AI workflow:
- Sees "continue with phase 2" → executes immediately instead of initializing first
- Updates TodoWrite but not CURRENT_SESSION.md
- Completes briefs but doesn't update status
- Treats session management as "documentation after" instead of "critical path during"

This leads to:
- Lost work on context resets (session state not saved)
- Briefs stuck in "In Progress" status
- No recovery mechanism for interrupted sessions

**Examples:**

```
# What happens now (v1.0.3):
User: "continue with phase 2"
Claude: [Sees TodoWrite in system reminder]
Claude: [Jumps straight to work - skips initialization]
Claude: [Completes tasks, updates TodoWrite ✅]
Claude: [Does NOT update CURRENT_SESSION.md ❌]
Claude: [Does NOT update brief status ❌]
[Context resets]
Claude: [Lost - no session state saved]
```

---

## Why It Matters

**Consequences of not fixing:**

- [x] **Reliability:** Session state not saved → work lost on context resets
- [x] **Workflow Compliance:** Claude skips Blueprint AI protocols
- [x] **Brief Management:** Briefs stuck in "In Progress" status forever
- [x] **User Experience:** Users must manually remind Claude to update session files
- [x] **Recovery:** No way to resume interrupted sessions reliably
- [x] **Pattern Matching:** Claude defaults to standard workflow instead of Blueprint AI

**Impact:** High

Production testing revealed these issues immediately when using Blueprint AI on a real migration project.

---

## Cleanup Steps

**How to pay off this debt:**

1. [x] Analyze production feedback from Claude's self-assessment
2. [ ] Update CLAUDE.md.template with mandatory first action (top of file)
3. [ ] Add context reset detection to CLAUDE.md.template
4. [ ] Add session state validation checklist to CLAUDE.md.template
5. [ ] Update claude_bootstrap.md with critical path clarification
6. [ ] Add checkpoint system to claude_bootstrap.md
7. [ ] Create session_protocol.md quick reference
8. [ ] Update README.md with session management note
9. [ ] Update CHANGELOG.md (v1.0.4)
10. [ ] Update version.txt
11. [ ] Test in fresh conversation scenario
12. [ ] Test context reset scenario

---

## Benefits of Fixing

**What improves after cleanup:**

- ✅ Initialization ALWAYS happens (even on context resets)
- ✅ Session state saved continuously (recovery works)
- ✅ Brief statuses updated immediately (no stuck briefs)
- ✅ TodoWrite AND CURRENT_SESSION.md maintained together
- ✅ Explicit checkpoints trigger updates (not relying on memory)
- ✅ Session management integrated with work (critical path)
- ✅ Clear detection for context resets
- ✅ Validation checklist before starting work

**Return on Investment:** High

This fixes the core workflow compliance issue discovered in production testing.

---

## Affected Areas

### Files to Modify
- `scripts/templates/CLAUDE.md.template` - Add mandatory first action at top
- `ai/prompts/claude_bootstrap.md` - Add critical path + checkpoint sections
- `README.md` - Add session management note
- `CHANGELOG.md` - Add v1.0.4 entry
- `version.txt` - Update to 1.0.4

### Files to Create
- `ai/prompts/session_protocol.md` - Quick reference for checkpoints (NEW)

### Count
**Total files affected:** 5 modified + 1 new
**Total lines to add:** ~300

---

## Testing

### Regression Testing
- [ ] All existing Blueprint AI workflows still work
- [ ] Brief registration works
- [ ] Brief implementation works
- [ ] Session tracking works
- [ ] Hooks system works

### New Feature Testing
- [ ] Mandatory first action displays session state before proceeding
- [ ] Context reset detection triggers re-initialization
- [ ] Validation checklist runs before starting work
- [ ] Checkpoint system triggers CURRENT_SESSION.md updates
- [ ] Brief status updates immediately after completion
- [ ] TodoWrite AND CURRENT_SESSION.md both maintained

### Verification
**How to verify cleanup is successful:**

1. Start fresh conversation with "continue phase 2"
2. Verify initialization happens BEFORE execution
3. Verify session status displayed
4. Complete a task → verify CURRENT_SESSION.md updated immediately
5. Complete a brief → verify status changes to "Done" immediately
6. Simulate context reset → verify re-initialization happens

---

## Acceptance Criteria

**The debt is paid off when:**

1. [ ] CLAUDE.md has mandatory first action at top (unmissable)
2. [ ] Context reset detection added to CLAUDE.md
3. [ ] Session state validation checklist added to CLAUDE.md
4. [ ] claude_bootstrap.md has critical path clarification
5. [ ] claude_bootstrap.md has 5 checkpoint protocols
6. [ ] session_protocol.md created as quick reference
7. [ ] README.md mentions session management
8. [ ] CHANGELOG.md documents v1.0.4 enhancements
9. [ ] version.txt updated to 1.0.4
10. [ ] Tested with fresh conversation (initialization works)
11. [ ] Tested with context reset (re-initialization works)
12. [ ] Tested checkpoint compliance (updates happen immediately)
13. [ ] No AI signatures in commits
14. [ ] Conventional commit format used

---

## References

**Coding Guidelines:**
- `ai/templates/commit_message.md` - No AI signatures rule
- `ai/prompts/claude_bootstrap.md` - Blueprint AI workflow

**Production Feedback:**
- Claude's self-assessment from real migration project testing
- Identified 5 root causes and 5 solutions

**Related Briefs:**
- TD-001 - Hooks-based auto-loading (v1.0.3)
- TD-002 - This brief (workflow enforcement)

---

## Notes

### Discovery Process

This technical debt was discovered through production testing of Blueprint AI on a real migration project. Claude provided detailed self-assessment explaining:

1. **What failed:** Initialization not executed, session updates skipped, brief statuses not updated
2. **Why it failed:** Pattern-matched to standard workflow instead of Blueprint AI workflow
3. **Root causes:** 5 system design issues identified
4. **Solutions:** 5 specific protocols that would have prevented the failures

### Key Insight from Feedback

> "Why I didn't follow it: I treated Blueprint AI session management as 'nice documentation to do afterward' rather than 'critical workflow integrated with every task.'"

The solution is to make session management "in your face" with:
- Mandatory first actions (can't skip)
- Explicit checkpoints (triggered at decision points)
- Validation checklists (verify before starting)
- Clear mental model (critical path, not documentation)

### Implementation Strategy

Use exact protocols from Claude's feedback (proven to work):
- "MANDATORY FIRST ACTION IN EVERY CONVERSATION"
- "Context Reset Detection"
- "Session State Validation"
- "Integrated Task Completion Protocol"
- "Brief Status Protocol"

Adapt only where needed for tooling (e.g., Read tool instead of `cat`).

---

**Created:** 2025-10-15
**Last Updated:** 2025-10-15
**Brief Owner:** Claude (AI Assistant)
