# Implementation Plan: FR-052 — Brain v5.0 Engine Foundation

**Complexity:** L (revised from brief — architect confirms extensive work)
**Estimated Files:** 17 (15 new, 2 modified)
**Risk Level:** High
**Implementation Phases:** 11

---

## Codebase Analysis

### Actual Tool Count: 27 (not 40)

The brief referenced "40 tools" but the actual codebase contains exactly **27 MCP tools** registered in `ListToolsRequestSchema`, duplicated across 2 switch statements (`dispatchToolCall` + `CallToolRequestSchema` handler = 54 case statements total). This plan accounts for the actual 27 tools.

### Current Architecture

**Entry point:** `brain-mcp-server/src/index.ts` (1,685 lines)
- `parseConfig()` — CLI/env config parsing (lines 97-130)
- `dispatchToolCall()` — Direct tool dispatch, 27-case switch (lines 143-213)
- `createBrainServer()` — MCP server factory with ListTools + CallTool handlers (lines 224-992)
  - `ListToolsRequestSchema` handler: all 27 tool schemas inline (lines 240-884)
  - `CallToolRequestSchema` handler: 27-case switch dispatching to tool modules (lines 889-989)
- `runStdio()` — stdio transport (lines 1001-1025)
- `runHttp()` — HTTP transport with sessions, auth, rate limiting, REST API, sync endpoints (lines 1052-1664)

**Database:** `brain-mcp-server/src/db.ts` (389 lines)
- Singleton `getDb()` with WAL mode, busy_timeout, foreign keys
- 8 incremental schema migrations (versions 1-8)
- 13 tables + 2 FTS5 virtual tables

**Tool Modules (8 files):**

| File | Tools | Lines |
|------|-------|-------|
| `tools/memory.ts` | store, search, recall, pattern_suggest | 465 |
| `tools/errors.ts` | error_lookup | 221 |
| `tools/projects.ts` | register, list, status | 206 |
| `tools/metrics.ts` | record, query, velocity | 344 |
| `tools/sessions.ts` | sync, recall | 144 |
| `tools/briefs.ts` | sync, dashboard | 181 |
| `tools/instances.ts` | heartbeat, list, remove | 206 |
| `tools/sync.ts` | brain_push, brain_pull, queue_status, queue_drain, brief_file_sync, session_file_sync, session_file_pull, definition_sync, definition_pull | 1,022 |

**Staging:** `staging.ts` — file ingestion pipeline (185 lines)

### Tool-to-Domain Mapping (27 tools, 8 domains)

| Domain | Tools | Count |
|--------|-------|-------|
| memory | igris_memory_store, igris_memory_search, igris_memory_recall, igris_pattern_suggest | 4 |
| errors | igris_error_lookup | 1 |
| projects | igris_project_register, igris_project_list, igris_project_status | 3 |
| metrics | igris_metrics_record, igris_metrics_query, igris_metrics_velocity | 3 |
| sessions | igris_session_sync, igris_session_recall | 2 |
| briefs | igris_brief_sync, igris_brief_dashboard | 2 |
| instances | igris_instance_heartbeat, igris_instance_list, igris_instance_remove | 3 |
| sync | igris_brain_push, igris_brain_pull, igris_sync_queue_status, igris_sync_queue_drain, igris_brief_file_sync, igris_session_file_sync, igris_session_file_pull, igris_definition_sync, igris_definition_pull | 9 |

### Decision: 8 Components (not 7)

The brief estimated 7 components. The actual codebase has 8 separate tool modules. **Keeping 8 components** preserves the 1:1 mapping with existing tool files and simplifies refactoring. The brief's "7" counted errors as part of memory — either works, but 8 is cleaner.

---

## Database Table Ownership

| Component | Tables Owned | FTS Tables |
|-----------|-------------|------------|
| memory | learnings | learnings_fts |
| errors | errors | errors_fts |
| projects | projects | — |
| metrics | agent_metrics | — |
| sessions | sessions | — |
| briefs | brief_status, brief_files | — |
| instances | instances | — |
| sync | sync_state, sync_queue, session_files, definition_files | — |
| (engine) | schema_version | — |

