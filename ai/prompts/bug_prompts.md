# Bug Management Prompts

Complete guide for managing bugs throughout their lifecycle: register → list → prioritize → implement → archive.

---

## 1. Register Bug

Use these prompts to **create a bug brief** (registration only - no implementation).

### Startup Prompt (New Conversation)

Copy-paste this when starting a fresh conversation:

```
I need to register a bug (DO NOT implement yet, just create the brief).

**Bug in:** [module/feature name, e.g., "Settings - Printer Status"]

**What I was doing:**
1. [step 1, e.g., "Opened printer settings"]
2. [step 2, e.g., "Connected to Bluetooth printer"]
3. [step 3, e.g., "App crashed when checking status"]

**Expected behavior:**
[what should happen, e.g., "Status should show 'Connected' with green dot"]

**Actual behavior:**
[what actually happened, e.g., "App crashes with null pointer exception"]

**Error messages/logs:**
[paste errors if any]
```
Error: NullPointerException at SettingsViewModel.checkPrinterStatus:485
```

**Screenshots:**
[mention if available, e.g., "See screenshot-001.png attached"]

**Priority:** [P0-Critical | P1-High | P2-Medium | P3-Low]
**Effort estimate:** [S-Small | M-Medium | L-Large | XL-Extra Large]

Please create a brief for this bug as BR-XXX.
```

### Mid-Conversation Prompt

Already talking to AI? Use this shorter format:

```
Register a bug (don't implement):

Module: [name]
Issue: [brief description]
Steps to reproduce:
1. [step 1]
2. [step 2]
Expected: [what should happen]
Actual: [what happened]
Priority: [P0/P1/P2/P3]

Create brief BR-XXX for this.
```

### Quick Registration (Minimal)

For fast bug logging:

```
Bug registration only:
- What: [brief description]
- Where: [module]
- Reproduce: [1, 2, 3]
- Priority: [P0/P1/P2/P3]

Create brief, don't implement.
```

### What AI Will Do

After using these prompts, AI will:
1. ✅ Create `ai/briefs/BR-XXX-bug-name.md` from template
2. ✅ Assign next available BR number (e.g., BR-005)
3. ✅ Set Status: "Ready" (or "Draft" if info incomplete)
4. ✅ Add to `ai/session/BLOCKERS.md` if P0 or P1
5. ❌ Will **NOT** start implementation
6. ❌ Will **NOT** load context files

To implement later, say: **"Implement BR-XXX"** or **"Fix BR-XXX"**

---

## 2. List Bugs

Show all registered bug briefs.

### Show All Bugs

```
List all bugs
```

or

```
Show all bug briefs
```

### Filter by Priority

```
List P0 bugs
```

```
Show critical bugs
```

```
List high priority bugs
```

### Filter by Status

```
List bugs in Draft status
```

```
Show Ready bugs
```

```
List bugs In Progress
```

### What AI Will Do

AI will:
1. ✅ Scan `ai/briefs/` for files with Type: "Bug Fix"
2. ✅ Parse metadata (Priority, Status, Effort)
3. ✅ Filter by criteria if specified
4. ✅ Display formatted table or list

Expected response:
```
## Bug Briefs (5 total)

| ID | Title | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| BR-002 | Fix printer crash | P0 | Ready | S |
| BR-005 | Handle null venue | P1 | Draft | M |
| BR-007 | Socket timeout | P2 | Ready | S |
| BR-009 | UI overflow | P3 | Ready | S |
| BR-001 | Printer status | P1 | Done | M |

To implement: "Implement BR-XXX"
```

---

## 3. Remove Bug

Delete a bug brief from the queue.

### Remove Single Bug

```
Remove BR-XXX
```

or

```
Delete bug BR-XXX
```

### Remove Multiple Bugs

```
Remove BR-005, BR-007, BR-009
```

### What AI Will Do

AI will:
1. ✅ Verify brief exists
2. ✅ Check Status (will refuse if "In Progress")
3. ✅ Show brief details
4. ✅ Ask for confirmation
5. ✅ Delete `ai/briefs/BR-XXX-*.md` after confirmation
6. ✅ Remove from `BLOCKERS.md` if present

Expected response:
```
⚠️ About to delete:

BR-005: Handle null venue error
Type: Bug Fix
Priority: P1
Status: Ready

This will permanently delete the brief.
Confirm deletion? (Say "yes" to confirm)
```

**Note:** Cannot remove briefs with Status: "In Progress"

---

## 4. Implement Bug Fix

Start working on fixing a bug.

### Start Implementation

```
Implement BR-XXX
```

or

```
Fix BR-XXX
```

or

```
Start working on BR-XXX
```

### What AI Will Do

AI will:
1. ✅ Read brief from `ai/briefs/BR-XXX-*.md`
2. ✅ Update Status to "In Progress"
3. ✅ Load context files (architecture_map, api_pattern, etc.)
4. ✅ Create session in CURRENT_SESSION.md
5. ✅ Create TodoWrite tasks from acceptance criteria
6. ✅ Follow workflow: Plan → Patch → Tests → Run → Commit

This transitions from **registration mode** to **implementation mode**.

---

## 5. Prioritize Bug

Change the priority level of an existing bug.

### Change Priority

```
Change BR-XXX priority to P0
```

```
Make BR-XXX high priority
```

```
Set BR-XXX to P2
```

### Reprioritize Multiple

```
Set BR-005, BR-007 to P1
```

### What AI Will Do

