# Session Management Protocol - Quick Reference

## Core Principle

**Session management is CRITICAL PATH, not optional documentation.**

Work and documentation happen SIMULTANEOUSLY, not sequentially.

---

## TodoWrite + CURRENT_SESSION.md: Both Required

**Different purposes, both mandatory:**

- **TodoWrite:** Immediate task tracking (volatile, lost on context reset)
- **CURRENT_SESSION.md:** Recovery state (persistent, survives context resets)

**After EVERY TodoWrite change → Update CURRENT_SESSION.md too.**

---

## Checkpoint Summary

### Checkpoint 1: Before Starting Work

**Execute validation checklist:**

- [ ] Have I read CURRENT_SESSION.md?
- [ ] Have I loaded coding_guidelines.md?
- [ ] Have I read the current brief (if implementing one)?
- [ ] Have I updated "Next Steps When Resuming"?
- [ ] Do I know what happens if context resets now?

**If any checkbox unchecked → STOP and load missing context.**

---

### Checkpoint 2: After Starting TodoWrite Task

**WHEN you mark a TodoWrite task as "in_progress":**

1. Update CURRENT_SESSION.md → "Current State" with what you're working on
2. Update "Next Steps When Resuming" → How to continue if interrupted NOW
3. THEN start the work

---

### Checkpoint 3: After Completing TodoWrite Task

**WHEN you mark a TodoWrite task as "completed":**

1. Update CURRENT_SESSION.md → Add task to "Completed Tasks" section
2. Update "Next Steps When Resuming" → What comes after this task
3. IF task is from a brief AND all brief tasks done → Go to Checkpoint 4
4. THEN continue to next task

---

### Checkpoint 4: After Brief Completion

**WHEN all tasks from brief [XX-NNN] are completed:**

1. IMMEDIATELY update brief file: Status: "In Progress" → "Done"
2. Add: `Completed: [current date YYYY-MM-DD]`
3. Update CURRENT_SESSION.md → Note brief completion
4. **DO NOT wait for user to ask**

**Timing specification:**

- ✅ Update AFTER: All acceptance criteria met
- ✅ Update AFTER: Tests pass (if applicable)
- ✅ Update AFTER: Code committed (if applicable)
- ✅ Update BEFORE: Asking user "what's next?"

**IMMEDIATELY means:** Right after conditions met, not when user asks.

---

### Checkpoint 5: Before Ending Conversation

**WHEN user says "thanks", "that's all", or conversation ending:**

1. Update CURRENT_SESSION.md → Final state
2. Update "Next Steps When Resuming" → Exact continuation point
3. Update all brief statuses if needed
4. Display: "✅ Session state saved. Resume anytime!"

---

## Quick Examples

### Example 1: Starting a Task

```
1. Mark TodoWrite task as "in_progress" ✅
2. Update CURRENT_SESSION.md:
   Current State: "Working on implementing authentication module"
3. Update "Next Steps When Resuming":
   "Continue with creating login service in lib/services/"
4. Start coding ✅
```

### Example 2: Completing a Task

```
1. Mark TodoWrite task as "completed" ✅
2. Update CURRENT_SESSION.md:
   Add to "Completed Tasks": "✅ Implemented authentication module"
3. Update "Next Steps When Resuming":
   "Next: Write unit tests for authentication service"
4. Continue to next task ✅
```

### Example 3: Brief Completion

```
All acceptance criteria met ✅
Tests pass ✅
Code committed ✅

IMMEDIATELY (before asking "what's next?"):
1. Update brief file:
   Status: In Progress → Done
   Completed: 2025-10-15
2. Update CURRENT_SESSION.md:
   "✅ BR-005 completed and committed"
3. Continue ✅
```

---

## Common Mistakes to Avoid

❌ **WRONG:** Update TodoWrite only, skip CURRENT_SESSION.md
✅ **CORRECT:** Update BOTH TodoWrite AND CURRENT_SESSION.md

❌ **WRONG:** Wait for user to ask "update the brief status"
✅ **CORRECT:** Update brief status IMMEDIATELY after completion

❌ **WRONG:** Think "I'll document this later"
✅ **CORRECT:** Document WHILE working (integrated)

❌ **WRONG:** Skip "Next Steps When Resuming" updates
✅ **CORRECT:** Update after EVERY task state change

---

## Mental Model Shift

**From this:**
```
1. Do the work
2. Report results
3. Maybe document if user asks
```

**To this:**
```
1. Validate context loaded (Checkpoint 1)
2. Start task → Update session (Checkpoint 2)
3. Do the work
4. Complete task → Update session (Checkpoint 3)
5. IF brief done → Update status (Checkpoint 4)
6. Continue
```

Session management is INTEGRATED with work, not AFTER work.

---

## Reference

**Full details:** `ai/prompts/igris_os.md`
**Mandatory first action:** `CLAUDE.md` (top of file)
**Template:** `ai/session/CURRENT_SESSION.md`

---

**Last Updated:** 2025-10-15
**Igris AI Version:** 1.0.4
