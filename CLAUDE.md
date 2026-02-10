# Igris AI - Project Instructions

@import ai/prompts/igris_os.md
@import ai/persona.json
@import ai/context/coding_guidelines.md

---

## Project Identity

**Igris AI** is an AI-powered code quality and architecture management system
for Claude Code. It provides structured brief management, session recovery,
autonomous multi-agent workflows, and architecture enforcement.

- **Version:** v3.4
- **Installed:** 2025-10-25
- **Repository:** [github.com/fiftynotai/igris-ai](https://github.com/fiftynotai/igris-ai)

---

## Installed Persona

**Active:** igris-persona-cyber-monkey (Crimson)

Persona configuration loaded from `ai/persona.json`.
Mask level determines greeting style and command vocabulary.

---

## Agent Registry

IGRIS v3.4 uses **7 native Claude Code subagents** for autonomous workflows.

| Tier | Purpose |
|------|---------|
| 1 - Core | architect, forger, sentinel, warden |
| 3 - Maintenance | mender |
| 4 - Research | seeker |
| 5 - Custom | sage (Flutter MVVM + Actions) |

**Definitions:** `.claude/agents/*.md`

---

## Enhancement

Run `/init` in Claude Code CLI to enhance with project-specific analysis:

- Project-specific architecture details
- Module structure analysis
- Existing patterns and conventions
- Technology stack documentation

IGRIS will analyze your codebase and merge findings with these instructions.

---

## Documentation

| Resource | Location |
|----------|----------|
| Operating System | `ai/prompts/igris_os.md` |
| Session Protocol | `ai/prompts/session_protocol.md` |
| Agent Definitions | `.claude/agents/*.md` |
| Modular Rules | `.claude/rules/*.md` |
| Main Repository | https://github.com/fiftynotai/igris-ai |

### Modular Rules (loaded automatically)

- `01-igris-init.md` - Boot sequence, context reset detection
- `02-igris-briefs.md` - Brief-first protocol gate
- `03-igris-commits.md` - Commit standards, quality checklist
- `04-igris-agents.md` - Agent delegation, Digivolve protocol
- `05-igris-persona.md` - Persona config, mask behavior

---

## Skills (Slash Commands)

Igris commands are available as native Claude Code skills:

| Command | Purpose | Usage |
|---------|---------|-------|
| `/scan` | System status report | `/scan` or `/scan P0` |
| `/rest` | Pause/end session | `/rest` |
| `/awaken` | Start/resume session | `/awaken` |
| `/register` | Create new brief | `/register bug "title"` |
| `/archive` | Archive completed brief | `/archive BR-008` |
| `/hunt` | Implement brief (full workflow) | `/hunt BR-008` |
| `/digivolve` | Agent management | `/digivolve status` |
| `/document` | Documentation workflow | `/document` |
| `/release` | Release preparation | `/release` |
| `/standardize` | Generate coding guidelines | `/standardize analyze` |
| `/ideate` | Feature brainstorming | `/ideate` |
| `/migrate-analyze` | Migration analysis | `/migrate-analyze` |
| `/audit` | Codebase audit | `/audit code_quality` |
| `/ui-design` | UI design guidelines | `/ui-design` |
| `/team` | Parallel execution (Agent Teams) | `/team hunt FR-022 FR-023` |

Skills defined in `.claude/skills/*/SKILL.md`

---

## Capabilities

- Structured brief management (bugs, features, tech debt, migrations)
- Session tracking and recovery after context resets
- Architecture enforcement via coding guidelines
- Autonomous multi-agent workflows (`/hunt` command)
- Parallel execution via Agent Teams (`/team` command)
- Quality gates and conventional commits
- Native skills with autocomplete support

---

## Notes

Project-specific notes can be added here after running `/init`.

---

**You are now operating in Igris AI mode.**
