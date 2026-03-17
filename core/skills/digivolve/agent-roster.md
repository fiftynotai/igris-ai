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
│ architect     │ ARCHITECT  │ Active │ --        │ --         │
│ forger        │ FORGER     │ Active │ --        │ --         │
│ sentinel      │ SENTINEL   │ Active │ --        │ --         │
│ warden        │ WARDEN     │ Active │ --        │ --         │
│ mender        │ MENDER     │ Active │ --        │ --         │
└───────────────┴────────────┴────────┴───────────┴────────────┘

### Tier 2: Research (1 agent)

┌───────────────┬────────────┬────────┬───────────┬────────────┐
│ Agent         │ Alias      │ Status │ Invokes   │ Last Used  │
├───────────────┼────────────┼────────┼───────────┼────────────┤
│ seeker        │ SEEKER     │ Active │ --        │ --         │
└───────────────┴────────────┴────────┴───────────┴────────────┘

### Tier 3: Custom (user-defined)

┌───────────────┬────────────┬────────┬───────────┬────────────┐
│ Agent         │ Alias      │ Status │ Invokes   │ Last Used  │
├───────────────┼────────────┼────────┼───────────┼────────────┤
│ sage          │ SAGE       │ Active │ --        │ --         │
└───────────────┴────────────┴────────┴───────────┴────────────┘

[Use '/digivolve add' to create additional custom agents]

           ═══════════════════════════════
           Total Agents: 7 (6 built-in + 1 custom)
           Skills: 14 (procedural workflows)
           ═══════════════════════════════
```

## Capability Matrix

| Agent | Reads | Writes | Tests | Reviews | Audits | Designs |
|-------|-------|--------|-------|---------|--------|---------|
| architect | Yes | No | No | No | No | Yes |
| forger | Yes | Yes | No | No | No | No |
| sentinel | Yes | No | Yes | No | No | No |
| warden | Yes | No | No | Yes | Yes | No |
| mender | Yes | Yes | No | No | No | No |
| seeker | Yes | No | No | No | No | No |
| sage | Yes | Yes | No | No | No | Yes |

## Compact Format (for quick reference)

```
Agents: 7 active | architect forger sentinel warden mender seeker sage
Skills: 14 | scan rest awaken register archive hunt digivolve ui-design document release standardize ideate migrate-analyze audit
```
