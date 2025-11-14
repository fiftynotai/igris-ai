# FR-001 Phase 1: Implementation Plan
## LangChain Plugin Architecture + Brief Generation MVP

**Brief:** FR-001 - LangChain Integration for Enhanced Intelligence
**Phase:** 1 of 4
**Duration:** 1 week (5 working days)
**Goal:** Functional LangChain plugin with brief generation capability
**Dependencies:** TD-012 ✅ (Enhancement Hook System complete)

---

## Phase 1 Objectives

### Primary Goal
Build a working LangChain plugin that can auto-generate briefs from git diffs or natural language.

### Success Criteria
- [ ] Plugin installable via `igris plugin install`
- [ ] Hook registered and discovered by Igris AI core
- [ ] Command works: `git diff | igris generate-brief`
- [ ] Command works: `igris generate-brief "add authentication"`
- [ ] Generated briefs follow BR-XXX template format
- [ ] Configuration documented (API keys, model selection)
- [ ] Basic tests passing

---

## Daily Breakdown

### Day 1: Plugin Structure + Dependencies (4-6 hours)

**Morning: Project Setup**
- [ ] Create plugin directory structure
- [ ] Initialize Python package (setup.py, requirements.txt)
- [ ] Setup git repository for plugin
- [ ] Create plugin.json metadata file
- [ ] Document installation instructions

**Afternoon: Dependency Setup**
- [ ] Install and test langchain core
- [ ] Install and test langchain-anthropic (or langchain-openai)
- [ ] Create configuration system (API keys, model selection)
- [ ] Test basic LangChain chain execution
- [ ] Create example configuration file

**Deliverables:**
```
igris-ai-langchain/
├── plugin.json
├── README.md
├── requirements.txt
├── setup.py
├── config.json.example
└── ai/
    └── langchain/
        ├── __init__.py
        └── config.py
```

**Validation:**
```bash
# Can install dependencies
pip install -r requirements.txt

# Can import modules
python3 -c "from langchain.chains import LLMChain; print('OK')"
```

---

### Day 2: Brief Generation Chain (6-8 hours)

**Morning: Chain Architecture**
- [ ] Design brief generation prompt template
- [ ] Define chain input schema (git diff vs natural language)
- [ ] Implement LangChain chain for brief generation
- [ ] Test with sample git diff
- [ ] Test with natural language input

**Afternoon: Hook Integration**
- [ ] Create `hooks/generate_brief.sh` bash wrapper
- [ ] Implement stdin/stdout handling
- [ ] Add error handling and logging
- [ ] Register hook in plugin.json
- [ ] Test hook execution via execute_hook()

**Deliverables:**
```
ai/langchain/
├── chains/
│   ├── __init__.py
│   └── brief_generator.py
├── prompts/
│   └── brief_generation.txt
└── hooks/
    └── generate_brief.sh
```

**Validation:**
```bash
# Hook can be discovered
python3 -c "from ai.langchain.chains.brief_generator import generate_brief; print('OK')"

# Hook executes successfully
echo "test diff" | ./ai/langchain/hooks/generate_brief.sh
```

---

### Day 3: Command Integration + Testing (6-8 hours)

**Morning: Command Script**
- [ ] Create `scripts/igris_generate_brief.sh`
- [ ] Implement stdin vs argument detection
- [ ] Add brief numbering logic (find next BR-XXX)
- [ ] Extract title from generated brief
- [ ] Save to ai/briefs/ directory
- [ ] Add usage examples and error messages

**Afternoon: Testing**
- [ ] Write unit tests for brief_generator.py
- [ ] Write integration test for full workflow
- [ ] Test with real git diff from sample project
- [ ] Test with various natural language inputs
- [ ] Document test results

**Deliverables:**
```
scripts/
└── igris_generate_brief.sh

test/langchain/
├── test_brief_generator.py
└── fixtures/
    ├── sample_diff.txt
    └── expected_brief.md
```

**Validation:**
```bash
# Command exists and shows help
./scripts/igris_generate_brief.sh

# Generate from diff
git diff main...feature | ./scripts/igris_generate_brief.sh

# Generate from NL
./scripts/igris_generate_brief.sh "add JWT authentication"

# Check brief created
ls ai/briefs/BR-*.md
```

---

### Day 4: Polish + Documentation (4-6 hours)

**Morning: Error Handling**
- [ ] Handle missing API key gracefully
- [ ] Handle rate limits with retry logic
- [ ] Handle empty/invalid input
- [ ] Add progress indicators
- [ ] Improve error messages

**Afternoon: Documentation**
- [ ] Complete plugin README
- [ ] Add installation guide
- [ ] Add configuration guide (API keys, models)
- [ ] Add usage examples
- [ ] Document limitations and known issues
- [ ] Create troubleshooting section

