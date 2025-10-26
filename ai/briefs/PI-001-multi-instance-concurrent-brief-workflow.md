# PI-001: Multi-Instance Concurrent Brief Workflow

**Type:** Process Improvement
**Priority:** P2-Medium
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2025-10-26

---

## Process Issue

**What's inefficient or broken in the current workflow?**

Igris AI currently assumes **single-instance operation** - one conversation working on one brief at a time. However, users may want to:

1. Run multiple Claude Code instances simultaneously
2. Work on different briefs in parallel (TD-005 in one instance, BR-XXX in another)
3. Maximize throughput for independent tasks

**Current architecture supports this technically** (brief files are independent, only `CURRENT_SESSION.md` is shared), but there is:
- ❌ No documented protocol for concurrent work
- ❌ No coordination strategy for shared files (CURRENT_SESSION.md)
- ❌ No git conflict resolution guidance
- ❌ No clear ownership model for brief instances

**Why does it matter?**

- **Productivity:** Users with multiple briefs could work faster with parallel instances
- **Efficiency:** Testing can run in one instance while development happens in another
- **Scale:** Teams could assign different briefs to different AI instances
- **Bottleneck removal:** Don't wait for one brief to finish before starting another

Without proper protocol, users risk:
- Git merge conflicts in CURRENT_SESSION.md
- Concurrent edits to the same brief file
- Loss of session state from competing updates
- Confusion about which instance owns which brief

---

## Current Process

**How does it work now?**

1. User starts Claude Code conversation
2. Igris AI loads CURRENT_SESSION.md (strategic state)
3. User says "implement BR-XXX"
4. Igris AI marks BR-XXX as active in CURRENT_SESSION.md
5. Igris AI works on brief exclusively until completion
6. User cannot effectively run second instance on different brief

**Pain points:**
- ❌ **Single-threaded:** Can only work on one brief at a time
- ❌ **No coordination:** Running second instance creates conflicts
- ❌ **File contention:** Both instances try to update CURRENT_SESSION.md
- ❌ **No ownership model:** Unclear which instance owns which brief
- ❌ **Merge conflicts:** Git conflicts when both instances commit
- ❌ **No documentation:** Users don't know if multi-instance is supported

---

## Improved Process

**How should it work after this improvement?**

### Multi-Instance Protocol with Conflict Detection

**Core Concept:** Single ownership registry file + automatic conflict analysis

### 1. Instance Registry File

**File:** `ai/session/INSTANCE_REGISTRY.json`

**Format:**
```json
{
  "instances": [
    {
      "id": "instance-1",
      "brief_id": "TD-005",
      "brief_title": "Automated Shell Script Testing",
      "started_at": "2025-10-26T18:30:00Z",
      "files_affected": [
        "test/",
        "scripts/*.sh",
        ".github/workflows/test.yml"
      ],
      "status": "active"
    },
    {
      "id": "instance-2",
      "brief_id": "BR-007",
      "brief_title": "Add user authentication",
      "started_at": "2025-10-26T18:45:00Z",
      "files_affected": [
        "src/auth/",
        "src/models/user.dart",
        "test/auth/"
      ],
      "status": "active"
    }
  ],
  "last_updated": "2025-10-26T18:45:00Z"
}
```

### 2. Before Starting Work (Automatic Check)

**When user says "implement BR-XXX":**

1. **Read registry:** Load `ai/session/INSTANCE_REGISTRY.json`
2. **Check existing instances:** Are any other instances active?
3. **If yes → Analyze conflict:**
   - Read the brief file (BR-XXX.md)
   - Extract "Affected Areas" / "Files to Modify"
   - Compare with other active instances' `files_affected`
   - Check for file path overlap
4. **Conflict detection logic:**
   ```
   IF overlap in files_affected:
     CONFLICT = true
     NOTIFY user with details
     ASK user for decision
   ELSE:
     CONFLICT = false
     PROCEED with registration
   ```

### 3. Registration Workflow

**If NO conflict detected:**
```
✅ No conflicts detected with active instances.

Registering this instance:
- Brief: BR-007
- Files affected: src/auth/, src/models/user.dart
- Other active: TD-005 (Instance 1, working on test/)

Instance registered. Proceeding with implementation...
```

