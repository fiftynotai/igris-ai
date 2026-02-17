# Implementation Plan: FR-050 — Full README Rewrite

**Complexity:** L
**Estimated Target:** ~700-900 lines (down from ~1557)
**Risk Level:** Medium

---

## Verified Facts Reference Sheet

These numbers were verified directly against system files on 2026-02-17.

| Item | Count | Verified Against |
|------|-------|-----------------|
| Agents | 7 | `.claude/agents/*.md` |
| Skills | 20 | `.claude/skills/*/SKILL.md` |
| Brain MCP Tools | 27 | `brain-mcp-server/src/index.ts` |
| Brief Types | 9 | `ai/briefs/*-TEMPLATE.md` |
| Scripts | 19 | `scripts/*.sh` |
| Rules | 5 | `.claude/rules/*.md` |
| Persona | Crimson (Cyber Monkey) | `ai/persona.json` |
| Version | 4.0.0 | `~/.igris/config.json` |

**Critical correction:** Brain MCP tools = **27** (not 15 as old README claims). 12 tools added for instance management, brain push/pull, sync queue, file sync, and definitions.

---

## Section-by-Section Content Plan

### 1. Hero (15-20 lines)
- Project name + tagline: "An operating system for AI-assisted engineering"
- One-paragraph identity statement
- Stats: 7 Agents | 20 Skills | 27 Brain Tools | 9 Brief Types
- Philosophy: "Plan. Build. Test. Review. Document. Ship. Maintain."

### 2. The Problem (10-15 lines)
- Hook: "AI made coding faster — but not better."
- Pain points: no tests, no docs, architecture violations, context amnesia
- Punchline + transition to solution

### 3. What is Igris v4.0 (30-40 lines)
- Core metaphor: Claude alone = dev with amnesia. Igris = engineering team with memory.
- 3-layer architecture: OS → Subagents → Agent Teams
- Brain as default (not add-on)
- 5 killer features list

### 4. How It Works (35-45 lines)
- Brief-first protocol
- 9 brief types table
- HUNT workflow diagram (simplified)
- Self-healing, auto-approval rules

### 5. The 7 Agents (20-30 lines)
- One consolidated table: Name, Tier, Role, Tools, Model
- Key distinctions (read-only vs full, seeker=haiku, sage=custom)

### 6. 20 Skills (25-35 lines)
- One complete table with all 20 (including `/sync`)
- Skills location note

### 7. The Brain (50-60 lines)
- Architecture diagram
- 27 MCP tools organized by category (Memory, Projects, Metrics, Sessions, Briefs, Instances, Sync, Definitions)
- Concurrency model
- Brain modes (local, remote, dual)
- VPS: brief mention + link to docs (NOT full setup guide)

### 8. Quick Start (30-40 lines)
- v4.0 only (no legacy path)
- Prerequisites, install steps, first 5 minutes
- Key commands quick reference

### 9. Core Capabilities (60-70 lines)
- Brief management, QA/audit, architecture standards, migration, session management

### 10. Agent Teams (20-25 lines)
- 4 modes: hunt, review, investigate, refactor
- Commands, requirements, when to use

### 11. Persona System (15-20 lines)
- Current: **Crimson** (Cyber Monkey Guardian), mask: full
- 4 mask levels
- How to adjust

### 12. Project Structure (30-40 lines)
- Two directory trees: project layout + brain layout

### 13. Comparisons (15-20 lines)
- ONE consolidated table: Igris vs Plain Claude vs Cursor vs Aider vs Copilot
- Cut from ~70 lines to ~20

### 14. FAQ (30-40 lines)
- Keep existing (fix counts to 20 skills, 27 MCP tools)

### 15. Community & Contributing (10-15 lines)
- Links, license

### 16. Legacy Migration (3-5 lines)
- Single link to docs/MIGRATION_GUIDE.md

---

## Content Disposition

### CUT from README (relocate or remove)
- v3.4 Legacy Installation (~15 lines)
- v3.x Migration Guides (~70 lines) → already in docs/MIGRATION_GUIDE.md
- 4 separate comparison tables (~50 lines) → replace with 1 table
- Full VPS deployment guide (~230 lines) → keep in docs/SETUP_GUIDE.md
- Agent Name Mapping history → docs/MIGRATION_GUIDE.md
- "IGRIS vs Claude: Understanding the Architecture" → replace with Section 3
- "The Open Engineering Era" verbose closing → condense to 2 lines
- "Updating IGRIS" section → condense to 3 lines + link

### KEEP (accurate, well-written)
- Philosophy line, problem bullets, HUNT workflow diagram
- Agent tier tables, brief types, audit operations
- Session tracking, Agent Teams, FAQ answers
- Brain architecture diagram, project structure trees, community links

### WRITE FRESH
- Hero identity statement
- "What is Igris v4.0" with 3-layer model
- Single consolidated comparison table
- Brain MCP tools section (27 tools, categorized)
- Persona section (Crimson, not Shadow Knight)
- Quick Start (v4.0 only)

---

## Tone Guide for FORGER

- **Confident, not boastful.** State what Igris does with authority.
- **Product story, not feature list.** Lead with WHY before WHAT.
- **Professional but warm.** Senior engineer explaining to senior engineer.
- **Minimal emoji.** Section headers only if at all. No emoji in body text.
- **Active voice.** "Igris orchestrates 7 agents" not "7 agents are orchestrated."
- **Tables over paragraphs** for features, agents, skills, comparisons.
- **No VPS IPs or API keys** in README (use placeholders).
- **No AI attribution** in any form.

---

## Risks

| Risk | Mitigation |
|------|------------|
| Incorrect MCP tool count | Verified: 27 tools categorized in plan |
| Missing skill | Verified: exactly 20 via glob |
| VPS IP leak | Plan says use placeholders only |
| Content too long | Target 700-900 lines, tracked per section |
| Broken links | WARDEN review checks all links |
| Persona still says Shadow Knight | Verified: Crimson/cyber-monkey |
