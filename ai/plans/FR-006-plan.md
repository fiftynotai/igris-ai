# FR-006 Implementation Plan: Add VoltAgent Subagents

**Complexity:** M (Medium)
**Estimated Duration:** 2-3 hours
**Risk Level:** Medium
**Created:** 2025-12-24
**Status:** Awaiting Approval

---

## Summary

Add 5 VoltAgent subagents to Igris AI:
- 4 meta-orchestration agents → New Tier 6
- 1 UI design agent → Tier 1

**Result:** 13 → 18 agents across 6 tiers

---

## Tier Assignment Decision

### New Structure (v3.3)

| Tier | Name | Agents |
|------|------|--------|
| 1 | Core Workflow | planner, coder, tester, reviewer, **ui-designer** |
| 2 | Documentation | documenter, releaser, standardizer |
| 3 | Maintenance | auditor, debugger, migrator |
| 4 | Innovation | ideator, explorer |
| 5 | Custom | flutter-mvvm-actions-expert, user-defined |
| 6 | **Meta-Orchestration** | **multi-agent-coordinator, agent-organizer, context-manager, task-distributor** |

**Rationale:** Meta-orchestration agents operate *above* the development workflow - they coordinate agents themselves. A new Tier 6 cleanly captures this semantic difference.

---

## Persona Aliases (Crimson Theme)

| Agent | Alias | Rationale |
|-------|-------|-----------|
| multi-agent-coordinator | **CONDUCTOR** | Orchestrates the ensemble |
| agent-organizer | **TACTICIAN** | Assembles teams strategically |
| context-manager | **ARCHIVIST** | Stores/retrieves information |
| task-distributor | **DISPATCHER** | Distributes load, manages queues |
| ui-designer | **ARTISAN** | Crafts visual designs |

---

## Implementation Phases

### Phase 1: Create Agent Files (5 files)
- `.claude/agents/multi-agent-coordinator.md`
- `.claude/agents/agent-organizer.md`
- `.claude/agents/context-manager.md`
- `.claude/agents/task-distributor.md`
- `.claude/agents/ui-designer.md`

### Phase 2: Update Registry
- Add Tier 6 definition to manifest.yaml
- Add 5 new agent entries
- Update agent_count: 13 → 18

### Phase 3: Update Persona
- Add 5 aliases to ai/persona.json

### Phase 4: Update Documentation
- README.md (agent count, tier table, diagram)
- CLAUDE.md (agent count, tier table)
- ai/prompts/igris_os.md (registry table)
- docs/PLUGIN_ECOSYSTEM.md (tier table)
- scripts/templates/CLAUDE.md.template

### Phase 5: Verify Scripts
- igris_init.sh - Confirm copies new agents ✅
- igris_update.sh - Confirm manifest merge works ✅

---

## Conflict Analysis

| New Agent | Overlap With | Resolution |
|-----------|--------------|------------|
| multi-agent-coordinator | Main Orchestrator | MACo handles complex parallel; Main handles simple delegation |
| context-manager | Session tracking | CM handles cross-agent sync; Main handles brief-level |
| task-distributor | Planner | Planner creates plans; TD parallelizes execution |
| ui-designer | Coder | Coder writes code; ui-designer handles design specs |

---

## Files Summary

| Action | Count | Files |
|--------|-------|-------|
| CREATE | 5 | 5 agent .md files |
| MODIFY | 7 | manifest.yaml, persona.json, README.md, CLAUDE.md, igris_os.md, PLUGIN_ECOSYSTEM.md, CLAUDE.md.template |
| VERIFY | 2 | igris_init.sh, igris_update.sh |

---

## Risks

| Risk | Mitigation |
|------|------------|
| Trigger collisions | Review all triggers for uniqueness |
| Documentation inconsistency | Update all docs in single commit |
| Role overlap confusion | Clear documentation of when to use each agent |

---

## Checklist

- [ ] Phase 1: Create 5 agent files
- [ ] Phase 2: Update manifest.yaml
- [ ] Phase 3: Update persona.json
- [ ] Phase 4: Update all documentation
- [ ] Phase 5: Verify scripts
- [ ] Commit all changes
