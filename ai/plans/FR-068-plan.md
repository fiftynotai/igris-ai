# Implementation Plan: FR-068 — Crimson Arena Live Activity Feed & Event Dashboard

**Complexity:** L
**Estimated Duration:** 3-4 sessions across 2 repos
**Risk Level:** Medium

## Summary

Add three new REST endpoints to the brain MCP server (events query, events SSE stream, tasks list), then build corresponding proxy endpoints and UI features in the Crimson Arena dashboard: a live activity feed with SSE, an event history table with filters/pagination/export, a kanban-style task board, enhanced instance heartbeat pulse indicators, and agent workload visualization.

## Architecture Overview

```
Brain MCP Server (Express.js)          Crimson Arena (FastAPI + Flutter Web)
-------------------------------         ------------------------------------
GET /api/events       ------\           GET /api/brain/events       (proxy)
GET /api/events/stream ------|--------> GET /api/brain/events/stream (SSE proxy)
GET /api/tasks        ------/           GET /api/brain/tasks        (proxy)
                                              |
                       EventBus.*             v
                       (wildcard)        WebSocket /ws
                           |             (broadcast to Flutter)
                           v                  |
                      SSE stream              v
                                         Flutter Web Pages:
                                         - EVENTS page (live feed + history)
                                         - TASKS page (kanban board)
                                         - INSTANCES page (heartbeat pulse)
```

## Files to Modify

### Brain MCP Server (igris-ai)

| File | Action | Changes |
|------|--------|---------|
| `brain-mcp-server/src/index.ts` | MODIFY | Add 3 REST endpoints: `/api/events`, `/api/events/stream`, `/api/tasks` |
| `brain-mcp-server/src/engine/components/monitoring/handlers.ts` | MODIFY | Export `handleEventLogQuery` args type for REST reuse (already suitable) |

### Crimson Arena — Server

| File | Action | Changes |
|------|--------|---------|
| `server.py` | MODIFY | Add 3 brain proxy endpoints, SSE-to-WS bridge in `poll_brain`, new WS message types |

### Crimson Arena — Flutter (data layer)

| File | Action | Changes |
|------|--------|---------|
| `crimson-arena/lib/core/constants/api_constants.dart` | MODIFY | Add `brainEvents`, `brainEventsStream`, `brainTasks` endpoint constants |
| `crimson-arena/lib/core/routing/app_routes.dart` | MODIFY | Add `/events` and `/tasks` routes |
| `crimson-arena/lib/core/routing/app_pages.dart` | MODIFY | Register Events and Tasks pages with bindings |
| `crimson-arena/lib/data/models/brain_event_model.dart` | CREATE | Model for event_log entries (id, event_name, component, payload, hostname, project, created_at) |
| `crimson-arena/lib/data/models/task_model.dart` | CREATE | Model for tasks (id, type, scope, title, status, priority, assignee, brief_id, project_slug, etc.) |
| `crimson-arena/lib/services/brain_api_service.dart` | MODIFY | Add `getBrainEvents()`, `getBrainTasks()` methods |
| `crimson-arena/lib/services/brain_websocket_service.dart` | MODIFY | Add `brainEvents` and `brainTasks` reactive streams, handle new WS message types |

### Crimson Arena — Flutter (events feature)

| File | Action | Changes |
|------|--------|---------|
| `crimson-arena/lib/features/events/bindings/events_bindings.dart` | CREATE | GetX binding for EventsViewModel |
| `crimson-arena/lib/features/events/controllers/events_view_model.dart` | CREATE | ViewModel: live feed list, history list, filters, pagination, export |
| `crimson-arena/lib/features/events/views/events_page.dart` | CREATE | Split layout: live feed panel (left/top) + history table (right/bottom) |
| `crimson-arena/lib/features/events/views/widgets/live_event_card.dart` | CREATE | Color-coded event card with timestamp, component, payload summary |
| `crimson-arena/lib/features/events/views/widgets/event_history_table.dart` | CREATE | Paginated table with filters, date range, search |
| `crimson-arena/lib/features/events/views/widgets/event_filter_bar.dart` | CREATE | Component/event-type/project filter chips + date range picker |

### Crimson Arena — Flutter (tasks feature)

