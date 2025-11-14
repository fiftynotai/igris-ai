# FR-001: LangChain Integration for Enhanced Intelligence

**Type:** Feature Request
**Priority:** P1-High
**Effort:** XL-Extra Large (>1w) - Multi-phase implementation
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Ready
**Created:** 2025-11-14
**Completed:** _(pending)_

---

## Feature Description

**What is the proposed feature?**

Integrate LangChain into Igris AI using a **hybrid architecture** - core provides enhancement hooks, optional LangChain plugin implements AI-powered features. This enables intelligent brief generation, codebase RAG, automated test creation, and AI code review while keeping Igris AI functional for users who don't need AI enhancements.

**Why is this valuable?**

Transforms Igris AI from a structured workflow system into an **intelligent engineering assistant**. Users get automated brief generation from git diffs, context-aware recommendations from codebase analysis, and AI-powered code review - all while maintaining the clean architecture and session management that makes Igris AI reliable.

---

## User Value

### Who Benefits?
- [x] End users (developers using Igris AI in their projects)
- [x] Developers (building with Igris AI)
- [x] Contributors (can build other AI enhancement plugins)
- [x] System (Igris AI itself - dogfooding for maintenance)

### Pain Point Solved
**Current situation:**
- Brief creation is manual - user must write problem, context, acceptance criteria
- System recommendations are static - can't analyze codebase patterns
- Code review relies on human verification of coding_guidelines.md
- Test generation is manual work
- No integration with external tools (GitHub Issues, git history, etc.)

**With this feature:**
- Briefs auto-generated from git diffs or natural language ("add authentication")
- Recommendations analyze recent commits, blockers, similar completed work
- AI reviews code against architecture guidelines before commit
- Tests auto-generated from implementation files
- Integration with issue trackers, git history, documentation

---

## Use Cases

### Use Case 1: Auto-Generate Brief from Git Diff
**Actor:** Developer with feature branch
**Goal:** Create comprehensive brief without manual writing
**Steps:**
1. Developer finishes coding feature in branch
2. Runs: `git diff main...feature-branch | igris langchain generate-brief`
3. LangChain analyzes changes, consults coding_guidelines.md, reviews similar briefs
4. Brief file created with problem, context, acceptance criteria pre-filled
5. Developer reviews and refines, marks as Ready

**Expected Outcome:** BR-XXX-feature-name.md created in 30 seconds vs 15 minutes manual writing

### Use Case 2: Codebase RAG for Context-Aware Recommendations
**Actor:** Developer starting session
**Goal:** Get intelligent recommendations based on project state
**Steps:**
1. Developer says "ARISE" (or runs Igris init)
2. LangChain plugin analyzes:
   - Recent commits and patterns
   - Open briefs and priority
   - Blockers and dependencies
   - Similar completed work
3. System displays enhanced recommendations:
   - "Resume TD-005 (blocker in UserService.ts resolved 2 commits ago)"
   - "Consider BR-007 next (similar to recently completed BR-005)"
   - "Technical debt in auth module increasing (3 TODOs added this week)"

**Expected Outcome:** Developer makes informed decision based on intelligent context analysis

### Use Case 3: AI Code Review Before Commit
**Actor:** Developer finishing task
**Goal:** Verify code follows architecture before committing
**Steps:**
1. Developer completes implementation
2. Runs: `igris langchain review`
3. LangChain analyzes changes against:
   - coding_guidelines.md patterns
   - Similar code in codebase (RAG)
   - Common bugs from BLOCKERS.md
4. Displays findings:
   - ✅ "Architecture compliant"
   - ⚠️ "Consider dependency injection (see UserService.ts:45 for pattern)"
   - ❌ "Missing error handling (similar bug in BR-008)"
5. Developer fixes issues, runs review again

**Expected Outcome:** Clean, architecture-compliant code before commit

### Use Case 4: Auto-Generate Tests from Implementation
**Actor:** Developer who implemented feature
**Goal:** Generate comprehensive test coverage quickly
**Steps:**
1. Developer completes implementation in `src/auth/LoginService.ts`
2. Runs: `igris langchain generate-tests src/auth/LoginService.ts`
3. LangChain analyzes:
   - Public API and methods
   - Similar test patterns in codebase
   - Edge cases and error paths
