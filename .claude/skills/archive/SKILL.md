---
name: archive
description: Archive a completed brief - usage: /archive BR-008
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - mcp__igris-brain__igris_brief_sync
triggers:
  - "ARCHIVE"
  - "archive brief"
  - "move to archive"
  - "archive completed"
---

# ARCHIVE - Archive Completed Brief

Move a completed brief to the archive directory.

## Usage

```
/archive BR-008
/archive MG-004
```

## Arguments

`$ARGUMENTS` should be a brief ID (e.g., BR-008, MG-004, TD-005).

## Execution

### 0. Track Invocation
Silently emit a skill invocation event (never blocks execution):
```bash
bash "$CLAUDE_PROJECT_DIR/scripts/emit_skill_event.sh" "archive" 2>/dev/null || true
```

### 1. Find Brief File

Search `ai/briefs/` for file matching `$ARGUMENTS`:
```
ai/briefs/*{$ARGUMENTS}*.md
```

If not found, display error and available briefs.

### 2. Verify Status

Read the brief file and check Status field.

**If Status != "Done":**
```
Cannot archive {BRIEF_ID}

Current Status: [In Progress | Ready | Draft | In Review]
Reason: Only briefs with Status: "Done" can be archived

To mark as Done: "Mark {BRIEF_ID} as Done"
```
Exit without archiving.

### 3. Create Archive Directory

Ensure `ai/session/archive/briefs/` exists.
Create if missing.

### 4. Move Brief File

Move from `ai/briefs/{BRIEF_ID}-*.md` to `ai/session/archive/briefs/`.

### 5. Update Session History

Edit `ai/session/CURRENT_SESSION.md` to add to completed briefs list (if applicable).

### 6. Sync Status to Brain

If the `igris-brain` MCP server is available, call `igris_brief_sync` with:
- **project:** current project slug (derive from directory name or brain registry)
- **brief_id:** the archived brief ID (e.g., "BR-008")
- **brief_type:** type from the brief (feature, bug, tech_debt, etc.)
- **title:** the brief title
- **status:** "Archived"
- **priority:** the brief's priority
- **effort:** the brief's effort
- **phase:** "COMPLETE"

If brain MCP is not available, skip silently. No errors.

### 7. Confirm Archive

Display:
```
Archived: {BRIEF_ID}

Moved from: ai/briefs/{filename}
Moved to: ai/session/archive/briefs/{filename}

Status: Done
Completed: [date from brief]
[Brief summary if available]
```
