# MG-012: Migrate Crimson Arena to Standalone Claude Code Plugin

**Type:** Migration
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** In Progress
**Created:** 2026-02-22

---

## Current State

**What's the problem with the current implementation?**

Crimson Arena (Flutter web dashboard) lives inside the igris-ai monorepo at `dashboard/crimson-arena/`. It depends on 7 `fifty_*` packages via hardcoded local paths (`../../../fifty_eco_system/packages/...`). Anyone cloning igris-ai cannot build the dashboard without the exact local directory structure.

The dashboard is 15.4K Dart LOC + 2K Python LOC (server), 205 files, with a 62MB build output — significant weight in a repo whose core purpose is an AI engineering OS, not a web dashboard.

**Why does it need to change?**

1. **Distribution:** Claude Code now has a native plugin system with marketplaces. Crimson Arena should be installable via `claude plugin install` instead of requiring a full repo clone
2. **Separation of concerns:** Igris AI = engineering OS (briefs, sessions, agents, quality gates). Crimson Arena = monitoring dashboard. Different release cadences, different audiences
3. **Dependency blocker:** TD-018 (fifty_* pub.dev migration) is the last v4.0 blocker. Moving to its own repo with pub.dev deps solves this cleanly
4. **Build isolation:** igris-ai repo shouldn't require Flutter SDK. Dashboard users shouldn't need the full igris-ai source

**Current directory structure:**
```
igris-ai/
├── dashboard/
│   ├── server.py              # FastAPI backend (2031 LOC)
│   ├── test_server.py         # Server tests (181 LOC)
│   ├── requirements.txt       # Python deps
│   ├── arena.db               # SQLite event store
│   ├── static/                # Vanilla JS fallback
│   └── crimson-arena/         # Flutter web app (91 Dart files)
│       ├── pubspec.yaml       # 7 fifty_* local path deps
│       ├── lib/               # 15.4K Dart LOC
│       └── build/web/         # 62MB compiled output
```

---

## Target State

**What should it look like after migration?**

Two separate repositories:

### igris-ai (core repo — lighter)
```
igris-ai/
├── .claude/                   # Agents, hooks, rules, skills (unchanged)
├── ai/                        # Briefs, session, context (unchanged)
├── mcp-server/                # Brain MCP server (unchanged)
├── scripts/                   # Shell scripts (unchanged)
└── (no dashboard/ directory)
```

### crimson-arena (new plugin repo)
```
crimson-arena/
├── .claude-plugin/
│   └── plugin.json            # Plugin manifest
├── skills/
│   └── dashboard/
│       └── SKILL.md           # /crimson-arena:dashboard launch command
├── hooks/
│   └── hooks.json             # SessionStart/SessionEnd for server lifecycle
├── .mcp.json                  # Brain MCP server config (optional)
├── server/
│   ├── server.py              # FastAPI backend (moved from dashboard/)
│   ├── test_server.py         # Server tests
│   └── requirements.txt       # Python deps
├── crimson-arena/             # Flutter web app
│   ├── pubspec.yaml           # fifty_* from pub.dev (no local paths)
│   ├── lib/                   # Flutter source
│   └── build/web/             # Pre-built output (shipped with plugin)
├── scripts/
│   ├── start_server.sh        # Launch dashboard server
│   └── stop_server.sh         # Stop dashboard server
├── README.md
├── LICENSE
└── CHANGELOG.md
```

---

## Migration Steps

1. [ ] Create new `crimson-arena` GitHub repo under fiftynotai org
2. [ ] Set up plugin structure (`.claude-plugin/plugin.json`, skills/, hooks/)
3. [ ] Move `dashboard/crimson-arena/` Flutter app to new repo
4. [ ] Move `dashboard/server.py` + `test_server.py` + `requirements.txt` to `server/`
5. [ ] Update `pubspec.yaml` — replace all 7 local path deps with pub.dev versions (resolves TD-018)
6. [ ] Update `server.py` path resolution — use `${CLAUDE_PLUGIN_ROOT}` and `CLAUDE_PROJECT_DIR`
7. [ ] Create `/crimson-arena:dashboard` skill (SKILL.md) for launching the dashboard
8. [ ] Create hooks.json for optional server auto-start on SessionStart
9. [ ] Add `.mcp.json` for brain server integration (optional, graceful degradation)
10. [ ] Verify `flutter build web --release` succeeds with pub.dev packages
11. [ ] Test plugin install via `claude --plugin-dir ./crimson-arena`
12. [ ] Remove `dashboard/` directory from igris-ai repo
13. [ ] Update igris-ai README and docs to reference plugin
14. [ ] Publish plugin to marketplace (GitHub-based)

---

## Tasks

### Pending
- [ ] Task 1: Create new GitHub repo and plugin scaffold
- [ ] Task 2: Move Flutter app and update pub.dev dependencies
- [ ] Task 3: Move and adapt server.py for plugin context
- [ ] Task 4: Create skill, hooks, and MCP config
- [ ] Task 5: Build, test, and verify plugin install
- [ ] Task 6: Remove dashboard/ from igris-ai + update docs
- [ ] Task 7: Publish to marketplace

---

## Workflow State

**Phase:** COMMITTING
**Active Agent:** none
**Retry Count:** 0

### Current Work
Brief registered, awaiting hunt command.