**Deliverables:**
```
README.md (complete)
docs/
├── INSTALLATION.md
├── CONFIGURATION.md
└── USAGE.md
```

**Validation:**
```bash
# Documentation complete
cat README.md | grep -q "Installation"
cat README.md | grep -q "Configuration"
cat README.md | grep -q "Usage"
```

---

### Day 5: Packaging + Integration Testing (4-6 hours)

**Morning: Plugin Packaging**
- [ ] Create install.sh script
- [ ] Test plugin installation end-to-end
- [ ] Verify hooks registered in installed.json
- [ ] Verify CLAUDE.md updated with plugin info
- [ ] Test plugin uninstallation

**Afternoon: Dogfooding**
- [ ] Install plugin in Igris AI repo
- [ ] Generate 3 real briefs from actual work
- [ ] Refine prompts based on output quality
- [ ] Document improvements needed
- [ ] Create Phase 2 task list

**Deliverables:**
```
install.sh
PHASE_1_RESULTS.md
PHASE_2_TASKS.md
```

**Validation:**
```bash
# Can package plugin
tar -czf igris-ai-langchain-v1.0.0.tar.gz .

# Can install in test project
cd /tmp/test-project
./scripts/plugin_install.sh igris-ai-langchain-v1.0.0.tar.gz

# Plugin shows in list
./scripts/plugin_list.sh | grep -q "igris-langchain"

# Hook works end-to-end
git diff | ./scripts/igris_generate_brief.sh
```

---

## File Structure (Complete)

```
igris-ai-langchain/
├── plugin.json                          # Plugin metadata + hooks
├── README.md                            # Main documentation
├── LICENSE                              # MIT license
├── requirements.txt                     # Python dependencies
├── setup.py                             # Python package setup
├── install.sh                           # Plugin installer script
├── config.json.example                  # Example configuration
│
├── docs/
│   ├── INSTALLATION.md                  # Installation guide
│   ├── CONFIGURATION.md                 # Configuration guide
│   └── USAGE.md                         # Usage examples
│
├── ai/
│   └── langchain/
│       ├── __init__.py
│       ├── config.py                    # Configuration loader
│       │
│       ├── chains/
│       │   ├── __init__.py
│       │   └── brief_generator.py       # Brief generation chain
│       │
│       ├── prompts/
│       │   └── brief_generation.txt     # LangChain prompt template
│       │
│       └── hooks/
│           └── generate_brief.sh        # Bash hook wrapper
│
├── scripts/
│   └── igris_generate_brief.sh          # User-facing command
│
└── test/
    └── langchain/
        ├── test_brief_generator.py      # Unit tests
        └── fixtures/
            ├── sample_diff.txt
            └── expected_brief.md
```

---

## Dependencies

### Python Packages (requirements.txt)
```txt
langchain>=0.1.0
langchain-anthropic>=0.1.0  # or langchain-openai
chromadb>=0.4.0              # For Phase 2 (RAG)
tiktoken>=0.5.0              # Token counting
pydantic>=2.0.0              # Data validation
python-dotenv>=1.0.0         # Environment variables
```

### System Requirements
- Python 3.9+
- pip
- git
- Igris AI v2.5.0+ (with TD-012 hook system)

### API Requirements
- Anthropic API key (or OpenAI API key)
- Claude 3.5 Sonnet or Claude 3 Opus recommended

---

## Configuration

### config.json Structure
```json
{
  "provider": "anthropic",
  "model": "claude-3-5-sonnet-20241022",
  "api_key_env": "ANTHROPIC_API_KEY",
  "features": {
    "brief_generation": true,
    "code_review": false,
    "test_generation": false,
    "codebase_rag": false
  },
  "generation": {
    "temperature": 0.7,
    "max_tokens": 2000
  }
}
```

### Environment Variables
```bash
# Required
export ANTHROPIC_API_KEY="sk-ant-..."

# Optional
export LANGCHAIN_TRACING_V2="true"
export LANGCHAIN_API_KEY="..."
```

---

## plugin.json Structure

```json
{
  "name": "igris-langchain",
  "version": "1.0.0",
  "description": "LangChain AI enhancements for Igris AI - brief generation, code review, and more",
  "author": "Fifty.ai",
  "repository": "https://github.com/fiftynotai/igris-ai-langchain",
  "license": "MIT",
  "igris_version": ">=2.5.0",
  "hooks": {
    "BRIEF_GENERATOR": "ai/langchain/hooks/generate_brief.sh"
  },
  "capabilities": [
    "brief-generation",
    "ai-powered-analysis"
  ],
  "dependencies": {
    "python": ">=3.9",
    "packages": [
      "langchain>=0.1.0",
      "langchain-anthropic>=0.1.0"
    ]
  }
}
```

---

## Testing Strategy

