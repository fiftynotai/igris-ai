# MG-006: Hooks Integration — Automated Session & Quality Management

**Type:** Migration
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-05
**Completed:** 2026-02-05

---

## Current State

**What's the problem with the current implementation?**

Igris AI relies entirely on CLAUDE.md instructions for:
- Session state loading (manual "read CURRENT_SESSION.md on first message")
- Brief-first protocol enforcement (manual "check for brief before file modifications")
- Session saving (manual "update CURRENT_SESSION.md as you progress")
- Agent metrics tracking (ad-hoc, inconsistent)
- Quality gate enforcement (relies on Claude remembering to lint/test)

These are all manual, instruction-based behaviors that fail when:
- Context resets occur (Claude forgets the instructions)
- Context compaction drops the instructions
- Claude simply doesn't follow the verbose rules

**Why does it need to change?**

Claude Code's Hooks system provides **automated, code-enforced** lifecycle events that fire regardless of context state. Hooks cannot be forgotten or skipped — they execute at the system level.

---

## Target State

**What should it look like after migration?**

```
.claude/
├── settings.json              # Hook definitions
└── hooks/
    ├── session-start.sh       # Auto-load session state on start
    ├── session-end.sh         # Auto-save session state on end
    ├── pre-compact.sh         # Preserve critical state before compaction
    ├── brief-gate.sh          # Enforce brief-first before file writes
    ├── post-edit-lint.sh      # Auto-lint after file edits
    ├── agent-metrics.sh       # Track subagent invocations
    ├── stop-verify.sh         # Verify session saved before stopping
    └── prompt-context.sh      # Inject session context on user prompt
```

