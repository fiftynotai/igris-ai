# Igris AI — Hook Event Schema (RETIRED)

**Status:** RETIRED 2026-08-26 by FR-267. This path is kept so inbound links
resolve; the contract it described no longer exists.

The HTTP hook-event receiver this document specified — `POST /api/hooks/event`
(FR-088) — was deleted from `brain-mcp-server/src/index.ts` by FR-267, together
with `POST /api/metrics` and the five `"type": "http"` hook groups in
`.claude/settings.json` (`Stop`, `SubagentStart`, `SubagentStop`,
`TaskCompleted`, `TeammateIdle`) that posted to it. Measured 2026-08-26:
nothing listened on `localhost:3001` (`curl` → HTTP 000, connection refused),
so those hooks had exited 0 and landed nothing since the local HTTP brain was
retired — the L-1248 class ("reports success without having checked") in
config form. FR-089, which shipped the wiring and was marked Done, is the
cautionary tale.

## What replaced it

- **The record:** `agent_events` — brain-timed, brief-keyed, one row per agent
  invocation (`model_requested`, `model_resolved`, `round`, `project`;
  `duration_ms` computed by the brain from its own start/stop timestamps;
  tokens NULL when unknown), plus the `hunt_runs` view that derives the
  per-agent / per-phase / per-hunt shape. Owner:
  `brain-mcp-server/src/engine/components/instances/index.ts` (migration v3).
  Durable — no purge.
- **The carrier:** the orchestrator, through the `igris_agent_event` MCP tool
  (harness-agnostic — R6 of FR-267). Harness hooks are not a carrier.
- **The control:** the `commit-msg` hook refuses a `closes #X` commit when a
  role named in X's Agent Log has no recorded agent event
  (`IGRIS_BYPASS_EVENT_GATE=1` is the one-shot escape hatch) — FR-267 Phase 5.
- **The reference:** `docs/reference/hunt-cost-record.md` (retention decision,
  schema, the R2 queries, known biases) — FR-267 Phase 6.

## Where the old contract went

The v1 payload schema (the `hook_event_name` routing into `agent_events`,
`agent_metrics` and `event_log`, the agent-name and action maps, the adapter
recipe) lives in git history: `git log --follow -- docs/HOOK_EVENT_SCHEMA.md`
and read the revision before the FR-267 commit. Do not rebuild it — nothing
should listen on port 3001 again (FR-267 Direction, row 5).