### Unit Tests
```python
# test/langchain/test_brief_generator.py

def test_generate_brief_from_diff():
    """Test brief generation from git diff"""
    diff = load_fixture('sample_diff.txt')
    brief = generate_brief(diff, mode='diff')

    assert brief.startswith('# BR-')
    assert '**Type:**' in brief
    assert '**Priority:**' in brief
    assert '## Problem' in brief

def test_generate_brief_from_natural_language():
    """Test brief generation from natural language"""
    brief = generate_brief("add JWT authentication to API", mode='nl')

    assert 'authentication' in brief.lower()
    assert 'jwt' in brief.lower()
```

### Integration Tests
```bash
# End-to-end workflow test

# 1. Create test project
cd /tmp/test-igris
./scripts/igris_init.sh

# 2. Install plugin
./scripts/plugin_install.sh ~/igris-ai-langchain.tar.gz

# 3. Generate brief
echo "add user authentication" | ./scripts/igris_generate_brief.sh

# 4. Verify brief created
test -f ai/briefs/BR-001-*.md
echo "✅ Phase 1 MVP working!"
```

---

## Risks & Mitigation

### Risk 1: API Rate Limits
**Impact:** High
**Probability:** Medium
**Mitigation:**
- Implement exponential backoff
- Cache responses when appropriate
- Document rate limit behavior
- Provide local model fallback option

### Risk 2: Prompt Quality
**Impact:** High
**Probability:** High
**Mitigation:**
- Iterate on prompts with real examples
- Collect feedback during dogfooding
- Version prompts (v1, v2, etc.)
- Allow prompt customization in config

### Risk 3: Installation Complexity
**Impact:** Medium
**Probability:** Low
**Mitigation:**
- Clear installation docs
- Validate dependencies in install.sh
- Provide troubleshooting guide
- Test on macOS, Linux, WSL

### Risk 4: API Key Security
**Impact:** High
**Probability:** Low
**Mitigation:**
- Never commit API keys
- Use environment variables
- Document security best practices
- Add .env to .gitignore

---

## Success Metrics

### Quantitative
- [ ] Brief generation takes < 30 seconds
- [ ] Generated briefs require < 5 minutes of editing
- [ ] 80%+ of generated content is kept
- [ ] Installation completes in < 2 minutes
- [ ] Zero dependency installation failures

### Qualitative
- [ ] Generated briefs are comprehensive
- [ ] Problem statements are clear
- [ ] Acceptance criteria are testable
- [ ] Context sections are relevant
- [ ] User reports "saves time"

---

## Phase 1 Definition of Done

- [ ] Plugin installable via standard Igris plugin system
- [ ] Hook registered and discoverable
- [ ] Brief generation works from git diff
- [ ] Brief generation works from natural language
- [ ] Briefs follow template format
- [ ] Tests passing (unit + integration)
- [ ] Documentation complete
- [ ] API key configuration documented
- [ ] Error handling graceful
- [ ] Dogfooding complete (3+ real briefs generated)
- [ ] Phase 2 tasks identified
- [ ] Tagged as v1.0.0-alpha

---

## Handoff to Phase 2

### What's Complete
- Plugin architecture
- Brief generation (MVP)
- Command integration
- Basic testing
- Documentation

### What's Next (Phase 2)
- Codebase RAG (ChromaDB embeddings)
- SYSTEM_ASSESSMENT hook (enhanced recommendations)
- Context-aware brief generation (uses RAG)
- Code similarity detection
- Technical debt pattern recognition

### Blockers to Resolve
- [ ] None expected (TD-012 foundation solid)

---

## Timeline Summary

| Day | Focus | Hours | Deliverable |
|-----|-------|-------|-------------|
| 1 | Structure + Dependencies | 4-6 | Working Python environment |
| 2 | Brief Generation Chain | 6-8 | LangChain chain functional |
| 3 | Command + Testing | 6-8 | End-to-end workflow working |
| 4 | Polish + Docs | 4-6 | Production-ready documentation |
| 5 | Packaging + Dogfooding | 4-6 | v1.0.0-alpha tagged |

**Total Effort:** 24-34 hours (~1 week)

---

## Notes

**Why Start with Brief Generation?**
- Highest ROI (saves 15min → 2min per brief)
- Standalone feature (doesn't depend on RAG)
- Validates hook system architecture
- Provides immediate user value
- Foundation for more complex features

**Why Not Include RAG in Phase 1?**
- RAG adds complexity (embeddings, vector DB)
- Brief generation proves the concept first
- Can add RAG incrementally in Phase 2
- Keeps Phase 1 scope manageable

**Why 1 Week?**
- Focused scope (single feature)
- Reasonable for XL brief
- Allows for iteration and refinement
- Dogfooding validates approach

---

**Created:** 2025-11-14
**Status:** Planning complete, ready for implementation
**Next Step:** Begin Day 1 when user commands

---

**Let the forging begin, Monarch. Phase 1 awaits your command.**