**If conflict detected:**
```
⚠️  CONFLICT DETECTED

This brief (BR-007) modifies files that overlap with active instances:

Instance 1 (TD-005):
  Files: test/, scripts/*.sh, .github/workflows/test.yml
  Overlap: scripts/*.sh (you also modify scripts/auth_helper.sh)

Recommendation: Wait for Instance 1 to complete, or coordinate changes.

Options:
1. CANCEL - Don't register this instance (recommended)
2. OVERRIDE - Register anyway (risk of merge conflicts)
3. ANALYZE - Show detailed file list for both briefs

Your decision? (1/2/3)
```

### 4. User Decision

**User chooses:**
- `1. CANCEL` → Instance does not register, user coordinates manually
- `2. OVERRIDE` → Instance registers anyway, user accepts conflict risk
- `3. ANALYZE` → Show detailed file comparison, then ask again

### 5. During Work

**Instance behavior:**
- Updates registry periodically (every 10 tasks or phase transition)
- Updates `files_affected` if scope expands
- Other instances re-check registry before major operations

### 6. Completion

**When instance completes brief:**
1. Mark status: "active" → "completed" in registry
2. Add "completed_at" timestamp
3. Move entry to `completed_instances` section (keep for history)
4. Clean up old entries (remove after 24 hours)

**Benefits:**
- ✅ **Automatic conflict detection** - No manual coordination needed
- ✅ **Smart analysis** - Knows which files each brief touches
- ✅ **User control** - User decides on override if needed
- ✅ **Registry history** - Track what instances worked on when
- ✅ **Minimal overhead** - Just read/write JSON file
- ✅ **Git-independent** - Works even without git (useful for testing)

---

## Context & Inputs

### Affected Workflows
- [x] Brief implementation workflow (multi-instance coordination)
- [x] Session management (shared CURRENT_SESSION.md)
- [ ] Brief creation workflow
- [x] Context reset recovery (which brief to resume in which instance)
- [x] Commit process (frequent commits to avoid conflicts)
- [ ] Testing workflow

### Files to Create
- `ai/session/INSTANCE_REGISTRY.json` - Instance ownership and conflict tracking
- `ai/prompts/multi_instance_protocol.md` - Complete protocol documentation
- `docs/MULTI_INSTANCE_WORKFLOW.md` - User guide with examples

### Files to Modify
- `ai/prompts/igris_os.md` - Add Multi-Instance Concurrent Work section with registry checks
- `CLAUDE.md.template` - Add multi-instance awareness during initialization
- `README.md` - Document multi-instance capability
- `ai/CONTRIBUTING.md` - Add guidance for multi-instance development
- Brief templates (BR/TD/MG/TS) - Add "Files to Modify" section for conflict detection

### Dependencies
- [x] Existing process: Brief-First Protocol (must preserve)
- [x] Existing process: Two-Level Session Management (brief + CURRENT_SESSION.md)
- [x] Tool/system: Git (for coordination via pull/push/rebase)
- [x] Documentation: Session Protocol, Brief Workflow

---

## Constraints

### Process Rules
- Must maintain existing single-instance workflow (backward compatible)
- Must not break existing brief management
- Must preserve two-level session tracking (tactical + strategic)
- Must handle git conflicts gracefully
- Should not add excessive overhead for single-instance users

### Technical Constraints
- No external coordination system (use git as coordination layer)
- Must work with standard git workflows (no special tools)
- Must be recoverable after context reset in any instance
- File ownership must be clear and unambiguous

### Timeline
- **Deadline:** N/A (future enhancement)
- **Milestones:**
  1. Design protocol (1-2h)
  2. Document in igris_os.md (2-3h)
  3. Create examples and user guide (3-4h)
  4. Test with concurrent instances (2-3h)

### Out of Scope
- Automatic instance coordination (no daemon/server)
- Real-time instance communication (git-based is sufficient)
- Lock files or complex concurrency primitives
- Cloud-based synchronization (local git only)
- Support for working on SAME brief in multiple instances (forbidden)

---

## Tasks

### Pending
- [ ] Task 1: Design Instance Registry File Format
  - Define JSON schema for INSTANCE_REGISTRY.json
  - Define instance metadata (id, brief_id, files_affected, status)
  - Define conflict detection algorithm (file path overlap)
  - Define lifecycle (register → active → completed → cleanup)

- [ ] Task 2: Implement conflict detection logic
  - Parse brief "Files to Modify" / "Affected Areas" sections
  - Compare file paths between instances (glob pattern matching)
  - Detect overlaps (same file, same directory, glob wildcards)
  - Generate conflict report with overlap details

