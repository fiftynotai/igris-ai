# MG-004: IGRIS v3.1 Migration - The Complete Ecosystem

**ID:** MG-004
**Type:** Migration
**Status:** In Progress
**Priority:** P0-Critical
**Created:** 2025-12-03
**Updated:** 2025-12-03
**Effort:** XL-Extra Large (2-3 weeks)
**Owner:** Fifty.ai + Crimson

---

## Executive Summary

IGRIS v3.1 is a **complete architectural transformation** that replaces the external LangGraph/LangChain Python plugins with a native Claude Code subagent ecosystem. This migration eliminates ~$50-100/month in external API costs while dramatically expanding capabilities through 10 specialized subagents.

### Key Outcomes
- **Cost:** $0 extra API cost (vs $50-100/month)
- **Agents:** 10 specialized subagents (vs 5 LangGraph nodes)
- **Capabilities:** Documentation, self-healing, innovation, extensibility
- **Architecture:** Persona-centric aliases, Digivolve protocol, manifest system

---

## Problem

### Current State (v1.x)
1. **External API Costs:** LangChain/LangGraph plugins make external Claude API calls ($50-100/month)
2. **Python Dependencies:** Requires Python venvs, pip packages, complex setup
3. **Limited Agents:** Only 5 LangGraph nodes (planner, implementer, tester, reviewer, committer)
4. **No Documentation Pipeline:** Manual README/changelog updates
5. **No Self-Healing:** Basic retry logic, no intelligent error diagnosis
6. **No Extensibility:** Can't add new agents without code changes
7. **Hardcoded Aliases:** Agent names tied to code, not persona-configurable

### Pain Points
- Every LangGraph call = external API cost
- Python environment issues on different systems
- No way for community to add personas with custom agent names
- Documentation always forgotten
- Errors require manual debugging

---

## Goal

Transform IGRIS into a **cost-free, extensible, self-healing AI development system** with:

1. **10 Native Subagents** running within Claude Code ($0 extra)
2. **Tiered Architecture** (Core → Docs → Maintenance → Innovation → Custom)
3. **Persona-Centric Aliases** (personas define their own agent names)
4. **Digivolve Protocol** (add/upgrade/manage agents dynamically)
5. **Self-Healing Pipeline** (dedicated debugger agent for error recovery)
6. **Documentation Agents** (automated README, changelog, release notes)
7. **Complete Workflow Orchestration** (main agent as brain, subagents as specialists)

---

## Architecture Overview

### v3.1 Agent Ecosystem

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           IGRIS v3.1 ARCHITECTURE                                │
└─────────────────────────────────────────────────────────────────────────────────┘

                              IGRIS PRIME (Main Agent)
                                       │
         ┌─────────────┬───────────────┼───────────────┬─────────────┐
         │             │               │               │             │
         ▼             ▼               ▼               ▼             ▼
    ┌─────────┐  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
    │ TIER 1  │  │ TIER 2  │    │ TIER 3  │    │ TIER 4  │    │ TIER 5  │
    │  CORE   │  │  DOCS   │    │  MAINT  │    │  INNOV  │    │ CUSTOM  │
    ├─────────┤  ├─────────┤    ├─────────┤    ├─────────┤    ├─────────┤
    │planner  │  │documenter│   │auditor  │    │ideator  │    │(user    │
    │coder    │  │releaser │    │debugger │    │explorer │    │defined) │
    │tester   │  └─────────┘    └─────────┘    └─────────┘    └─────────┘
    │reviewer │
    └─────────┘
