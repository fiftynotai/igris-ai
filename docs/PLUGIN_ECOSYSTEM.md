# Igris AI Plugin Ecosystem Strategy

**Vision:** Modular AI enhancement system with specialized plugins for different capabilities.

**Last Updated:** 2025-11-14
**Status:** Strategic Design Document

---

## Architecture Philosophy

### Core Principle: Separation of Concerns

**Igris AI Core:**
- Workflow management (briefs, sessions)
- Architecture enforcement
- Quality gates
- Hook system (extensibility layer)

**Enhancement Plugins:**
- AI capabilities
- Code analysis tools
- Automation features
- Integration with external services

**Why Separate?**
- ✅ Users install only what they need
- ✅ Independent versioning (break one, others work)
- ✅ Clear cost model (pay for what you use)
- ✅ Community contributions (anyone can build plugins)
- ✅ Scalability (10+ plugins without chaos)

---

## Plugin Portfolio

### Tier 1: Intelligence Plugins (AI-Powered)

#### igris-ai-langchain
**Type:** Stateless AI Tools
**Status:** ✅ v1.0.0-beta (complete)
**Repository:** https://github.com/fiftynotai/igris-ai-langchain

**Capabilities:**
- Brief generation (git diffs, natural language)
- Code review (single-pass analysis)
- Test generation (scaffolding)
- System assessment (quick recommendations)
- Codebase RAG (vector search)

**Hooks:**
- BRIEF_GENERATOR
- CODE_REVIEWER
- TEST_GENERATOR
- SYSTEM_ASSESSMENT

**When to Use:**
- Daily workflow (fast operations)
- Cost-conscious users ($0.01-0.10 per op)
- CI/CD integration (quick checks)

---

#### igris-ai-langgraph
**Type:** Stateful AI Agents
**Status:** 📋 Planned (FR-002)
**Repository:** https://github.com/fiftynotai/igris-ai-langgraph (future)

**Capabilities:**
- Autonomous brief implementation (planner → coder → tester)
- Multi-expert code review (5 specialized agents)
- Strategic sprint planning (dependency analysis)
- Self-healing CI/CD (auto-fix failures)
- Conversational brief refinement (interactive)
- Autonomous maintenance (tech debt cleanup)

**Hooks:**
- AUTONOMOUS_IMPLEMENTER
- MULTI_AGENT_REVIEWER
- BRIEF_PLANNER
- SELF_HEALER
- CONVERSATIONAL_REFINER
- MAINTENANCE_AGENT

**When to Use:**
- Complex tasks (autonomous implementation)
- Critical reviews (comprehensive analysis)
- Strategic planning (AI-driven roadmap)
- Automation (self-healing, maintenance)

---

### Tier 2: Domain-Specific Plugins (Future)

#### igris-ai-security
**Type:** Security Analysis Agents
**Status:** 🔮 Planned

**Capabilities:**
- OWASP Top 10 scanning
- Dependency vulnerability analysis
- Secret detection and rotation
- Penetration testing suggestions
- Compliance checking (GDPR, SOC2)

**Hooks:**
- SECURITY_SCANNER
- VULNERABILITY_ANALYZER
- SECRET_DETECTOR
- COMPLIANCE_CHECKER

---

#### igris-ai-performance
**Type:** Performance Analysis Agents
**Status:** 🔮 Planned

**Capabilities:**
- Performance profiling
- Bottleneck detection
- Query optimization suggestions
- Memory leak detection
- Load testing automation

**Hooks:**
- PERFORMANCE_PROFILER
- BOTTLENECK_DETECTOR
- QUERY_OPTIMIZER

---

#### igris-ai-migration
**Type:** Codebase Migration Agents
**Status:** 🔮 Planned

**Capabilities:**
- Framework migration (React → Vue, etc.)
- Language migration (JavaScript → TypeScript)
- API migration (REST → GraphQL)
- Database migration planning

**Hooks:**
- MIGRATION_PLANNER
- MIGRATION_EXECUTOR
- MIGRATION_VALIDATOR

---

#### igris-ai-team
**Type:** Multi-Developer Coordination
**Status:** 🔮 Planned

**Capabilities:**
- Merge conflict resolution
- Code review assignment (match expertise)
- Knowledge sharing (who knows what)
- Onboarding automation (new dev setup)

**Hooks:**
- CONFLICT_RESOLVER
- REVIEWER_MATCHER
- KNOWLEDGE_FINDER

---

### Tier 3: Integration Plugins (External Services)

#### igris-ai-github
**Type:** GitHub Integration
**Status:** 🔮 Planned

**Capabilities:**
- Auto-sync briefs with GitHub Issues
- PR description generation
- Release notes automation
- Issue triage and labeling

---

#### igris-ai-jira
**Type:** Jira Integration
**Status:** 🔮 Planned

**Capabilities:**
- Sync briefs with Jira tickets
- Sprint planning sync
- Time tracking integration

---

## 🎯 Feature Distribution Strategy

### Clear Separation: LangChain vs LangGraph

**Rule:** If it needs state/loops/multiple agents → LangGraph. If one-shot → LangChain.

| Feature | Plugin | Reason |
|---------|--------|--------|
| Brief from diff | LangChain | One-shot generation |
| Brief implementation | LangGraph | Multi-step with state |
| Simple code review | LangChain | Single perspective |
| Multi-expert review | LangGraph | Parallel agents |
| Test scaffolding | LangChain | One-shot generation |
| Test refinement | LangGraph | Iterative improvement |
| Quick assessment | LangChain | Fast recommendations |
| Strategic planning | LangGraph | Complex analysis |
| One-time embed | LangChain | Simple operation |
| Auto-fix tests | LangGraph | Retry loops |

---

## 🔄 Plugin Interaction Patterns

