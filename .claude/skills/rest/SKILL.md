---
name: rest
description: Pause or end current session - saves state for later resumption
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Edit
triggers:
  - "REST"
  - "REST MODE"
  - "end session"
  - "pause session"
  - "STAND DOWN"
---

# REST - Pause/End Session

Safely pause or end the current session, saving state for later resumption.

## Execution

### 1. Read Current Session

Read `ai/session/CURRENT_SESSION.md` to understand current state.

### 2. Confirm with User

Ask: "Save session and enter REST MODE? Any unsaved work will be noted for resumption."

### 3. Update Session File

Edit `ai/session/CURRENT_SESSION.md`:

```markdown
## Status
**Mode:** REST MODE
**Updated:** [current date]
**Active Brief:** [current brief or None]

---

## Resume Point

**Last Active:** [brief ID if any]
**Phase:** [current phase]

---

## Next Session Instructions

[Capture current context and next steps for resumption]

---

## Last Session Summary
**Date:** [today]
**Completed:** [list completed items]
**Summary:** [brief summary of work done]
```

### 4. Confirm REST MODE

Display:
```
Session saved. REST MODE activated.

Resume Point:
- Brief: [ID]
- Phase: [phase]
- Next: [next steps]

To resume: /awaken or "ARISE"
```
