# FR-052 Design Spec: Crimson Arena Dashboard Redesign

**Version:** v4.0
**Created:** 2026-02-17
**Status:** Approved Design

---

## Architecture: Two-Page Split

### Rationale

The current single-page design mixes two different user intents:

1. **"How is Igris doing?"** — Passive monitoring. Wide and shallow. Glance-friendly.
2. **"What is running right now?"** — Active investigation. Narrow and deep.

Splitting them creates a clean mental model: **HOME is the war room. INSTANCES is the operations floor.**

---

## Navigation

```
  [ HOME ]  [ INSTANCES (N) ]
     ^            ^
  active tab   badge pulses when N > 0

  - Client-side hash routing: /#home  /#instances
  - Vital signs strip visible on both pages (expanded on HOME, compact on INSTANCES)
  - WebSocket stays connected across tab switches
  - Deep links: /#instances/inst-abc-123 auto-expands specific instance
  - Keyboard: Ctrl+1 = HOME, Ctrl+2 = INSTANCES
```

---

## PAGE 1: HOME (General Overview)

Default landing page. System-wide health and stats. No instance-specific details.

### Content

| Section | Description |
|---------|-------------|
| Vital Signs Strip | Session HP, Data Load, Sync Pipeline status (expanded) |
| Token Breakdown | Input/output/cache bars with counts and percentages |
| Cost Estimate | Per-category cost with model rates, daily/weekly totals |
| Brain Command Center | System health, projects, brief status, recent sessions |
| Knowledge Base | Learnings/errors/patterns counts + recent entries |
| Skill Heatmap | Skill invocation counts with bar chart |
| Agent Roster | Condensed horizontal strip — all agents with levels, run counts |
| Battle Log | Global activity feed (newest first) |
| Overall Stats | Footer — total invocations, tokens, cost, uptime |

### Wireframe

```
+==========================================================================================+
|  [CRIMSON ARENA]              [ HOME ]  [ INSTANCES (2) ]         [*] LIVE  [Today|Week] |
+==========================================================================================+
|  SESSION HP ████████░░  72%  |  DATA LOAD ██████░░  34%  |  SYNC: SYNCED  Queue: 0      |
+==========================================================================================+
|                                                                                          |
|  +-------------------------------------------+  +--------------------------------------+|
|  |  TOKEN BREAKDOWN              -- Today     |  |  COST ESTIMATE                       ||
|  |                                            |  |                                      ||
|  |  Direct Tokens          186,812            |  |  Model: Opus 4.6                     ||
|  |  (+ 42,000 cached)                         |  |                                      ||
|  |                                            |  |  Input    18,200 x $5.00/M  = $0.09  ||
|  |  Input   [===========-------]  18K   34%   |  |  Output    8,600 x $25.00/M = $0.22  ||
|  |  Output  [=======-----------]   8K   16%   |  |  Cache R  42,000 x $0.50/M  = $0.02  ||
|  |  ──────────────────────────────────────    |  |  Cache C  12,000 x $6.25/M  = $0.08  ||
|  |  Cache Rd [=================-]  42K   78%  |  |  ──────────────────────────────────   ||
|  |  Cache Cr [=====-----------]    12K   22%  |  |  TOTAL                       $0.41   ||
|  |                                            |  |                                      ||
|  |  Total Invocations:              47        |  |  Today: $0.41 | Week: $3.82          ||
|  +-------------------------------------------+  +--------------------------------------+|
|                                                                                          |
|  BRAIN COMMAND CENTER                                              [*] HEALTHY           |
|  +----------------+ +----------------+ +-----------------+ +-----------------------+     |
|  | System Health  | | Projects     3 | | Brief Status 12 | | Recent Sessions     4 |     |
|  | Status: OK     | | igris-ai  ACT  | | Ready:    5     | | #42 igris-ai   2h ago |     |
|  | v4.0.0         | | kalvad    ACT  | | In Prog:  2     | | #41 kalvad     1d ago |     |
|  | Latency: 12ms  | | crimson   OFF  | | Done:     3     | | #40 igris-ai   2d ago |     |
|  | Records: 847   | |                | | Blocked:  1     | |                       |     |
|  +----------------+ +----------------+ +-----------------+ +-----------------------+     |
|                                                                                          |
|  +-------------------------------------------+ +---------------------------------------+|
|  | Knowledge Base                             | | Skill Heatmap              47 total   ||
|  | Learnings: 124  Errors: 18  Patterns: 42  | |  /hunt      ████████████████  18      ||
|  |                                            | |  /scan      ██████████        10      ||
|  | Recent:                                    | |  /register  ██████            6       ||
|  |  - Flutter MVVM pattern         (2h)      | |  /archive   ████             4        ||
|  |  - API error handling           (1d)      | |  /rest      ██              2         ||
|  |  - SQLite FTS5 optimization     (3d)      | |  /team      ██              2         ||
|  +-------------------------------------------+ +---------------------------------------+|
|                                                                                          |
|  AGENT ROSTER                                                                            |
|  +------+ +------+ +------+ +------+ +------+ +------+ +------+ +------+                |
|  | [IG] | | [AR] | | [FO] | | [SE] | | [WA] | | [ME] | | [SK] | | [SA] |                |
|  | IGRIS| |ARCHI | |FORGE | |SENTI | |WARDE | |MENDE | |SEEKE | | SAGE |                |
|  | Lv.4 | | Lv.3 | | Lv.3 | | Lv.2 | | Lv.2 | | Lv.1 | | Lv.1 | | Lv.1 |                |
|  | 47trn| |18 run| |22 run| |15 run| |12 run| | 4 run| | 3 run| | 2 run|                |
|  +------+ +------+ +------+ +------+ +------+ +------+ +------+ +------+                |
|                                                                                          |
|  BATTLE LOG                                                                              |
|  14:32  [ARCHITECT]  Planning BR-015                    2m14s   SUCCESS                  |
|  14:30  [IGRIS]      Hunt started: BR-015               --      ACTIVE                   |
|  14:28  [WARDEN]     Code review BR-012                 4m02s   APPROVE                  |
|  14:24  [SENTINEL]   Test suite BR-012                  1m18s   PASS                     |
|  14:22  [FORGER]     Implementing BR-012                8m44s   SUCCESS                  |
|                                                                                          |
|  Total Invocations: 847 | Total Tokens: 12.4M | Total Cost: $48.72 | Uptime: 14d       |
+==========================================================================================+
```

