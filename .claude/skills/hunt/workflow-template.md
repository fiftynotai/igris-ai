# HUNT Workflow State Machine Reference

## Visual Diagram

```
     ┌──────────────────────────────────────────────────────────────────────────┐
     │                         HUNT WORKFLOW STATE MACHINE                       │
     └──────────────────────────────────────────────────────────────────────────┘

     ┌──────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
     │ INIT │────►│ PLANNING │────►│ BUILDING │────►│ TESTING  │────►│ REVIEWING│
     └──────┘     └──────────┘     └──────────┘     └──────────┘     └──────────┘
                       │                 ▲              │ │              │ │
                       │                 │              │ │              │ │
                       ▼                 │              │ │              │ │
                  ┌──────────┐           │              │ │              │ │
                  │ APPROVAL │───────────┘              │ │              │ │
                  │ (L/XL)   │                          │ │              │ │
                  └──────────┘                          │ │              │ │
                                                        │ │              │ │
                       ┌────────────────────────────────┘ │              │ │
                       │ (fail, retry<3: mender)        │              │ │
                       ▼                                  │              │ │
                  ┌──────────┐                            │              │ │
                  │ DEBUGGER │────────────────────────────┘              │ │
                  └──────────┘                                           │ │
                                                                         │ │
                       ┌─────────────────────────────────────────────────┘ │
                       │ (reject, retry<2: fix)                             │
                       ▼                                                    │
                  ┌──────────┐                                              │
                  │  FIXING  │──────────────────────────────────────────────┘
                  └──────────┘

                                    ┌───────────┐     ┌──────────┐
                                    │ COMMITTING│────►│ COMPLETE │
                                    └───────────┘     └──────────┘
                                          ▲
                                          │
                                    (approve)
```

## Phase Descriptions

### INIT
- Load brief from ai/briefs/
- Verify status (Ready or In Progress)
- Update session state

### PLANNING
- Delegate to architect agent
- Create implementation plan
- Save to ai/plans/{BRIEF_ID}-plan.md

### APPROVAL (L/XL only)
- Display plan to user
- Wait for explicit approval
- Skip for S/M efforts

### BUILDING
- Delegate to forger agent
- Implement according to plan
- Follow coding_guidelines.md

### TESTING
- Delegate to sentinel agent
- Run linter, tests
- Self-heal via mender (max 3 retries)

### REVIEWING
- Delegate to warden agent
- Quality gate check
- Can reject back to building (max 2 retries)

### COMMITTING
- Stage changes
- Create conventional commit
- Reference brief ID

### COMPLETE
- Update brief status to Done
- Update session
- Suggest next actions

## Subagent Delegation Pattern

Before invoking:
1. Update brief: Phase = X, Active Agent = Y
2. Add Agent Log entry: "Starting [agent]..."

After return:
1. Update brief: Active Agent = none
2. Update Agent Log with result
3. Advance or retry based on result
