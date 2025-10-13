# Claude Bootstrap Prompt — Blueprint AI (Flutter Edition)

Use this prompt when starting ANY new task on Opaala Admin App v3.

---

## Session Management (Required - Do This First)

### On Session Start

1. **Check for existing session:**
   ```bash
   cat ai/session/CURRENT_SESSION.md
   ```

2. **If resuming paused session:**
   - Read "Current State" section
   - Read "Next Steps When Resuming"
   - Run `git status` to verify uncommitted changes
   - Continue from last "In Progress" task
   - Update TodoWrite tool with pending tasks

3. **If starting new session:**
   - Archive previous `CURRENT_SESSION.md` to `ai/session/archive/[date]-[id].md` (if completed)
   - Create new `CURRENT_SESSION.md` with today's date
   - Define session goal from brief
   - Break down into tasks using TodoWrite

### During Session (Keep Updated)

Update `CURRENT_SESSION.md` every time you:
- ✅ Complete a task (move to completed, add timestamp)
- 🔄 Start a task (move to in_progress, document "Next step")
- 🚫 Encounter a blocker (add to `BLOCKERS.md`)
- 💡 Make a decision (add to `DECISIONS.md`)
- 📚 Discover a pattern (add to `LEARNINGS.md`)

**Always keep "Next Steps When Resuming" current** - this is your crash recovery mechanism.

### On Session Pause/End

1. Update "Current State" with exact stopping point
2. Commit safe changes
3. List uncommitted changes in CURRENT_SESSION.md
4. If session completed, archive to `ai/session/archive/`

---

## Context Loading (Automatic)

You are working on **Opaala Admin App v3** (Flutter + GetX + MVVM + Actions).

**Read these files in order:**

1. **Base Architecture:** https://github.com/KalvadTech/flutter-mvvm-actions-arch (canonical reference)
2. **Repo Adaptations:** `ai/context/architecture_map.md`
3. **API Flow:** `ai/context/api_pattern.md`
4. **Coding Style:** `ai/context/coding_guidelines.md`
5. **Module Reference:** `ai/context/module_catalog.md`

**Then read the brief:**
- Brief path: `ai/briefs/BR-XXX-<title>.md`

---

## Operating Rules

### Architecture Enforcement
- ✅ **DO:** Respect layer boundaries (View → Actions → ViewModel → Service → Model)
- ❌ **DON'T:** Skip layers (View calling Service directly)
- ✅ **DO:** Use `ActionPresenter.actionHandler()` for async actions with loaders
- ❌ **DON'T:** Put UI logic (dialogs, navigation) in ViewModel

### Code Quality
- ✅ **DO:** Add structured Dart doc-comments to all public APIs
- ✅ **DO:** Use `ApiResponse<T>` + `apiFetch()` for API calls
- ✅ **DO:** Make models immutable (`final` fields, `const` constructors)
- ✅ **DO:** Run `flutter analyze` and fix all issues
- ❌ **DON'T:** Commit code with lint errors

### Testing
- ✅ **DO:** Write unit tests for ViewModels (mock services)
- ✅ **DO:** Test state transitions (idle → loading → success/fail)
- ✅ **DO:** Run `flutter test` and ensure all pass
- ❌ **DON'T:** Skip tests for business logic

### Documentation
- ✅ **DO:** Update `README.md` if adding user-facing features
- ✅ **DO:** Add i18n keys to `lib/src/config/keys.dart` and translations
- ✅ **DO:** Update module catalog if adding new module
- ❌ **DON'T:** Leave hardcoded strings in UI

---

## Workflow (Strict)

### 1. PLAN
- Read the brief thoroughly
- Identify affected modules, layers, files
- List dependencies (new services, models, routes)
- Outline test scenarios
- State any assumptions or questions
- Create TodoWrite list

### 2. PATCH
- Implement changes respecting architecture
- Add doc-comments to all new public APIs
- Follow naming conventions from guidelines
- Use GetX bindings for dependency injection
- Update CURRENT_SESSION.md as you progress

### 3. TESTS
- Write unit tests for ViewModels
- Write widget tests for complex UI (if applicable)
- Ensure `flutter test` passes
- Document test results in `ai/session/TEST_RESULTS.md`

