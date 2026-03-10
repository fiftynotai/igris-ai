# FR-088 Implementation Plan: HTTP Hooks — Brain Event Pipeline

**Brief:** FR-088
**Effort:** M-Medium
**Created:** 2026-03-10
**Agent:** architect

---

## Summary

Replace shell-script event hooks with HTTP hooks that POST directly to the brain MCP REST API. This establishes the event JSON schema for FR-066's cross-CLI adapters.

---

## Architecture Analysis

### Current State

1. **Shell hooks** in `.claude/hooks/`:
   - `agent_metrics.sh` — SubagentStart/SubagentStop: tracks agent invocations, timing, tokens, and auto-records brain metrics (FR-089)
   - `main_agent_metrics.sh` — Stop: tracks orchestrator tokens, context window metrics
   - `stop_session_check.sh` — Stop: warns if session still active
   - `session_start.sh` — SessionStart: injects session context via `additionalContext`
   - `session_end.sh` — SessionEnd: updates session to REST MODE, deregisters instance

2. **Skill event script** `scripts/emit_skill_event.sh` — called by 20+ skills via bash commands in SKILL.md files. Posts to `events.jsonl` + dashboard endpoints.

3. **Brain REST API** already has:
   - `POST /api/agent-event` — agent lifecycle events (used by MCP tool)
   - `POST /api/metrics` — agent performance metrics (used by agent_metrics.sh)
   - `POST /api/instances/heartbeat` — instance heartbeats
   - `GET /api/events` — query event_log (read-only, no POST)
   - `GET /api/events/stream` — SSE stream

### Target State

Claude Code HTTP hooks (`"type": "http"`) POST JSON directly to the brain API. The brain API receives structured events and routes them to the appropriate tables (event_log, agent_events, agent_metrics).

---

## Event JSON Schema (v1)

```json
{
  "event_type": "agent.stop | agent.start | session.stop | skill.invoke",
  "timestamp": "2026-03-10T12:00:00Z",
  "project_slug": "igris-ai",
  "instance_id": "uuid",
  "agent": "forger | sentinel | orchestrator",
  "payload": {
    // event-specific fields
  }
}
```

### Event Types

| event_type | Source Hook | Payload Fields |
|------------|------------|----------------|
| `agent.start` | SubagentStart | agent_type, agent_id |
| `agent.stop` | SubagentStop | agent_type, agent_id, duration_ms, input_tokens, output_tokens, cache_read, cache_create, result, brief_id, action |
| `session.stop` | Stop | session_id, input_tokens, output_tokens, context_used, context_max, model_id |
| `skill.invoke` | Skill SKILL.md (future) | skill_name |

---

## Implementation Steps

### Step 1: Add POST /api/events endpoint to brain REST API

**File:** `brain-mcp-server/src/index.ts`

Add a new `POST /api/events` endpoint that:
- Accepts the unified event JSON schema
- Validates required fields (event_type, timestamp)
- Routes events to appropriate handlers:
  - `agent.start/stop` → inserts into `agent_events` table + fires engine event bus
  - `session.stop` → inserts into `event_log` + fires engine event bus
  - `agent.stop` with metrics → also inserts into `agent_metrics` table
  - `skill.invoke` → inserts into `event_log`
- Returns `{ ok: true, id: N }` on success
- Supports both local and VPS brain (auth via Bearer token for VPS)

### Step 2: Convert SubagentStart/SubagentStop to HTTP hooks

**File:** `.claude/settings.json`

Replace the command hooks for SubagentStart and SubagentStop with HTTP hooks:
```json
{
  "matcher": "",
  "hooks": [
    {
      "type": "http",
      "url": "http://localhost:3001/api/events",
      "timeout": 5,
      "body": {
        "event_type": "agent.start",
        "project_slug": "{{project_slug}}",
        "payload": "{{stdin}}"
      }
    }
  ]
}
```