- [ ] Task 3: Add registry checks to igris_os.md initialization
  - Read INSTANCE_REGISTRY.json on session start
  - If registry exists and has active instances → analyze conflict
  - Display conflict warning or proceed confirmation
  - Implement user decision flow (CANCEL/OVERRIDE/ANALYZE)
  - Register instance after user approval

- [ ] Task 4: Create protocol documentation (ai/prompts/multi_instance_protocol.md)
  - Registry file format specification
  - Conflict detection algorithm
  - Registration workflow
  - Completion workflow
  - Example scenarios (conflict vs no-conflict)

- [ ] Task 5: Update brief templates
  - Add "Files to Modify" section to all templates (BR/TD/MG/TS/PI/FR/DU/PF/AC)
  - Make section mandatory for conflict detection to work
  - Add guidance on listing affected files

- [ ] Task 6: Create user guide (docs/MULTI_INSTANCE_WORKFLOW.md)
  - Step-by-step setup for parallel briefs
  - How conflict detection works
  - What to do when conflict detected
  - Examples: safe parallel work (testing + feature in different files)
  - Examples: unsafe parallel work (both modify same file)

- [ ] Task 7: Update CONTRIBUTING.md with multi-instance guidelines
  - When to use multi-instance (independent briefs)
  - How to ensure brief documents affected files accurately
  - What to do if conflict detected

