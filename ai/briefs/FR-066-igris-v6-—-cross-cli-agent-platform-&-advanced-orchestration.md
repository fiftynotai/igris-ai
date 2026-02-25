# FR-066: Igris v6 — Cross-CLI Agent Platform & Advanced Orchestration

**Type:** FR
**Priority:** P2
**Effort:** TBD
**Status:** Ready
**Created:** 2026-02-25
**Completed:** _TBD_

---

## Problem

Igris v5 builds the distributed task execution layer but remains Claude Code-native for system prompts, skills, rules, and agent definitions. The broader vision is Igris as a platform-agnostic AI operating system that hijacks any CLI agent (Claude Code, Gemini CLI, Codex CLI, OpenCode, Goose, OpenClaw, future CLIs) and makes it a full Igris worker.

Current limitations after v5:
1. System prompt portability — CLAUDE.md, skills, rules are Claude Code-specific format. Other CLIs have different config systems (~/.gemini/settings.json, ~/.codex/config.toml, ~/.config/opencode/, goose config.yaml)
2. Agent capability discovery — agents self-report capabilities on registration, but there's no auto-detection or verification of what a connected agent can actually do
3. Task communication is poll-based — agents poll every 30s, no real-time push. For time-sensitive coordination, 30s latency is too high
4. No cross-agent collaboration — two agents can't work on the same task or hand off intermediate results
5. CLI-specific features — Claude Code has subagents, skills, hooks, Agent Teams. Other CLIs have different feature sets. Igris workflows that depend on Claude-specific features won't work elsewhere
6. No adapter layer — each CLI's MCP config, system prompt injection, and tool permission model is different. No abstraction to handle this

Research findings (Feb 2026):
- MCP is adopted by all major CLI agents (Claude Code, Gemini CLI, Codex CLI, OpenCode, Goose) as the universal tool/plugin standard
- Gemini CLI supports MCP via stdio, SSE, and HTTP
- Codex CLI supports MCP and can even run AS an MCP server itself
- OpenCode supports MCP with custom agent definitions
- Goose converts MCP configs between CLI formats automatically
- Aider lacks native MCP (community workarounds only)
- The brain MCP server is already agent-agnostic — any MCP client can use it

---

## Goal

Evolve Igris from a Claude Code-native system into a platform-agnostic AI operating system that works across any CLI agent.

**Phase 1: CLI Adapter Layer**
- Build adapter modules for each supported CLI: claude-code, gemini-cli, codex-cli, opencode, goose
- Each adapter knows: where to put system prompts, how to configure MCP, what features are available
- `igris_install.sh` detects installed CLIs and configures all of them
- Adapter translates Igris concepts → CLI-native format:
  - Skills → CLI-specific tool/prompt format
  - Rules → CLI-specific instruction injection
  - Agent definitions → CLI-specific agent config
  - MCP connection → CLI-specific MCP config file

**Phase 2: Real-Time Task Streaming**
- Replace polling with WebSocket/SSE push from brain server to connected agents
- Brain notifies agents immediately when tasks are assigned or updated
- Eliminates 30s poll latency for time-sensitive coordination
- Fallback to polling for agents that can't maintain persistent connections

**Phase 3: Agent Capability Discovery & Verification**
- On registration, brain probes agent with test tasks to verify claimed capabilities
- Capability scoring: agents build a track record (success rate per task type)
- Auto-routing uses scores: "openclaw-vps has 95% success on social-media, 40% on dev — route social to openclaw, dev to claude"
- Capability marketplace: agents advertise what they can do, brain matches demand

**Phase 4: Cross-Agent Collaboration**
- Shared task workspace: two agents can read/write to the same task's intermediate files
- Handoff protocol: agent A completes phase 1, hands intermediate result to agent B for phase 2
- Conversation threads: agents can leave notes/context for the next agent on a task
- Example: Claude plans architecture → OpenClaw generates marketing copy for the feature → Claude reviews

**Phase 5: Igris as Standalone Agent**
- Build a dedicated Igris CLI (`igris` command) that wraps any LLM provider
- Not dependent on Claude Code, Gemini CLI, or any specific CLI
- Direct LLM API calls + brain MCP + task execution
- The "final form" — Igris IS the agent, not a system running inside someone else's agent
- Can use any model: Claude, Gemini, GPT, Llama, GLM, Mistral

**Cross-Cutting Concerns:**
- Security: agent authentication for brain access (beyond API key — per-agent tokens)
- Quotas: rate limiting per agent to prevent runaway costs
- Audit trail: every task assignment, execution, and result tracked with agent identity
- Graceful degradation: if a CLI doesn't support feature X, Igris works without it (reduced capability, not broken)

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
**Last Updated:** 2026-02-25
**Blockers:** None

---

## Acceptance Criteria

1. [ ] TBD

---

**Created:** 2026-02-25
**Last Updated:** 2026-02-25
