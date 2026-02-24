---
name: register
description: Create a new brief - usage: /register bug|feature|migration|debt "title"
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Glob
  - mcp__igris-brain__igris_brief_sync
  - mcp__igris-brain__igris_brief_create
  - mcp__igris-brain__igris_brief_list
triggers:
  - "REGISTER"
  - "register a bug"
  - "register a feature"
  - "create a brief"
  - "add to queue"
  - "register bug"
  - "register feature"
  - "register migration"
  - "register debt"
---

# REGISTER - Create New Brief

Register a new brief for tracking bugs, features, migrations, or technical debt.

## Usage

```
/register bug "Title of the bug"
/register feature "Title of the feature"
/register migration "Title of migration"
/register debt "Title of technical debt"
```

Or without type (will prompt):
```
/register "Brief title"
```

## Arguments

`$ARGUMENTS` format: `[type] "title"` or just `"title"`

Types and their prefixes:
- `bug` or `feature` → BR-XXX
- `migration` → MG-XXX
- `debt` → TD-XXX
- `testing` → TS-XXX
- `process` → PI-XXX
- `request` → FR-XXX
- `dependency` → DU-XXX
- `performance` → PF-XXX
- `architecture` → AC-XXX

## Execution

### 0. Track Invocation
Silently emit a skill invocation event (never blocks execution):
```bash
bash "$CLAUDE_PROJECT_DIR/scripts/emit_skill_event.sh" "register" 2>/dev/null || true
```

### 1. Parse Arguments

Extract type and title from `$ARGUMENTS`.
If type not specified, ask user which type.

### 2. Determine Prefix

Map type to brief prefix:
| Type | Prefix |
|------|--------|
| bug, feature | BR |
| migration | MG |
| debt | TD |
| testing | TS |
| process | PI |
| request | FR |
| dependency | DU |
| performance | PF |
| architecture | AC |

### 3. Find Next Available Number

Call `igris_brief_list` to find next available number, fallback to cache glob at `~/.igris/cache/{project}/briefs/`.
Find highest number, add 1.
Example: If BR-007 exists, next is BR-008.

### 4. Read Template

Read template from `ai/templates/{PREFIX}-TEMPLATE.md`.
Fallback to `ai/templates/BR-TEMPLATE.md` if specific template not found.

### 5. Create Brief File

Call `igris_brief_create` with project, brief_id, content, metadata. If MCP unavailable, write to `~/.igris/cache/{project}/briefs/{PREFIX}-{XXX}-{slug}.md`:
- Fill in title from arguments
- Set Status: Ready (or Draft if info incomplete)
- Set Priority: P2 (default, can be changed)
- Set Created date: today
- Leave other fields for user to complete

### 6. Handle P0/P1 Priority

If user specifies P0 or P1 priority, also add entry to `~/.igris/cache/{project}/session/BLOCKERS.md`.

### 7. Sync Brief to Brain

If the `igris-brain` MCP server is available, call `igris_brief_sync` with:
- **project:** current project slug (derive from directory name or brain registry)
- **brief_id:** the new brief ID (e.g., "FR-031")
- **brief_type:** type from the brief (feature, bug, tech_debt, migration, testing, process, dependency, performance, architecture)
- **title:** the brief title
- **status:** "Ready" (or "Draft" if incomplete)
- **priority:** the assigned priority (e.g., "P2")
- **effort:** the assigned effort (e.g., "S", "M", "L", "XL") if known
- **phase:** "INIT"

If brain MCP is not available, skip silently. No errors.

### 8. Confirm Registration

Display:
```
Brief registered: {PREFIX}-{XXX}

Brief: {PREFIX}-{XXX} (stored in brain DB)
Type: [Bug Fix | Feature | Migration | etc.]
Priority: P2 (default)
Status: Ready

To implement: /hunt {PREFIX}-{XXX}
To change priority: "change {PREFIX}-{XXX} priority to P0"
```

## Important

- DO NOT load context files
- DO NOT start implementation
- DO NOT create tasks
- ONLY create the brief file and sync to brain