### 4. RUN STEPS
- `flutter analyze` (must pass)
- `flutter test` (must pass)
- `flutter run` (smoke test manually if UI changes)

### 5. COMMIT
- Use Conventional Commits format (see `ai/templates/commit_message.md`)
- Reference brief in commit body
- Include "closes #BR-XXX" if applicable

---

## Brief Format Expectations

Every brief MUST have:
- **Problem:** What's broken or missing?
- **Goal:** What should happen after the fix/feature?
- **Context & Inputs:** Relevant modules, APIs, data
- **Constraints:** Architecture rules, timeline, scope
- **Acceptance Criteria:** Testable outcomes
- **Test Plan:** How to verify manually + automated tests
- **Delivery:** Migrations, feature flags, docs to update

---

## Handling Brief Management Operations

User can manage bugs and features using prompts from:
- **Bug Management:** `ai/prompts/bug_prompts.md`
- **Feature Management:** `ai/prompts/feature_prompts.md`

### 1. Registration (Create Brief Only)

**Trigger phrases:**
- "register a bug/feature"
- "create a brief"
- "don't implement yet"
- "add to queue"

**Actions:**
1. ✅ Scan `ai/briefs/` to find next available BR number
2. ✅ Create `ai/briefs/BR-XXX-[name].md` from `BR-TEMPLATE.md`
3. ✅ Fill in all provided information
4. ✅ Set Status: "Ready" (or "Draft" if incomplete info)
5. ✅ Set Priority, Effort, Type (Bug Fix/Feature)
6. ✅ If P0/P1 bug, add entry to `ai/session/BLOCKERS.md`
7. ❌ **DO NOT** load context files
8. ❌ **DO NOT** start implementation
9. ❌ **DO NOT** create TodoWrite tasks

**Response format:**
```
✅ Brief registered: BR-XXX

File: ai/briefs/BR-XXX-[name].md
Type: [Bug Fix | Feature]
Priority: [P0/P1/P2/P3]
Status: Ready
Effort: [S/M/L/XL]

[If P0/P1 bug:]
Added to BLOCKERS.md (critical issue)

To implement: "Implement BR-XXX" or "Fix BR-XXX"
```

---

### 2. Listing Briefs

**Trigger phrases:**
- "list all bugs/features"
- "show bug briefs"
- "list P0 bugs"
- "show features in Ready status"

**Actions:**
1. ✅ Read all files in `ai/briefs/` (exclude BR-TEMPLATE.md)
2. ✅ Parse metadata from each file (Type, Priority, Status, Effort)
3. ✅ Filter by Type if specified (bugs vs features)
4. ✅ Filter by Priority if specified (P0, P1, etc.)
5. ✅ Filter by Status if specified (Ready, In Progress, etc.)
6. ✅ Format as organized table or list

**Response format:**
```
## [Bug | Feature] Briefs (X total)

| ID | Title | Priority | Status | Effort |
|----|-------|----------|--------|--------|
| BR-002 | Fix printer crash | P0 | Ready | S |
| BR-005 | Handle null venue | P1 | Draft | M |
| BR-007 | Socket timeout | P2 | Ready | S |

[If filter applied:]
Showing: [filter description, e.g., "P0/P1 bugs only"]

To implement: "Implement BR-XXX"
```

---

### 3. Removing Briefs

**Trigger phrases:**
- "remove BR-XXX"
- "delete brief BR-XXX"
- "remove BR-005, BR-007"

**Actions:**
1. ✅ Verify brief file exists
2. ✅ Read brief to get details
3. ✅ Check Status (refuse if "In Progress")
4. ✅ Show details and ask for confirmation
5. ✅ After confirmation, delete `ai/briefs/BR-XXX-*.md`
6. ✅ Remove from `BLOCKERS.md` if present
7. ❌ **DO NOT** delete if Status = "In Progress" (must finish or abandon first)

**Response format (before confirmation):**
```
⚠️ About to delete:

BR-XXX: [title]
Type: [Bug Fix | Feature]
Priority: [P0/P1/P2/P3]
Status: [Ready]

This will permanently delete the brief file.
Confirm deletion? (Say "yes" to confirm)
```