**Challenge:** Claude Code HTTP hooks send the hook input JSON as the POST body. The brain endpoint needs to parse and route based on the `hook_event_name` field that Claude Code includes in the JSON.

**Solution:** Rather than requiring the hook to construct the event schema, have the brain API accept raw Claude Code hook payloads at a dedicated endpoint `POST /api/hooks/event` that:
1. Reads `hook_event_name` from the payload
2. Maps it to our event schema
3. Extracts relevant fields (agent_type, tokens, etc.)
4. Inserts into appropriate tables

This is cleaner because HTTP hooks can't template/transform the JSON — they forward what Claude Code sends.

### Step 3: Convert Stop hook to HTTP

**File:** `.claude/settings.json`

Add HTTP hook for Stop event alongside the existing command hooks that must remain (notification_sound.sh needs to play audio — can't be HTTP):
- HTTP hook POSTs to `POST /api/hooks/event`
- Brain endpoint handles session.stop event type
- `stop_session_check.sh` can be removed (brain handles session state)
- `main_agent_metrics.sh` token parsing moves server-side OR stays as command hook since it needs transcript file access

**Important:** The Stop hook receives `session_id` and `transcript_path`. Transcript parsing requires local file access. The HTTP hook alone can't read transcripts. Two options:
- **Option A:** Keep `main_agent_metrics.sh` as command hook (it does local file I/O), add HTTP hook only for session end notification to brain
- **Option B:** Have the command hook do transcript parsing AND POST results to brain API (current behavior, already works via FR-089)

**Decision: Option A** — Add a lightweight HTTP hook for session end events (session_id, timestamp) to the brain. Keep main_agent_metrics.sh for transcript parsing (it already POSTs metrics). This gives the brain visibility into session lifecycle without duplicating transcript I/O.

### Step 4: Brain-side hook event handler

**File:** `brain-mcp-server/src/index.ts`

New endpoint `POST /api/hooks/event`:
```typescript
app.post('/api/hooks/event', express.json(), (req, res) => {
  // req.body is the raw Claude Code hook payload
  const hookEvent = req.body.hook_event_name;
  const agentType = req.body.agent_type || req.body.agent_id || 'unknown';
  const projectSlug = req.query.project || '';
  const instanceId = req.query.instance_id || '';

  switch (hookEvent) {
    case 'SubagentStart':
      // Insert agent start event
      break;
    case 'SubagentStop':
      // Insert agent stop event + metrics
      break;
    case 'Stop':
      // Insert session stop event
      break;
  }
});
```

Query params `?project=slug&instance_id=uuid` are appended to the URL in settings.json since they come from the environment, not from Claude Code's hook payload.

**Problem:** HTTP hooks can't include dynamic values (env vars, session state) in the URL. The URL is static in settings.json.

**Revised approach:** The brain endpoint reads `project_slug` and `instance_id` from the hook payload itself. Claude Code includes `session_id` in Stop payloads. For SubagentStart/Stop, the brain can derive project_slug from the transcript path or accept it as optional.

Actually, looking at the Claude Code hook documentation more carefully:

- HTTP hooks POST the **same JSON** that command hooks receive on stdin
- The hook payload includes fields like `hook_event_name`, `session_id`, `agent_type`, `agent_id`, `transcript_path`, `last_assistant_message`
- We can't add custom fields to the URL or body — we get exactly what Claude Code sends

**Final approach:** The `POST /api/hooks/event` endpoint accepts the raw Claude Code hook JSON and enriches it server-side. For project_slug, the endpoint reads it from the `cwd` field (if present) or from a query param set statically. Since the brain server runs locally, it can resolve the project slug from the CWD.

### Step 5: Handle emit_skill_event.sh deprecation

The 20+ skills call `emit_skill_event.sh` via `bash` commands in their SKILL.md files. These are orchestrator-level commands, not Claude Code hooks. Options:

- **Keep as-is:** The shell script works and is fire-and-forget. Low priority to change.
- **Replace with HTTP:** Skills could invoke a curl/python one-liner instead.
- **Defer:** Mark as deprecated, replace when skills are next updated.

**Decision:** Keep `emit_skill_event.sh` for now but add a deprecation comment. The script already POSTs to the dashboard; we can add a POST to the brain API endpoint too. The v6 adapter work (FR-066) will provide the proper replacement.

### Step 6: Update settings.json

Replace command hooks with HTTP hooks where possible:

```json
{
  "SubagentStart": [
    {
      "hooks": [
        {
          "type": "http",
          "url": "http://localhost:3001/api/hooks/event",
          "timeout": 5
        }
      ]
    }
  ],
  "SubagentStop": [
    {
      "hooks": [
        {
          "type": "http",
          "url": "http://localhost:3001/api/hooks/event",
          "timeout": 5
        }
      ]
    }
  ],
  "Stop": [
    {
      "hooks": [
        {
          "type": "http",
          "url": "http://localhost:3001/api/hooks/event",
          "timeout": 5
        }
      ]
    },
    {
      "hooks": [
        {
          "type": "command",
          "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/notification_sound.sh",
          "timeout": 5
        }
      ]
    },
    {
      "hooks": [
        {
          "type": "command",
          "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/main_agent_metrics.sh",
          "timeout": 5
        }
      ]
    }
  ]
}
```

**Note:** `stop_session_check.sh` is removed — the brain handles session state. `agent_metrics.sh` command hook is removed — replaced by HTTP hook. `main_agent_metrics.sh` stays — needs local transcript file I/O.

---

## Files to Modify

| File | Change |
|------|--------|
| `brain-mcp-server/src/index.ts` | Add `POST /api/hooks/event` endpoint |
| `.claude/settings.json` | Replace SubagentStart/Stop command hooks with HTTP hooks, add HTTP Stop hook |
| `.claude/hooks/agent_metrics.sh` | Remove (replaced by HTTP hook + brain-side handler) |
| `.claude/hooks/stop_session_check.sh` | Remove (trivial, brain handles session state) |
| `scripts/emit_skill_event.sh` | Add deprecation comment, optionally add brain API POST |

## Files to Keep (No Change)

| File | Reason |
|------|--------|
| `.claude/hooks/main_agent_metrics.sh` | Needs local transcript file I/O for token parsing + context breakdown |
| `.claude/hooks/session_start.sh` | Returns `additionalContext` — HTTP hooks can't return response data to Claude |
| `.claude/hooks/session_end.sh` | Instance deregistration needs local file access + DELETE API call |
| `.claude/hooks/notification_sound.sh` | Plays audio — must be local command |
| `.claude/hooks/brief_gate.sh` | PreToolUse gate — returns decision to Claude |
| `.claude/hooks/post_edit_lint.sh` | PostToolUse — runs local linter |
| `.claude/hooks/post_brief_sync.sh` | PostToolUse — reads local brief files |
| `.claude/hooks/post_session_sync.sh` | PostToolUse — reads local session files |
| `.claude/hooks/pre_compact.sh` | PreCompact — needs local file access |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Brain server not running | Medium | Low | HTTP hooks fail silently (timeout) — no functional impact |
| Hook payload format changes | Low | Medium | Validate fields, use defaults for missing |
| Duplicate events (HTTP + command) | Medium | Low | Remove command hooks when adding HTTP equivalents |
| VPS brain auth | Low | Low | HTTP hooks only hit localhost; VPS sync handles replication |

---

## Test Scenarios

1. SubagentStart → brain receives agent start event → visible in Crimson Arena
2. SubagentStop → brain receives agent stop event + metrics → visible in dashboard
3. Stop → brain receives session stop event → event_log updated
4. Brain offline → hooks timeout silently → no errors displayed
5. Events visible in `GET /api/events` and SSE stream