| File | Action | Changes |
|------|--------|---------|
| `crimson-arena/lib/features/tasks/bindings/tasks_bindings.dart` | CREATE | GetX binding for TasksViewModel |
| `crimson-arena/lib/features/tasks/controllers/tasks_view_model.dart` | CREATE | ViewModel: task lists by status (kanban columns), filters, refresh |
| `crimson-arena/lib/features/tasks/views/tasks_page.dart` | CREATE | Kanban board layout with status columns |
| `crimson-arena/lib/features/tasks/views/widgets/task_card.dart` | CREATE | Task card: title, assignee, priority badge, brief link |
| `crimson-arena/lib/features/tasks/views/widgets/task_column.dart` | CREATE | Single kanban column (header + scrollable card list) |
| `crimson-arena/lib/features/tasks/views/widgets/agent_workload_bar.dart` | CREATE | Horizontal bar chart: agent -> active task count |

### Crimson Arena — Flutter (instances enhancement)

| File | Action | Changes |
|------|--------|---------|
| `crimson-arena/lib/features/instances/views/widgets/instance_card.dart` | MODIFY | Add heartbeat pulse indicator (green/yellow/red animated dot) |
| `crimson-arena/lib/shared/widgets/heartbeat_pulse.dart` | CREATE | Animated pulse widget with color based on staleness |
| `crimson-arena/lib/shared/widgets/arena_scaffold.dart` | MODIFY | Add EVENTS and TASKS tabs to nav (total: 7 tabs) |

---

## Implementation Steps

### Wave 1: Brain REST Endpoints (igris-ai repo)

**Goal:** Expose event_log and tasks data via REST for dashboard consumption. Independently deployable.

#### Step 1.1: Add `GET /api/events` endpoint

In `/Users/m.elamin/StudioProjects/igris-ai/brain-mcp-server/src/index.ts`, add a new REST endpoint after the existing `/api/sync-status` block (around line 597):

```
GET /api/events?event_name=&component=&project=&since=&until=&limit=100&offset=0
```

- Reuse the exact same query logic from `handleEventLogQuery` in `brain-mcp-server/src/engine/components/monitoring/handlers.ts`
- Call `getDb()` directly (same pattern as other REST endpoints) rather than importing the handler, to keep REST responses as JSON (not MCP ToolResult format)
- WHERE clauses: `event_name = ?`, `component = ?`, `project_slug = ?`, `created_at >= ?` (since), `created_at <= ?` (until)
- Response: `{ events: [...], total: N, limit: N, offset: N }`
- Cap limit at 1000, default 100

#### Step 1.2: Add `GET /api/events/stream` SSE endpoint

Same file, add an SSE endpoint that streams engine events in real-time:

- Set response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
- Subscribe to the engine's EventBus using wildcard listener: `engine.bus.on('*', handler)`
- On each event, write `data: {JSON}\n\n` to the response
- Send keepalive comments (`:keepalive\n\n`) every 25 seconds
- On client disconnect (`res.on('close')`), call `engine.bus.off('*', handler)` and clear keepalive interval
- Optional query params: `?component=tasks&project=igris-ai` to filter at the stream level
- Auth: already covered by `app.use('/api', authMiddleware)` at line 358

**Key design decision:** Use SSE (not WebSocket) on the brain side because Express.js supports SSE natively with `res.write()` and we already have the pattern at `GET /mcp` (line 792). The dashboard FastAPI server will consume this SSE and re-broadcast via its existing WebSocket to the Flutter app.

#### Step 1.3: Add `GET /api/tasks` endpoint

Same file, add a tasks list endpoint:

```
GET /api/tasks?status=&task_type=&project_slug=&assignee=&scope=&limit=50&offset=0
```

- Query the `tasks` table directly (same pattern as `/api/briefs`)
- Join `task_assignments` for assignee info if needed, or just use the `assignee` column on tasks
- Response: `{ tasks: [...], total: N, limit: N, offset: N }`
- Include summary counts by status: `{ pending: N, active: N, blocked: N, done: N, ... }`

#### Step 1.4: Verify existing tests pass

- Run `cd brain-mcp-server && npx vitest run` to confirm no regressions
- The event-bus-integrity test should still pass since we are using wildcard subscription (`'*'`) in the SSE handler, which is NOT a component declaration -- it is infrastructure code in `index.ts`

