---
name: scan
description: Show system status report - briefs, session, blockers, git status
disable-model-invocation: true
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
triggers:
  - "SCAN"
  - "REPORT"
  - "show status"
  - "show brief status"
  - "show bug status report"
  - "show feature status report"
  - "brief overview"
---

# SCAN - System Status Report

Display comprehensive status of the Igris AI system.

## Arguments

`$ARGUMENTS` can optionally filter results:
- Empty: Full status report
- `P0` or `P1`: Filter by priority
- `bugs` or `features`: Filter by type

## Execution

### 1. Load Session State

Read `ai/session/CURRENT_SESSION.md` for:
- Current session mode (Active/REST MODE)
- Active briefs
- Resume point

### 2. Scan Briefs

Read all files in `ai/briefs/` (exclude templates):
- Count by status (Ready, In Progress, Done, Draft)
- Count by priority (P0, P1, P2, P3)
- Apply filter if `$ARGUMENTS` provided

### 3. Check Blockers

Read `ai/session/BLOCKERS.md`:
- Count active blockers (not in Resolved section)
- Flag critical blockers

### 4. Agent Count

Count `.claude/agents/*.md` files to get current agent count.

### 5. Git Status

Run: `git status --short`

### 5.5. Query Brain Stats (Optional)

If the `igris-brain` MCP server is available:
- Call `igris_project_status` for the current project slug
- Get learning count, error count, recent metrics

If brain MCP is not available, skip this step silently. No errors, no warnings.

### 6. Display Report

Format as:

```
## System Status Report

### Session
- Mode: [Active | REST MODE]
- Active Brief: [ID or None]
- Resume Point: [description]

### Briefs Inventory
| Status | Count |
|--------|-------|
| Ready | X |
| In Progress | X |
| Done | X |
| Draft | X |

[If filtered: "Showing: P0 only" or "Showing: bugs only"]

### Priority Distribution
- P0 (Critical): X briefs
- P1 (High): X briefs
- P2 (Medium): X briefs
- P3 (Low): X briefs

### Agents
X agents registered (Y skills available)

### Blockers
[None | X active (Y critical)]

### Git Status
[Clean | X uncommitted files]

### Brain (if connected)
- Learnings: X (Y global)
- Errors cataloged: Z
- Cross-project patterns: N available
- Last brain sync: [timestamp]

### Recommendations
1. [Primary recommendation]
2. [Secondary recommendation]
```
