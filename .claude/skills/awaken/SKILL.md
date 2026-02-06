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

### 4. Perform System Assessment

Scan `ai/briefs/` for inventory:
- Count by status and priority
- Identify highest priority ready brief

Check `ai/session/BLOCKERS.md` for active blockers.

Check git status.

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
