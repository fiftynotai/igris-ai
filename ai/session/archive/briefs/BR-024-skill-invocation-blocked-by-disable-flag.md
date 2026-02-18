# BR-024: Skills Cannot Be Invoked via Skill Tool Due to disable-model-invocation Flag

**Type:** Bug Fix
**Priority:** P0-Critical
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-18
**Completed:** 2026-02-18

---

## Problem

**What's broken or missing?**

All 20 Igris skills have `disable-model-invocation: true` set in their SKILL.md frontmatter. This prevents Claude Code's Skill tool from invoking them programmatically. When the orchestrator (or user via slash command) tries to invoke a skill using the Skill tool, it fails with:

```
Error: Skill ideate cannot be used with Skill tool due to disable-model-invocation
```

This affects ALL 20 skills:
- awaken, rest, scan, hunt, register, archive
- digivolve, document, standardize, ideate, migrate-analyze, audit
- release, ui-design, higgsfield, team
- projects, portfolio, dashboard, sync

**Why does it matter?**

- Skills are a core v4.0 feature (20 slash commands)
- The orchestrator cannot delegate to skills as designed in igris_os.md
- Users cannot invoke skills through natural language ("call ideator", "run audit")
- Only direct `/command` invocation works, breaking the conversational UX
- This is a regression from the intended design where skills are invokable by the model

---

## Goal

**What should happen after this brief is completed?**

All 20 skills should be invocable via the Skill tool when the user requests them. Change `disable-model-invocation: true` to `disable-model-invocation: false` (or remove the flag entirely) across all SKILL.md files.

---

## Context & Inputs

### Affected Modules
- [x] .claude/skills/ (all 20 SKILL.md files)

### Layers Touched
- [x] Configuration (SKILL.md frontmatter)

### API Changes
- [x] No API changes

### Dependencies
- None

### Related Files
- .claude/skills/ideate/SKILL.md
- .claude/skills/hunt/SKILL.md
- .claude/skills/scan/SKILL.md
- .claude/skills/awaken/SKILL.md
- .claude/skills/rest/SKILL.md
- (and all other 15 SKILL.md files)

---

## Constraints

### Architecture Rules
- Must preserve all other SKILL.md content unchanged
- Only modify the `disable-model-invocation` field

### Technical Constraints
- Simple find-and-replace across 20 files
- No behavioral changes to skill logic

### Timeline
- **Deadline:** Before v4.0 publish

### Out of Scope
- Skill logic changes
- New skill creation

---

## Tasks

### Pending
- [ ] Task 1: Change `disable-model-invocation: true` to `disable-model-invocation: false` in all 20 SKILL.md files
- [ ] Task 2: Verify at least 3 skills can be invoked via Skill tool after fix
- [ ] Task 3: Commit with conventional format

### In Progress

### Completed

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
All tasks complete. Brief done.

### Next Steps
Archive brief with `/archive BR-024`.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-18 | architect | Create implementation plan | SUCCESS |
| 2026-02-18 | forger | Modify 20 SKILL.md files | SUCCESS (20/20 changed) |
| 2026-02-18 | sentinel | Verify all SKILL.md files | PASS (21/21 correct) |
| 2026-02-18 | warden | Code review | APPROVE |
| 2026-02-18 | /document | Documentation check | Skipped — config-only fix |
| 2026-02-18 | — | Commit d6ced58 | SUCCESS |

### Blockers
None

---

## Acceptance Criteria

**The fix is complete when:**

1. [ ] All 20 SKILL.md files have `disable-model-invocation: false` (or flag removed)
2. [ ] `/ideate` can be invoked via Skill tool without error
3. [ ] `/hunt` can be invoked via Skill tool without error
4. [ ] `/scan` can be invoked via Skill tool without error
5. [ ] Linter/analyzer passes (zero issues)
6. [ ] Commit with conventional format

---

## Test Plan

### Manual Test Cases

#### Test Case 1: Invoke /ideate via Skill Tool
**Steps:**
1. Ask Claude to "call the ideator"
2. Observe Skill tool invocation

**Expected Result:** Skill loads and executes without error
**Status:** [ ] Pass / [ ] Fail

#### Test Case 2: Invoke /hunt via Skill Tool
**Steps:**
1. Ask Claude to "hunt BR-024"
2. Observe Skill tool invocation

**Expected Result:** Skill loads and executes without error
**Status:** [ ] Pass / [ ] Fail

---

## Delivery

### Code Changes
- [ ] Modified files: 20 SKILL.md files in .claude/skills/*/

### Documentation Updates
- None needed

---

## Notes

The `disable-model-invocation` flag was likely set as a safety measure during development to prevent unintended skill execution. Now that skills are stable and part of the v4.0 release, they should be model-invocable for full conversational UX.

---

**Created:** 2026-02-18
**Last Updated:** 2026-02-18
**Brief Owner:** Crimson
