---
name: awaken
description: Start or resume session - loads state and continues work
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
triggers:
  - "AWAKEN"
  - "ARISE"
  - "start session"
  - "resume session"
---

# AWAKEN - Start/Resume Session

Initialize Igris AI and resume any pending work.

## Execution

### 1. Load System Context

Read these files silently:
- `ai/prompts/igris_os.md` - Operating system
- `ai/persona.json` - Persona identity
- `ai/context/coding_guidelines.md` - Architecture standards

### 2. Load Session State

Read `ai/session/CURRENT_SESSION.md`:
- Check if session exists (Mode field)
- If REST MODE: This is a resume
- If no session: This is a fresh start

### 3. Display Persona Greeting

If persona.json exists with mask != "none":
```
I am [branding.title] v[version], developed by Fifty.ai, standing ready to serve, [user.name].

My capabilities:
- Brief management, session recovery, architecture enforcement
- Quality gates, protocol enforcement

Current mode: [mask level description]
```

### 3.5. Query Brain for Context (Optional)

If the `igris-brain` MCP server is available:
- Call `igris_memory_recall` with the current project slug and context="session start, current project priorities"
- Display any relevant cross-project learnings to the user
- Call `igris_project_register` to update `last_session_at` for this project
- Call `igris_session_recall` with days=2 to see recent cross-project activity
- If sessions returned, display a "Cross-Project Context" section:
  ```
  ### Cross-Project Context (last 48h)
  - project-a: Worked on BR-012 (auth fix), BUILDING phase
  - project-b: Completed FR-005 (dark mode)
  ```
- This gives a "welcome back" overview across all projects

If brain MCP is not available, skip this step silently. No errors, no warnings.

### 4. Perform System Assessment

Scan `ai/briefs/` for inventory:
- Count by status and priority
- Identify highest priority ready brief

Check `ai/session/BLOCKERS.md` for active blockers.

Check git status.

If brain is connected (from step 3.5), include brain stats in assessment:
- Brain: Connected (X learnings, Y errors cataloged) | Not available
- Cross-project insights if relevant

### 5. Display Resume Point (if resuming)

If session was in REST MODE:
```
## Resuming Session

**Last Active:** [brief ID]
**Phase:** [phase]
**Next Steps:** [from session file]
```

### 6. Display Recommendations

```
## Recommended Actions

1. [Primary - resume current or start highest priority]
2. [Secondary - show status or review briefs]
3. [Tertiary - other relevant action]
```

### 7. Update Session

If resuming, update Mode from "REST MODE" to "HUNT MODE" or "Active".

Display: "Igris AI initialized. System ready."
