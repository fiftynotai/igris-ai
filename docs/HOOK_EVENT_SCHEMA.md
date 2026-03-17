# Igris AI — Hook Event Schema (v1)

Reference documentation for the HTTP hook event pipeline. Defines the JSON
schema that CLI adapters must implement to send events to the Igris brain.

**Version:** 1.0.0
**Created:** 2026-03-10 (FR-088)
**Target:** FR-066 cross-CLI adapters (Gemini CLI, Codex CLI, etc.)

---

## Endpoint

```
POST /api/hooks/event?project=<slug>
Content-Type: application/json
```

- **Local brain:** `http://localhost:3001/api/hooks/event?project=<slug>`
- **VPS brain:** `http://<vps-host>:3001/api/hooks/event?project=<slug>`
  - VPS requires `Authorization: Bearer <api_key>` header

### Query Parameters

| Param | Required | Description |
|-------|----------|-------------|
| `project` | Recommended | Project slug (e.g., `igris-ai`). Used for event_log and metrics. |

---

## Event Types

### `SubagentStart` — Agent Invocation Start

Sent when a subagent (Task tool) is invoked.

```json
{
  "hook_event_name": "SubagentStart",
  "agent_type": "forger",
  "agent_id": "unique-agent-id"
}
```

**Brain actions:**
- Inserts into `agent_events` table (event_type: start)
- Inserts into `event_log` table (event_name: agent.start, component: hooks)

---

### `SubagentStop` — Agent Invocation Complete

Sent when a subagent finishes execution.

```json
{
  "hook_event_name": "SubagentStop",
  "agent_type": "forger",
  "agent_id": "unique-agent-id",
  "agent_transcript_path": "/path/to/transcript.jsonl",
  "last_assistant_message": "Implementation complete. All files updated."
}
```

**Brain actions:**
- Inserts into `agent_events` table (event_type: stop, result parsed from last_assistant_message)
- Inserts into `agent_metrics` table (project, agent, action, result)
- Inserts into `event_log` table (event_name: agent.stop, component: hooks)

**Result parsing:** The brain parses `last_assistant_message` for success/failure indicators:
- Failure: "fail", "failed", "reject", "rejected", "error", "blocked", "tests failing"
- Success: "pass", "passed", "success", "approve", "complete", "lgtm"

---

### `Stop` — Session End

Sent when the main Claude Code session ends.

```json
{
  "hook_event_name": "Stop",
  "session_id": "session-uuid",
  "transcript_path": "/path/to/transcript.jsonl"
}
```

**Brain actions:**
- Inserts into `event_log` table (event_name: session.stop, component: hooks)

**Note:** Transcript token parsing requires local file access and is handled
separately by the `main_agent_metrics.sh` command hook. The HTTP hook records
the session end event only.

---

### `SkillInvoke` — Skill Execution (via emit_skill_event.sh)

Sent when a skill (slash command) is executed.

```json
{
  "hook_event_name": "SkillInvoke",
  "skill_name": "hunt",
  "project_slug": "igris-ai"
}
```

**Brain actions:**
- Inserts into `event_log` table (event_name: hook.skillinvoke, component: hooks)

---

## Agent Name Normalization

The brain normalizes Claude Code built-in agent names to Igris canonical names:

| Claude Code Name | Igris Name |
|-----------------|------------|
| planner | architect |
| coder | forger |
| tester | sentinel |
| reviewer | warden |
| debugger | mender |
| explorer | seeker |
| Explore | seeker |
| claude-code-guide | seeker |
| documenter | forger |
| releaser | forger |
| auditor | warden |
| ideator | architect |

If the agent name is not in the map, it is used as-is.

---

## Agent-to-Action Mapping

For `agent_metrics` recording, agents are mapped to actions:

| Agent | Action |
|-------|--------|
| architect | plan |
| forger | implement |
| sentinel | test |
| warden | review |
| mender | debug |
| seeker | research |
| sage | advise |
| (other) | execute |

---

## Response Format

### Success (201)

```json
{
  "ok": true,
  "hook": "SubagentStop",
  "agent": "forger",
  "result": "success",
  "results": [
    { "table": "agent_events", "id": 42 },
    { "table": "agent_metrics", "id": 15 },
    { "table": "event_log", "id": 301 }
  ]
}
```

### Error (400)

```json
{
  "error": "Missing hook_event_name field"
}
```

### Error (500)

```json
{
  "error": "Database error message"
}
```

---

## Graceful Degradation

HTTP hooks must fail silently. When the brain is unreachable:
- Claude Code's HTTP hook timeout fires (default: 5s)
- No error is displayed to the user
- Workflow continues uninterrupted

This is enforced by Claude Code's hook system -- HTTP hook failures do not
block the main agent.

---

## Cross-CLI Adapter Guide (FR-066)

To implement this event pipeline in another CLI:

1. **Identify hook points** in your CLI that correspond to SubagentStart/Stop/Stop
2. **POST the JSON payload** to `POST /api/hooks/event?project=<slug>`
3. **Include at minimum:** `hook_event_name` and agent information
4. **Set timeout to 5 seconds** and fail silently on errors
5. **Use the agent name map** to normalize your CLI's agent names

### Example: Gemini CLI Adapter

```python
# On agent invocation
requests.post(
    "http://localhost:3001/api/hooks/event?project=my-project",
    json={"hook_event_name": "SubagentStart", "agent_type": "coder"},
    timeout=5
)
```

---

**Maintained by:** Igris AI (Fifty.ai)