**Testing for Wave 1:**
- Manual: Start brain in HTTP mode, call `GET /api/events`, `GET /api/tasks` with curl
- Manual: Open `GET /api/events/stream` in curl (`--no-buffer`), trigger MCP tool calls, observe SSE events appear
- Automated: Consider adding a REST endpoint integration test (optional, since existing REST endpoints have no dedicated tests)

---

### Wave 2: Dashboard Proxy Layer (crimson-arena repo, server.py)

**Goal:** Wire the brain REST and SSE endpoints through the FastAPI server to the Flutter Web app. Independently deployable after Wave 1.

#### Step 2.1: Add brain event proxy endpoints

In `/Users/m.elamin/StudioProjects/crimson-arena/server.py`, add three new proxy routes (after existing brain proxy endpoints, around line 1865):

```python
@app.get("/api/brain/events")
async def brain_events(request: Request, ...):
    """Proxy to brain /api/events with filter params."""

@app.get("/api/brain/events/stream")
async def brain_events_stream(request: Request):
    """SSE proxy: connect to brain /api/events/stream and forward to client."""

@app.get("/api/brain/tasks")
async def brain_tasks(request: Request, ...):
    """Proxy to brain /api/tasks with filter params."""
```

For the SSE proxy (`/api/brain/events/stream`):
- Use `httpx` streaming to connect to the brain SSE endpoint
- Return a `StreamingResponse` with `media_type="text/event-stream"`
- Forward each SSE line from brain to the client
- Handle disconnection and cleanup

#### Step 2.2: Add brain event polling to `poll_brain()`

In the existing `poll_brain()` function (line 826):
- Add a new polling interval for events (every 10s) or connect to the brain SSE stream
- On new events, broadcast to WebSocket clients: `{"type": "brain_event", "data": {...}}`
- Add task list polling (every 60s): `{"type": "brain_tasks", "data": {...}}`

**Preferred approach:** Instead of SSE proxy polling, use a persistent SSE connection in a background task:

```python
async def stream_brain_events(app: FastAPI):
    """Background task that connects to brain SSE and re-broadcasts via WebSocket."""
```

This connects to `brain_url/api/events/stream`, reads SSE events, and calls `manager.broadcast()` for each. Reconnects on disconnect with exponential backoff.

#### Step 2.3: Extend WebSocket initial payload

In the `websocket_endpoint` function (line 1922), add initial brain events and tasks to the bootstrap payload:

```python
# Send initial brain events (last 50)
brain_events = await brain_request(app, "/api/events", params={"limit": "50"})
if brain_events:
    await websocket.send_json({"type": "brain_events", "data": brain_events})

# Send initial tasks
brain_tasks = await brain_request(app, "/api/tasks")
if brain_tasks:
    await websocket.send_json({"type": "brain_tasks", "data": brain_tasks})
```

**Testing for Wave 2:**
- Manual: Start both servers. Verify `/api/brain/events`, `/api/brain/tasks` return proxied data
- Manual: Connect WebSocket, verify `brain_events` and `brain_tasks` messages arrive
- Manual: Trigger brain events, verify they propagate through SSE -> WS -> client

---

### Wave 3: Flutter Data Layer & Navigation (crimson-arena repo)

**Goal:** Add models, API methods, WS handlers, and routing for the new pages. No visible UI yet -- just plumbing.

#### Step 3.1: Add data models

Create `brain_event_model.dart`:
```dart
class BrainEventModel {
  final int id;
  final String eventName;
  final String component;
  final Map<String, dynamic> payload;
  final String? machineHostname;
  final String? projectSlug;
  final String? instanceId;
  final String createdAt;
}
```

Create `task_model.dart`:
```dart
class TaskModel {
  final String id;
  final String taskType;
  final String scope;
  final String title;
  final String? description;
  final String status;
  final int priority;
  final String? assignee;
  final String? briefId;
  final String? projectSlug;
  final String createdAt;
  final String updatedAt;
}
```

#### Step 3.2: Extend API service

In `brain_api_service.dart`, add:
- `getBrainEvents({params})` -> calls `/api/brain/events`
- `getBrainTasks({params})` -> calls `/api/brain/tasks`

#### Step 3.3: Extend WebSocket service

In `brain_websocket_service.dart`, add:
- `brainEvents` reactive stream (`Rx<Map<String, dynamic>?>`)
- `brainTasks` reactive stream (`Rx<Map<String, dynamic>?>`)
- `liveEventFeed` append-only list (`RxList<Map<String, dynamic>>`) for the live feed
- Handle new message types in the `_onMessage` router: `brain_events`, `brain_tasks`, `brain_event`

