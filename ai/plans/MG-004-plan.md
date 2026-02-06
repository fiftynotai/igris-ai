# Implementation Plan: MG-004 Memory Architecture Migration

**Brief:** MG-004
**Created:** 2026-02-06
**Complexity:** L (Large)
**Estimated Duration:** 3-5 days
**Risk Level:** Medium

---

## Summary

Migrate the monolithic 769-line CLAUDE.md to a modular architecture using `@import` syntax to reference external files, and `.claude/rules/*.md` for path-specific protocol enforcement. The goal is a slim ~100-150 line CLAUDE.md that serves as an import hub, with behavioral rules auto-loaded from the rules directory.

---

## Current State Analysis

### CLAUDE.md Section Audit (769 lines)

| Lines | Section | Content Type | Target Location |
|-------|---------|--------------|-----------------|
| 1-107 | Mandatory First Action / Init Sequence | **Critical** - Boot sequence | `.claude/rules/01-igris-init.md` |
| 36-71 | Persona Greeting Format | Persona behavior | `.claude/rules/05-igris-persona.md` |
| 73-88 | Context Reset Detection | Recovery protocol | `.claude/rules/01-igris-init.md` |
| 91-107 | Brief Requirement Validation | Gate protocol | `.claude/rules/02-igris-briefs.md` |
| 110-165 | Crimson Persona Active | Persona config | `@import ai/persona.json` + `.claude/rules/05-igris-persona.md` |
| 168-198 | Multi-Agent Ecosystem | Agent overview | `@import .claude/agents/manifest.yaml` (reference only) |
| 201-216 | Detection (Is Igris loaded?) | Identity response | `.claude/rules/01-igris-init.md` |
| 220-256 | On First Message | Init steps | **DUPLICATE** of igris_os.md - REMOVE |
| 259-331 | Subagent Architecture v3.1 | Agent info | **DUPLICATE** of igris_os.md - REMOVE |
| 334-524 | Workflow Orchestration | State machine | **DUPLICATE** of igris_os.md - REMOVE |
| 527-625 | Digivolve Protocol | Agent mgmt | `.claude/rules/04-igris-agents.md` |
| 628-669 | Brief Workflow | Brief ops | **DUPLICATE** of igris_os.md - REMOVE |
| 672-692 | Commit Message Rules | Commit standards | `.claude/rules/03-igris-commits.md` |
| 695-709 | Architecture Enforcement | Standards | `@import ai/context/coding_guidelines.md` |
| 711-722 | Session Management | Session tracking | **DUPLICATE** of igris_os.md - REMOVE |
| 725-735 | Quality Standards | Checklist | `.claude/rules/03-igris-commits.md` |
| 738-749 | Enhancement | Project init | Keep in CLAUDE.md (project-specific) |
| 752-758 | Documentation | Links | Keep in CLAUDE.md |
| 761-768 | Footer | Identity | Keep in CLAUDE.md |

### Duplication Analysis

**Content duplicated from igris_os.md (remove from CLAUDE.md):**
- Lines 220-256: "On First Message" duplicates igris_os.md Post-Init Protocol
- Lines 259-331: "Subagent Architecture v3.1" duplicates igris_os.md Multi-Agent Architecture
- Lines 334-524: "Workflow Orchestration" duplicates igris_os.md Workflow State Machine
- Lines 628-669: "Brief Workflow" duplicates igris_os.md Brief Management Operations
- Lines 711-722: "Session Management" duplicates igris_os.md Session Tracking Protocol

**Total removable:** ~350 lines (46% of current file)

---

## Target File Structure

```
/Users/m.elamin/StudioProjects/igris-ai/
├── CLAUDE.md                          # ~100-120 lines (import hub)
├── CLAUDE.local.md                    # NEW: Local overrides template
├── .claude/
│   ├── rules/                         # NEW DIRECTORY
│   │   ├── 01-igris-init.md          # Boot sequence, context reset, detection
│   │   ├── 02-igris-briefs.md        # Brief-first protocol gate
│   │   ├── 03-igris-commits.md       # Commit standards, quality checklist
│   │   ├── 04-igris-agents.md        # Agent delegation, Digivolve protocol
│   │   └── 05-igris-persona.md       # Persona config, mask behavior
│   ├── agents/                        # Existing - no changes
│   ├── hooks/                         # Existing - no changes
│   └── settings.json                  # Existing - no changes
├── ai/
│   ├── prompts/
│   │   └── igris_os.md               # Source of truth (no changes needed)
│   ├── persona.json                   # Persona config (no changes)
│   └── context/
│       └── coding_guidelines.md      # Architecture standards
```

---

## Section Mapping Table