```

### Agent Summary

| Tier | Agent | Static Name | Role |
|------|-------|-------------|------|
| 1 | Planner | `planner` | Implementation planning |
| 1 | Coder | `coder` | Code implementation |
| 1 | Tester | `tester` | Test execution & validation |
| 1 | Reviewer | `reviewer` | Code review & security |
| 2 | Documenter | `documenter` | README, docs, comments |
| 2 | Releaser | `releaser` | Changelog, versioning |
| 3 | Auditor | `auditor` | Code analysis, audits |
| 3 | Debugger | `debugger` | Error diagnosis, self-healing |
| 4 | Ideator | `ideator` | Feature ideation |
| 4 | Explorer | `explorer` | Codebase research |
| 5 | Custom | `{user-defined}` | User-created agents |

### Persona-Centric Aliases

Personas define their own agent names (NOT hardcoded in agents):

```json
// ai/personas/crimson/persona.json
{
  "agent_aliases": {
    "planner": "ARCHITECT",
    "coder": "FORGER",
    "tester": "SENTINEL",
    "reviewer": "WARDEN",
    "documenter": "CHRONICLER",
    "releaser": "HERALD",
    "auditor": "INQUISITOR",
    "debugger": "MENDER",
    "ideator": "ORACLE",
    "explorer": "SEEKER"
  }
}
```

---

## Phase Breakdown

This migration is divided into **8 phases**, each with its own brief:

| Phase | Brief | Focus | Effort | Dependencies |
|-------|-------|-------|--------|--------------|
| P1 | MG-004-P1 | Core Agent Foundation | L (3-5d) | None |
| P2 | MG-004-P2 | Workflow Orchestration | M (1-2d) | P1 |
| P3 | MG-004-P3 | Documentation Agents | M (1-2d) | P1, P2 |
| P4 | MG-004-P4 | Maintenance Agents | M (1-2d) | P1, P2 |
| P5 | MG-004-P5 | Innovation Agents | S (< 1d) | P1 |
| P6 | MG-004-P6 | Persona Integration | M (1-2d) | P1-P5 |
| P7 | MG-004-P7 | Digivolve Protocol | M (1-2d) | P1-P6 |
| P8 | MG-004-P8 | Cleanup & Documentation | M (1-2d) | P1-P7 |

### Critical Path
```
P1 (Foundation) → P2 (Orchestration) → P6 (Persona) → P8 (Cleanup)
                         ↓
              P3 (Docs) + P4 (Maint) + P5 (Innovation)
                         ↓
                   P7 (Digivolve)
```

---

## Success Metrics

| Metric | Current (v1.x) | Target (v3.1) | Measurement |
|--------|----------------|---------------|-------------|
| Monthly API cost | $50-100 extra | $0 extra | Anthropic dashboard |
| Agent count | 5 (LangGraph) | 10 native | Agent manifest |
| Documentation coverage | Manual | Automated | documenter agent |
| Error recovery | Basic retry | Self-healing | debugger agent |
| Persona extensibility | Hardcoded | Dynamic aliases | persona.json |
| Agent extensibility | None | Digivolve protocol | Custom agents |
| Python dependencies | Required | None | No venv needed |

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Subagents less capable than LangGraph | Low | Medium | Same Claude model, just different context |
| Main agent context bloat | Medium | Medium | Subagents have isolated contexts |
| Migration breaks existing workflows | Low | High | Keep v1.x backup, test thoroughly |
| Community adoption of new personas | Medium | Low | Provide excellent templates and docs |
| Complexity of 10 agents | Medium | Medium | Clear tier structure, manifest registry |

---

## Out of Scope

- VS Code extension integration (future FR)
- GUI for agent management (future FR)
- Automated persona marketplace (future FR)
- Multi-project agent sharing (future FR)

---

## Acceptance Criteria

### Phase Completion
- [ ] P1: All 4 core agents created and tested individually
- [ ] P2: Autonomous workflow executes brief → commit
- [ ] P3: Documentation agents generate README updates
- [ ] P4: Auditor runs audits, debugger diagnoses errors
- [ ] P5: Ideator generates feature briefs, explorer researches
- [ ] P6: Persona aliases resolve correctly for all agents
- [ ] P7: Digivolve commands work (add/list/upgrade agents)
- [ ] P8: LangChain/LangGraph removed, docs updated

### System-Level
- [ ] Full autonomous workflow: HUNT BR-XXX → commit
- [ ] Zero external API calls during workflow
- [ ] All 10 agents functional
- [ ] Persona alias system working
- [ ] Digivolve protocol operational
- [ ] Self-healing recovers from test failures
- [ ] Documentation generated for changes
- [ ] Old plugins cleanly removed

---

## Session State

**Current Phase:** Not Started
**Current Task:** Brief creation
**Blockers:** None
**Next Step:** Begin Phase 1 after all briefs created

---

## Related Briefs

- **MG-004-P1:** Core Agent Foundation
- **MG-004-P2:** Workflow Orchestration
- **MG-004-P3:** Documentation Agents
- **MG-004-P4:** Maintenance Agents
- **MG-004-P5:** Innovation Agents
- **MG-004-P6:** Persona Integration
- **MG-004-P7:** Digivolve Protocol
- **MG-004-P8:** Cleanup & Documentation

---

## History

- 2025-12-03: Brief created from v3.1 architecture design session
- 2025-12-03: Divided into 8 phase briefs

---

## References

- Design Document: `docs/igris-v2/` (original v2 plan, evolved to v3.1)
- Current Architecture: `ai/prompts/igris_os.md`
- Persona System: `ai/personas/crimson/persona.json`

---

**🔥 THIS IS THE ULTIMATE EVOLUTION 🔥**