---

## Key Architectural Decisions

### 1. StorageAdapter mirrors better-sqlite3 API

Tool modules currently call `getDb().prepare().run()/.get()/.all()`. The adapter wraps `better-sqlite3` to provide the same interface. This means **zero code changes** inside existing tool handler functions.

### 2. `getDb()` bridged to adapter via `setAdapter()`

Updated `db.ts` exposes a `setAdapter()` function. Once the engine boots and calls `setAdapter()`, all tool modules that still use `getDb()` get the adapter's underlying connection. No import changes needed in tool modules.

### 3. All components share one StorageAdapter

For Phase 1: all components share one SQLite database (same as today). No access isolation. The dependency graph in the registry is informational for migration ordering, not for access control. True isolation is a future concern.

### 4. DB migration is file copy (not schema transform)

The database schema is identical between v4 and v5. Migration = copy `knowledge.db` → `brain.db`. Never delete the source. Verify row counts match.

### 5. REST API endpoints stay in index.ts

`/api/instances`, `/api/projects`, `/api/briefs`, `/api/sessions`, `/api/brain-stats` are Express route handlers that query the DB directly. They are NOT MCP tools. Refactoring them into components is out of scope for Phase 1.

---

## Event Bus Design

| Event | Producer | Consumers | Purpose |
|-------|----------|-----------|---------|
| `memory.stored` | memory | sync | Queue for remote sync |
| `memory.promoted` | memory | sync | Learning promoted to global |
| `error.stored` | errors | sync | Queue for remote sync |
| `project.registered` | projects | sync | Queue for remote sync |
| `session.synced` | sessions | sync | Queue for remote sync |
| `brief.synced` | briefs | sync | Queue for remote sync |
| `instance.heartbeat` | instances | sync | Queue for remote sync |
| `metrics.recorded` | metrics | sync | Queue for remote sync |
| `component.loaded` | registry | (all) | Component lifecycle |
| `component.error` | registry | (all) | Component error |

---

## Implementation Phases

### Phase 1: Engine Types (types.ts)

Define all interfaces: BrainComponent, ComponentContext, ToolDefinition, Migration, EventDef, StorageAdapter, EventBus, EngineConfig. No runtime code. This is the contract everything else builds on.

**File:** `brain-mcp-server/src/engine/types.ts`

### Phase 2: Event Bus (bus.ts)

Simple synchronous event bus with typed events. Wildcard support (`memory.*`). Handler errors caught and logged, never crash. No external dependencies.

**File:** `brain-mcp-server/src/engine/bus.ts`

### Phase 3: Storage Adapter (storage/)

SQLite adapter wrapping `better-sqlite3`. Sets pragmas (WAL, busy_timeout, foreign_keys, trusted_schema=OFF). Migration runner (reads schema_version, runs migrations in order). DB path migration logic (knowledge.db → brain.db copy).

**Files:**
- `brain-mcp-server/src/engine/storage/adapter.ts`
- `brain-mcp-server/src/engine/storage/sqlite.ts`

### Phase 4: Component Registry (registry.ts)

Component loader with dependency resolution (topological sort). For each component: run migrations → init(ctx) → register tools → wire events. Shutdown in reverse order.

**File:** `brain-mcp-server/src/engine/registry.ts`

### Phase 5: API Gateway (gateway.ts)

Dynamic tool registry replacing the two 27-case switch statements. `register()`, `listTools()`, `dispatch()`. Reduces `createBrainServer()` from ~750 lines to ~15 lines.

**File:** `brain-mcp-server/src/engine/gateway.ts`

### Phase 6: Domain Components (8 components)

Wrap each existing tool module as a BrainComponent. Minimal code changes — structural wrapping only. Components import existing handler functions from `../../tools/*.ts`. Each component declares its schema (extracted from db.ts), tools (extracted from index.ts), and events.

