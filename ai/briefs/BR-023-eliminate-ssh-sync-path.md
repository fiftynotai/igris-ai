# BR-023: Eliminate SSH Sync Path — Move All Data Sync to MCP

**Type:** Bug Fix / Tech Debt
**Priority:** P2-Medium
**Effort:** M-Medium (4-8h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-18

---

## Problem

The `/sync data` skill has two redundant data sync paths:
1. **MCP path** — `igris_brain_push`/`igris_brain_pull` via the brain server HTTP API
2. **SSH path** — SCP file uploads + raw SQL merge via SSH

The SSH path is legacy from before the MCP sync tools existed. It causes:
- **Redundant DB syncing** — step [4/4] (raw SQL merge) duplicates what `igris_brain_push` already does
- **`sync_state` tracking gap** — SSH uploads bypass `sync_state`, so the Sync Pipeline dashboard shows stale "last push/pull" timestamps even after a fresh sync
- **Unnecessary complexity** — two transport mechanisms doing the same job
- **Three flat files not covered by MCP** — `events.jsonl`, `agent-metrics.json`, `budget.json` are only synced via SCP because no MCP tool handles them

---

## Goal

All data sync happens through MCP tools. Zero SSH dependency for `/sync data`. The Sync Pipeline dashboard shows accurate timestamps for all sync operations.

---

## Context & Inputs

### Current Architecture
- `brain-mcp-server/src/tools/sync.ts` — MCP sync tools (`igris_brain_push`, `igris_brain_pull`, `igris_sync_queue_drain`)
- `brain-mcp-server/src/index.ts` — Brain server HTTP endpoints including `POST /sync/push`, `POST /sync/pull`
- `.claude/skills/sync/SKILL.md` — Sync skill definition with both MCP and SSH paths
- `~/.igris/config.json` — VPS and remote brain configuration

### Files Not Currently Synced via MCP
| File | Purpose | Used By |
|------|---------|---------|
| `ai/session/metrics/events.jsonl` | Cost tracking events | Crimson Arena file watcher → arena.db |
| `ai/session/metrics/agent-metrics.json` | Agent performance stats | Crimson Arena `/api/agents` endpoint |
| `ai/session/metrics/budget.json` | Daily budget thresholds | Crimson Arena budget display |

### What SSH Path Currently Does
1. **[3/4] SCP uploads** — `events.jsonl`, `agent-metrics.json`, `budget.json` to VPS
2. **[4/4] DB merge** — Dumps local brain DB as SQL, uploads, executes on VPS via SSH

### What MCP Path Currently Does
1. **[1/4] Drain sync queue** — Retry failed push operations
2. **[2/4] Brain push** — Sync DB tables (learnings, sessions, brief_status, agent_metrics, projects) via HTTP API

---

## Fix Plan

### Phase 1: Add File Sync MCP Tools

Add two new MCP tools to `brain-mcp-server/src/tools/sync.ts`:

1. **`igris_file_push`** — Push a file's content to the remote brain server
   - Accepts: `file_type` (events|agent_metrics|budget), `content` (file contents)
   - Brain server stores the file at the correct path
   - Updates `sync_state` with push timestamp

2. **`igris_file_pull`** — Pull a file from the remote brain server
   - Accepts: `file_type` (events|agent_metrics|budget)
   - Returns file content for local storage

Add corresponding HTTP endpoints to `brain-mcp-server/src/index.ts`:
- `POST /sync/file-push` — Receive file content, write to VPS path
- `GET /sync/file-pull/:type` — Return file content

### Phase 2: Update /sync Skill

Rewrite `.claude/skills/sync/SKILL.md` data sync section:
- Remove all SSH/SCP commands (steps [3/4] and [4/4])
- Replace with MCP tool calls:
  1. `igris_sync_queue_drain` (existing)
  2. `igris_brain_push` (existing)
  3. `igris_file_push` for events.jsonl (new)
  4. `igris_file_push` for agent-metrics.json (new)
  5. `igris_file_push` for budget.json (new)
- Keep SSH only for `/sync code` (git deploy) and `/sync status` (health check) — those are fundamentally SSH operations

### Phase 3: Fix sync_state Tracking

Ensure all sync operations (including file pushes) update `sync_state` so the Sync Pipeline dashboard shows accurate timestamps.

### Phase 4: Fix Local sync_state

The local `sync_state` table has `last_push_at = 1970-01-01` for all rows. Fix the MCP push tool to update local `sync_state` after a successful push, not just remote.

---

## Acceptance Criteria

1. [ ] New `igris_file_push` MCP tool accepts file content and writes to VPS
2. [ ] New `igris_file_pull` MCP tool returns file content from VPS
3. [ ] Brain server has `POST /sync/file-push` and `GET /sync/file-pull/:type` endpoints
4. [ ] `/sync data` skill uses only MCP tools — no SSH/SCP for data
5. [ ] Sync Pipeline dashboard shows accurate last push/pull after `/sync data`
6. [ ] Local `sync_state` updated correctly after push
7. [ ] `/sync code` still uses SSH (unchanged)
8. [ ] `/sync status` still uses SSH (unchanged)

---

## Test Plan

1. Run `/sync data` — verify all 3 files synced via MCP (no SSH)
2. Check Sync Pipeline dashboard — last push/pull should be within seconds
3. Run `sqlite3 ~/.igris/memory/knowledge.db "SELECT * FROM sync_state;"` — verify local timestamps updated
4. Restart Crimson Arena on VPS — verify events.jsonl imported correctly
5. Check `/api/agents` on VPS — verify agent-metrics.json available

---

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Agent Log
- [2026-02-18] ARCHITECT: Plan complete — 3 files, 4 phases, M complexity. New `igris_file_push`/`igris_file_pull` MCP tools + HTTP endpoints, SKILL.md rewrite, sync_state fix.
- [2026-02-18] FORGER: Implementation complete — 3 files modified. Added handleFilePush/handleFilePull to sync.ts, MCP tool defs + HTTP endpoints + dispatch in index.ts, rewrote SKILL.md data sync to 5-step MCP-only.
- [2026-02-18] SENTINEL: PASS — Build clean (tsc zero errors), 7/7 acceptance criteria met, zero issues.
- [2026-02-18] WARDEN: APPROVE — Security solid, patterns consistent, zero critical/major issues. 4 minor suggestions (non-blocking).

---

**Created:** 2026-02-18
**Brief Owner:** Crimson
