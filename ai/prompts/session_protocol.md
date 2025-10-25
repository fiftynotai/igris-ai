# Session Management Protocol - Quick Reference

## Core Principle

**Session management is CRITICAL PATH, not optional documentation.**

Work and documentation happen SIMULTANEOUSLY, not sequentially.

---

## Two-Level Session Management Architecture

**Igris AI uses a two-level architecture for session management:**

### Level 1: Strategic (CURRENT_SESSION.md)
**Purpose:** Overall session tracking across multiple briefs

**Contains:**
- Session goal (high-level objective)
- Active briefs (can track multiple simultaneously)
- Current phase for each brief
- Progress counters (which phase, tasks completed)
- Strategic "Next Steps" (which brief to work on next)

**Update when:**
- Starting new brief
- Switching between briefs
- Completing a brief phase
- Brief completion
- Session pause/end

**Example:**
```markdown
## Active Briefs
1. **TD-010** - Protocol Enforcement System
   - Phase: 4 of 5 (Two-Level Session Management Integration)
   - Phase 4: 2 of 5 tasks completed
   - Next: Continue Task 19

2. **BR-003** - Authentication Bug Fix
   - Status: Ready (not started yet)
```

---

### Level 2: Tactical (Brief Files)
**Purpose:** Task-specific tracking within a single brief

