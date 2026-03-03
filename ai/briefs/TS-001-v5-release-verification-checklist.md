# TS-001: v5.0.0 Release Verification Checklist

**Type:** Testing
**Priority:** P0-Critical
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-03-04

---

## Problem

Igris AI v5.0.0 introduces 67 MCP tools, 29 REST endpoints, task orchestration, scheduling, coordination, monitoring, and a worker daemon. None of these have been end-to-end verified before release.

**Why does it matter?**

Shipping unverified features risks broken tools, silent data loss, or integration failures across all Igris-managed projects.

---

## Goal

Execute 100 structured tests across 4 tiers. Every test checked off with PASS/FAIL and timestamp. Zero critical failures before release.

---

## Tier 1 — Core Infrastructure

| # | Test | Status | Notes |
|---|------|--------|-------|
| 1.1 | `GET /health` returns `{ status: "ok", version: "5.0.0" }` | [ ] | |
| 1.2 | `igris_project_status` for igris-ai returns stats | [ ] | |
| 1.3 | `igris_event_log` has entries after any tool call | [ ] | |
| 1.4 | `GET /api/projects` without auth key returns 401 | [ ] | |
| 1.5 | `igris_brain_push` + `igris_brain_pull` round-trip succeeds | [ ] | |
| 1.6 | `igris_sync_queue_status` returns counts | [ ] | |

---

## Tier 2 — MCP Tools (65 tests)

### Memory (4 tools)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 2.1 | `igris_memory_store` — store test learning, confirm ID returned | [ ] | |
| 2.2 | `igris_memory_search` — search by keyword, find test learning | [ ] | |
| 2.3 | `igris_memory_recall` — recall with matching context, learning returned | [ ] | |
| 2.4 | `igris_pattern_suggest` — suggest patterns for known context | [ ] | |

### Errors (2 tests)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 2.5 | `igris_error_lookup` (store) — store error+solution pair | [ ] | |
| 2.6 | `igris_error_lookup` (search) — look up same error, solution returned | [ ] | |

### Projects (3 tools)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 2.7 | `igris_project_register` — register test-v5-verify project | [ ] | |
| 2.8 | `igris_project_list` — test-v5-verify in results | [ ] | |
| 2.9 | `igris_project_status` — igris-ai returns counts + metrics | [ ] | |

### Metrics (3 tools)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 2.10 | `igris_metrics_record` — record test metric, confirm | [ ] | |
| 2.11 | `igris_metrics_query` — query for igris-ai, test metric in results | [ ] | |
| 2.12 | `igris_metrics_velocity` — weekly buckets returned | [ ] | |

### Sessions (4 tools)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 2.13 | `igris_session_sync` — sync test session, confirm | [ ] | |
| 2.14 | `igris_session_recall` — recall last 2 days, test session appears | [ ] | |
| 2.15 | `igris_session_file_update` — update file, confirm hash returned | [ ] | |
| 2.16 | `igris_session_file_get` — get file, content matches what was written | [ ] | |

### Briefs (6 tools)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 2.17 | `igris_brief_create` — create TS-999 test brief, both records confirmed | [ ] | |
| 2.18 | `igris_brief_get` — get TS-999, metadata + content returned | [ ] | |
| 2.19 | `igris_brief_list` — list with status filter, TS-999 in results | [ ] | |
| 2.20 | `igris_brief_update` — update TS-999 status to Done, confirm | [ ] | |
| 2.21 | `igris_brief_sync` — sync TS-999 with new priority, confirm upsert | [ ] | |
| 2.22 | `igris_brief_dashboard` — cross-project summary returned | [ ] | |