### Hook Configuration (.claude/settings.json)

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh"
      }]
    }],
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-end.sh"
      }]
    }],
    "PreCompact": [{
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/pre-compact.sh"
      }]
    }],
    "PreToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/brief-gate.sh"
      }]
    }],
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/post-edit-lint.sh",
        "async": true
      }]
    }],
    "SubagentStart": [{
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-metrics.sh",
        "async": true
      }]
    }],
    "SubagentStop": [{
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/agent-metrics.sh",
        "async": true
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "prompt",
        "prompt": "Check if the session state in ai/session/CURRENT_SESSION.md has been updated with current work. Context: $ARGUMENTS. If session state is stale or missing recent work, respond with {\"ok\": false, \"reason\": \"Update CURRENT_SESSION.md before stopping\"}. Otherwise {\"ok\": true}."
      }]
    }]
  }
}
```

---

## Migration Steps

1. [ ] Create `.claude/hooks/` directory
2. [ ] Implement `session-start.sh` — reads CURRENT_SESSION.md, outputs additionalContext
3. [ ] Implement `session-end.sh` — updates CURRENT_SESSION.md status to REST MODE
4. [ ] Implement `pre-compact.sh` — outputs critical session state as additionalContext
5. [ ] Implement `brief-gate.sh` — checks for active brief before allowing Write/Edit
6. [ ] Implement `post-edit-lint.sh` — runs linter async after file edits
7. [ ] Implement `agent-metrics.sh` — logs SubagentStart/Stop to metrics file
8. [ ] Configure Stop hook (prompt-based) for session save verification
9. [ ] Add hook config to `.claude/settings.json`
10. [ ] Test each hook in isolation
11. [ ] Test full session lifecycle with all hooks active
12. [ ] Update igris_os.md to document hook-based automation

---

## Tasks

### Pending
- [ ] Task 1: Design hook scripts with proper JSON input/output handling
- [ ] Task 2: Implement session lifecycle hooks (start, end, pre-compact)
- [ ] Task 3: Implement quality gate hooks (brief-gate, post-edit-lint)
- [ ] Task 4: Implement agent tracking hooks (metrics)
- [ ] Task 5: Configure .claude/settings.json with all hooks
- [ ] Task 6: End-to-end testing

### In Progress
_(none)_

### Completed
_(none)_

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
Implementation complete. Merged to develop.

### Next Steps
Ready for archive. Remaining migrations: MG-004 → MG-005 → MG-007.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-05 | ARCHITECT | Implementation planning | Plan complete (M complexity, 9 files, 7 phases) |
| 2026-02-05 | FORGER | Initial implementation | 7 scripts + settings.json created |
| 2026-02-05 | SENTINEL | Validation | FAIL — grep -oP not macOS compatible, brief pattern mismatch |
| 2026-02-05 | FORGER | Bug fixes | Fixed macOS compat (grep -oP → sed), brief patterns |
| 2026-02-05 | SENTINEL | Re-validation | PASS — all issues fixed |
| 2026-02-05 | WARDEN | Code review | APPROVE — 9/10 quality, all criteria met |

### Blockers
None

---

## Impact Assessment

### Affected Files
- [ ] `.claude/settings.json` - Hook configuration
- [ ] `.claude/hooks/*.sh` - New hook scripts (7-8 scripts)
- [ ] `ai/prompts/igris_os.md` - Document hook-based automation
- [ ] `CLAUDE.md` - Remove manual session loading instructions

### Affected Modules
- [ ] `Session management` - Automated via SessionStart/SessionEnd hooks
- [ ] `Quality enforcement` - Automated via PreToolUse/PostToolUse hooks
- [ ] `Agent tracking` - Automated via SubagentStart/Stop hooks
- [ ] `Context persistence` - Automated via PreCompact hook

### Breaking Changes
- [ ] **No** - Hooks add automation alongside existing instructions; can coexist

### Dependencies
- [ ] Depends on: None (can implement independently)
- [ ] Blocks: None
- [ ] Enhanced by: MG-004 (cleaner CLAUDE.md after migration)

---

## Testing Strategy

### Manual Testing

#### Test Case 1: Session Auto-Load
**Steps:**
1. Start new Claude Code session
2. Check if session state is auto-injected

**Expected:** CURRENT_SESSION.md content appears as context without manual prompt
**Status:** [ ] Pass / [ ] Fail

#### Test Case 2: Brief-First Gate
**Steps:**
1. Attempt to write/edit a file without an active brief
2. Verify hook blocks the action

**Expected:** Write/Edit denied with message to create brief first
**Status:** [ ] Pass / [ ] Fail

#### Test Case 3: Session Auto-Save on End
**Steps:**
1. Work on a brief during session
2. Exit session
3. Check CURRENT_SESSION.md

**Expected:** Session status updated to REST MODE with last work summary
**Status:** [ ] Pass / [ ] Fail

#### Test Case 4: Context Compaction Preservation
**Steps:**
1. Work until context compaction triggers
2. Verify critical state preserved

**Expected:** Session state and active brief context survive compaction
**Status:** [ ] Pass / [ ] Fail

---

## Rollback Plan

1. Remove `.claude/hooks/` directory
2. Remove hook config from `.claude/settings.json`
3. Manual session management instructions remain in CLAUDE.md as fallback

**Rollback safe until:** Merged to main

---

## Acceptance Criteria

1. [ ] Session state auto-loads on every session start (no manual reading)
2. [ ] Session state auto-saves on session end
3. [ ] Brief-first protocol enforced via PreToolUse hook (Write/Edit blocked without brief)
4. [ ] Agent metrics tracked automatically on SubagentStart/Stop
5. [ ] Context compaction preserves critical session state
6. [ ] Stop hook verifies session state is current
7. [ ] All hooks handle errors gracefully (non-blocking on failure)
8. [ ] Hook scripts are portable (bash, no exotic dependencies)

---

## References

**External References:**
- Claude Code Hooks Reference: https://code.claude.com/docs/en/hooks
- Hook events: SessionStart, SessionEnd, PreCompact, PreToolUse, PostToolUse, SubagentStart, SubagentStop, Stop
- Prompt-based hooks for LLM evaluation
- Async hooks for non-blocking operations
- CLAUDE_ENV_FILE for environment variable persistence

**Related Briefs:**
- Enhanced by: MG-004 (Memory Architecture)
- Complements: MG-005 (Skills can define scoped hooks)
- Related: MG-007 (Native Agents can define per-agent hooks)

---

## Notes

Start with `session-start.sh` — it has the highest immediate impact on session recovery. The `brief-gate.sh` is the second highest priority as it enforces the core Igris protocol automatically.

The Stop hook uses `type: "prompt"` (LLM evaluation) rather than a shell script, since it needs to reason about whether session state is current.

---

**Created:** 2026-02-05
**Last Updated:** 2026-02-05
**Brief Owner:** Crimson (Fifty.ai)