**After confirmation:**
```
✅ Deleted: BR-XXX
Removed file: ai/briefs/BR-XXX-[name].md
[If was in BLOCKERS:]
Removed from BLOCKERS.md
```

---

### 4. Implementation (Transitions to Normal Workflow)

**Trigger phrases:**
- "implement BR-XXX"
- "fix BR-XXX"
- "build BR-XXX"
- "start working on BR-XXX"

**Actions:**
1. ✅ Read brief from `ai/briefs/BR-XXX-*.md`
2. ✅ Update Status: "Ready" → "In Progress"
3. ✅ Save updated brief
4. ✅ Load context files (architecture_map, api_pattern, coding_guidelines, module_catalog)
5. ✅ Create/update `CURRENT_SESSION.md` with session goal
6. ✅ Create TodoWrite tasks from acceptance criteria
7. ✅ Follow normal workflow: **Plan → Patch → Tests → Run → Commit**
8. ✅ After commit succeeds, update Status: "In Progress" → "Done"

**This transitions from registration mode to implementation mode.**

---

### 5. Prioritization

**Trigger phrases:**
- "change BR-XXX priority to P0"
- "make BR-XXX high priority"
- "set BR-005, BR-007 to P1"

**Actions:**
1. ✅ Read brief file(s)
2. ✅ Update Priority field in metadata
3. ✅ Save file(s)
4. ✅ If changed TO P0/P1, add to `BLOCKERS.md`
5. ✅ If changed FROM P0/P1 to P2/P3, remove from `BLOCKERS.md`

**Response format:**
```
✅ Priority updated:

BR-XXX: [title]
Priority: [old] → [new]
Status: [status]

[If now P0/P1:]
Added to BLOCKERS.md (critical/high priority)

[If lowered from P0/P1:]
Removed from BLOCKERS.md
```

---

### 6. Status Updates

**Trigger phrases:**
- "mark BR-XXX as Ready"
- "set BR-XXX status to Done"
- "update BR-XXX status to In Review"

**Actions:**
1. ✅ Read brief file
2. ✅ Update Status field
3. ✅ Save file
4. ✅ If status = "Done", suggest archiving

**Response format:**
```
✅ Status updated:

BR-XXX: [title]
Status: [old] → [new]

[If now Done:]
Suggestion: Archive this brief using "Archive BR-XXX"
```

---

### 7. Show Next Task

**Trigger phrases:**
- "what should I work on next?"
- "what bug should I fix next?"
- "what feature should I implement next?"
- "show highest priority brief"

**Actions:**
1. ✅ List all briefs with Status: "Ready"
2. ✅ Filter by Type if specified (bugs vs features)
3. ✅ Sort by Priority (P0 → P1 → P2 → P3)
4. ✅ Within same priority, prefer S/M effort over L/XL
5. ✅ Suggest highest priority brief

**Response format:**
```
📋 Recommended next task:

BR-XXX: [title]
Type: [Bug Fix | Feature]
Priority: [P0-Critical]
Effort: [S-Small] (< 4 hours)
Status: Ready

[Brief problem/goal summary]

To start: "Implement BR-XXX" or "Fix BR-XXX"
```

---

### 8. Status Reports

**Trigger phrases:**
- "show bug status report"
- "show feature status report"
- "brief overview"
- "show critical bugs"
- "list P0/P1 features"

**Actions:**
1. ✅ Read all briefs from `ai/briefs/`
2. ✅ Filter by Type if specified (bugs/features)
3. ✅ Filter by Priority if specified (P0/P1 only)
4. ✅ Group by Status
5. ✅ Count totals per group
6. ✅ Format as organized report

**Response format:**
```
📊 [Bug | Feature] Status Report

## Ready (X briefs)
- BR-XXX (P0) - [title] [effort]
- BR-YYY (P1) - [title] [effort]

## In Progress (X briefs)
- BR-ZZZ (P1) - [title] [effort]

## In Review (X briefs)
[list]

## Done (X briefs)
[list]

---

💡 Recommendation: [next task suggestion]
To implement: "Implement BR-XXX"
```

---

### 9. Archiving

**Trigger phrases:**
- "archive BR-XXX"
- "move BR-XXX to archive"
- "archive all completed bugs"
- "archive all done features"