AI will:
1. ✅ Read brief file
2. ✅ Update Priority field in metadata
3. ✅ Save file
4. ✅ Add to BLOCKERS.md if changed to P0/P1
5. ✅ Remove from BLOCKERS.md if lowered from P0/P1

Expected response:
```
✅ Priority updated:

BR-005: Handle null venue error
Priority: P1 → P0
Status: Ready

Added to BLOCKERS.md (critical issue)
```

---

## 6. Update Status

Manually update the status of a bug brief.

### Manual Status Update

```
Mark BR-XXX as Ready
```

```
Set BR-XXX status to In Review
```

```
Mark BR-XXX as Done
```

### Status Values

- **Draft** - Brief incomplete, needs more info
- **Ready** - Brief complete, ready for implementation
- **In Progress** - Currently being worked on
- **In Review** - Implementation done, awaiting review
- **Done** - Completed and verified

### What AI Will Do

AI will:
1. ✅ Read brief file
2. ✅ Update Status field
3. ✅ Save file
4. ✅ If status = "Done", suggest archiving

Expected response:
```
✅ Status updated:

BR-007: Fix socket timeout
Status: In Progress → Done

Suggestion: Archive this brief using "Archive BR-007"
```

---

## 7. Show Next Bug

Get AI recommendation for which bug to work on next.

### Get Recommendation

```
What bug should I fix next?
```

```
Show highest priority bug
```

```
What should I work on next?
```

### What AI Will Do

AI will:
1. ✅ List all bug briefs with Status: "Ready"
2. ✅ Sort by Priority (P0 → P1 → P2 → P3)
3. ✅ Consider Effort (prefer S/M over L/XL if equal priority)
4. ✅ Suggest highest priority brief

Expected response:
```
📋 Recommended next bug to fix:

BR-002: Fix printer crash on status check
Type: Bug Fix
Priority: P0-Critical
Effort: S-Small (< 4 hours)
Status: Ready

Description: App crashes with NullPointerException when checking
Bluetooth printer status in SettingsViewModel.

To start: "Fix BR-002"
```

---

## 8. Status Report

Get an overview of all bug briefs.

### Full Report

```
Show bug status report
```

```
Bug brief overview
```

### Blocker Report (Critical Only)

```
Show critical bugs
```

```
List P0/P1 bugs only
```

### What AI Will Do

AI will:
1. ✅ Read all bug briefs from `ai/briefs/`
2. ✅ Group by Status or Priority
3. ✅ Count totals per group
4. ✅ Format as organized report

Expected response:
```
📊 Bug Status Report

## Ready (3 bugs)
- BR-002 (P0) - Fix printer crash on status check
- BR-005 (P1) - Handle null venue error in event list
- BR-007 (P2) - Fix socket timeout on reconnection

## In Progress (1 bug)
- BR-003 (P1) - Memory leak in KDS module

## In Review (1 bug)
- BR-004 (P2) - Fix UI overflow in order details

## Done (2 bugs)
- BR-001 (P1) - Printer status indicator
- BR-006 (P3) - Translation missing for error

---

💡 Recommendation: Start with BR-002 (P0-Critical)
To implement: "Fix BR-002"
```

---

## 9. Archive Completed Bugs

Move completed bug briefs to archive.

### Archive Single Bug

```
Archive BR-XXX
```

```
Move BR-XXX to archive
```

### Archive All Done Bugs

```
Archive all completed bugs
```

```
Archive all done bug briefs
```

### What AI Will Do

AI will:
1. ✅ Verify brief Status = "Done"
2. ✅ Create `ai/session/archive/briefs/` if not exists
3. ✅ Move file from `ai/briefs/` to `ai/session/archive/briefs/`
4. ✅ Update CURRENT_SESSION.md history
5. ❌ Refuse to archive if Status ≠ "Done"

Expected response:
```
✅ Archived: BR-001

Moved from: ai/briefs/BR-001-printer-status.md
Moved to: ai/session/archive/briefs/BR-001-printer-status.md

Status: Done
Completed: 2025-10-13
```

**Note:** Only briefs with Status: "Done" can be archived.

---

## Quick Reference Card

| Operation | Prompt Example |
|-----------|----------------|
| **Register** | "Register a bug (don't implement): Module: settings, Issue: crash on status check..." |
| **List** | "List all bugs" or "Show P0 bugs" |
| **Remove** | "Remove BR-005" |
| **Implement** | "Fix BR-002" |
| **Prioritize** | "Change BR-005 to P0" |
| **Update Status** | "Mark BR-007 as Done" |
| **Show Next** | "What bug should I fix next?" |
| **Status Report** | "Show bug status report" |
| **Archive** | "Archive BR-001" |

---

## Tips

### When to Use Each Priority

- **P0 - Critical:** App crashes, data loss, security issues, production blockers
- **P1 - High:** Major features broken, significant UX issues, impacts many users
- **P2 - Medium:** Minor features broken, workaround exists, impacts some users
- **P3 - Low:** Cosmetic issues, edge cases, nice-to-have fixes

### When to Update Status Manually

Status usually updates automatically during implementation:
- "Ready" → "In Progress" (when you say "Fix BR-XXX")
- "In Progress" → "Done" (when tests pass and commit is made)

Manual updates are useful for:
- Marking brief as "Draft" when more info needed
- Setting to "In Review" for human code review
- Marking as "Done" after manual testing

---

**Created:** 2025-10-13
**Last Updated:** 2025-10-13
**Related:** [feature_prompts.md](feature_prompts.md), [igris_os.md](igris_os.md), [CONTRIBUTING.md](../CONTRIBUTING.md)
