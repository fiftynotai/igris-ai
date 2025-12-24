# Igris AI Plugin Ecosystem

**Vision:** Modular enhancement system with specialized plugins for different capabilities.

**Last Updated:** 2025-12-03
**Status:** v3.2 - Native Subagent Architecture

---

## Architecture Philosophy

### Core Principle: Native Subagents + Optional Plugins

**IGRIS v3.2** uses a hybrid approach:

1. **Native Subagents (Built-in):** 12 Claude Code subagents for core development workflows
2. **Persona Plugins:** Customize appearance, tone, and commands
3. **Future Plugins:** Domain-specific extensions (security, performance, integrations)

---

## Native Subagent Ecosystem (v3.2)

IGRIS now uses **native Claude Code subagents** instead of external LangChain/LangGraph plugins.

### Why Native?

| Aspect | LangChain/LangGraph (Old) | Native Subagents (v3.2) |
|--------|---------------------------|-------------------------|
| Cost | External API calls ($$$) | $0 (included in Claude) |
| Setup | Python, dependencies, API keys | Zero setup |
| Latency | Network round-trips | Instant |
| Maintenance | Plugin updates | Built-in |
| Reliability | External service dependencies | Always available |

### Agent Registry

| Tier | Agents | Purpose |
|------|--------|---------|
| 1 - Core | planner, coder, tester, reviewer | Development workflow |
| 2 - Docs | documenter, releaser, standardizer | Documentation & releases |
| 3 - Maintenance | auditor, debugger, migrator | Quality & migration |
| 4 - Innovation | ideator, explorer | Research & ideas |
| 5 - Custom | flutter-mvvm-actions-expert (SAGE) | Domain expertise |

**Total: 13 agents** defined in `.claude/agents/manifest.yaml`

---

## Plugin Portfolio

### Active Plugins

#### Persona Plugins
**Type:** Appearance & Tone Customization
**Status:** Supported

**Available:**
- `igris-persona-cyber-monkey` - Crimson persona (Digimon theme)
- Custom personas can be created

**Capabilities:**
- Custom greetings and tone
- Agent aliases (PATHFINDER, LAWKEEPER, etc.)
- Command theming
- Visual branding

**Installation:**
```bash
./scripts/persona_install.sh igris-persona-cyber-monkey
```

---

### Future Plugin Ideas

#### igris-ai-security (Planned)
**Type:** Security Analysis
**Status:** Conceptual

**Potential Capabilities:**
- OWASP Top 10 scanning
- Dependency vulnerability analysis
- Secret detection
- Compliance checking

---

#### igris-ai-integrations (Planned)
**Type:** External Service Integrations
**Status:** Conceptual

**Potential Capabilities:**
- GitHub Issues sync with briefs
- Jira ticket sync
- Slack notifications
- CI/CD webhooks

---

## Deprecated Plugins

The following plugins have been **replaced by native subagents** in v3.2:

| Plugin | Status | Replaced By |
|--------|--------|-------------|
| igris-ai-langchain | Deprecated | Native agents (coder, reviewer, etc.) |
| igris-ai-langgraph | Deprecated | Native orchestration via HUNT workflow |

**Migration:** No action needed. Native subagents provide equivalent or better functionality at zero additional cost.

---

## Hook System

IGRIS still supports the hook system for extensibility, but core AI functionality is now provided by native subagents.

**Hook Types Still Supported:**
- `SYSTEM_ASSESSMENT` - Startup recommendations
- `PRE_COMMIT` - Pre-commit checks
- `POST_COMMIT` - Post-commit actions

**Deprecated Hooks (Removed):**
- BRIEF_GENERATOR (now: main agent)
- CODE_REVIEWER (now: reviewer subagent)
- AUTONOMOUS_IMPLEMENTER (now: HUNT workflow)
- MULTI_AGENT_REVIEWER (now: reviewer subagent)
- SELF_HEALER (now: debugger subagent)

See `ai/hooks/HOOKS_SPEC.md` for current hook documentation.

---

## Creating Custom Plugins

### Persona Plugins

Create a persona plugin with:

```
my-persona/
├── persona.json      # Identity, tone, aliases
├── masks/            # Greeting variations
│   ├── full.md
│   ├── casual.md
│   └── none.md
└── install.sh        # Installation script
```

### Integration Plugins (Future)

Framework for integration plugins is planned. Will support:
- External API connections
- Webhook handlers
- Data sync scripts

---

## Key Changes in v3.2

### Removed
- LangChain plugin dependency
- LangGraph plugin dependency
- External AI API requirements
- Complex hook-based workflows

### Added
- 12 native Claude Code subagents
- Zero-cost AI operations
- Instant agent availability
- Simplified architecture

### Kept
- Persona plugin system
- Core hook extensibility
- Brief-first protocol
- Session management

---

**Created:** 2025-11-14
**Updated:** 2025-12-03
**Version:** 3.2