| Current Location (CLAUDE.md) | New Location | Action |
|------------------------------|--------------|--------|
| Lines 1-33: Init Sequence | `.claude/rules/01-igris-init.md` | MOVE |
| Lines 36-71: Greeting Format | `.claude/rules/05-igris-persona.md` | MOVE |
| Lines 73-88: Context Reset | `.claude/rules/01-igris-init.md` | MOVE |
| Lines 91-107: Brief Validation | `.claude/rules/02-igris-briefs.md` | MOVE |
| Lines 110-165: Persona Active | `.claude/rules/05-igris-persona.md` | MOVE |
| Lines 168-198: Multi-Agent | `@import` reference | REPLACE w/ reference |
| Lines 201-216: Detection | `.claude/rules/01-igris-init.md` | MOVE |
| Lines 220-524: Duplicates | DELETE | REMOVE (use igris_os.md) |
| Lines 527-625: Digivolve | `.claude/rules/04-igris-agents.md` | MOVE |
| Lines 628-669: Brief Workflow | DELETE | REMOVE (use igris_os.md) |
| Lines 672-692: Commit Rules | `.claude/rules/03-igris-commits.md` | MOVE |
| Lines 695-709: Architecture | `@import ai/context/coding_guidelines.md` | REPLACE |
| Lines 711-722: Session Mgmt | DELETE | REMOVE (use igris_os.md) |
| Lines 725-735: Quality | `.claude/rules/03-igris-commits.md` | MOVE |
| Lines 738-768: Footer/Docs | Keep in CLAUDE.md | KEEP |

---

## Implementation Phases

### Phase 1: Create Rules Directory Structure (Day 1)

**Step 1.1:** Create `.claude/rules/` directory

**Step 1.2:** Create `01-igris-init.md` - Boot sequence rules
- Extract lines 1-33 (init sequence)
- Extract lines 73-88 (context reset detection)
- Extract lines 201-216 (detection response)

**Step 1.3:** Create `02-igris-briefs.md` - Brief-first protocol
- Extract lines 91-107 (brief validation gate)
- Reference existing brief_gate.sh hook

**Step 1.4:** Create `03-igris-commits.md` - Commit standards
- Extract lines 672-692 (commit message rules)
- Extract lines 725-735 (quality standards checklist)

**Step 1.5:** Create `04-igris-agents.md` - Agent delegation
- Extract lines 527-625 (Digivolve Protocol)
- Reference `.claude/agents/manifest.yaml`

**Step 1.6:** Create `05-igris-persona.md` - Persona behavior
- Extract lines 36-71 (greeting format)
- Extract lines 110-165 (Crimson persona active)

### Phase 2: Rewrite CLAUDE.md as Import Hub (Day 2)

**Step 2.1:** Create new slim CLAUDE.md structure (~100-120 lines)
```markdown
# Igris AI Project

@import ai/prompts/igris_os.md
@import ai/persona.json

## Project Identity
[Brief project description]

## Version Information
[Version, installed date, links]

## Enhancement
[Project-specific /init info]

## Documentation Links
[References]
```

**Step 2.2:** Remove all duplicated content (350+ lines)

### Phase 3: Test @import Resolution (Day 3)

- Validate `@import` syntax works
- Validate `.claude/rules/` auto-loading
- Test initialization flow (Test Case 1)

### Phase 4: Context Reset Recovery Testing (Day 4)

- Test context reset scenarios (Test Case 2)
- Validate hook integration

### Phase 5: Documentation & Cleanup (Day 5)

- Create `CLAUDE.local.md` template
- Update README.md
- Update igris_os.md references

---

## Files to Modify

| File | Action | Changes |
|------|--------|---------|
| `CLAUDE.md` | REWRITE | 769 lines → ~100-120 lines |
| `.claude/rules/01-igris-init.md` | CREATE | Boot sequence, context reset, detection |
| `.claude/rules/02-igris-briefs.md` | CREATE | Brief-first protocol gate |
| `.claude/rules/03-igris-commits.md` | CREATE | Commit standards, quality checklist |
| `.claude/rules/04-igris-agents.md` | CREATE | Agent delegation, Digivolve |
| `.claude/rules/05-igris-persona.md` | CREATE | Persona config, mask behavior |
| `CLAUDE.local.md` | CREATE | Local overrides template |
| `.gitignore` | MODIFY | Add CLAUDE.local.md |
| `ai/prompts/igris_os.md` | MODIFY | Add modular architecture reference |
| `README.md` | MODIFY | Document new memory architecture |

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `@import` syntax not supported | Low | High | Check version first; fallback plan |
| `.claude/rules/` not auto-loading | Medium | High | Test early; may need config |
| Rule ordering issues | Medium | Medium | Use numeric prefixes |
| Context reset behavior changes | Medium | High | Extensive testing; keep backup |

### Fallback Plan
If `@import` or `.claude/rules/` don't work as expected:
1. Restore CLAUDE.md from backup
2. Keep rules but reference manually
3. Document alternative approach

---

## Success Metrics

| Metric | Target |
|--------|--------|
| CLAUDE.md line count | < 150 lines |
| Duplicated content | 0 lines |
| Rule files | 5 files in .claude/rules/ |
| Init behavior | Identical to current |
| Test pass rate | 100% |

---

## Acceptance Criteria

1. [ ] CLAUDE.md under 150 lines using @import syntax
2. [ ] All modular rules in .claude/rules/ auto-load correctly
3. [ ] Initialization sequence identical to current behavior
4. [ ] Context resets recover session state correctly
5. [ ] No regression in brief workflow operations
6. [ ] Documentation updated

---

**Plan Status:** AWAITING APPROVAL
**Complexity:** L (Large)
**Approval Required:** Yes (L/XL complexity)