#### Step 3.4: Update routing

In `app_routes.dart`, add:
```dart
static const String events = '/events';
static const String tasks = '/tasks';
```

In `app_pages.dart`, add GetPage entries for events and tasks pages.

#### Step 3.5: Update API constants

In `api_constants.dart`, add:
```dart
static const String brainEvents = '$apiBase/brain/events';
static const String brainTasks = '$apiBase/brain/tasks';
static const String brainEventsStream = '$apiBase/brain/events/stream';
```

#### Step 3.6: Update navigation scaffold

In `arena_scaffold.dart`, add EVENTS and TASKS tabs (between INSTANCES and AGENTS):
```dart
_TabDef(label: 'EVENTS', shortLabel: 'EV', route: AppRoutes.events),
_TabDef(label: 'TASKS', shortLabel: 'TK', route: AppRoutes.tasks),
```

Update `activeTabIndex` values for all pages that reference it. The new tab order becomes:
0. HOME
1. INSTANCES
2. EVENTS (new)
3. TASKS (new)
4. AGENTS
5. ACHIEVEMENTS
6. SKILLS

**Testing for Wave 3:**
- Compile Flutter Web: `cd crimson-arena/crimson-arena && flutter build web`
- Verify app loads, navigation shows new tabs (empty pages)
- Verify no regressions on existing pages

---

### Wave 4: Events Page UI (crimson-arena repo)

**Goal:** Build the live activity feed and event history table.

#### Step 4.1: Create EventsViewModel

`events_view_model.dart`:
- `liveEvents` - RxList, newest first, max 200 entries (auto-trim)
- `historyEvents` - RxList from REST query
- `filters` - component, eventName, project, since, until
- `pagination` - offset, limit, total
- `isPaused` - toggle auto-scroll
- `isLoadingHistory` - loading flag
- Listen to `_wsService.liveEventFeed` for live updates
- `fetchHistory()` method calls `_apiService.getBrainEvents()` with filters
- `exportCsv()` / `exportJson()` methods for export

#### Step 4.2: Create Events page layout

`events_page.dart`:
- Responsive split: on wide screens, left panel = live feed, right panel = history table
- On narrow screens, tabbed view (Live / History)
- Use `ArenaScaffold` with `activeTabIndex: 2`

#### Step 4.3: Create live event card widget

`live_event_card.dart`:
- Compact card: `[HH:MM:SS] [COMPONENT] event.name - payload_summary`
- Color-coded by component:
  - schedules = `#4A9EFF` (blue)
  - cache = `#4ADE80` (green)
  - coordination = `#FB923C` (orange)
  - tasks = `#A78BFA` (purple)
  - monitoring = `#F472B6` (pink)
- Expandable to show full payload JSON
- Pause-on-hover: wrap list in `MouseRegion` that sets `isPaused`

#### Step 4.4: Create event history table

`event_history_table.dart`:
- DataTable or custom scrollable table
- Columns: Time, Component, Event, Machine, Project, Payload
- Sortable by time
- Paginated (prev/next buttons, page indicator)
- Row click expands payload detail

#### Step 4.5: Create filter bar

`event_filter_bar.dart`:
- Component filter: dropdown/chips (schedules, cache, coordination, tasks)
- Event type: text search
- Project: dropdown (populated from brain projects)
- Date range: start/end date pickers
- Clear all button
- Export buttons (CSV, JSON)

**Testing for Wave 4:**
- Manual: Navigate to Events page, verify live feed shows events
- Manual: Apply filters, verify history table updates
- Manual: Hover over live feed, verify auto-scroll pauses
- Manual: Click export, verify CSV/JSON download

---

### Wave 5: Tasks Page & Instance Enhancement (crimson-arena repo)

**Goal:** Build the kanban task board, agent workload visualization, and instance heartbeat pulse.

#### Step 5.1: Create TasksViewModel

`tasks_view_model.dart`:
- `tasksByStatus` - Map<String, List<TaskModel>> keyed by status
- `agentWorkload` - Map<String, int> agent -> active task count
- `filters` - project, assignee, type
- `statusSummary` - Map<String, int> from API response
- Listen to `_wsService.brainTasks` for updates
- `refreshTasks()` fetches from `_apiService.getBrainTasks()`

