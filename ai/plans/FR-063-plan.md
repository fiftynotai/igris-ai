# Implementation Plan: FR-063 — Brain v5.0 Skill & Rule Path Migration

**Complexity:** L (Large)
**Estimated Duration:** 2-3 days
**Risk Level:** High

## Summary

Migrate 12 skills, 2 rules, 2 prompts, 1 script, and 1 workflow template from project-local `ai/briefs/` and `ai/session/` references to MCP-first with `~/.igris/cache/{project}/` fallback.

## Scoping Groups

- **Group A (MUST MIGRATE):** Brief path references (`ai/briefs/`) → MCP-first + cache fallback
- **Group B (SESSION SPLIT):** Session files → cache-first at `~/.igris/cache/{project}/session/`, MCP sync at boundaries
- **Group C (NO CHANGE):** Metrics/data files (`ai/session/metrics/`) stay project-local
- **Group D (REMOVE):** Archive directory concept → DB status update
- **Group E (DOCS UPDATE):** Architecture descriptions in prompts

## Files to Modify (17 total)

### Skills (12 modify, 2 no-change)
| Skill | Brief refs | Session refs | Changes |
|-------|-----------|-------------|---------|
| hunt | 1 | 2 | MCP brief lookup, cache session |
| register | 5 | 1 | MCP brief create/list, cache session |
| scan | 1 | 2 | MCP brief list, cache session |
| archive | 4 | 4 | MCP status update (no file move) |
| awaken | 1 | 2 | MCP brief list, cache session |
| rest | 0 | 3 | Cache session paths |
| team | 5 | 8 | MCP brief validation, cache session |
| ideate | 1 | 0 | MCP brief create |
| audit | 1 | 0 | MCP brief create |
| migrate-analyze | 1 | 0 | MCP brief create |
| sync | 0 | 3 | NO CHANGE (metrics) |
| digivolve | 0 | 1 | NO CHANGE (metrics) |

### Other Files (5)
| File | Changes |
|------|---------|
| `.claude/rules/01-igris-init.md` | Brief/session paths to MCP/cache |
| `.claude/rules/02-igris-briefs.md` | Brief workflow to MCP-first |
| `ai/prompts/igris_os.md` | Major rewrite (23+ refs) |
| `ai/prompts/session_protocol.md` | Update to MCP/cache paths |
| `scripts/igris_install.sh` | Remove ai/briefs mkdir, create cache dirs |

### Delete (1)
| File | Reason |
|------|--------|
| `.claude/skills/hunt/scripts/validate-brief.sh` | Replaced by MCP validation |

## MCP-First Pattern

1. TRY MCP: `igris_brief_get`/`igris_brief_list`/`igris_brief_create`/`igris_brief_update`
2. FALLBACK: Cache at `~/.igris/cache/{project}/briefs/`
3. LAST RESORT: Legacy `ai/briefs/` (migration period only)

Session files: cache-first writes, MCP sync at /awaken (pull) and /rest (push).

## Phases

1. allowed-tools header updates (prerequisite)
2. Core skills (hunt, register, scan, archive)
3. Session skills (awaken, rest)
4. Satellite skills (team, ideate, audit, migrate-analyze)
5. Scripts (validate-brief.sh delete, install.sh, workflow-template.md)
6. Rules (01-igris-init, 02-igris-briefs)
7. Prompts (igris_os.md, session_protocol.md)
8. Verification and testing

---

**Created:** 2026-02-24
**Architect:** ARCHITECT Agent