---

## PAGE 2: INSTANCES (Operations Floor)

Dedicated page for running instances. Everything is instance-centric.

### Content

| Section | Description |
|---------|-------------|
| Vital Signs Strip | Compact single-line (HP, CTX, Sync) |
| Instance Cards | All running instances — solo and team leads |
| Expanded Instance | Hunt pipeline + agents + gantt + execution log |
| Team (nested) | Team container nested inside parent instance |

### Instance Expand Logic

| Instance Type | Expanded View |
|---|---|
| **Solo instance** | Hunt pipeline + agent table + gantt timeline + execution log |
| **Team lead instance** | Team overview + per-teammate pipelines + coordination log + file ownership |

### Wireframe: Empty State

```
+==========================================================================================+
|  [CRIMSON ARENA]              [ HOME ]  [ INSTANCES (0) ]         [*] LIVE               |
+==========================================================================================+
|  HP: 72%  |  CTX: 34%  |  SYNC: OK                                                      |
+==========================================================================================+
|                                                                                          |
|                          .  .  .  .  .  .  .  .                                          |
|                        .                        .                                        |
|                       .    NO ACTIVE INSTANCES    .                                      |
|                        .                        .                                        |
|                          .  .  .  .  .  .  .  .                                          |
|                                                                                          |
|                  Start a session:     /awaken                                             |
|                  Begin a hunt:        /hunt BR-008                                       |
|                  Deploy a team:       /team hunt BR-008 BR-009                            |
|                                                                                          |
+==========================================================================================+
```

### Wireframe: Solo Instances

```
+==========================================================================================+
|  [CRIMSON ARENA]              [ HOME ]  [ INSTANCES (2) ]         [*] LIVE               |
+==========================================================================================+
|  HP: 72%  |  CTX: 34%  |  SYNC: OK                                                      |
+==========================================================================================+
|                                                                                          |
|  RUNNING INSTANCES                                              2 active / 0 idle        |
|                                                                                          |
|  +--- [*] macbook-pro / igris-ai / BR-015 / BUILDING --------- 12m34s --- [EXPAND] ----+|
|  |                                                                                       ||
|  |  HUNT PIPELINE: BR-015 "Add sync retry logic"                                        ||
|  |                                                                                       ||
|  |  [ PLAN ]------>[ BUILD ]------>[ TEST ]------>[ REVIEW ]------>[ DONE ]              ||
|  |    done          ACTIVE          --             --               --                   ||
|  |   (2m14s)       (10m20s)                                                              ||
|  |                                                                                       ||
|  |  TIMELINE                                                                             ||
|  |  14:30  INIT     ██ (12s)                                                             ||
|  |  14:30  architect ████████ (2m14s)  ok                                                ||
|  |  14:33  forger    ██████████████████████████>>> (10m20s running)                      ||
|  |                                                                                       ||
|  |  AGENTS IN THIS INSTANCE                                                              ||
|  |         IG    AR     FO     SE    WA    ME    SK                                      ||
|  |  Status --    done   RUN    --    --    --    --                                       ||
|  |  Time   --    2m14s  10m20s --    --    --    --                                       ||
|  |  Tokens --    12K    34K    --    --    --    --                                       ||
|  |                                                                                       ||
|  |  EXECUTION LOG                                                                        ||
|  |  14:33  FORGER    implementing sync retry with exponential backoff                    ||
|  |  14:30  ARCHITECT plan complete: 3 files, 2 test scenarios                            ||
|  |  14:30  IGRIS     Hunt started: BR-015                                                ||
|  |  Retries: 0/3                                                                         ||
|  +----------------------------------------------------------------------------------------+|
|                                                                                          |
|  +--- [*] macbook-pro / igris-ai / BR-012 / REVIEWING -------- 28m07s --- [EXPAND] ----+|
|  |  (collapsed)                                                                          ||
|  +----------------------------------------------------------------------------------------+|
+==========================================================================================+
```

