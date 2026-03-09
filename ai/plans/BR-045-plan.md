# BR-045 Implementation Plan

## Summary

Fix silent brain sync failures by adding visible warnings, a local file-based sync queue fallback, and reconciliation on `/awaken`.

## Files to Modify

1. `.claude/skills/hunt/SKILL.md` -- Add warning + local queue fallback when `igris_brief_sync` fails
2. `.claude/skills/register/SKILL.md` -- Add warning + local queue fallback when `igris_brief_create` fails
3. `.claude/skills/awaken/SKILL.md` -- Add local sync queue drain step + drift detection
4. `.claude/skills/sync/SKILL.md` -- Add local sync queue drain step

## Implementation Steps

### 1. Hunt SKILL.md Changes (Phase 1 INIT, Phase 7 COMMITTING)

In Phase 1 INIT (line ~91-101) and Phase 7 COMMITTING (line ~413):
- Replace "skip silently. No errors." with:
  - Try `igris_brief_sync` call
  - If MCP unavailable or call fails:
    - Display visible warning: `WARNING: Brain sync skipped for {BRIEF_ID} — MCP unavailable. Queued locally.`
    - Append sync operation to `~/.igris/cache/{project}/sync_queue.jsonl`

### 2. Register SKILL.md Changes (Step 5)

In Step 5 (line ~142):
- The fallback to cache file already exists
- Add: when `igris_brief_create` fails, also append to local sync queue
- Display visible warning

### 3. Awaken SKILL.md Changes (new step 3.6.5)

Add new step after 3.6.4:
- Read `~/.igris/cache/{project}/sync_queue.jsonl`
- If entries exist and brain MCP is available:
  - Process each entry (call appropriate MCP tool)
  - Remove processed entries
  - Display summary: "Drained X local sync queue entries"
- If brain MCP still unavailable: display warning about pending queue

### 4. Sync SKILL.md Changes (Step 4)

Add local queue drain before remote queue drain:
- Read `~/.igris/cache/{project}/sync_queue.jsonl`
- Process entries via brain MCP tools
- Display count

## Local Sync Queue Format

File: `~/.igris/cache/{project}/sync_queue.jsonl`

Each line is a JSON object:
```json
{"timestamp":"2026-03-09T10:00:00Z","operation":"brief_sync","project":"igris-ai","brief_id":"BR-045","title":"...","status":"In Progress","priority":"P1-High","effort":"M-Medium","brief_type":"Bug","phase":"INIT"}
```

## Risk Assessment

- **Low risk**: Changes are to markdown skill instructions only, not executable code
- **No regressions**: When MCP IS available, behavior is unchanged (sync succeeds, no queue entry)
- **Human-readable**: JSONL format is easy to inspect and debug
