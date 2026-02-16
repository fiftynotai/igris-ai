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

### 2.5. Sync to Brain (Optional)

If the `igris-brain` MCP server is available:
- Read `ai/session/LEARNINGS.md` — if it has new content since last sync, store each learning via `igris_memory_store` with the current project slug
- Read `ai/session/DECISIONS.md` — if it has new content, store each decision via `igris_memory_store` with category="decision" and the current project slug
- Call `igris_metrics_record` with session summary: project=current project slug, agent="session", action="rest", result="success"

If brain MCP is not available, skip this step silently. No errors, no warnings.

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
