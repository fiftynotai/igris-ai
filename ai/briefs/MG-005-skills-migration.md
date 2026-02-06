# MG-005: Skills Migration — Igris Commands to Native Skills

**Type:** Migration
**Priority:** P1-High
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-02-05
**Completed:** _(pending)_

---

## Current State

**What's the problem with the current implementation?**

Igris commands (HUNT, SCAN, REGISTER, ARCHIVE, REST, DIGIVOLVE, AWAKEN) are defined as text instructions inside CLAUDE.md and igris_os.md. They rely on Claude parsing natural language trigger phrases and following embedded workflows. There is no structured command system — Claude must pattern-match user input against documented phrases.

Problems:
- Commands are not discoverable (user must know the exact phrases)
- No autocomplete or `/slash-command` support
- Command logic is buried in massive markdown files
- No isolation — commands run in main conversation context
- No supporting files (templates, scripts) bundled with commands
- No dynamic context injection (must manually read files)

**Why does it need to change?**

Claude Code's Skills system provides native infrastructure for everything Igris commands need:
- `/skill-name` invocation with autocomplete
- Own directories with supporting files
- `$ARGUMENTS` for parameter passing (e.g., `/hunt BR-008`)
- `context: fork` for isolated execution
- `!`command`` for dynamic context injection (git status, brief content)
- Hooks scoped to skill lifecycle
- `disable-model-invocation` to prevent accidental triggers

---

## Target State

**What should it look like after migration?**

```
.claude/skills/
├── hunt/
│   ├── SKILL.md              # HUNT workflow - implement brief
│   ├── workflow-template.md   # Workflow state machine reference
│   └── scripts/
│       └── validate-brief.sh  # Verify brief exists before starting
├── scan/
│   ├── SKILL.md              # SCAN - show status/report
│   └── report-template.md    # Report formatting template
├── register/
│   ├── SKILL.md              # REGISTER - create brief
│   └── templates/
│       ├── br-template.md     # Bug report template
│       ├── fr-template.md     # Feature request template
│       ├── td-template.md     # Technical debt template
│       └── mg-template.md     # Migration template
├── archive/
│   └── SKILL.md              # ARCHIVE - archive completed brief
├── rest/
│   └── SKILL.md              # REST - pause/end session
├── awaken/
│   └── SKILL.md              # AWAKEN - start/resume session
└── digivolve/
    ├── SKILL.md              # DIGIVOLVE - agent management
    └── agent-roster.md        # Agent status display template
```

Each skill:
- Invocable via `/hunt BR-008`, `/scan`, `/register bug`, etc.
- Has `disable-model-invocation: true` (user-triggered only)
- Uses `$ARGUMENTS` for brief IDs and parameters
- Injects dynamic context via `!`commands``
- Can run in forked context where appropriate

---

## Migration Steps

1. [ ] Create `.claude/skills/` directory structure
2. [ ] Migrate HUNT command to `/hunt` skill with workflow template
3. [ ] Migrate SCAN command to `/scan` skill with report template
4. [ ] Migrate REGISTER command to `/register` skill with brief templates
5. [ ] Migrate ARCHIVE command to `/archive` skill
6. [ ] Migrate REST command to `/rest` skill
7. [ ] Migrate AWAKEN command to `/awaken` skill
8. [ ] Migrate DIGIVOLVE command to `/digivolve` skill
9. [ ] Create validation scripts for skills that need them
10. [ ] Test all skills with real brief operations
11. [ ] Update CLAUDE.md/igris_os.md to reference skills instead of trigger phrases
12. [ ] Document skill usage in README

---

## Tasks

### Pending
- [ ] Task 1: Design SKILL.md frontmatter for each command
- [ ] Task 2: Create skill directories and SKILL.md files
- [ ] Task 3: Move brief templates into register skill directory
- [ ] Task 4: Create validation scripts (brief existence, status checks)
- [ ] Task 5: Test each skill end-to-end
- [ ] Task 6: Remove old command definitions from CLAUDE.md/igris_os.md

### In Progress
_(none)_

### Completed
_(none)_

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered. Awaiting implementation.

### Next Steps
Design skill frontmatter specifications for each Igris command.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
None (soft dependency on MG-004 for clean CLAUDE.md, but can proceed independently)

---

## Impact Assessment

### Affected Files
- [ ] `.claude/skills/*/SKILL.md` - New skill files (7 skills)
- [ ] `CLAUDE.md` - Remove command definitions, reference skills
- [ ] `ai/prompts/igris_os.md` - Remove command trigger phrases
- [ ] `ai/briefs/*-TEMPLATE.md` - Move copies into register skill

### Affected Modules
- [ ] `Command system` - Complete replacement with skills
- [ ] `Brief management` - REGISTER, ARCHIVE operations
- [ ] `Session management` - AWAKEN, REST operations
- [ ] `Workflow orchestration` - HUNT operation
- [ ] `Agent management` - DIGIVOLVE operation

### Breaking Changes
- [x] **Yes** - Old trigger phrases (e.g., "HUNT BR-008") may still work via skill descriptions, but primary invocation becomes `/hunt BR-008`

### Dependencies
- [ ] Depends on: MG-004 (recommended but not blocking)
- [ ] Blocks: None

---

## Testing Strategy

### Manual Testing

#### Test Case 1: /hunt Skill
**Steps:**
1. Run `/hunt BR-008` in Claude Code
2. Verify brief is loaded and workflow initiates
3. Verify subagent delegation works

**Expected:** Full HUNT workflow executes with plan → build → test → review → commit
**Status:** [ ] Pass / [ ] Fail

#### Test Case 2: /register Skill
**Steps:**
1. Run `/register bug` with description
2. Verify brief file created with correct template
3. Verify next available number assigned

**Expected:** New brief registered with correct format
**Status:** [ ] Pass / [ ] Fail

#### Test Case 3: /scan Skill
**Steps:**
1. Run `/scan` with no arguments
2. Run `/scan P0` for filtered view

**Expected:** Formatted status report displayed
**Status:** [ ] Pass / [ ] Fail

---

## Rollback Plan

1. Remove `.claude/skills/` directory
2. Restore command definitions in CLAUDE.md/igris_os.md from git

**Rollback safe until:** Merged to main

---

## Acceptance Criteria

1. [ ] All 7 Igris commands available as `/skill-name` in Claude Code
2. [ ] Each skill has proper frontmatter with descriptions
3. [ ] `/hunt {brief_id}` triggers full autonomous workflow
4. [ ] `/register {type}` creates brief with correct template
5. [ ] `/scan` displays formatted status report
6. [ ] Skills appear in Claude Code autocomplete
7. [ ] Old trigger phrases still work via skill descriptions (backward compat)
8. [ ] Documentation updated

---

## References

**External References:**
- Claude Code Skills Docs: https://code.claude.com/docs/en/skills
- SKILL.md frontmatter reference
- $ARGUMENTS substitution syntax
- `context: fork` for isolated execution

**Related Briefs:**
- Depends on: MG-004 (Memory Architecture) - recommended
- Related: MG-006 (Hooks), MG-007 (Native Agents)

---

## Notes

The HUNT skill is the most complex — it orchestrates the full workflow state machine with subagent delegation. Consider using `context: fork` with `agent: general-purpose` for HUNT to keep the workflow isolated from main conversation context.

---

**Created:** 2026-02-05
**Last Updated:** 2026-02-05
**Brief Owner:** Crimson (Fifty.ai)