### Pattern 1: Escalation

Start simple (LangChain), escalate if needed (LangGraph)

```bash
# Try simple review
igris review  # LangChain: fast, single-agent

# If complex issues
🤖 Complex issues detected. Run deep review?
> igris review --deep  # LangGraph: 5 agents
```

---

### Pattern 2: Workflow Integration

Use both in sequence

```bash
# 1. Quick brief (LangChain)
git diff | igris generate-brief

# 2. Refine conversationally (LangGraph)
igris refine-brief BR-005 --interactive

# 3. Implement autonomously (LangGraph)
igris implement BR-005 --autonomous

# 4. Final review (LangChain or LangGraph)
igris review --deep  # LangGraph for critical
```

---

### Pattern 3: Parallel Capabilities

Both plugins provide same hook, different implementations

```bash
# User has both plugins installed

# Use LangChain version (fast)
igris review

# Use LangGraph version (comprehensive)
igris review --deep

# System chooses based on context
igris review --auto  # Simple for small changes, deep for large
```

---

### Pattern 4: Shared Infrastructure

Both plugins can share RAG

```bash
# LangChain creates embeddings
igris embed-codebase  # via langchain plugin

# LangGraph uses same embeddings
igris implement BR-005 --autonomous  # uses RAG from langchain
```

---

## 📊 Hook Registry Design

Update `ai/hooks/HOOKS_SPEC.md` to include:

### LangChain Hooks (Stateless)
- BRIEF_GENERATOR
- CODE_REVIEWER
- TEST_GENERATOR
- SYSTEM_ASSESSMENT

### LangGraph Hooks (Stateful)
- AUTONOMOUS_IMPLEMENTER
- MULTI_AGENT_REVIEWER
- BRIEF_PLANNER
- SELF_HEALER
- CONVERSATIONAL_REFINER
- MAINTENANCE_AGENT

### Hook Metadata

Add to hook registration:

```json
{
  "hooks": {
    "CODE_REVIEWER": {
      "script": "ai/langchain/hooks/review.sh",
      "type": "stateless",
      "cost_estimate": "$0.05",
      "duration_estimate": "20s",
      "plugin": "igris-ai-langchain"
    },
    "MULTI_AGENT_REVIEWER": {
      "script": "ai/langgraph/hooks/multi_review.sh",
      "type": "stateful",
      "cost_estimate": "$0.50",
      "duration_estimate": "1min",
      "plugin": "igris-ai-langgraph"
    }
  }
}
```

**Benefit:** Users see cost/time before choosing which hook to use.

---

## 🎨 User Experience Design

### Installation Flow

**Beginner:**
```bash
# Just the basics
igris plugin install igris-ai-langchain.tar.gz

# Available: generate-brief, review, generate-tests
```

**Intermediate:**
```bash
# Add autonomous capabilities
igris plugin install igris-ai-langgraph.tar.gz

# Available: All LangChain + autonomous agents
```

**Advanced:**
```bash
# Full suite
igris plugin install igris-ai-langchain.tar.gz
igris plugin install igris-ai-langgraph.tar.gz
igris plugin install igris-ai-security.tar.gz

# Available: Everything
```

---

### Command Disambiguation

When both plugins installed:

```bash
# Explicit: Use LangChain version
igris review --simple

# Explicit: Use LangGraph version
igris review --deep

# Smart: System decides
igris review --auto
  # Small changes (< 5 files) → LangChain
  # Large changes (> 5 files) → LangGraph

# Default: User configures preference
# In ai/langgraph/config.json:
{
  "default_review": "multi_agent"  // or "simple"
}
```

---

## 🚀 Roadmap: The Plugin Empire

### Q1 2025
- ✅ FR-001: igris-ai-langchain v1.0.0
- 🎯 FR-002: igris-ai-langgraph v1.0.0
  - Multi-agent code review
  - Autonomous brief implementer

### Q2 2025
- FR-003: igris-ai-langgraph v2.0.0
  - Strategic planning agents
  - Self-healing agents
  - Maintenance bot

### Q3 2025
- FR-004: igris-ai-security v1.0.0
  - Security scanning
  - Vulnerability analysis

- FR-005: igris-ai-performance v1.0.0
  - Performance profiling
  - Optimization suggestions

### Q4 2025
- FR-006: igris-ai-team v1.0.0
  - Multi-developer coordination
  - Knowledge management

### 2026+
- Plugin marketplace
- Community plugins
- Custom agent builder
- Cross-project learning

---

## 💡 Key Insights

### Architectural Decisions

**✅ Do:**
- Separate plugins by capability type (stateless vs stateful)
- Clear hook naming (no conflicts)
- Shared infrastructure where possible (RAG, config)
- Independent versioning

**❌ Don't:**
- Mix simple and complex in one plugin
- Create hook name conflicts
- Tightly couple plugins
- Force users to install everything

---

### Economic Model

**LangChain:** Low cost, high volume
- Brief tier: Free users, students, side projects
- $5-10/month typical usage

**LangGraph:** High value, premium users
- Pro tier: Agencies, teams, power users
- $50-100/month typical usage (saves $1000s in developer time)

**Combined:** Accessibility + power

---

## 📋 Next Steps

**Immediate:**
1. ✅ Create FR-002 brief (done)
2. Update HOOKS_SPEC.md with LangGraph hooks
3. Create strategic doc for dual-plugin architecture
4. Commit planning work

**Next Sprint (FR-002 Implementation):**
1. Create igris-ai-langgraph repository
2. Implement multi-agent code review (proof of concept)
3. Implement autonomous brief implementer
4. Package and release v1.0.0-alpha

---

**Created:** 2025-11-14
**Purpose:** Strategic foundation for Igris AI plugin ecosystem
**Vision:** Enable developers to build any enhancement plugin imaginable
