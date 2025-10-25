# Feature Management Prompts

Complete guide for managing feature requests throughout their lifecycle: register → list → prioritize → implement → archive.

---

## 1. Register Feature

Use these prompts to **create a feature brief** (registration only - no implementation).

### Startup Prompt (New Conversation)

Copy-paste this when starting a fresh conversation:

```
I need to register a feature request (DO NOT implement yet, just create the brief).

**Feature name:** [descriptive name, e.g., "Export Orders to CSV"]

**Problem:**
[What problem does this solve? Why is it needed?]

Example: "Restaurant managers need to export order data for accounting
purposes but currently have to manually copy data from the app."

**Proposed solution:**
[How should it work? What should users see/do?]

Example: "Add 'Export' button in History screen that generates CSV file
with order details (ID, items, total, date, payment method) and shares
it via Android/iOS share dialog."

**Affected modules:**
[Check all that apply]
- [ ] auth
- [ ] event
- [ ] venue
- [ ] details
- [ ] kds
- [x] settings
- [x] history
- [ ] home
- [ ] connections
- [ ] Other: [specify]

**User impact:**
[Who benefits? How does it help?]

Example: "Restaurant managers save 2-3 hours per week. Accountants get
accurate data in compatible format."

**Priority:** [P0-Critical | P1-High | P2-Medium | P3-Low]
**Effort estimate:** [S-Small | M-Medium | L-Large | XL-Extra Large]

**Acceptance criteria:**
1. [User can do X, e.g., "User can tap Export button in History screen"]
2. [System shows Y, e.g., "CSV file includes all order fields"]
3. [Feature works in Z scenario, e.g., "Export works for date ranges"]

Please create a brief for this feature as BR-XXX.
```

### Mid-Conversation Prompt

Already talking to AI? Use this shorter format:

```
Register a feature (don't implement):

Feature: [name]
Problem: [what it solves]
Solution: [how it should work]
Modules: [affected areas]
Priority: [P0/P1/P2/P3]

Acceptance criteria:
1. [criterion 1]
2. [criterion 2]

Create brief BR-XXX for this.
```

### Quick Registration (Minimal)

For fast feature logging:

```
Feature registration only:
- What: [feature name]
- Why: [problem it solves]
- Where: [modules affected]
- Priority: [P0/P1/P2/P3]

Create brief, don't implement.
```

### What AI Will Do

After using these prompts, AI will:
1. ✅ Create `ai/briefs/BR-XXX-feature-name.md` from template
2. ✅ Assign next available BR number (e.g., BR-008)
3. ✅ Set Status: "Ready" (or "Draft" if info incomplete)
4. ✅ Add to feature backlog
5. ❌ Will **NOT** start implementation
6. ❌ Will **NOT** load context files

To implement later, say: **"Implement BR-XXX"**

---

## 2. List Features

Show all registered feature briefs.

### Show All Features

```
List all features
```

or

```
Show all feature briefs
```

### Filter by Priority

```
List P0 features
```

```
Show high priority features
```

```
List critical features
```

### Filter by Status

```
List features in Ready status
```

```
Show features In Progress
```

```
List completed features
```

### What AI Will Do

AI will:
1. ✅ Scan `ai/briefs/` for files with Type: "Feature"
2. ✅ Parse metadata (Priority, Status, Effort)
3. ✅ Filter by criteria if specified
4. ✅ Display formatted table or list

Expected response:
```
## Feature Briefs (6 total)

| ID | Title | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| BR-008 | Export orders to CSV | P1 | Ready | M |
| BR-010 | Dark mode support | P2 | Draft | L |
| BR-012 | Voice order input | P3 | Ready | XL |
| BR-014 | Offline mode | P1 | Ready | L |
| BR-016 | Multi-language UI | P2 | Ready | M |
| BR-001 | Printer status | P1 | Done | M |

To implement: "Implement BR-XXX"
```

