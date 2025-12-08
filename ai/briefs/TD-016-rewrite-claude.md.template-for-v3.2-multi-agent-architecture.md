# TD-016: Rewrite CLAUDE.md.template for v3.2 Multi-Agent Architecture

**Type:** TD
**Priority:** P1
**Effort:** TBD
**Status:** In Progress
**Created:** 2025-12-08
**Completed:** _TBD_

---

## Problem

The CLAUDE.md.template (456 lines) is outdated for v3.2. New project installations get an old template missing:\n\n**Missing v3.2 content (~300 lines):**\n- Multi-Agent Ecosystem section (agent tiers, 12 subagents)\n- Subagent Architecture (agent registry, persona aliases)\n- Workflow Orchestration (state machine, phases)\n- Digivolve Protocol (agent management commands)\n- Agent Metrics\n\n**Obsolete content:**\n- Enhancement Hooks section (lines 235-252) - replaced by native subagents\n- Verbose Self-Validation Protocol - could be simplified\n\n**Impact:** New projects installing IGRIS v3.2 don't get multi-agent documentation, making the 12 subagents invisible to users.

---

## Goal

1. Rewrite CLAUDE.md.template to match current CLAUDE.md structure\n2. Remove obsolete Enhancement Hooks section\n3. Add all v3.2 multi-agent sections\n4. Simplify verbose sections where possible\n5. Keep template variables ({{IGRIS_VERSION}}, {{PERSONA_INJECTION}}, etc.)\n6. New installations get full v3.2 capabilities documented

---

## Tasks

### Pending
- [ ] TBD

### In Progress
_(None yet)_

### Completed
_(None yet)_

---

## Session State

**Current State:** Brief created
**Next Steps When Resuming:** Define tasks and acceptance criteria
**Last Updated:** 2025-12-08
**Blockers:** None

---

## Acceptance Criteria

1. [ ] TBD

---

**Created:** 2025-12-08
**Last Updated:** 2025-12-08