### Next Steps
Architect to plan detailed migration with file-level mapping.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-22 | architect | Planning MG-012 scope | COMPLETE — 14 files, 9 phases, M-effort auto-approved |
| 2026-02-22 | forger | Implement MG-012 removal | COMPLETE — 2 deleted, 10 modified |
| 2026-02-22 | sentinel | Validate MG-012 implementation | PASS — scripts pass shellcheck, no dangling refs, git clean |
| 2026-02-22 | warden | Review MG-012 changes | APPROVE — 3 minor findings, 2 fixed pre-commit |

### Blockers
None — fifty_* packages confirmed published on pub.dev.

---

## Impact Assessment

### Affected Files (igris-ai repo — removals)
- [ ] `dashboard/` — entire directory removed (205 files)
- [ ] `README.md` — update dashboard references to point at plugin
- [ ] `ai/session/CURRENT_SESSION.md` — update to reflect migration
- [ ] `CLAUDE.md` — remove dashboard references if any

### Affected Files (new repo — creations)
- [ ] `.claude-plugin/plugin.json` — plugin manifest
- [ ] `skills/dashboard/SKILL.md` — launch skill
- [ ] `hooks/hooks.json` — server lifecycle hooks
- [ ] `.mcp.json` — brain MCP config
- [ ] `server/server.py` — adapted FastAPI backend
- [ ] `crimson-arena/pubspec.yaml` — pub.dev dependencies
- [ ] `scripts/start_server.sh`, `stop_server.sh` — server scripts

### Breaking Changes
- [x] **Yes** — `dashboard/` removed from igris-ai. Users must install the plugin separately.

### Dependencies
- [ ] Resolves: TD-018 (fifty_* pub.dev migration)
- [ ] Depends on: fifty_* packages published on pub.dev (confirmed)

---

## Testing Strategy

### Existing Tests
- [ ] `dashboard/test_server.py` — move to new repo, verify passes
- [ ] `dashboard/crimson-arena/test/` — move to new repo, verify passes

### New Tests Required
- [ ] Plugin install test: `claude --plugin-dir ./crimson-arena` loads without errors
- [ ] Skill invocation test: `/crimson-arena:dashboard` launches server
- [ ] Build test: `flutter build web --release` with pub.dev deps succeeds
- [ ] API test: All REST endpoints respond correctly from plugin context

### Manual Testing

#### Test Case 1: Plugin Installation
**Steps:**
1. Clone crimson-arena repo
2. Run `claude --plugin-dir ./crimson-arena`
3. Verify plugin appears in `/plugin` list
4. Invoke `/crimson-arena:dashboard`

**Expected:** Dashboard server starts, browser opens at localhost:8001
**Status:** [ ] Pass / [ ] Fail

#### Test Case 2: Metrics Collection
**Steps:**
1. Install plugin in a project with igris-ai configured
2. Run some agent operations to generate metrics
3. Open dashboard and verify data appears

**Expected:** Agent metrics, battle log, and brain status display correctly
**Status:** [ ] Pass / [ ] Fail

---

## Rollback Plan

**If migration causes issues:**

1. Revert igris-ai commit that removes `dashboard/`
2. Dashboard continues working from monorepo as before
3. Plugin repo can be developed in parallel without affecting igris-ai

**Rollback safe until:** Dashboard directory removed from igris-ai and pushed to main

---

## Acceptance Criteria

1. [ ] New `crimson-arena` repo exists with valid plugin structure
2. [ ] `plugin.json` manifest is valid and complete
3. [ ] All 7 `fifty_*` packages reference pub.dev versions (no local paths)
4. [ ] `flutter pub get` succeeds in new repo
5. [ ] `flutter build web --release` succeeds in new repo
6. [ ] `claude --plugin-dir ./crimson-arena` installs without errors
7. [ ] `/crimson-arena:dashboard` skill launches the dashboard
8. [ ] Dashboard displays agent metrics from host project
9. [ ] Brain integration works (optional, graceful degradation)
10. [ ] `dashboard/` directory removed from igris-ai repo
11. [ ] igris-ai README updated with plugin install instructions
12. [ ] TD-018 can be marked as Done (pub.dev deps resolved)

---

## References

**Related Briefs:**
- Resolves: TD-018 (fifty_* pub.dev migration)
- Supersedes: TD-018 scope (pub.dev migration now part of this migration)
- Related: FR-051-FR-056 (Brain v5.0 — may affect dashboard API contract later)

**Claude Code Plugin Docs:**
- Plugin creation: code.claude.com/docs/en/plugins
- Plugin reference: code.claude.com/docs/en/plugins-reference
- Marketplaces: code.claude.com/docs/en/plugin-marketplaces
- Official plugins: github.com/anthropics/claude-plugins-official

**Codebase Analysis:**
- Dashboard coupling: LOW (API-driven, no source imports)
- Data sources: 4 local JSON files + optional brain server
- Server endpoints: 20+ REST + 1 WebSocket (stable contract)

---

## Notes

- The fifty_* packages are now published on pub.dev (blocker resolved)
- Dashboard is already architecturally independent — API-driven with no source code coupling
- Plugin `${CLAUDE_PLUGIN_ROOT}` env var resolves paths at runtime
- Consider shipping pre-built `build/web/` in the plugin to avoid Flutter SDK requirement for end users
- Vanilla JS fallback (`dashboard/static/`) can be included as lightweight alternative

---

**Created:** 2026-02-22
**Last Updated:** 2026-02-22
**Brief Owner:** Crimson