### Tasks (13 tools)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 2.23 | `igris_task_create` — create dev task (priority=3), confirm ID | [ ] | |
| 2.24 | `igris_task_list` — test task appears in list | [ ] | |
| 2.25 | `igris_task_get` — full detail with deps + assignments | [ ] | |
| 2.26 | `igris_task_update` — update title, confirm changed | [ ] | |
| 2.27 | `igris_task_assign` — assign to "forger", status becomes active | [ ] | |
| 2.28 | `igris_task_claim` — create 2nd task, atomic claim succeeds | [ ] | |
| 2.29 | `igris_task_next` — create 3rd pending task with caps, next returns it | [ ] | |
| 2.30 | `igris_task_block` — block task-3 on task-2, dependency created | [ ] | |
| 2.31 | `igris_task_complete` — complete task-2, task-3 unblocked | [ ] | |
| 2.32 | `igris_task_fail` — fail task with reason, retry_count incremented | [ ] | |
| 2.33 | `igris_task_retry` — retry failed task, status back to pending | [ ] | |
| 2.34 | `igris_task_result_add` — add commit result, confirm ID | [ ] | |
| 2.35 | `igris_task_result_get` — get results for task, array returned | [ ] | |

### Instances (4 tools)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 2.36 | `igris_instance_heartbeat` — heartbeat with capabilities, ID returned | [ ] | |
| 2.37 | `igris_instance_list` — our instance appears in active list | [ ] | |
| 2.38 | `igris_agent_event` — record start event, confirm ID | [ ] | |
| 2.39 | `igris_instance_remove` — remove test instance, confirm deleted | [ ] | |

### Sync (8 tools)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 2.40 | `igris_brief_file_sync` — sync brief file, confirm hash | [ ] | |
| 2.41 | `igris_session_file_sync` — sync session file, confirm | [ ] | |
| 2.42 | `igris_session_file_pull` — pull session files, array returned | [ ] | |
| 2.43 | `igris_definition_sync` — sync agent definition, confirm | [ ] | |
| 2.44 | `igris_definition_pull` — pull definitions, array returned | [ ] | |
| 2.45 | `igris_file_push` — push events file, bytes written | [ ] | |
| 2.46 | `igris_file_pull` — pull events file, content returned | [ ] | |
| 2.47 | `igris_sync_queue_drain` — drain queue, count processed | [ ] | |

### Cache (2 tools)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 2.48 | `igris_cache_rebuild` — rebuild igris-ai briefs, file count > 0 | [ ] | |
| 2.49 | `igris_cache_clean` — clean test-v5-verify, confirm deleted | [ ] | |

### Schedules (7 tools)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 2.50 | `igris_schedule_create` — create noop schedule, ID + next_run_at | [ ] | |
| 2.51 | `igris_schedule_list` — test schedule appears | [ ] | |
| 2.52 | `igris_schedule_get` — schedule detail with run history | [ ] | |
| 2.53 | `igris_schedule_fire_now` — fire immediately, run record with success | [ ] | |
| 2.54 | `igris_schedule_disable` — enabled becomes false | [ ] | |
| 2.55 | `igris_schedule_enable` — enabled becomes true, next_run_at recalculated | [ ] | |
| 2.56 | `igris_schedule_delete` — confirm gone | [ ] | |

### Coordination (7 tools)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 2.57 | `igris_coordination_config_set` — set autonomous_enabled=true | [ ] | |
| 2.58 | `igris_coordination_config_get` — full config object returned | [ ] | |
| 2.59 | `igris_agent_capability_set` — set forger caps=["code","refactor"] | [ ] | |
| 2.60 | `igris_agent_capability_list` — forger appears with caps | [ ] | |
| 2.61 | `igris_coordination_adjust_priorities` — dry run, report returned | [ ] | |
| 2.62 | `igris_coordination_auto_route` — dry run, potential assignments | [ ] | |
| 2.63 | `igris_coordination_audit` — decision records returned | [ ] | |

### Monitoring (2 tools)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 2.64 | `igris_event_log` — query recent events, entries from test calls | [ ] | |
| 2.65 | `igris_event_log_cleanup` — cleanup retention_days=365, 0 deleted | [ ] | |