---

## 3. Remove Feature

Delete a feature brief from the queue.

### Remove Single Feature

```
Remove BR-XXX
```

or

```
Delete feature BR-XXX
```

### Remove Multiple Features

```
Remove BR-008, BR-010, BR-012
```

### What AI Will Do

AI will:
1. ✅ Verify brief exists
2. ✅ Check Status (will refuse if "In Progress")
3. ✅ Show brief details
4. ✅ Ask for confirmation
5. ✅ Delete `ai/briefs/BR-XXX-*.md` after confirmation

Expected response:
```
⚠️ About to delete:

BR-012: Voice order input feature
Type: Feature
Priority: P3
Status: Ready
Effort: XL-Extra Large

This will permanently delete the brief.
Confirm deletion? (Say "yes" to confirm)
```

**Note:** Cannot remove briefs with Status: "In Progress"

---

## 4. Implement Feature

Start working on building a feature.

### Start Implementation

```
Implement BR-XXX
```

or

```
Build BR-XXX
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

## 5. Prioritize Feature

Change the priority level of an existing feature.

### Change Priority

```
Change BR-XXX priority to P1
```

```
Make BR-XXX high priority
```

```
Set BR-XXX to P3
```

### Reprioritize Multiple

```
Set BR-008, BR-014 to P1
```

### What AI Will Do

AI will:
1. ✅ Read brief file
2. ✅ Update Priority field in metadata
3. ✅ Save file
4. ✅ Confirm update

Expected response:
```
✅ Priority updated:

BR-008: Export orders to CSV
Priority: P2 → P1
Status: Ready
Effort: M-Medium

This feature is now high priority.
```

---

## 6. Update Status

Manually update the status of a feature brief.

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

BR-008: Export orders to CSV
Status: In Progress → Done

All acceptance criteria met ✅
- User can export orders from History
- CSV includes all required fields
- Export works for custom date ranges

Suggestion: Archive this brief using "Archive BR-008"
```

---

## 7. Show Next Feature

Get AI recommendation for which feature to work on next.

### Get Recommendation

```
What feature should I implement next?
```

```
Show highest priority feature
```

```
What should I work on next?
```

### What AI Will Do

AI will:
1. ✅ List all feature briefs with Status: "Ready"
2. ✅ Sort by Priority (P0 → P1 → P2 → P3)
3. ✅ Consider Effort (prefer S/M over L/XL if equal priority)
4. ✅ Suggest highest priority brief

Expected response:
```
📋 Recommended next feature to implement:

BR-008: Export orders to CSV
Type: Feature
Priority: P1-High
Effort: M-Medium (1-2 days)
Status: Ready

Problem: Restaurant managers need to export order data for accounting
but currently have to manually copy data from the app.

Solution: Add export button in History screen with CSV generation.

To start: "Implement BR-008"
```

---

## 8. Status Report

Get an overview of all feature briefs.

### Full Report

```
Show feature status report
```

```
Feature brief overview
```

### High Priority Report

```
Show high priority features
```

```
List P0/P1 features only
```

### What AI Will Do

AI will:
1. ✅ Read all feature briefs from `ai/briefs/`
2. ✅ Group by Status or Priority
3. ✅ Count totals per group
4. ✅ Format as organized report

Expected response:
```
📊 Feature Status Report

## Ready (4 features)
- BR-008 (P1) - Export orders to CSV [M]
- BR-014 (P1) - Offline mode support [L]
- BR-016 (P2) - Multi-language UI [M]
- BR-012 (P3) - Voice order input [XL]

## In Progress (1 feature)
- BR-009 (P2) - Dark mode support [L]

## In Review (0 features)

## Done (2 features)
- BR-001 (P1) - Printer status indicator [M]
- BR-003 (P2) - Multi-printer support [L]

---

💡 Recommendation: Start with BR-008 (P1-High, M-Medium effort)
To implement: "Implement BR-008"
```