#### Step 5.2: Create Tasks page (kanban board)

`tasks_page.dart`:
- Horizontal scroll of status columns: PENDING -> ACTIVE -> BLOCKED -> DONE
- Each column is a `TaskColumn` widget with header (status name + count badge)
- Below the kanban: agent workload bar chart
- Filter bar at top (project, assignee, type dropdowns)
- Use `ArenaScaffold` with `activeTabIndex: 3`

#### Step 5.3: Create task card widget

`task_card.dart`:
- Title, type badge (color-coded: brief=crimson, dev=blue, content=green, etc.)
- Priority indicator (1-5 dots or colored stripe)
- Assignee avatar/name (agent alias)
- Brief ID link (if linked to a brief)
- Project slug
- Timestamps (created, updated)

#### Step 5.4: Create agent workload visualization

`agent_workload_bar.dart`:
- Horizontal stacked bar per agent
- Segments: active tasks (crimson), pending tasks (gray), blocked (yellow)
- Shows at bottom of tasks page or as a collapsible panel

#### Step 5.5: Add heartbeat pulse to instance cards

In `instance_card.dart`:
- Replace static status text/icon with `HeartbeatPulse` widget
- Parse `lastHeartbeat` timestamp from `InstanceModel`
- Color logic:
  - Green pulsing: heartbeat < 5 min ago
  - Yellow pulsing (slow): heartbeat 5-30 min ago
  - Red static: heartbeat > 30 min ago (stale)
- The animation: `AnimatedContainer` or `AnimationController` with `CurvedAnimation`

Create `heartbeat_pulse.dart`:
- `HeartbeatPulse(color, isAnimated)` widget
- Two concentric circles: inner solid, outer pulsing opacity
- Uses `AnimationController` with repeat for the pulse effect

**Testing for Wave 5:**
- Manual: Navigate to Tasks page, verify kanban columns populate
- Manual: Check agent workload bar renders with correct data
- Manual: Check instance cards show animated pulse dots
- Manual: Wait for stale instance, verify pulse changes to red/static

---

## Dependency Order

```
Wave 1 (brain endpoints)
    |
    v
Wave 2 (server.py proxy + SSE bridge)
    |
    v
Wave 3 (Flutter data layer + routing)
    |
    v
Wave 4 (Events page UI) ----+
                             |---- can be parallel
Wave 5 (Tasks page + pulse) +
```

Waves 4 and 5 have no dependency on each other and can be implemented in parallel or in either order.

---

## Testing Strategy

### Brain MCP Server
- **Unit:** The monitoring handlers (`handleEventLogQuery`) are already tested in `brain-mcp-server/src/engine/components/monitoring/__tests__/monitoring.test.ts`. The new REST endpoints reuse the same DB queries.
- **Integration:** Manual curl tests against running brain in HTTP mode
- **Regression:** Run `npx vitest run` -- event-bus-integrity test must pass. The SSE endpoint uses `engine.bus.on('*', handler)` which is internal infrastructure, not a component declaration, so it will not trigger integrity violations.

### Crimson Arena
- **Server:** Manual test with brain server running, verify proxy endpoints return correct data
- **Flutter:** Build and test in Chrome with `flutter run -d chrome`
- **WS flow:** Connect to WS, trigger brain events, verify they appear in live feed
- **Export:** Verify CSV and JSON export produce valid files with correct data

