# FR-039: Sync Agent Definitions, Skills, and Rules to VPS Brain

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** L-Large (3-5d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2026-02-17

---

## Feature Description

**What is the proposed feature?**

Sync the Igris AI "DNA" — agent definitions (`.claude/agents/*.md`), skill definitions (`.claude/skills/`), rules (`.claude/rules/*.md`), and prompts (`ai/prompts/*.md`) — to the VPS brain. This enables the centralized brain to distribute updated agent behavior, skills, and rules to all connected machines. When Igris evolves on one machine, all machines evolve.

**Why is this valuable?**

This is the "clone itself" capability. Currently, agent definitions, skills, and rules are installed once (via `igris_brain_init.sh`) and never updated. When we improve an agent's prompt, add a new skill, or update a rule, those changes stay on the source machine. Other machines run stale versions. With this feature, the brain becomes the single source of truth for Igris behavior — every machine pulls the latest definitions.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] Contributors (extending Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
- Agent definitions at `~/.igris/core/agents/` are static copies from installation
- Skills at `~/.igris/core/skills/` frozen at install time
- Rules at `~/.igris/core/rules/` never updated after install
- Prompts at `~/.igris/core/prompts/` stale
- Improving an agent on Mac = VPS still runs old version
- No version tracking for definitions

**With this feature:**
- All Igris "DNA" files synced to VPS brain
- VPS brain distributes latest versions to all machines on /awaken
- Version tracking: know which version each machine runs
- One-push update: change agent definition → all machines get it next session
- True self-cloning distributed agent

---

## Technical Approach

### High-Level Design

1. **New sync tables** — `agent_definitions`, `skill_definitions`, `rule_definitions`, `prompt_definitions`
2. **Version tracking** — content hash + updated_at for change detection
3. **Push on change** — when any definition file modified, push to brain
4. **Pull on /awaken** — check for newer versions, update local copies
5. **Conflict resolution** — LWW on updated_at (most recent wins)

### Schema
```sql
CREATE TABLE definition_files (
  id TEXT PRIMARY KEY,  -- type:name (e.g., "agent:architect", "skill:awaken/SKILL.md")
  type TEXT NOT NULL CHECK (type IN ('agent', 'skill', 'rule', 'prompt')),
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  version TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(type, name)
);
```

### Files to Sync
| Type | Source | Pattern |
|------|--------|---------|
| agent | `.claude/agents/` | `*.md` |
| skill | `.claude/skills/` | `*/SKILL.md` |
| rule | `.claude/rules/` | `*.md` |
| prompt | `ai/prompts/` | `*.md` |

### Components Affected
- `brain-mcp-server/src/tools/sync.ts` — Add definition_files to SYNC_TABLES
- `brain-mcp-server/src/index.ts` — Schema migration, API endpoints
- `.claude/skills/awaken/SKILL.md` — Pull latest definitions on session start
- `scripts/igris_brain_init.sh` — Initial seed from source repo to brain

---

## Context & Inputs

### Dependencies
- [x] FR-033: Brain MCP HTTP transport fix
- [x] FR-034: Activate sync pipeline
- [ ] FR-035: Auto-sync hooks (triggers definition sync on edit)
- [ ] FR-036: Offline queue (reliability for definition sync)

### Files to Modify
- `brain-mcp-server/src/tools/sync.ts` — Add definition_files sync config
- `brain-mcp-server/src/index.ts` — Schema migration + API
- `.claude/skills/awaken/SKILL.md` — Definition pull step
- `scripts/igris_brain_init.sh` — Seed definitions to brain on install

---

## Constraints

### Technical Constraints
- Definition files are small (1-10KB each, ~30 files total)
- Total payload: ~100KB — well within sync limits
- Must not overwrite local customizations (user-modified agents)
- Need "source of truth" flag: which machine's version wins?
- Pull should only update if remote is newer (hash comparison)

### Out of Scope
- Per-machine agent customization (all machines get same definitions)
- Agent behavior A/B testing
- Rollback to previous versions (future)

---

## Tasks

### Pending
- [ ] Design `definition_files` schema and migration
- [ ] Add to SYNC_TABLES config in sync.ts
- [ ] Create `igris_definition_sync` MCP tool (push definitions)
- [ ] Create `igris_definition_pull` MCP tool (pull latest from brain)
- [ ] Seed initial definitions from source repo on brain install
- [ ] Update `/awaken` to check for newer definitions
- [ ] Add `GET /api/definitions` API endpoint for dashboard
- [ ] Test: update agent on Mac → push → pull on VPS → VPS has latest

---

## Workflow State

**Phase:** INIT
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered.

### Next Steps
Implement after FR-033, FR-034, and FR-037.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
- FR-033 (MCP tools must load)

---

## Acceptance Criteria

1. [ ] `definition_files` table exists in schema
2. [ ] Agent definitions synced to VPS brain
3. [ ] Skill definitions synced to VPS brain
4. [ ] Rule definitions synced to VPS brain
5. [ ] Prompt definitions synced to VPS brain
6. [ ] `/awaken` pulls newer definitions from brain
7. [ ] Version tracking via content hash
8. [ ] Local customizations not overwritten (LWW with explicit flag)
9. [ ] Dashboard shows definition versions across machines

---

## Notes

**Depends on:** FR-033, FR-034
**Enables:** True self-cloning distributed agent — evolve once, propagate everywhere
**This is the "brain clone" feature** — the core of the distributed Igris vision

---

**Created:** 2026-02-17
**Last Updated:** 2026-02-17
**Brief Owner:** Crimson (Fifty.ai)