---

## 9. Archive Completed Features

Move completed feature briefs to archive.

### Archive Single Feature

```
Archive BR-XXX
```

```
Move BR-XXX to archive
```

### Archive All Done Features

```
Archive all completed features
```

```
Archive all done feature briefs
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
✅ Archived: BR-008

Moved from: ai/briefs/BR-008-export-orders-csv.md
Moved to: ai/session/archive/briefs/BR-008-export-orders-csv.md

Status: Done
Completed: 2025-10-13
Implementation: Added CSV export feature to History module
```

**Note:** Only briefs with Status: "Done" can be archived.

---

## Quick Reference Card

| Operation | Prompt Example |
|-----------|----------------|
| **Register** | "Register a feature (don't implement): Feature: export orders, Problem: managers need CSV..." |
| **List** | "List all features" or "Show P1 features" |
| **Remove** | "Remove BR-008" |
| **Implement** | "Implement BR-008" |
| **Prioritize** | "Change BR-008 to P1" |
| **Update Status** | "Mark BR-008 as Done" |
| **Show Next** | "What feature should I implement next?" |
| **Status Report** | "Show feature status report" |
| **Archive** | "Archive BR-008" |

---

## Tips

### When to Use Each Priority

- **P0 - Critical:** Blocking major release, contractual obligation, critical business need
- **P1 - High:** High user demand, significant business value, competitive advantage
- **P2 - Medium:** Nice-to-have, improves UX, requested by some users
- **P3 - Low:** Polish, experimental, low user demand

### When to Use Each Effort Estimate

- **S - Small (< 4 hours):** Single component, no API changes, minimal testing
- **M - Medium (1-2 days):** Multiple components, minor API changes, standard testing
- **L - Large (3-5 days):** Multiple modules, significant API changes, extensive testing
- **XL - Extra Large (> 1 week):** Major architectural changes, new infrastructure, complex testing

### Writing Good Acceptance Criteria

Make criteria:
- **Testable:** "User can export orders" ✅ (not "Export works well" ❌)
- **Specific:** "CSV includes ID, date, items, total" ✅ (not "CSV has data" ❌)
- **User-focused:** "User sees success message" ✅ (not "Function returns true" ❌)

Example:
```
Good:
1. User taps Export button in History screen
2. System generates CSV with columns: Order ID, Date, Items, Total, Payment
3. User can share CSV via Android/iOS share dialog
4. Export includes orders from selected date range

Poor:
1. Export feature works
2. CSV file is created
3. Data is correct
```

### When to Update Status Manually

Status usually updates automatically during implementation:
- "Ready" → "In Progress" (when you say "Implement BR-XXX")
- "In Progress" → "Done" (when tests pass and commit is made)

Manual updates are useful for:
- Marking brief as "Draft" when more info needed
- Setting to "In Review" for human code review
- Marking as "Done" after QA verification

---

## Feature vs Bug: Which to Use?

### Use Feature Brief When:
- Adding new functionality that didn't exist before
- Enhancing existing feature with new capabilities
- Improving UX with new interactions
- Adding integration with new service

### Use Bug Brief When:
- Something that worked before is now broken
- Feature exists but behaves incorrectly
- App crashes or throws errors
- Data is displayed incorrectly

### Examples:

| Scenario | Type | Reason |
|----------|------|--------|
| Add CSV export to History | Feature | New functionality |
| Export button doesn't work | Bug | Existing feature broken |
| Add dark mode | Feature | New UI theme |
| Colors don't change in dark mode | Bug | Feature not working correctly |
| Add offline support | Feature | New capability |
| App crashes when offline | Bug | Error condition |

---

**Created:** 2025-10-13
**Last Updated:** 2025-10-13
**Related:** [bug_prompts.md](bug_prompts.md), [igris_os.md](igris_os.md), [CONTRIBUTING.md](../CONTRIBUTING.md)