---

## Tier 3 — REST API (22 tests)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 3.1 | `GET /health` — 200 + version 5.0.0 | [ ] | |
| 3.2 | `GET /api/instances` — instance list returned | [ ] | |
| 3.3 | `GET /api/projects` — project list returned | [ ] | |
| 3.4 | `GET /api/briefs` — brief list with summary counts | [ ] | |
| 3.5 | `GET /api/briefs/velocity` — weekly velocity data | [ ] | |
| 3.6 | `GET /api/sessions` — recent sessions | [ ] | |
| 3.7 | `GET /api/brain-stats` — db size, counts, uptime | [ ] | |
| 3.8 | `GET /api/sync-status` — push/pull timestamps + queue depth | [ ] | |
| 3.9 | `GET /api/events` — event log entries | [ ] | |
| 3.10 | `GET /api/events/stream` — SSE stream (verify keepalive fires) | [ ] | |
| 3.11 | `GET /api/tasks` — task list with summary | [ ] | |
| 3.12 | `POST /api/agent-event` — 200 + id returned | [ ] | |
| 3.13 | `GET /api/instances/:id/agents` — per-instance agent stats | [ ] | |
| 3.14 | `GET /api/instances/:id/log` — agent execution log | [ ] | |
| 3.15 | `GET /api/agent-metrics/summary` — cross-instance summary | [ ] | |
| 3.16 | `GET /api/agent-metrics/by-project?agent=forger` — per-project | [ ] | |
| 3.17 | `GET /api/projects/:slug/budget` — budget data | [ ] | |
| 3.18 | `PUT /api/projects/:slug/budget` — update budget limit | [ ] | |
| 3.19 | `GET /api/briefs/:project/:briefId/content` — brief content | [ ] | |
| 3.20 | `GET /api/sessions/:project/files` — session files | [ ] | |
| 3.21 | `GET /api/definitions` — definition list | [ ] | |
| 3.22 | `DELETE /api/instances/:id` — confirm removal | [ ] | |

---

## Tier 4 — Integration / End-to-End (7 tests)

| # | Test | Status | Notes |
|---|------|--------|-------|
| 4.1 | Auto-push: sync brief via MCP → verify on VPS via REST | [ ] | |
| 4.2 | Auto-cache: create brief via MCP → verify file at `~/.igris/cache/` | [ ] | |
| 4.3 | Task DAG: create A→B→C deps, complete A → B unblocks → complete B → C unblocks | [ ] | |
| 4.4 | Schedule fire: create mcp-tool schedule, fire_now → verify run record | [ ] | |
| 4.5 | Self-heal: enable self-heal, fail task → child diagnostic task created | [ ] | |
| 4.6 | SSE stream: open stream, trigger event via MCP → event appears | [ ] | |
| 4.7 | Worker daemon: start → verify PID + heartbeat → stop → verify cleanup | [ ] | |

---

## Summary

| Tier | Tests | Passed | Failed | Skipped |
|------|-------|--------|--------|---------|
| Tier 1 — Core Infrastructure | 6 | | | |
| Tier 2 — MCP Tools | 65 | | | |
| Tier 3 — REST API | 22 | | | |
| Tier 4 — Integration | 7 | | | |
| **Total** | **100** | | | |

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Next Steps
Execute Tier 1 first, then Tier 2 sequentially, then Tier 3 via curl, then Tier 4 integration.

---

## Acceptance Criteria

1. [ ] All 100 tests executed and recorded in checklist above
2. [ ] Zero critical (Tier 1) failures
3. [ ] Zero Tier 2 CRUD failures
4. [ ] All REST endpoints return expected status codes
5. [ ] Integration tests confirm event-driven flows work
6. [ ] Test data cleaned up after verification
7. [ ] Summary table filled with final counts

---

**Created:** 2026-03-04
**Brief Owner:** Igris AI