**Files:**
- `brain-mcp-server/src/engine/components/memory/index.ts`
- `brain-mcp-server/src/engine/components/errors/index.ts`
- `brain-mcp-server/src/engine/components/projects/index.ts`
- `brain-mcp-server/src/engine/components/metrics/index.ts`
- `brain-mcp-server/src/engine/components/sessions/index.ts`
- `brain-mcp-server/src/engine/components/briefs/index.ts`
- `brain-mcp-server/src/engine/components/instances/index.ts`
- `brain-mcp-server/src/engine/components/sync/index.ts`

### Phase 7: Rewrite index.ts

Replace monolith entry point with engine bootstrap: parse config → create adapter → create bus → create registry → register components → boot → create gateway → create MCP server → wire transport. Keep HTTP/REST routes.

**File:** `brain-mcp-server/src/index.ts`

### Phase 8: Config Schema

Extend `~/.igris/config.json` with `engine` section for component config. Additive changes only (never remove existing keys). Default all components enabled.

### Phase 9: Database Migration

Safe file copy from `knowledge.db` to `brain.db` on first boot. Verify row counts. Never delete source. Create `~/.igris/data/` directory.

### Phase 10: Integration Testing

Boot test, tool parity test (all 27), disable test, event test, DB migration test, HTTP transport test.

### Phase 11: Update Brain Init Script

Update `igris_brain_init.sh` to create `~/.igris/data/` directory and include engine config in template.

---

## Dependency Graph

```
Phase 1 (types)
    |
    +---> Phase 2 (bus) --------+
    |                            |
    +---> Phase 3 (storage) ----+---> Phase 4 (registry) ---> Phase 5 (gateway)
                                           |                        |
                                           v                        v
                                  Phase 6 (components) -----> Phase 7 (index.ts)
                                                                    |
                                                                    v
                                                    Phase 8 (config) + Phase 9 (migration)
                                                                    |
                                                                    v
                                                        Phase 10 (testing) ---> Phase 11 (init script)
```

Each phase produces a working system. After Phase 6+7, the full system works through the engine.

---

## Highest-Risk Area: getDb() Singleton

The `getDb()` singleton in `db.ts` is the most dangerous aspect. Currently all tool modules import `{ getDb }` and get a shared connection. The engine creates its own StorageAdapter with its own connection.

**Solution:** Update `db.ts` to delegate to the adapter:

```typescript
let _adapter: StorageAdapter | null = null;

function setAdapter(adapter: StorageAdapter): void {
  _adapter = adapter;
}

function getDb(): Database.Database {
  if (_adapter) {
    return (_adapter as SqliteAdapter).rawConnection;
  }
  // Legacy fallback
  if (!_db) { _db = new Database(DB_PATH); /* pragmas */ }
  return _db;
}
```

Once the engine calls `setAdapter()`, all tool modules get the same underlying connection. Zero code changes in tool modules.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Tool schema drift (inline schemas vs extracted) | High | High | Automated diff of all 27 inputSchema objects |
| Database locking (two connections) | Medium | High | `setAdapter()` bridge — single connection |
| HTTP session handling regression | Medium | High | Keep `runHttp()` code as-is, only change `createBrainServer()` |
| REST API endpoints not covered | Low | Medium | Keep REST handlers in index.ts using getDb() |
| Config file corruption | Low | Medium | Additive changes only, atomic writes |
| DB migration data loss | Low | Critical | Copy to temp, verify counts, then rename. Never delete source |
| Performance regression | Low | Low | Gateway.dispatch is Map.get() + function call. Negligible |

---

## File Summary

| Category | Files | Action |
|----------|-------|--------|
| Engine core | 5 | CREATE (types, bus, registry, gateway, index) |
| Storage layer | 2 | CREATE (adapter, sqlite) |
| Domain components | 8 | CREATE |
| Entry point | 1 | MODIFY (index.ts) |
| Package files | 1 | MODIFY (package.json) |
| **Total** | **17** | **15 create, 2 modify** |

---

**Created:** 2026-02-17
**Architect:** Crimson ARCHITECT Agent
