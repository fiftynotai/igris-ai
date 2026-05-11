# FORGER Memory

## FR-063 Migration Pattern (2026-02-24)

Path migration from project-local `ai/briefs/` and `ai/session/` to MCP-first with `~/.igris/cache/{project}/` fallback.

- **Briefs**: MCP (`igris_brief_get/list/create/update`) -> cache (`~/.igris/cache/{slug}/briefs/`)
- **Session files**: Cache at `~/.igris/cache/{slug}/session/CURRENT_SESSION.md` etc.
- **Metrics**: Cache at `~/.igris/cache/{slug}/metrics/`
- **Hooks**: Cache paths only (no legacy fallback — v5 hard cutover)
- **Templates**: Stay at `ai/templates/` (project-local scaffolding)
- **Context/Masks/Prompts**: Stay at `ai/context/`, `ai/masks/`, `ai/prompts/` (project-local)
- **Hook scripts**: Derive slug via `basename "$PROJECT_DIR"` for cache path construction

See `/Users/m.elamin/StudioProjects/igris-ai/.claude/agent-memory/forger/fr063-files.md` for full file list.

## TD-074 Perception Events Architecture (2026-04-30)

- [TD-074 Perception Events](td074-perception-events.md) — Detached CLI cannot use bus.emit (no engine boot in spawned process). Solution: `writePerceptionEvent(db, name, payload)` writes directly to event_log mirroring monitoring.onEventReceived shape. Lifecycle invariant: exactly one terminal event per run_started. Repo `core/` is NOT symlinked to `~/.igris/core/` — mirror manually.