### Wireframe: Team Nested Inside Parent Instance

Teams are NOT a separate section. They live inside the parent (team lead) instance.

```
+==========================================================================================+
|  [CRIMSON ARENA]              [ HOME ]  [ INSTANCES (4) ]         [*] LIVE               |
+==========================================================================================+
|  HP: 58%  |  CTX: 67%  |  SYNC: OK  Queue: 2                                            |
+==========================================================================================+
|                                                                                          |
|  RUNNING INSTANCES                                      1 solo + 1 team lead             |
|                                                                                          |
|  +--- [*] macbook-pro / igris-ai / TEAM LEAD -------------------- 18m22s -- [EXPAND] ---+
|  |                                                                                       |
|  |  TEAM: "parallel-hunt"  3 briefs  ████████████████░░░░░░  62%                         |
|  |                                                                                       |
|  |  +-- teammate-alpha / BR-015 / TESTING -------------------------------- 18m22s --+   |
|  |  |  [PLAN v]-->[BUILD v]-->[TEST >>]-->[REVIEW]-->[DONE]                          |   |
|  |  |  architect(2m) forger(8m) sentinel(running 8m)          62K tkn   Retry: 0/3   |   |
|  |  +--------------------------------------------------------------------------------+   |
|  |                                                                                       |
|  |  +-- teammate-bravo / BR-016 / BUILDING ------------------------------- 14m05s --+   |
|  |  |  [PLAN v]-->[BUILD >>]-->[TEST]-->[REVIEW]-->[DONE]                            |   |
|  |  |  architect(3m) forger(running 11m)                      48K tkn   Retry: 0/3   |   |
|  |  +--------------------------------------------------------------------------------+   |
|  |                                                                                       |
|  |  +-- teammate-charlie / FR-022 / REVIEWING ---------------------------- 22m11s --+   |
|  |  |  [PLAN v]-->[BUILD v]-->[TEST v]-->[REVIEW >>]-->[DONE]                        |   |
|  |  |  architect(2m) forger(10m) sentinel(3m) warden(running 7m) 88K  Retry: 1/3     |   |
|  |  +--------------------------------------------------------------------------------+   |
|  |                                                                                       |
|  |  COORDINATION LOG                           FILE OWNERSHIP                            |
|  |  14:52 charlie -> REVIEWING                 sync/retry.dart     -> alpha              |
|  |  14:49 alpha test started                   dashboard/          -> bravo              |
|  |  14:45 mender fixed sentinel on alpha       ui/heatmap.dart     -> charlie            |
|  |                                                                                       |
|  |  [ Broadcast ]  [ Team Status ]  [ Shutdown Team ]                                    |
|  +----------------------------------------------------------------------------------------+
|                                                                                          |
|  +--- [*] vps-brain / kalvad / BR-044 / BUILDING --------------- 6m12s --- [EXPAND] ----+
|  |  (solo instance — click to expand its own hunt pipeline + agents)                     |
|  +----------------------------------------------------------------------------------------+
+==========================================================================================+
```

---

## Information Architecture

| Content | HOME | INSTANCES |
|---------|------|-----------|
| Token breakdown + costs | Yes | No |
| Brain health, projects, sessions | Yes | No |
| Knowledge base, skill heatmap | Yes | No |
| Agent roster (all agents) | Yes | No |
| Battle log (global) | Yes | No |
| Overall stats | Yes | No |
| Vital signs (HP, CTX, Sync) | Expanded | Compact |
| Instance cards | No | Yes |
| Hunt pipeline per instance | No | Yes (expanded) |
| Gantt timeline | No | Yes (expanded) |
| Per-instance agent table | No | Yes (expanded) |
| Per-instance execution log | No | Yes (expanded) |
| Agent team (nested in parent) | No | Yes (expanded) |
| Team coordination + file ownership | No | Yes (expanded) |

---

## Design Principles

1. **Operational data first** — Running instances and pipeline progress dominate the Instances page
2. **Progressive disclosure** — Cards collapsed by default, expand on click
3. **Instance-centric** — Everything flows from "which instance am I looking at?"
4. **Teams are nested** — Team container lives inside parent instance, not as a separate section
5. **Dark theme** — Monitoring dashboard aesthetic with crimson accents
6. **Real-time** — WebSocket updates, pulsing indicators, live timers
7. **Persistent vitals** — HP/CTX/Sync visible on both pages

---

## Technical Notes

- Navigation: Client-side hash routing (`/#home`, `/#instances`)
- Deep links: `/#instances/inst-abc-123` auto-expands specific instance
- WebSocket: Single connection shared across both pages
- State: Shared ArenaClient object, both pages read same data
- Mobile: Tabs stack below title, instance cards stack vertically

---

**Design Owner:** Crimson Arena
**Implementation Brief:** FR-052