**Actions:**
1. ✅ Verify brief Status = "Done"
2. ✅ Create `ai/session/archive/briefs/` folder if not exists
3. ✅ Move file from `ai/briefs/BR-XXX-*.md` to `ai/session/archive/briefs/`
4. ✅ Update `CURRENT_SESSION.md` history (add to completed list)
5. ❌ **DO NOT** archive if Status ≠ "Done"

**Response format:**
```
✅ Archived: BR-XXX

Moved from: ai/briefs/BR-XXX-[name].md
Moved to: ai/session/archive/briefs/BR-XXX-[name].md

Status: Done
Completed: [date]
[Brief summary]
```

**If Status ≠ "Done":**
```
❌ Cannot archive BR-XXX

Current Status: [In Progress | Ready | Draft | In Review]
Reason: Only briefs with Status: "Done" can be archived

To mark as Done: "Mark BR-XXX as Done"
```

---

### Brief Numbering

- **Format:** BR-XXX where XXX is zero-padded 3-digit number
- **Starting:** BR-001
- **Increment:** Find highest existing BR number in `ai/briefs/`, add 1
- **Example:** If BR-007 exists, next is BR-008

---

## PR Checklist (Enforce)

Before submitting PR:
- [ ] Brief path referenced in PR description
- [ ] `flutter analyze` passes (zero issues)
- [ ] `flutter test` passes (all tests green)
- [ ] New code has doc-comments (public APIs)
- [ ] UI strings use i18n (no hardcoded text)
- [ ] Tests added/updated for logic changes
- [ ] README updated if user-facing feature
- [ ] Conventional Commit message format
- [ ] Session archived to `ai/session/archive/`

---

## Common Gotchas (This Repo)

1. **Folder naming inconsistency:** Some modules use `data/service/` (singular), new code uses `data/services/` (plural). Follow plural for new modules.

2. **Socket lifecycle:** If using Phoenix Socket, connect in `onInit()`, disconnect in `onClose()` of ViewModel.

3. **Token refresh:** ApiService handles 401 auto-refresh, but ensure MemoryService has valid refresh token.

4. **Printer role-based routing (v2.6.0):** Use `printerRole` field in PrinterConfig (KOT → kitchen, BILL → front desk).

5. **History module separation (v2.6.0):** Use `HistoryViewModel` for historical data, not `EventsViewModel` (memory optimization).

---

## Session Files Reference

| File | Purpose | Update Frequency |
|------|---------|------------------|
| `CURRENT_SESSION.md` | Active session state, todo list, recovery info | Every task |
| `DECISIONS.md` | Architectural decisions log | When making decisions |
| `BLOCKERS.md` | Active blockers/questions | When blocked |
| `LEARNINGS.md` | Discoveries and patterns | When learning something |
| `TEST_RESULTS.md` | Test outcomes | After running tests |

---

## Example: Starting a New Task

**Scenario:** Implementing BR-001: Add Printer Connection Status Indicator

**Steps:**

1. **Check session:**
   ```bash
   cat ai/session/CURRENT_SESSION.md
   # If empty or completed, create new session
   ```

2. **Create session:**
   - Session Goal: "Implement BR-001: Printer Connection Status Indicator"
   - Status: In Progress
   - Break down into tasks:
     - [ ] Read BR-001 brief
     - [ ] Create PrinterStatusIndicator widget
     - [ ] Add checkPrinterStatus() in SettingsViewModel
     - [ ] Add status refresh timer
     - [ ] Write unit tests
     - [ ] Run analyze/test
     - [ ] Commit changes

3. **Load context:**
   - Read `ai/context/architecture_map.md`
   - Read `ai/context/api_pattern.md`
   - Read `ai/briefs/BR-001-printer-status.md`

4. **Start implementing:**
   - Mark first task as in_progress
   - Update "Next Steps When Resuming" continuously
   - Document decisions in DECISIONS.md
   - Document blockers in BLOCKERS.md

5. **Complete:**
   - Run analyze/test
   - Commit with conventional format
   - Archive session to `ai/session/archive/2025-10-13-001.md`

---

**Last Updated:** 2025-10-13
**Repo:** Opaala Admin App v3 (v2.6.0+215)
**Base Architecture:** https://github.com/KalvadTech/flutter-mvvm-actions-arch
