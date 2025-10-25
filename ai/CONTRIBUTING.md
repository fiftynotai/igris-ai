# Contributing to Opaala Admin App v3

Guide for managing bugs and features using Igris AI workflow.

---

## Quick Reference

### 🐛 Bug Management
📄 **[ai/prompts/bug_prompts.md](prompts/bug_prompts.md)**

Operations:
- **Register** - Create bug brief (don't implement)
- **List** - Show all bugs, filter by priority/status
- **Remove** - Delete bug brief
- **Implement** - Start fixing the bug
- **Prioritize** - Change priority level
- **Update Status** - Manual status changes
- **Show Next** - Get recommendation
- **Status Report** - Overview of all bugs
- **Archive** - Move completed bugs to archive

### ✨ Feature Management
📄 **[ai/prompts/feature_prompts.md](prompts/feature_prompts.md)**

Operations:
- **Register** - Create feature brief (don't implement)
- **List** - Show all features, filter by priority/status
- **Remove** - Delete feature brief
- **Implement** - Start building the feature
- **Prioritize** - Change priority level
- **Update Status** - Manual status changes
- **Show Next** - Get recommendation
- **Status Report** - Overview of all features
- **Archive** - Move completed features to archive

---

## Quick Commands

### Register (Brief Creation Only)

**Register a bug:**
```
Register a bug (don't implement):
Module: [name]
Issue: [description]
Steps: [how to reproduce]
Priority: [P0/P1/P2/P3]

Create brief BR-XXX for this.
```

**Register a feature:**
```
Register a feature (don't implement):
Feature: [name]
Problem: [what it solves]
Solution: [how it works]
Priority: [P0/P1/P2/P3]

Create brief BR-XXX for this.
```

See full templates in [bug_prompts.md](prompts/bug_prompts.md) and [feature_prompts.md](prompts/feature_prompts.md).

---

### List

```bash
# List all bugs
"List all bugs"

# List all features
"List all features"

# Filter by priority
"Show P0 bugs"
"List high priority features"

# Filter by status
"List bugs in Ready status"
"Show features In Progress"
```

---

### Implement

```bash
# Start implementation (triggers full workflow)
"Implement BR-XXX"
"Fix BR-XXX"
"Build BR-XXX"
```

**Note:** This loads context, creates session, and starts Plan → Patch → Tests → Run → Commit workflow.

---

### Manage Queue

```bash
# Prioritize
"Change BR-XXX to P0"
"Set BR-005, BR-007 to P1"

# Show next task
"What should I work on next?"
"What bug should I fix next?"
"What feature should I implement next?"

# Update status
"Mark BR-XXX as Ready"
"Set BR-XXX status to Done"

# Status overview
"Show bug status report"
"Show feature status report"
"List P0/P1 bugs only"

# Remove
"Remove BR-XXX"
"Delete feature BR-008"

# Archive completed
"Archive BR-XXX"
"Archive all completed bugs"
```

---

## Brief Lifecycle

```
Draft → Ready → In Progress → In Review → Done → Archived
```

### Status Definitions

| Status | Meaning | When to Use |
|--------|---------|-------------|
| **Draft** | Brief incomplete, needs more info | Initial creation, missing details |
| **Ready** | Brief complete, ready for implementation | All info provided, can start work |
| **In Progress** | Currently being worked on | AI is implementing (auto-set) |
| **In Review** | Implementation done, awaiting review | Code done, needs human review |
| **Done** | Completed and verified | Tests passed, committed, verified |
| **Archived** | Moved to archive folder | Done and no longer in active queue |

### Automatic Status Updates

- **Draft → Ready:** When you provide all required info
- **Ready → In Progress:** When you say "Implement BR-XXX"
- **In Progress → Done:** When tests pass and commit succeeds

### Manual Status Updates

Use when you need to:
- Mark brief as "Draft" if more info needed
- Set to "In Review" for code review process
- Mark as "Done" after manual testing/verification

---

## Priority Levels

### For Bugs

| Priority | Use When | Example |
|----------|----------|---------|
| **P0 - Critical** | App crashes, data loss, security, production down | App crashes on printer status check |
| **P1 - High** | Major features broken, significant UX issue | Orders not loading in History |
| **P2 - Medium** | Minor features broken, workaround exists | UI overflow in order details |
| **P3 - Low** | Cosmetic issues, edge cases | Translation missing for one error |

### For Features

| Priority | Use When | Example |
|----------|----------|---------|
| **P0 - Critical** | Blocking release, contractual obligation | Export feature for accounting audit |
| **P1 - High** | High user demand, significant business value | Dark mode support |
| **P2 - Medium** | Nice-to-have, improves UX | Voice order input |
| **P3 - Low** | Polish, experimental | Custom app themes |

---

## Effort Estimates

| Effort | Time | When to Use |
|--------|------|-------------|
| **S - Small** | < 4 hours | Single component, no API changes |
| **M - Medium** | 1-2 days | Multiple components, minor API changes |
| **L - Large** | 3-5 days | Multiple modules, significant changes |
| **XL - Extra Large** | > 1 week | Major architectural changes, new infrastructure |

---

## File Structure

```
ai/
├── briefs/                          # Active briefs
│   ├── BR-001-printer-status.md     # Feature brief
│   ├── BR-002-fix-crash.md          # Bug brief
│   ├── BR-003-export-feature.md     # Feature brief
│   └── BR-TEMPLATE.md               # Template for all briefs
│
├── session/
│   ├── CURRENT_SESSION.md           # Active session state
│   ├── DECISIONS.md                 # Architectural decisions
│   ├── BLOCKERS.md                  # Active blockers
│   ├── LEARNINGS.md                 # Discovered patterns
│   └── archive/
│       ├── 2025-10-13-001.md        # Archived session
│       └── briefs/                  # Archived briefs
│           ├── BR-001.md            # Completed & archived
│           └── BR-002.md            # Completed & archived
│
└── prompts/
    ├── bug_prompts.md               # Bug management guide
    ├── feature_prompts.md           # Feature management guide
    └── claude_bootstrap.md          # AI session startup guide
```

---

## Workflow Examples

### Example 1: Report a Bug

1. **Find a bug during testing**
   ```
   App crashes when checking printer status
   ```

2. **Register the bug (don't implement)**
   ```
   Register a bug (don't implement):
   Module: settings
   Issue: App crashes when checking Bluetooth printer status
   Steps: 1) Open Settings, 2) Tap Printer Status, 3) App crashes
   Expected: Show "Connected" with green dot
   Actual: NullPointerException at line 485
   Priority: P0

   Create brief BR-002 for this.
   ```

3. **AI creates brief**
   ```
   ✅ Brief registered: BR-002
   File: ai/briefs/BR-002-fix-printer-status-crash.md
   Status: Ready
   Priority: P0-Critical
   Added to BLOCKERS.md

   To implement: "Fix BR-002"
   ```

4. **Later, implement the fix**
   ```
   Fix BR-002
   ```

5. **AI implements, tests, and commits**

---

### Example 2: Request a Feature

1. **Identify need**
   ```
   Managers need to export order data to CSV
   ```

2. **Register the feature**
   ```
   Register a feature (don't implement):
   Feature: Export orders to CSV
   Problem: Managers need order data for accounting but have to manually copy
   Solution: Add Export button in History screen that generates CSV
   Modules: history, settings
   Priority: P1

   Acceptance criteria:
   1. User can tap Export in History
   2. CSV includes Order ID, Date, Items, Total, Payment
   3. User can share via native share dialog

   Create brief BR-008 for this.
   ```

3. **AI creates brief**
   ```
   ✅ Brief registered: BR-008
   File: ai/briefs/BR-008-export-orders-csv.md
   Status: Ready
   Priority: P1-High
   Effort: M-Medium

   To implement: "Implement BR-008"
   ```

4. **Check what to work on next**
   ```
   What should I work on next?
   ```

5. **AI recommends**
   ```
   📋 Recommended: BR-002 (P0-Critical, fix printer crash)
   Then: BR-008 (P1-High, CSV export)
   ```

6. **Implement highest priority**
   ```
   Fix BR-002
   ```

---

### Example 3: Manage Queue

**List all pending work:**
```
Show bug status report
```

**Filter critical issues:**
```
List P0/P1 bugs only
```

**Reprioritize:**
```
Change BR-008 to P0
```

**Remove canceled brief:**
```
Remove BR-010
```

**Archive completed work:**
```
Archive BR-002
```

---

## Best Practices

### Registration

✅ **DO:**
- Provide reproduction steps for bugs
- Include error messages and logs
- Define clear acceptance criteria for features
- Estimate priority and effort
- Use "don't implement" in prompt to avoid auto-implementation

❌ **DON'T:**
- Start implementation immediately (register first)
- Skip priority/effort estimates
- Write vague descriptions ("it doesn't work")
- Forget to specify affected modules

### Implementation

✅ **DO:**
- Fix P0 bugs before adding P2 features
- Implement one brief at a time
- Follow Plan → Patch → Tests → Run → Commit workflow
- Update brief status after completion

❌ **DON'T:**
- Work on multiple briefs simultaneously
- Skip testing
- Implement features without briefs
- Leave briefs in "In Progress" after finishing

### Queue Management

✅ **DO:**
- Archive completed briefs regularly
- Keep queue organized (remove canceled items)
- Update priorities as needs change
- Use "Show Next" for recommendations

❌ **DON'T:**
- Let queue grow indefinitely
- Keep low-priority briefs blocking view
- Forget to update status
- Ignore P0/P1 critical issues

---

## Getting Help

### Common Questions

**Q: How do I know what BR number to use?**
A: AI automatically assigns the next available number. Just say "Create brief BR-XXX" and AI will use the correct number.

**Q: Can I implement immediately without creating a brief?**
A: Not recommended. Briefs ensure proper planning, documentation, and tracking. Always register first.

**Q: What if I need to change a brief after creation?**
A: Edit the file directly in `ai/briefs/BR-XXX-*.md` or ask AI to update specific fields.

**Q: How do I resume interrupted work?**
A: Check `ai/session/CURRENT_SESSION.md` for "Next Steps When Resuming" and continue from there.

**Q: Should I create a brief for tiny changes?**
A: For very small changes (< 30 min), you can skip briefs. But tracking improves visibility and learning.

---

## Related Documentation

- **[ai/prompts/bug_prompts.md](prompts/bug_prompts.md)** - Complete bug management guide
- **[ai/prompts/feature_prompts.md](prompts/feature_prompts.md)** - Complete feature management guide
- **[ai/prompts/claude_bootstrap.md](prompts/claude_bootstrap.md)** - AI session startup guide
- **[ai/briefs/BR-TEMPLATE.md](briefs/BR-TEMPLATE.md)** - Brief template with all fields
- **[ai/checks/qa_runbook.md](checks/qa_runbook.md)** - QA verification checklist
- **[README.md](../README.md#igris-ai-pilot)** - Igris AI overview

---

**Created:** 2025-10-13
**Last Updated:** 2025-10-13
**Maintained By:** Opaala Development Team