4. Generates test files:
   - `test/auth/LoginService.test.ts` (unit tests)
   - `test/integration/auth-flow.test.ts` (integration tests)
5. Developer reviews, refines, runs tests

**Expected Outcome:** 80% test coverage in 5 minutes vs 2 hours manual writing

---

## Technical Approach

### High-Level Design

**Hybrid Architecture:**
```
┌─────────────────────────────────────────┐
│         Igris AI Core (v2.x)            │
│  ┌─────────────────────────────────┐   │
│  │   Enhancement Hook System       │   │
│  │  {{PRE_ANALYSIS}}               │   │
│  │  {{POST_ANALYSIS}}              │   │
│  │  {{BRIEF_GENERATOR}}            │   │
│  │  {{CODE_REVIEWER}}              │   │
│  │  {{TEST_GENERATOR}}             │   │
│  └─────────────────────────────────┘   │
│         ↓ (optional)                    │
│  ┌─────────────────────────────────┐   │
│  │   LangChain Plugin (v1.0)       │   │
│  │  - RAG over codebase            │   │
│  │  - Brief generation chains      │   │
│  │  - Code review agents           │   │
│  │  - Test generation              │   │
│  │  - Issue tracker integration    │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

**Two-Phase Implementation:**

**Phase 1: Enhancement Hook System (TD-012)**
- Add hook placeholders to core workflows
- Update igris_init.sh to resolve enhancement hooks
- Document hook contracts (input/output)
- Ensure backward compatibility (hooks optional)

**Phase 2: LangChain Plugin (FR-001 implementation)**
- Python package with LangChain dependencies
- Bash wrapper scripts bridge to Python
- Configuration (models, API keys, features)
- Plugin installation via existing plugin system

### Components Affected

**Core System (TD-012):**
- `scripts/igris_init.sh` - Hook resolution logic
- `ai/templates/CLAUDE.md.template` - Hook placeholders
- `ai/prompts/igris_os.md` - Hook documentation
- New: `ai/hooks/HOOKS_SPEC.md` - Hook contract definitions

**LangChain Plugin (FR-001):**
- New: `ai/langchain/` - Python LangChain code
- New: `scripts/langchain_*.sh` - Bash wrappers
- New: `ai/langchain/config.json` - Plugin config
- New: `ai/langchain/chains/` - LangChain chain definitions
- New: `ai/langchain/tools/` - Custom tools
- New: `ai/langchain/plugin.json` - Plugin metadata

### API/Interface Design

**Enhancement Hook Contract:**
```bash
# Hook: {{BRIEF_GENERATOR}}
# Input: stdin (git diff or natural language)
# Output: stdout (brief markdown)
# Exit code: 0=success, 1=error

# Example implementation by LangChain plugin:
cat diff.txt | ai/langchain/hooks/generate_brief.sh
```

**LangChain Commands:**
```bash
# Generate brief from git diff
git diff main...feature | igris langchain generate-brief

# Generate brief from natural language
igris langchain generate-brief "add user authentication with JWT"

# Code review
igris langchain review [--files <pattern>]

# Generate tests
igris langchain generate-tests <file_path>

