---
name: register
description: "Create a new brief - usage: /register bug|feature|migration|debt \"title\""
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Glob
  - mcp__igris-brain__igris_brief_sync
  - mcp__igris-brain__igris_brief_create
  - mcp__igris-brain__igris_brief_list
  - mcp__igris-brain__igris_brief_similar
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

Call `igris_brief_list` to find next available number, fallback to cache glob at `~/.igris/projects/{project}/briefs/`.
Find highest number, add 1.
Example: If BR-007 exists, next is BR-008.

### 3.5 Dup-check (enforcement gate)

Before creating the brief, run the dup-check — the enforced form of brain
obligation #3 ("Dup-check before creating a brief"), tracked in
`core/enforcement/INDEX.md`.

Call `igris_brief_similar` with:
- **query:** `"{title}. {problem}"` (the title plus the one-line problem, if known)
- **project:** the current project slug
- **threshold:** `0.85`

Then branch:
- **A hit at or above the threshold** → STOP. Display the near-duplicate brief(s)
  (ID, title, similarity) and ask the operator to confirm they want a new brief
  anyway, or to abort / amend the existing one. Do NOT proceed to step 4 without
  operator confirmation.
- **No hit** → proceed to step 4.
- **Tool unavailable** (`igris_brief_similar` returns a capability message —
  sqlite-vec extension or embeddings backend not loaded — rather than results) →
  proceed to step 4 (fail-open, matching every other Igris gate's posture). Do not
  treat the capability message as an error.

### 4. Build Brief Content

Construct brief markdown content using this structure:

```markdown
# {PREFIX}-{XXX}: {title}

## Metadata
- **Type:** {Bug Fix | Feature | Migration | Tech Debt | Testing | ...}
- **Priority:** {priority, default P2}
- **Status:** Ready
- **Effort:** {effort if known, otherwise omit}
- **Created:** {today's date}

## Problem

{Description of the problem or need — ask user if not clear from title}

## Goal

{What should happen after this is implemented}

## Context and Inputs

{Relevant files, modules, APIs — fill in what's known}

## Acceptance Criteria

{Testable outcomes — fill in what's known, leave for user to complete if unclear}

## Test Plan

{How to verify — fill in what's known}

## Delivery

{Migrations, feature flags, docs to update — fill in what's known}
```

### 5. Store Brief in Brain

Call `igris_brief_create` with:
- **project:** current project slug
- **brief_id:** the new brief ID (e.g., "FR-031")
- **title:** the brief title
- **content:** the constructed markdown from step 4
- **brief_type:** type (Bug, Feature, Migration, etc.)
- **status:** "Ready" (or "Draft" if info incomplete)
- **priority:** the assigned priority (default "P2")
- **effort:** the assigned effort if known

If `igris_brief_create` fails or MCP is unavailable:
1. Write to `~/.igris/projects/{project}/briefs/{PREFIX}-{XXX}-{slug}.md` as fallback.
2. Display: `WARNING: Brain MCP unavailable — brief {PREFIX}-{XXX} saved to local cache only. Queued for sync on next /awaken or /sync data.`
3. Append a JSON line to `~/.igris/projects/{project}/sync_queue.jsonl`:
   ```json
   {"timestamp":"{ISO-8601 now}","operation":"brief_create","project":"{project}","brief_id":"{PREFIX}-{XXX}","title":"{title}","status":"Ready","priority":"{priority}","brief_type":"{type}","cache_path":"~/.igris/projects/{project}/briefs/{PREFIX}-{XXX}-{slug}.md"}
   ```

**DO NOT write brief files to the repo.** Briefs live in the brain DB only.

### 6. Handle P0/P1 Priority

If user specifies P0 or P1 priority, also add entry to `~/.igris/projects/{project}/session/BLOCKERS.md`.

### 7. Confirm Registration

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
- ONLY store the brief in the brain DB via `igris_brief_create`
- DO NOT write brief files to the repo