### End-to-End
1. Start brain server in HTTP mode (`--http --port 3001`)
2. Start crimson-arena server (`uvicorn server:app --port 8001`)
3. Open dashboard in browser
4. Trigger brain events (run MCP tool calls via Claude Code or curl)
5. Verify events appear in live feed within seconds
6. Verify task board reflects current task state
7. Verify instance pulse indicators animate correctly

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SSE connection drops silently between brain and dashboard | Medium | High | Implement keepalive (25s interval) + reconnect logic with exponential backoff in the `stream_brain_events` background task |
| EventBus wildcard listener in SSE endpoint creates performance overhead | Low | Medium | The wildcard handler only serializes + writes to connected SSE clients. If no clients, the handler returns immediately. Add client count check before serialization. |
| Event-bus-integrity test fails due to wildcard `'*'` subscription in index.ts | Low | High | The integrity test only scans component source files (`components/{name}/index.ts`), not `index.ts`. Verify by running the test. If it does scan `index.ts`, add the SSE pattern to the INFRASTRUCTURE_EVENTS exclusion set. |
| SYNC_TABLES count assertion fails | Low | Medium | The new endpoints read from existing tables, not new ones. No new sync tables needed. No risk to the auto-push test count assertion (currently 20). |
| Large event_log table causes slow REST queries | Medium | Medium | The monitoring component already runs 30-day retention cleanup on init. The REST endpoint caps at 1000 rows per query. Indexes already exist on `event_name`, `component`, and `created_at`. |
| Flutter navigation tab count increases from 5 to 7, crowding the nav bar | Medium | Low | The scaffold already handles narrow screens with abbreviated labels (2 chars). With 7 tabs the narrow mode will engage earlier. Consider grouping EVENTS and TASKS under a "MONITOR" dropdown if it gets too crowded. |
| SSE proxy in FastAPI needs async streaming which is tricky with httpx | Medium | Medium | Use `httpx.AsyncClient.stream()` with `StreamingResponse`. Alternatively, poll `/api/events?since=last_seen` every 5s instead of maintaining persistent SSE proxy (simpler, less real-time). |
| Brain server not running when dashboard starts | Low | Low | Dashboard already handles brain offline gracefully (returns offline status). Events and tasks pages will show "Brain offline" message with retry button. |
| Memory leak from SSE clients that disconnect without cleanup | Medium | Medium | Track SSE response objects. On `res.on('close')`, remove the wildcard listener. Add a periodic cleanup that checks `res.writableEnded` and removes stale listeners. |

---

## Design Decisions

### SSE vs WebSocket on Brain Side
**Decision:** SSE (Server-Sent Events) from brain to dashboard server.
**Rationale:** Express.js supports SSE natively via `res.write()`. The brain already has an SSE pattern at `GET /mcp` (line 792) with keepalive comments. SSE is unidirectional (server -> client) which is exactly what event streaming needs. WebSocket would require additional dependencies and complexity for no benefit since the client never sends events to the brain.

### Polling vs Persistent SSE in Dashboard Server
**Decision:** Start with polling (`/api/events?since=last_seen` every 5-10s), upgrade to persistent SSE connection in a future iteration.
**Rationale:** Polling is simpler to implement, debug, and reason about. It reuses the existing `brain_request()` helper. The latency (5-10s) is acceptable for a dashboard. A persistent SSE connection adds complexity (reconnection, error handling, partial message parsing) that can be added later if sub-second latency is needed.

### Task Board: Read-Only vs Interactive
**Decision:** Read-only kanban board (no drag-and-drop).
**Rationale:** Task state changes should go through MCP tools (igris_task_update, etc.), not through the dashboard UI. The dashboard is an observation tool, not a control plane. This keeps the architecture simple and avoids the need for write-back REST endpoints.

### Navigation: 7 Tabs
**Decision:** Add EVENTS and TASKS as separate top-level tabs.
**Rationale:** These are distinct concerns with different data models and update patterns. Nesting them under INSTANCES or HOME would create cognitive overload. 7 tabs is manageable with the existing responsive nav system.

---

## Non-Goals (Explicitly Out of Scope)

1. **Write-back endpoints** -- No POST/PUT for tasks or events from the dashboard
2. **User authentication** -- The dashboard remains a local/private tool
3. **Event deduplication at brain level** -- The monitoring component already handles this
4. **Historical data migration** -- Only new events after deployment will appear
5. **Mobile responsive layout** -- Dashboard is desktop-first
6. **Dark/light theme toggle** -- Dashboard remains dark theme only

---

## Open Questions

1. **FR-067 dependency:** The brief mentions FR-067 as a prerequisite. However, the `event_log` table and monitoring component already exist in the current codebase. The SSE stream endpoint is being added in this brief. Confirm that FR-067 is either already completed or that this brief subsumes its scope.

2. **Instance detail endpoint:** The brain has no `GET /api/instances/:id` (single instance detail) endpoint. The dashboard proxies to it (`brain_instance_detail` at line 1772) but it would return 404. This is a pre-existing gap, not introduced by FR-068, but worth noting.

3. **Event volume:** If the brain is processing many events per second (e.g., during heavy CI/CD), the SSE stream could generate significant traffic. Consider adding server-side throttling (batch events, emit at most once per 500ms) if this becomes an issue.