# Enhanced system assessment (called by ARISE)
igris langchain assess
```

**Configuration:**
```json
{
  "provider": "anthropic",
  "model": "claude-3-5-sonnet-20241022",
  "api_key_env": "ANTHROPIC_API_KEY",
  "features": {
    "brief_generation": true,
    "code_review": true,
    "test_generation": true,
    "codebase_rag": true
  },
  "embeddings": {
    "provider": "openai",
    "model": "text-embedding-3-small"
  }
}
```

---

## Context & Inputs

### Dependencies
- [x] New package needed: `langchain` (Python, for chains and agents)
- [x] New package needed: `langchain-anthropic` (for Claude integration)
- [x] New package needed: `chromadb` (for vector storage/RAG)
- [x] New package needed: `tiktoken` (for token counting)
- [x] Existing system: Python3 (already required dependency)
- [x] Existing system: Plugin system (TD-003, already implemented)
- [x] External service: Anthropic API (or OpenAI, configurable)

### Files to Create

**Phase 1 (TD-012 - Enhancement Hook System):**
- `ai/hooks/HOOKS_SPEC.md` - Hook contract documentation
- `test/hooks.test.bash` - Hook system tests

**Phase 2 (FR-001 - LangChain Plugin):**
- `ai/langchain/plugin.json` - Plugin metadata
- `ai/langchain/config.json.example` - Configuration template
- `ai/langchain/README.md` - Plugin documentation
- `ai/langchain/requirements.txt` - Python dependencies
- `ai/langchain/setup.py` - Python package setup
- `ai/langchain/chains/brief_generator.py` - Brief generation chain
- `ai/langchain/chains/code_reviewer.py` - Code review chain
- `ai/langchain/chains/test_generator.py` - Test generation chain
- `ai/langchain/agents/codebase_analyst.py` - RAG agent
- `ai/langchain/tools/git_tools.py` - Git integration tools
- `ai/langchain/tools/brief_tools.py` - Brief management tools
- `scripts/langchain_generate_brief.sh` - Bash wrapper
- `scripts/langchain_review.sh` - Bash wrapper
- `scripts/langchain_generate_tests.sh` - Bash wrapper
- `scripts/langchain_assess.sh` - Bash wrapper
- `test/langchain/brief_generation.test.bash` - Tests
- `test/langchain/code_review.test.bash` - Tests

### Files to Modify

**Phase 1 (TD-012):**
- `scripts/igris_init.sh` - Add hook resolution logic
- `ai/templates/CLAUDE.md.template` - Add hook placeholders
- `ai/prompts/igris_os.md` - Document hook system
- `README.md` - Document enhancement capabilities
- `CHANGELOG.md` - Version update

**Phase 2 (FR-001):**
- `README.md` - Add LangChain plugin documentation
- `docs/PLUGIN_DEVELOPMENT.md` - Add enhancement hook examples
- `CHANGELOG.md` - Version update

### Configuration Changes
- [x] New settings: `ai/langchain/config.json` (model, API keys, features)
- [x] Environment variables: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (user-provided)
- [x] Optional: `LANGCHAIN_TRACING_V2` (for debugging)

---

## Alternatives Considered

### Alternative 1: Plugin-Only Architecture (No Core Hooks)
**Pros:**
- ✅ Faster to implement (skip hook system)
- ✅ No core changes needed
- ✅ Completely isolated

**Cons:**
- ❌ Plugin must duplicate core logic
- ❌ Can't integrate with existing workflows
- ❌ Other enhancement plugins not possible
- ❌ Fragile (breaks if core changes)

**Why not chosen:** Hook system enables extensibility beyond just LangChain. Future plugins (security scanning, performance analysis, etc.) benefit from same architecture.

### Alternative 2: Core Integration (Mandatory LangChain)
**Pros:**
- ✅ Deeply integrated experience
- ✅ Every user gets AI features
- ✅ Simpler architecture (no plugin layer)

**Cons:**
- ❌ Mandatory API costs for all users
- ❌ Breaking change (v3.0.0)
- ❌ Excludes users who can't use external APIs
- ❌ Complexity in core (harder to maintain)

**Why not chosen:** Igris AI should work perfectly without AI enhancements. Users choose their level of augmentation.

### Alternative 3: LangGraph Instead of LangChain
**Pros:**
- ✅ More powerful agentic workflows
- ✅ Better state management
- ✅ Cycle detection and flow control

**Cons:**
- ❌ More complex to learn and maintain
- ❌ Overkill for simple chains (brief generation)
- ❌ Larger dependency footprint

**Why not chosen:** Start with LangChain for simplicity. Can migrate to LangGraph later for advanced agent workflows (PI-XXX future brief).

---

## Constraints

### Technical Constraints
- Must work with existing plugin system (TD-003)
- Must be optional (Igris AI works without it)
- Must not break existing workflows
- Must support multiple LLM providers (Anthropic, OpenAI, local models)
- Must handle API failures gracefully (fallback to manual workflows)
- Python dependencies must be isolated (requirements.txt)

### UX Constraints
- Must be intuitive (commands feel natural)
- Must not disrupt existing workflows (opt-in enhancements)
- Must provide clear feedback (show what AI is analyzing)
- Must handle slow API responses (show progress)
- Must work offline (optional - when features disabled)

### Privacy Constraints
- Must not send code to external APIs without user consent
- Must allow local-only operation (local LLMs)
- Must document what data is sent where
- Must respect .gitignore and sensitive files

### Timeline
- **Phase 1 Deadline:** 1 week (hook system)
- **Phase 2 Deadline:** 2 weeks (LangChain plugin MVP)
- **Milestones:**
  - Week 1: TD-012 complete (hook system working)
  - Week 2: Brief generation working
  - Week 3: Code review + test generation working
  - Week 4: Polish, documentation, dogfooding

### Out of Scope (Future Enhancements)
- LangGraph migration (advanced agents)
- Multi-agent collaboration
- Integration with external issue trackers (GitHub, Jira, Linear)
- Autonomous brief prioritization
- Predictive effort estimation
- Performance profiling and optimization suggestions
- Security vulnerability scanning

---

## Tasks

### Pending
- [ ] Task 1: Create TD-012 brief (Enhancement Hook System)
- [ ] Task 2: Implement TD-012 (hook system in core)
- [ ] Task 3: Design LangChain plugin architecture
- [ ] Task 4: Setup Python package structure
- [ ] Task 5: Implement brief generation chain
- [ ] Task 6: Implement codebase RAG (ChromaDB embeddings)
- [ ] Task 7: Implement code review chain
- [ ] Task 8: Implement test generation chain
- [ ] Task 9: Create bash wrapper scripts
- [ ] Task 10: Write plugin documentation
- [ ] Task 11: Create example configuration
- [ ] Task 12: Write tests for all chains
- [ ] Task 13: Test end-to-end workflows
- [ ] Task 14: Dogfood on Igris AI itself
- [ ] Task 15: Update README and CHANGELOG

### In Progress
_(No tasks in progress yet)_

### Completed
_(No tasks completed yet)_

---

## Session State (Tactical - This Brief)

**Current State:** Brief creation complete, ready for implementation
**Next Steps When Resuming:** Create TD-012 brief for hook system
**Last Updated:** 2025-11-14
**Blockers:** None - TD-012 must be completed first before FR-001 implementation

---

## Acceptance Criteria

**The feature is complete when:**

1. [ ] TD-012 complete (hook system working in core)
2. [ ] LangChain plugin installed via `igris plugin install`
3. [ ] Brief generation works: `git diff | igris langchain generate-brief`
4. [ ] Brief generation from NL works: `igris langchain generate-brief "add auth"`
5. [ ] Code review works: `igris langchain review`
6. [ ] Test generation works: `igris langchain generate-tests <file>`
7. [ ] Codebase RAG provides context-aware recommendations on ARISE
8. [ ] Configuration documented (API keys, model selection)
9. [ ] Tests pass for all chains
10. [ ] Plugin README complete with examples
11. [ ] Dogfooded on Igris AI itself (ate our own dog food)
12. [ ] CHANGELOG and README updated

---

## Test Plan

### Functional Tests

**Test Case 1: Brief Generation from Git Diff**
**Steps:**
1. Create feature branch with code changes
2. Run: `git diff main...feature | igris langchain generate-brief`
3. Review generated brief file

**Expected Result:**
- Brief file created in `ai/briefs/BR-XXX-*.md`
- Problem section populated from diff analysis
- Context section includes affected files
- Acceptance criteria generated from changes
**Status:** [ ] Pass / [ ] Fail

**Test Case 2: Brief Generation from Natural Language**
**Steps:**
1. Run: `igris langchain generate-brief "add JWT authentication to API"`
2. Review generated brief

**Expected Result:**
- Brief includes authentication context
- References existing auth patterns if in codebase
- Acceptance criteria match JWT requirements
**Status:** [ ] Pass / [ ] Fail

**Test Case 3: Code Review Against Guidelines**
**Steps:**
1. Make changes that violate coding_guidelines.md
2. Run: `igris langchain review`
3. Review feedback

**Expected Result:**
- Violations detected and reported
- Suggestions reference coding_guidelines.md sections
- Similar correct patterns shown from codebase
**Status:** [ ] Pass / [ ] Fail

**Test Case 4: Test Generation**
**Steps:**
1. Implement feature in `src/auth/LoginService.ts`
2. Run: `igris langchain generate-tests src/auth/LoginService.ts`
3. Review generated tests

**Expected Result:**
- Test file created with unit tests
- Edge cases covered
- Follows existing test patterns in codebase
**Status:** [ ] Pass / [ ] Fail

**Test Case 5: Codebase RAG Recommendations**
**Steps:**
1. Run: `igris langchain assess` (or ARISE with plugin)
2. Review recommendations

**Expected Result:**
- Recommendations reference recent commits
- Suggests briefs based on similar completed work
- Identifies patterns (increasing debt, resolved blockers)
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] Igris AI works without plugin installed (backward compatible)
- [ ] Existing workflows unchanged (init, implement, commit)
- [ ] Plugin install/uninstall works correctly
- [ ] No performance degradation for non-AI workflows

### Edge Cases
- [ ] API key missing - graceful error with setup instructions
- [ ] API rate limit hit - retry with backoff
- [ ] Network offline - fallback to manual workflow
- [ ] Invalid git diff - clear error message
- [ ] Empty codebase - brief generation still works

---

## Delivery

### Documentation
- [ ] User guide: "Getting Started with LangChain Plugin" in README
- [ ] Configuration guide: API keys, model selection
- [ ] Command reference: All `igris langchain *` commands
- [ ] Hook development guide: For future enhancement plugins
- [ ] Examples: Real brief generation, code review output

### Announcement
- [ ] Changelog entry: "v3.0.0 - LangChain Integration (Hybrid Architecture)"
- [ ] Release notes: Feature highlights, setup instructions
- [ ] Blog post: "From Structured Workflows to Intelligent Engineering"

---

## Success Metrics

**How will we know this feature is valuable?**

- 70% of Igris AI users install LangChain plugin within 30 days
- Brief generation reduces time from 15min → 2min (85% reduction)
- Code review catches 80% of guideline violations before commit
- Test generation achieves 60%+ coverage in <5 minutes
- Positive feedback: "Igris AI + LangChain transformed my workflow"

---

## Notes

**Implementation Priority:**

**Phase 1 (Week 1): Foundation**
- TD-012: Enhancement hook system
- Plugin structure and installation

**Phase 2 (Week 2): Killer Feature**
- Brief generation (highest ROI)
- Basic configuration

**Phase 3 (Week 3): Intelligence**
- Codebase RAG for recommendations
- Code review chain

**Phase 4 (Week 4): Polish**
- Test generation
- Documentation
- Dogfooding

**Inspiration:**
- Cursor AI (codebase-aware suggestions)
- GitHub Copilot Workspace (brief generation)
- Aider (AI pair programming)
- LangChain's own codebase analysis tools

**Future Enhancements (Out of Scope):**
- Multi-agent collaboration (agents work together on complex tasks)
- Integration with GitHub Issues, Jira, Linear
- Autonomous brief prioritization based on business value
- Predictive effort estimation (ML on historical data)
- Performance profiling and bottleneck detection
- Security vulnerability scanning (OWASP, CVE databases)
- Migration to LangGraph for advanced workflows

**Dogfooding Commitment:**
Use LangChain plugin to maintain Igris AI itself. Every brief, every commit reviewed by our own system.

---

**Created:** 2025-11-14
**Last Updated:** 2025-11-14
**Brief Owner:** Igris AI / Fifty.ai
