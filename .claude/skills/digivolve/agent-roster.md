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
│ architect     │ ARCHITECT  │ Active │ 42        │ 2026-02-06 │
│ forger        │ FORGER     │ Active │ 38        │ 2026-02-06 │
│ sentinel      │ SENTINEL   │ Active │ 35        │ 2026-02-06 │
│ warden        │ WARDEN     │ Active │ 30        │ 2026-02-06 │
│ artisan       │ ARTISAN    │ Active │ 5         │ 2026-02-05 │
└───────────────┴────────────┴────────┴───────────┴────────────┘

### Tier 2: Documentation (3 agents)

┌───────────────┬────────────┬────────┬───────────┬────────────┐
│ Agent         │ Alias      │ Status │ Invokes   │ Last Used  │
├───────────────┼────────────┼────────┼───────────┼────────────┤
│ chronicler    │ CHRONICLER │ Active │ 12        │ 2026-02-05 │
│ herald        │ HERALD     │ Active │ 3         │ 2026-02-01 │
│ lawkeeper     │ LAWKEEPER  │ Active │ 2         │ 2026-01-28 │
└───────────────┴────────────┴────────┴───────────┴────────────┘

### Tier 3: Maintenance (3 agents)

┌───────────────┬────────────┬────────┬───────────┬────────────┐
│ Agent         │ Alias      │ Status │ Invokes   │ Last Used  │
├───────────────┼────────────┼────────┼───────────┼────────────┤
│ inquisitor    │ INQUISITOR │ Active │ 8         │ 2026-02-04 │
│ mender        │ MENDER     │ Active │ 15        │ 2026-02-06 │
│ pathfinder    │ PATHFINDER │ Active │ 4         │ 2026-02-02 │
└───────────────┴────────────┴────────┴───────────┴────────────┘

### Tier 4: Innovation (2 agents)

┌───────────────┬────────────┬────────┬───────────┬────────────┐
│ Agent         │ Alias      │ Status │ Invokes   │ Last Used  │
├───────────────┼────────────┼────────┼───────────┼────────────┤
│ oracle        │ ORACLE     │ Active │ 6         │ 2026-02-03 │
│ seeker        │ SEEKER     │ Active │ 20        │ 2026-02-06 │
└───────────────┴────────────┴────────┴───────────┴────────────┘

### Tier 5: Custom (user-defined)

[None defined - use '/digivolve add' to create]

### Tier 6: Meta - Orchestration (4 agents)

┌─────────────────────────┬────────────┬────────┬───────────┬────────────┐
│ Agent                   │ Alias      │ Status │ Invokes   │ Last Used  │
├─────────────────────────┼────────────┼────────┼───────────┼────────────┤
│ conductor               │ CONDUCTOR  │ Active │ 2         │ 2026-02-05 │
│ tactician               │ TACTICIAN  │ Active │ 1         │ 2026-02-04 │
│ archivist               │ ARCHIVIST  │ Active │ 3         │ 2026-02-05 │
│ dispatcher              │ DISPATCHER │ Active │ 1         │ 2026-02-03 │
└─────────────────────────┴────────────┴────────┴───────────┴────────────┘

           ═══════════════════════════════
           Total Agents: 18 (17 built-in + 0 custom)
           Session Invocations: 227
           ═══════════════════════════════
```

## Compact Format (for quick reference)

```
Agents: 18 active | architect(42) forger(38) sentinel(35) warden(30) ...
Custom: 0 defined | Session invocations: 227
```
