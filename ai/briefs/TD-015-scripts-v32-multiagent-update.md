# TD-015: Update Init/Update Scripts for v3.2 Multi-Agent Architecture

**Type:** Technical Debt
**Priority:** P1-High
**Effort:** S-Small (< 1d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2025-12-03

---

## What is the Technical Debt?

**Current situation:**

The `igris_init.sh` and `igris_update.sh` scripts are outdated for v3.2:

1. **Hook system functions** (~115 lines) defined but never called - dead code from LangChain/LangGraph era
2. **Missing `.claude/agents/`** - v3.2 uses 12 native subagents, not copied during init/update
3. **CONTRIBUTING.md copy** - No longer needed (file is in root, not distributed)
4. **Outdated messages** - Reference deleted prompts (`generate_coding_guidelines.md`, etc.)

**Why is it technical debt?**

- Dead code (hook functions) adds confusion
- New projects don't get native subagents
- Update script doesn't update agent definitions
- Getting Started messages reference non-existent files

---

## Why It Matters

**Consequences of not fixing:**

- [x] **Maintainability:** Dead code confuses future developers
- [x] **Developer Experience:** New projects missing v3.2 capabilities
- [x] **Readability:** Outdated messages cause confusion
- [ ] **Performance:** N/A
- [ ] **Security:** N/A

**Impact:** High - blocks v3.2 distribution

---

## Cleanup Steps

### Phase 1: Update igris_init.sh

1. [ ] Remove hook system functions (lines 216-332)
   - `resolve_hooks()` function
   - `execute_hook()` function
   - Related comments

2. [ ] Remove CONTRIBUTING.md copy (line 57-58)

3. [ ] Add `.claude/agents/` copy after `.claude/hooks/` setup:
   ```bash
   echo "🤖 Installing native subagents..."
   mkdir -p .claude/agents
   cp "$IGRIS_DIR/.claude/agents/"*.md .claude/agents/
   cp "$IGRIS_DIR/.claude/agents/manifest.yaml" .claude/agents/
   ```

4. [ ] Update "Getting Started" messages (lines 503-517):
   - Remove references to deleted prompts
   - Add DIGIVOLVE command reference
   - Add native subagent commands (STANDARDIZE, etc.)

5. [ ] Update success output to mention:
   - 12 native subagents installed
   - `.claude/agents/` directory

### Phase 2: Update igris_update.sh

6. [ ] Remove CONTRIBUTING.md from backup section
7. [ ] Remove CONTRIBUTING.md from update section
8. [ ] Add `.claude/agents/` to backup section
9. [ ] Add `.claude/agents/` update logic
10. [ ] Update "Files that will be updated" message
11. [ ] Update dry-run output to list agents

---

## Tasks

### Pending
- [ ] Task 1: Remove hook system functions from igris_init.sh
- [ ] Task 2: Remove CONTRIBUTING.md copy from igris_init.sh
- [ ] Task 3: Add .claude/agents/ copy to igris_init.sh
- [ ] Task 4: Update Getting Started messages in igris_init.sh
- [ ] Task 5: Remove CONTRIBUTING.md refs from igris_update.sh
- [ ] Task 6: Add .claude/agents/ backup/update to igris_update.sh
- [ ] Task 7: Update messages in igris_update.sh

### In Progress
_(none)_

### Completed
_(none)_

---

## Workflow State

**Phase:** READY
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief created, ready for implementation.

### Next Steps
Start Phase 1: Update igris_init.sh

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2025-12-03 | orchestrator | Created brief | Success |

### Blockers
None

---

## Affected Files

### Files to UPDATE (2)
- `scripts/igris_init.sh`
- `scripts/igris_update.sh`

### Lines Changed Estimate
- `igris_init.sh`: -115 lines (hooks), -1 line (CONTRIBUTING), +5 lines (agents), +15 lines (messages)
- `igris_update.sh`: -3 lines (CONTRIBUTING), +7 lines (agents), +5 lines (messages)

**Net:** ~90 lines removed

---

## Acceptance Criteria

**The debt is paid off when:**

1. [ ] Hook system functions removed from igris_init.sh
2. [ ] CONTRIBUTING.md copy removed from both scripts
3. [ ] `.claude/agents/` copied during init
4. [ ] `.claude/agents/` backed up and updated during update
5. [ ] Getting Started messages reference v3.2 commands
6. [ ] No references to deleted prompts
7. [ ] Scripts tested and working

---

## Testing

### Verification Steps
1. Run `igris_init.sh` in test directory
2. Verify `.claude/agents/` exists with 12 agent files + manifest
3. Verify no CONTRIBUTING.md copied
4. Run `igris_update.sh --dry-run`
5. Verify agents listed in update output

---

## References

**Related Briefs:**
- TD-014: Prompts Restructure - Subagent Integration (completed)
- MG-004: Igris v3.1 Migration (completed)

**Files:**
- `.claude/agents/manifest.yaml` - Agent registry

---

**Created:** 2025-12-03
**Last Updated:** 2025-12-03
**Brief Owner:** Fifty.ai
