# Agent Roster Display Template

Use this format when displaying agent status.

## Full Roster Format

```
                    AGENT ROSTER
           ═══════════════════════════════

### Tier 1: Core Workflow (5 agents)

┌───────────────┬────────────┬────────┬───────────┬────────────┐
│ Agent         │ Alias      │ Status │ Invokes   │ Last Used  │
├───────────────┼────────────┼────────┼───────────┼────────────┤
│ planner       │ ARCHITECT  │ Active │ 42        │ 2026-02-06 │
│ coder         │ FORGER     │ Active │ 38        │ 2026-02-06 │
│ tester        │ SENTINEL   │ Active │ 35        │ 2026-02-06 │
│ reviewer      │ WARDEN     │ Active │ 30        │ 2026-02-06 │
│ ui-designer   │ ARTISAN    │ Active │ 5         │ 2026-02-05 │
└───────────────┴────────────┴────────┴───────────┴────────────┘

### Tier 2: Documentation (3 agents)

┌───────────────┬────────────┬────────┬───────────┬────────────┐
│ Agent         │ Alias      │ Status │ Invokes   │ Last Used  │
├───────────────┼────────────┼────────┼───────────┼────────────┤
│ documenter    │ CHRONICLER │ Active │ 12        │ 2026-02-05 │
│ releaser      │ HERALD     │ Active │ 3         │ 2026-02-01 │
│ standardizer  │ LAWKEEPER  │ Active │ 2         │ 2026-01-28 │
└───────────────┴────────────┴────────┴───────────┴────────────┘

### Tier 3: Maintenance (3 agents)

┌───────────────┬────────────┬────────┬───────────┬────────────┐
│ Agent         │ Alias      │ Status │ Invokes   │ Last Used  │
├───────────────┼────────────┼────────┼───────────┼────────────┤
│ auditor       │ INQUISITOR │ Active │ 8         │ 2026-02-04 │
│ debugger      │ MENDER     │ Active │ 15        │ 2026-02-06 │
│ migrator      │ PATHFINDER │ Active │ 4         │ 2026-02-02 │
└───────────────┴────────────┴────────┴───────────┴────────────┘

### Tier 4: Innovation (2 agents)

┌───────────────┬────────────┬────────┬───────────┬────────────┐
│ Agent         │ Alias      │ Status │ Invokes   │ Last Used  │
├───────────────┼────────────┼────────┼───────────┼────────────┤
│ ideator       │ ORACLE     │ Active │ 6         │ 2026-02-03 │
│ explorer      │ SEEKER     │ Active │ 20        │ 2026-02-06 │
└───────────────┴────────────┴────────┴───────────┴────────────┘

### Tier 5: Custom (user-defined)

[None defined - use '/digivolve add' to create]

### Tier 6: Meta - Orchestration (4 agents)

┌─────────────────────────┬────────────┬────────┬───────────┬────────────┐
│ Agent                   │ Alias      │ Status │ Invokes   │ Last Used  │
├─────────────────────────┼────────────┼────────┼───────────┼────────────┤
│ multi-agent-coordinator │ CONDUCTOR  │ Active │ 2         │ 2026-02-05 │
│ agent-organizer         │ TACTICIAN  │ Active │ 1         │ 2026-02-04 │
│ context-manager         │ ARCHIVIST  │ Active │ 3         │ 2026-02-05 │
│ task-distributor        │ DISPATCHER │ Active │ 1         │ 2026-02-03 │
└─────────────────────────┴────────────┴────────┴───────────┴────────────┘

           ═══════════════════════════════
           Total Agents: 18 (17 built-in + 0 custom)
           Session Invocations: 227
           ═══════════════════════════════
```

## Compact Format (for quick reference)

```
Agents: 18 active | planner(42) coder(38) tester(35) reviewer(30) ...
Custom: 0 defined | Session invocations: 227
```
