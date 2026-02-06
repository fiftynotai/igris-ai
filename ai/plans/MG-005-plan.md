# Implementation Plan: MG-005 Skills Migration

**Brief:** MG-005
**Created:** 2026-02-06
**Complexity:** L (Large)
**Estimated Duration:** 3-5 days
**Risk Level:** Medium

---

## Summary

Migrate 7 Igris commands (HUNT, SCAN, REGISTER, ARCHIVE, REST, AWAKEN, DIGIVOLVE) from text-based trigger phrases in `igris_os.md` to native Claude Code skills with `/skill-name` invocation, proper frontmatter, supporting files, and dynamic context injection.

---

## SKILL.md Frontmatter Specification

```yaml
---
name: skill-name
description: Brief description (appears in autocomplete)
disable-model-invocation: true    # User-triggered only
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Task                           # For subagent delegation
triggers:                          # Backward-compatible trigger phrases
  - "old trigger phrase"
context: default | fork            # fork for isolated execution
---
```

### Dynamic Context Injection

- `!`git status`` - Current git state
- `!`cat ai/session/CURRENT_SESSION.md`` - Session state
- `!`cat ai/briefs/$ARGUMENTS*.md`` - Specific brief content

---

## Implementation Phases

### Phase 1: Directory Structure and Simple Skills (Day 1)

| Skill | Purpose | Complexity |
|-------|---------|------------|
| `/scan` | Status report | Simple |
| `/rest` | Pause/end session | Simple |
| `/awaken` | Start/resume session | Simple |

**Creates:**
- `.claude/skills/scan/SKILL.md`
- `.claude/skills/rest/SKILL.md`
- `.claude/skills/awaken/SKILL.md`

---

### Phase 2: Brief Management Skills (Day 2)

| Skill | Purpose | Complexity |
|-------|---------|------------|
| `/register` | Create brief | Medium |
| `/archive` | Archive completed brief | Simple |

**Creates:**
- `.claude/skills/register/SKILL.md`
- `.claude/skills/register/templates/*.md` (9 templates)
- `.claude/skills/archive/SKILL.md`

---

### Phase 3: HUNT Skill - Complex Workflow (Days 3-4)

**The most complex skill** - full autonomous workflow with subagent delegation.

| Feature | Implementation |
|---------|---------------|
| `context: fork` | Isolated execution |
| Workflow state machine | INIT → PLANNING → APPROVAL → BUILDING → TESTING → REVIEWING → COMMITTING → COMPLETE |
| Subagent delegation | Task tool with planner, coder, tester, reviewer |
| Self-healing | debugger on test failures (retry < 3) |

**Creates:**
- `.claude/skills/hunt/SKILL.md`
- `.claude/skills/hunt/workflow-template.md`
- `.claude/skills/hunt/scripts/validate-brief.sh`

---

### Phase 4: DIGIVOLVE Skill - Agent Management (Day 4)

| Subcommand | Action |
|------------|--------|
| `status` | Show agent roster with metrics |
| `add {name}` | Create custom agent |
| `upgrade {name}` | Enhance capabilities |
| `disable/enable {name}` | Toggle agent |
| `remove {name}` | Delete custom agent |
| `reset {name}` | Restore defaults |

**Creates:**
- `.claude/skills/digivolve/SKILL.md`
- `.claude/skills/digivolve/agent-roster.md`

---

### Phase 5: Testing and Documentation (Day 5)

| Test | Command | Expected |
|------|---------|----------|
| Scan | `/scan` | Full status report |
| Scan filtered | `/scan P0` | Only P0 items |
| Rest | `/rest` | Saves session, REST MODE |
| Awaken | `/awaken` | Loads session, resume point |
| Register | `/register bug "Test"` | Creates BR-XXX |
| Archive | `/archive MG-006` | Moves to archive |
| Hunt | `/hunt BR-008` | Full workflow |
| Digivolve | `/digivolve status` | Agent roster |

---

## Files Summary

| Category | Count | Files |
|----------|-------|-------|
| SKILL.md files | 7 | scan, rest, awaken, register, archive, hunt, digivolve |
| Templates | 9 | br, mg, td, fr, pi, ts, du, pf, ac |
| Scripts | 1 | validate-brief.sh |
| Documentation | 2 | CLAUDE.md, igris_os.md updates |
| **Total** | **19** | |

---

## Acceptance Criteria

1. [ ] All 7 Igris commands available as `/skill-name`
2. [ ] Each skill has proper frontmatter with descriptions
3. [ ] `/hunt {brief_id}` triggers full autonomous workflow
4. [ ] `/register {type}` creates brief with correct template
5. [ ] `/scan` displays formatted status report
6. [ ] Skills appear in Claude Code autocomplete
7. [ ] Old trigger phrases still work (backward compat)
8. [ ] Documentation updated

---

**Plan Status:** AWAITING APPROVAL
**Approval Required:** Yes (L/XL complexity)