**Contains (per brief):**
- Tasks section (Pending/In Progress/Completed)
- Task timestamps (started/completed times)
- Session State (what you're working on RIGHT NOW in THIS brief)
- Tactical "Next Steps" (exact continuation point for THIS brief)
- Blockers specific to this brief

**Update when:**
- Task state changes (Pending → In Progress → Completed)
- Any work done on this brief
- Before switching to another brief
- Context about to reset

**Example:**
```markdown
## Tasks

### In Progress
- [x] Task 17: Define two-level architecture (started: 2025-10-25 18:01)

### Completed
- [x] Task 16: Document recovery process (completed: 2025-10-25 17:58)

## Session State (Tactical - This Brief)
**Current State:** Adding two-level architecture section to session_protocol.md
**Next Steps When Resuming:** Complete Task 17, then move to Task 18
**Last Updated:** 2025-10-25 18:05
**Blockers:** None
```

---

### TodoWrite: Execution Layer
**Purpose:** In-memory task execution derived from brief files

**Relationship:**
- **Loads FROM:** Brief file "Tasks" section (Pending/In Progress/Completed)
- **Syncs TO:** Brief file immediately on every state change
- **Volatile:** Lost on context reset (designed that way)
- **Recovery:** Re-load from brief file after context reset

**Integration:**
```
Brief File (Persistent)
  └─ Tasks: Pending/In Progress/Completed
         ↓ loads into
  TodoWrite (In-Memory)
    └─ pending / in_progress / completed
         ↓ syncs back IMMEDIATELY
  Brief File Updated
    └─ Task moved between sections
    └─ Timestamp added
    └─ Session State updated
```

**After EVERY TodoWrite change → Update brief file immediately + CURRENT_SESSION.md.**

---

### How the Levels Coordinate

**Starting work on a brief:**
1. **Strategic:** Update CURRENT_SESSION.md with active brief
2. **Tactical:** Read brief file, load tasks into TodoWrite
3. **Both:** Mark starting point in both levels

**During work (task state change):**
1. **TodoWrite:** Mark task in_progress/completed
2. **Tactical (IMMEDIATE):** Update brief Tasks section + timestamps + Session State
3. **Strategic:** Update CURRENT_SESSION.md progress counters + current state

**Switching briefs:**
1. **Tactical:** Update current brief Session State ("Next Steps When Resuming")
2. **Strategic:** Update CURRENT_SESSION.md to show which brief is now active
3. **Tactical:** Load new brief, read Session State, continue from exact point

**Context reset (two-level recovery):**
1. **Strategic:** Read CURRENT_SESSION.md → Which brief was active? Which phase?
2. **Tactical:** Read that brief file → Which task? Where stopped exactly?
3. **TodoWrite:** Load tasks from brief → Continue execution
4. **Result:** Resume EXACTLY where work stopped

---

### When to Update Each Level

**Update STRATEGIC (CURRENT_SESSION.md) when:**
- ✅ Starting new brief
- ✅ Completing a brief task (update progress counter)
- ✅ Switching between briefs
- ✅ Completing a brief phase
- ✅ Brief completion (Status: Done)
- ✅ Session pause/end

**Update TACTICAL (Brief file) when:**
- ✅ Task state changes (every TodoWrite change)
- ✅ Any work done on this brief (code written, tests run, decisions made)
- ✅ Before switching to another brief
- ✅ Before context might reset
- ✅ Blocker encountered (add to brief "Blockers" field)

**Update BOTH levels when:**
- ✅ Starting work on a task
- ✅ Completing a task
- ✅ Major progress milestone
- ✅ Session pause/end

---

### Example: Both Levels in Action

**User says: "Implement TD-010 Phase 4 Task 17"**

**Step 1: Load from strategic level**
```bash
Read: ai/session/CURRENT_SESSION.md
→ See: TD-010 active, Phase 4, Task 17 next
```

**Step 2: Load from tactical level**
```bash
Read: ai/briefs/TD-010-protocol-enforcement-system.md
→ See: Phase 4 tasks, Session State says "Continue Task 17"
→ Load Tasks into TodoWrite
```

**Step 3: Update both levels before starting**
```bash
TodoWrite: Mark Task 17 in_progress

TACTICAL (Brief file):
- Move Task 17 from "### Pending" to "### In Progress"
- Add: (started: 2025-10-25 18:01)
- Update Session State: "Current State: Defining two-level architecture"

STRATEGIC (CURRENT_SESSION.md):
- Update: "Phase 4: 0 of 5 tasks completed" → "1 in progress"
- Update: "Next: Implement Task 17" → "Current: Task 17 in progress"
```

**Step 4: Do the work**
```bash
Edit: ai/prompts/session_protocol.md
→ Add two-level architecture section
```

**Step 5: Update both levels after completion**
```bash
TodoWrite: Mark Task 17 completed

TACTICAL (Brief file):
- Move Task 17 from "### In Progress" to "### Completed"
- Add: (completed: 2025-10-25 18:25)
- Update Session State: "Next Steps When Resuming: Start Task 18"

STRATEGIC (CURRENT_SESSION.md):
- Update: "Phase 4: 1 in progress" → "1 of 5 tasks completed"
- Update: "Current: Task 17 in progress" → "Next: Task 18"
```

**Result:** Both levels synchronized, exact state tracked, recovery guaranteed.

---

## Checkpoint Summary

### Checkpoint 1: Before Starting Work

**Execute validation checklist (two-level loading):**

**STRATEGIC level:**
- [ ] Have I read CURRENT_SESSION.md?
- [ ] Do I know which brief is active?
- [ ] Do I know which phase/task to work on?

**TACTICAL level:**
- [ ] Have I read the current brief file?
- [ ] Have I loaded tasks from brief into TodoWrite?
- [ ] Do I understand "Next Steps When Resuming" from brief?

**Context:**
- [ ] Have I loaded coding_guidelines.md (if exists)?
- [ ] Do I know what happens if context resets now?

**If any checkbox unchecked → STOP and load missing context.**

---

### Checkpoint 2: After Starting TodoWrite Task

**WHEN you mark a TodoWrite task as "in_progress":**

**Update BOTH levels immediately:**

1. **TACTICAL (Brief file) - IMMEDIATE:**
   - Move task from "### Pending" to "### In Progress"
   - Add timestamp: `(started: YYYY-MM-DD HH:MM)`
   - Update "Session State" → "Current State" with exact work

2. **STRATEGIC (CURRENT_SESSION.md):**
   - Update "Current State" with what you're working on
   - Update progress counter (e.g., "1 in progress")
   - Update "Next Steps When Resuming"

3. **THEN start the work**

---

### Checkpoint 3: After Completing TodoWrite Task

**WHEN you mark a TodoWrite task as "completed":**

**Update BOTH levels immediately:**

1. **TACTICAL (Brief file) - IMMEDIATE:**
   - Move task from "### In Progress" to "### Completed"
   - Add timestamp: `(completed: YYYY-MM-DD HH:MM)`
   - Update "Session State" → "Next Steps When Resuming" with next action

2. **STRATEGIC (CURRENT_SESSION.md):**
   - Update progress counter (e.g., "1 of 5 tasks completed")
   - Update "Next Steps When Resuming" → What comes after this task

3. **IF task is from a brief AND all brief tasks done → Go to Checkpoint 4**

4. **THEN continue to next task**

---

### Checkpoint 4: After Brief Completion

**WHEN all tasks from brief [XX-NNN] are completed:**

**Update BOTH levels immediately:**

1. **TACTICAL (Brief file) - IMMEDIATE:**
   - Update Status: "In Progress" → "Done"
   - Add: `Completed: [current date YYYY-MM-DD]`
   - Update "Session State" → Final state

2. **STRATEGIC (CURRENT_SESSION.md) - IMMEDIATE:**
   - Note brief completion in Active Briefs section
   - Update session status if no other active briefs
   - Update "Next Steps When Resuming"

3. **DO NOT wait for user to ask**

**Timing specification:**

- ✅ Update AFTER: All acceptance criteria met
- ✅ Update AFTER: Tests pass (if applicable)
- ✅ Update AFTER: Code committed (if applicable)
- ✅ Update BEFORE: Asking user "what's next?"

**IMMEDIATELY means:** Right after conditions met, not when user asks.

---

### Checkpoint 5: Before Ending Conversation

**WHEN user says "thanks", "that's all", or conversation ending:**

**Update BOTH levels:**

1. **TACTICAL (Brief files):**
   - Update all active brief "Session State" sections
   - Update "Next Steps When Resuming" → Exact continuation point for each brief
   - Update all brief statuses if needed (mark Done if completed)

2. **STRATEGIC (CURRENT_SESSION.md):**
   - Update final state
   - Update "Next Steps When Resuming" → Which brief to work on next
   - Note any blockers or decisions

3. **Display:** "✅ Session state saved. Resume anytime!"

---

## Quick Examples

### Example 1: Starting a Task

```
1. Mark TodoWrite task as "in_progress" ✅

2. TACTICAL (Brief file BR-005):
   - Move task from "### Pending" to "### In Progress"
   - Add: (started: 2025-10-26 09:30)
   - Session State: "Current State: Implementing authentication module"

3. STRATEGIC (CURRENT_SESSION.md):
   - Update: "Phase 2: 1 in progress"
   - Current State: "Working on BR-005 authentication module"
   - Next Steps: "Continue with creating login service"

4. Start coding ✅
```

### Example 2: Completing a Task

```
1. Mark TodoWrite task as "completed" ✅

2. TACTICAL (Brief file BR-005):
   - Move task from "### In Progress" to "### Completed"
   - Add: (completed: 2025-10-26 11:45)
   - Session State: "Next Steps: Start writing unit tests"

3. STRATEGIC (CURRENT_SESSION.md):
   - Update: "Phase 2: 1 of 3 tasks completed"
   - Next Steps: "Continue BR-005 - Write unit tests for authentication"

4. Continue to next task ✅
```

### Example 3: Brief Completion

```
All acceptance criteria met ✅
Tests pass ✅
Code committed ✅

IMMEDIATELY (before asking "what's next?"):

1. TACTICAL (Brief file BR-005):
   - Status: In Progress → Done
   - Completed: 2025-10-26
   - Session State: "Final state: All tasks completed, committed"

2. STRATEGIC (CURRENT_SESSION.md):
   - Update: "✅ BR-005 completed and committed"
   - Remove from Active Briefs or mark as Done
   - Update Next Steps to next brief/task

3. Continue ✅
```

---

## Common Mistakes to Avoid

❌ **WRONG:** Update TodoWrite only, skip brief file and CURRENT_SESSION.md
✅ **CORRECT:** Update ALL THREE: TodoWrite → Brief file (TACTICAL) → CURRENT_SESSION.md (STRATEGIC)

❌ **WRONG:** Update STRATEGIC level only, skip TACTICAL brief file updates
✅ **CORRECT:** Update BOTH levels on every task state change

❌ **WRONG:** Wait for user to ask "update the brief status"
✅ **CORRECT:** Update brief status IMMEDIATELY after completion (TACTICAL level)

❌ **WRONG:** Think "I'll document this later"
✅ **CORRECT:** Document WHILE working (integrated, both levels)

❌ **WRONG:** Skip "Next Steps When Resuming" in brief files
✅ **CORRECT:** Update TACTICAL "Next Steps" after EVERY task state change

❌ **WRONG:** Only update one level (strategic OR tactical)
✅ **CORRECT:** Update BOTH levels at every checkpoint

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
1. Validate context loaded (Checkpoint 1) - Load BOTH levels
2. Start task → Update BOTH levels (Checkpoint 2)
   - TACTICAL: Brief file Tasks + Session State
   - STRATEGIC: CURRENT_SESSION.md progress
3. Do the work
4. Complete task → Update BOTH levels (Checkpoint 3)
   - TACTICAL: Move task to Completed, add timestamp
   - STRATEGIC: Update progress counter
5. IF brief done → Update BOTH levels (Checkpoint 4)
   - TACTICAL: Status → Done
   - STRATEGIC: Note completion
6. Continue
```

Session management is INTEGRATED with work at BOTH levels, not AFTER work.

---

## Reference

**Full details:** `ai/prompts/igris_os.md`
**Mandatory first action:** `CLAUDE.md` (top of file)
**Template:** `ai/session/CURRENT_SESSION.md`

---

**Last Updated:** 2025-10-15
**Igris AI Version:** 1.0.4
