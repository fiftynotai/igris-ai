# FR-065: Distributed Task Orchestration — Multi-Agent Worker System

**Type:** FR
**Priority:** P1
**Effort:** TBD
**Status:** Ready
**Created:** 2026-02-25
**Completed:** _TBD_

---

## Problem

Igris tasks are currently inert records in the brain database. No agent can autonomously poll for, claim, execute, and complete tasks. The task system has full CRUD (10 MCP tools, DAG dependencies, assignments) but no execution layer.

Key gaps:
1. No task type system — tasks have no semantic type (dev, content, media, research) to route correctly
2. No agent-as-worker registration — instances register presence but not capabilities (what they can do)
3. No task claim/poll with capability filtering — `igris_task_next` exists but doesn't match agent capabilities to task types
4. No task result storage — no standard place for task outputs (commits, files, text, images)
5. No task handler skills — no portable instructions for how to handle each task type
6. No worker daemon — no process that auto-spawns Claude sessions to handle assigned tasks
7. No auto-routing — coordinator can't auto-assign tasks to best-fit online agent

Current state: tasks table, task_deps, task_assignments, agent_capabilities tables all exist. 5 orphan task lifecycle events (created, assigned, completed, blocked, unblocked) are emitted but unlistened. The infrastructure is built, the execution layer is missing.

---

## Goal

Build the execution layer for distributed task orchestration across machines and AI agents.

**Task Type System:**
- Define task types: dev, content, social-media, media-gen, research, operational
- Each type has a handler skill (portable markdown file) that any agent can load
- Task creation requires a type, task routing uses type → capability matching

**Agent-as-Worker Registration:**
- Extend `igris_instance_heartbeat` to accept a capabilities list (e.g., ["dev", "research", "code-review"])
- Store capabilities in instances table (or agent_capabilities)
- Any CLI agent that speaks MCP can register: Claude Code, Gemini CLI, Codex, OpenCode, OpenClaw

**Task Claim and Routing:**
- Extend `igris_task_next` with capability filtering — only return tasks the agent can handle
- Add `igris_task_claim` tool — agent atomically claims a task (prevents double-assignment)
- Auto-routing: coordinator matches task type to online agent capabilities, assigns automatically
- Manual override: user can explicitly assign task to specific agent/machine

**Task Result Storage:**
- `task_results` table in brain: task_id, result_type (commit, file, text, url), content/path, created_at
- Output folder convention: `~/.igris/output/{task-type}/` for file-based results
- Results accessible from any machine via brain MCP (`igris_task_result_get`)

**Task Handler Skills (Portable Markdown):**
- `skills/task-handlers/dev.md` — Read brief, plan, code, test, commit
- `skills/task-handlers/social-media.md` — Write post, save to output/social/
- `skills/task-handlers/media-gen.md` — Generate image/video via MCP, save to output/media/
- `skills/task-handlers/research.md` — Research topic, save findings to output/research/
- Skills are agent-agnostic — any CLI agent reads the markdown and follows instructions

**Worker Daemon:**
- Simple polling loop script: `igris_worker.sh`
- Polls brain every 30s for assigned tasks via `igris_task_next`
- Spawns `claude -p "Handle task T-{id}"` for each task (headless, non-interactive)
- Claude reads `~/.claude/CLAUDE.md` (global Igris identity already installed) — no system prompt passing needed
- Worker auto-sleeps when no tasks, auto-wakes when tasks appear
- Configurable: max concurrent tasks, poll interval, allowed task types

**Wire Orphan Task Events:**
- `task.created` → coordination logs + auto-routing attempt
- `task.assigned` → coordination logs assignment
- `task.completed` → coordination checks DAG deps, unblocks downstream, records metrics
- `task.blocked` → coordination logs blocker, attempts self-heal
- `task.unblocked` → coordination triggers next agent pickup

**Global CLAUDE.md Enhancement:**
- Expand `~/.claude/CLAUDE.md` to include core Igris worker identity + brain MCP connection
- Any `claude -p` spawn automatically becomes Igris-aware without explicit system prompt
- `igris_install.sh` already manages this file — extend it

**Configuration:**
- `config.json` gains: `worker.enabled`, `worker.poll_interval_s`, `worker.max_concurrent`, `worker.allowed_types`
- `coordination_config` table gains: `auto_route_enabled` flag
- Manual assignment always available regardless of auto-route setting

---

## Tasks

### Pending
- [ ] TBD

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** Brief created
**Next Steps When Resuming:** Define tasks and acceptance criteria
**Last Updated:** 2026-02-25
**Blockers:** None

---

## Acceptance Criteria

1. [ ] TBD

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