- [ ] Task 8: Test conflict detection
  - Test 1: No conflict (TD-005 testing, BR-007 auth feature)
  - Test 2: Conflict detected (both modify scripts/igris_init.sh)
  - Test 3: User chooses CANCEL (instance doesn't register)
  - Test 4: User chooses OVERRIDE (instance registers with warning)
  - Test 5: Completion updates registry correctly

- [ ] Task 9: Test registry lifecycle
  - Test instance registration adds entry
  - Test instance completion marks completed
  - Test cleanup removes old entries (>24h)
  - Test recovery after context reset reads registry

- [ ] Task 10: Update README.md
  - Add "Multi-Instance Support" section
  - Show capability and benefits
  - Link to user guide
  - Show conflict detection example

### In Progress
_(Tasks currently being worked on)_

### Completed
_(Finished tasks)_

**Note:** Update this section as you work. Mark tasks in_progress when starting, completed when done. Add timestamps.

---

## Session State (Tactical - This Brief)

**Current State:** Brief registered, ready for implementation
**Next Steps When Resuming:** Start with Task 1 - Design protocol
**Last Updated:** 2025-10-26 18:30
**Blockers:** None

**Note:** Strategic session state (overall plan/phase across multiple briefs) managed in `ai/session/CURRENT_SESSION.md`

---

## Acceptance Criteria

**The process improvement is complete when:**

1. [ ] Protocol document created (ai/prompts/multi_instance_protocol.md)
2. [ ] User guide created (docs/MULTI_INSTANCE_WORKFLOW.md)
3. [ ] igris_os.md updated with multi-instance section
4. [ ] CONTRIBUTING.md includes multi-instance guidelines
5. [ ] README.md documents multi-instance capability
6. [ ] Successfully tested: Two instances working on different briefs simultaneously
7. [ ] Successfully tested: Git conflict resolution in CURRENT_SESSION.md
8. [ ] Successfully tested: Context reset recovery in multi-instance scenario
9. [ ] Documentation includes 3+ real-world examples
10. [ ] No regression: Single-instance workflow still works identically

---

## Verification Plan

### Test New Process

**Scenario 1: Parallel Brief Development**
**Setup:**
1. Start Instance 1, load TD-005 (testing fixes)
2. Start Instance 2, load BR-XXX (new feature)
3. Both instances update CURRENT_SESSION.md to declare ownership

**Expected Result:**
- Both briefs progress independently
- Git conflicts minimal (only on CURRENT_SESSION.md if updating simultaneously)
- Each instance commits to its own files without conflict
- Both instances can recover after context reset

**Old Result:** Not possible - second instance would conflict with first

---

**Scenario 2: Git Conflict Resolution**
**Setup:**
1. Instance 1 updates CURRENT_SESSION.md (marks task complete in TD-005)
2. Instance 2 updates CURRENT_SESSION.md (marks task complete in BR-XXX)
3. Both commit without pulling

**Expected Result:**
- Second instance to push gets conflict
- Conflict resolution merges both updates (both briefs show progress)
- No data loss
- Both instances continue work

**Old Result:** Undefined behavior, likely overwrite or confusion

---

**Scenario 3: Completion Handshake**
**Setup:**
1. Instance 1 completes TD-005 (all tasks done)
2. Instance 2 still working on BR-XXX

**Expected Result:**
- Instance 1 marks TD-005 Done in brief file
- Instance 1 updates CURRENT_SESSION.md (removes TD-005 from active)
- Instance 2 pulls latest, sees TD-005 complete
- Instance 2 continues BR-XXX work
- CURRENT_SESSION.md correctly shows: 1 completed brief, 1 active

**Old Result:** Not defined, manual coordination required

---

### Regression Check
- [ ] Single-instance workflow unchanged (can still work on one brief exclusively)
- [ ] Existing brief commands work identically
- [ ] No new pain points introduced for solo users
- [ ] Documentation clear about when to use multi-instance (optional feature)

---

## Delivery

### Documentation Updates
- [ ] Process documentation: `ai/prompts/multi_instance_protocol.md`
- [ ] Workflow guides: `docs/MULTI_INSTANCE_WORKFLOW.md`
- [ ] Templates: None (existing templates work)
- [ ] README: Add "Multi-Instance Support" section

### Training/Communication
- [ ] Users notified via README and changelog
- [ ] Examples provided in user guide (3+ scenarios)
- [ ] Migration path: N/A (opt-in feature, backward compatible)

---

## Notes

### Implementation Strategy (User-Specified)

**Core idea from Fifty.ai:**

> "Single file where instance declares ownership of brief. Any other instance checks this file and analyzes the brief for conflicts with his own brief. If conflict detected, doesn't register and notifies user. User decides from there."

**Key features:**
1. **Registry file:** `ai/session/INSTANCE_REGISTRY.json` - single source of truth
2. **Automatic analysis:** Parse briefs to extract affected files, compare for overlap
3. **Smart prevention:** Don't register if conflict detected, notify user with details
4. **User control:** User can override if they understand the risk
5. **No manual coordination:** System handles detection automatically

**This approach is superior to manual coordination because:**
- ❌ Manual: "User must remember what other instances are doing"
- ✅ Automatic: "System checks for you and warns before problems occur"

**Example:**
```
Instance 1: Working on TD-005 (modifies test/, scripts/*.sh)
Instance 2: Wants to work on BR-007 (modifies scripts/auth.sh)

System detects overlap: scripts/*.sh vs scripts/auth.sh
System warns: "Conflict detected in scripts/ directory"
User decides: Cancel or override
```

### Architecture Insight

**Why this works:**

Igris AI's two-level session management naturally supports concurrency:

```
┌─────────────────────────────────────────────────┐
│ CURRENT_SESSION.md (STRATEGIC - Shared)         │
│ - Active Briefs: [TD-005, BR-XXX]              │
│ - Which instance owns which                     │
│ - Overall session status                        │
└─────────────────────────────────────────────────┘
         ↓                           ↓
┌──────────────────────┐    ┌──────────────────────┐
│ TD-005.md (TACTICAL) │    │ BR-XXX.md (TACTICAL) │
│ Instance 1 owns this │    │ Instance 2 owns this │
│ - Tasks              │    │ - Tasks              │
│ - Session State      │    │ - Session State      │
└──────────────────────┘    └──────────────────────┘
```

**Key principles:**
1. **Brief files are independent** - no conflict
2. **CURRENT_SESSION.md is shared** - minimal updates, pull-first strategy
3. **Git is the coordination layer** - no special tooling needed
4. **Clear ownership** - one instance per brief

### Before/After Comparison

**Before:**
- Time to complete 2 briefs sequentially: 8 hours (4h each)
- Throughput: 1 brief at a time
- Context switching: Must finish one before starting another

**After:**
- Time to complete 2 briefs in parallel: 4 hours (both running)
- Throughput: 2 briefs simultaneously
- Context switching: Both can run independently
- Git conflicts: **Prevented automatically** via conflict detection
- Conflict detection: < 1 second (read registry, parse briefs, compare files)
- User experience: System warns before problems occur

**ROI:**
- 2x throughput for independent briefs
- Minimal overhead (< 1s per instance start)
- Prevents merge conflicts before they happen
- User stays in control with override option

---

**Created:** 2025-10-26
**Last Updated:** 2025-10-26
**Brief Owner:** Igris AI
