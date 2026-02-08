# MG-008 Test Checklist — Agent Consolidation Validation

**Created:** 2026-02-08
**Purpose:** Validate v3.4 architecture (7 agents + 14 skills) during normal usage

---

## Core Pipeline (validate during next HUNT)

- [ ] `/hunt` triggers full workflow (INIT → PLANNING → BUILDING → TESTING → REVIEWING → COMMITTING)
- [ ] architect agent invokes successfully (planning phase)
- [ ] forger agent invokes successfully (building phase)
- [ ] sentinel agent invokes successfully (testing phase)
- [ ] warden agent invokes successfully (reviewing phase)
- [ ] mender self-heal loop triggers on test failure (if applicable)
- [ ] No references to deleted agents in workflow output

## Agent Invocations (validate as encountered)

- [ ] seeker agent works for codebase research
- [ ] sage agent works for Flutter-specific tasks
- [ ] warden audit mode produces structured audit report

## New Skills (validate when used)

- [ ] `/document` — produces documentation output
- [ ] `/release` — generates changelog + version bump
- [ ] `/standardize` — runs with mode selection (analyze/from-base/hybrid/minimal)
- [ ] `/ideate` — produces value/effort matrix + FR-XXX brief
- [ ] `/migrate-analyze` — produces gap analysis + MG-XXX brief
- [ ] `/audit` — runs audit with operation type selection
- [ ] `/ui-design` — produces design specs with WCAG 2.1, component states

## Existing Skills (smoke test)

- [ ] `/scan` — shows correct 7-agent count
- [ ] `/digivolve status` — displays 7-agent roster (not 18)
- [ ] `/register` — creates brief with correct Active Agent field
- [ ] `/hunt` — triggers workflow (covered above)
- [ ] `/awaken` — session start works
- [ ] `/rest` — session pause works
- [ ] `/archive` — archives completed brief

## Reference Integrity

- [x] No stale agent names in .claude/rules/
- [x] No stale agent names in CLAUDE.md
- [x] No stale agent names in igris_os.md
- [x] No stale agent names in brief templates
- [x] persona.json has exactly 7 aliases
- [x] manifest.yaml lists exactly 7 agents
- [x] 7 agent .md files in .claude/agents/
- [x] 14 skill directories in .claude/skills/

---

**How to use:** Check items off as they get validated through normal Igris usage. No need for dedicated test sessions — just confirm as you work.
