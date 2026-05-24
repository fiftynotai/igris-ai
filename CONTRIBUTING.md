# Contributing to Igris AI

Welcome! Igris AI is an open-source code quality and architecture management system. We welcome contributions that improve the system.

---

## 🚀 Quick Start

1. **Fork** the repository
2. **Clone** your fork
3. **Create a branch** from `main`
4. **Make your changes** following our coding guidelines
5. **Test your changes**
6. **Submit a pull request**

---

## 📋 Coding Guidelines

**All contributions MUST follow the Igris AI Coding Guidelines:**

📄 **`~/.igris/projects/{project}/context/coding_guidelines.md`**

This document defines:
- Bash, TypeScript, and Python standards
- Error handling patterns
- Hook and MCP conventions
- Testing requirements
- Documentation standards
- Security best practices
- Commit message format

**Please read the coding guidelines before contributing.**

---

## 🐛 Reporting Bugs

### Before Reporting

1. **Search existing issues** - Check if it's already reported
2. **Check latest version** - Update and test again
3. **Reproduce** - Can you consistently reproduce it?

### Bug Report Template

Create an issue with:

```markdown
**Bug Description:**
Clear description of what's broken

**Steps to Reproduce:**
1. Step one
2. Step two
3. Bug occurs

**Expected Behavior:**
What should happen

**Actual Behavior:**
What actually happens

**Environment:**
- OS: (macOS 14.0, Ubuntu 22.04, etc.)
- Igris AI Version: (run `node -p "require('./package.json').version"`)
- Shell: (bash 5.2, zsh, etc.)

**Error Messages:**
Paste relevant error output
```

---

## ✨ Suggesting Features

### Feature Request Template

Create an issue with:

```markdown
**Feature Name:**
Brief name

**Problem:**
What problem does this solve?

**Proposed Solution:**
How should it work?

**Alternatives Considered:**
What other approaches did you consider?

**Additional Context:**
Screenshots, examples, references
```

---

## 🔧 Development Workflow

### 1. Set Up Development Environment

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/igris-ai.git
cd igris-ai

# Add upstream remote
git remote add upstream https://github.com/fiftynotai/igris-ai.git

# Create development branch
git checkout -b feature/my-feature
```

### 2. Make Changes

Follow the coding guidelines:
- Use `set -e` in all scripts
- Validate dependencies upfront
- Use perl for multi-line substitution
- Quote all variables
- Provide clear error messages

### 3. Test Your Changes

```bash
# Run shellcheck on modified scripts
shellcheck scripts/*.sh

# Run bash tests
bats test/

# TypeScript (if modifying MCP server)
cd brain-mcp-server && npm run build

# Manual testing — bootstrap brain from this checkout, then install in test project
node cli/dist/index.js init --from-source .
mkdir -p /tmp/test-project
node cli/dist/index.js install /tmp/test-project
```

### 3.1 Brief-gate escape hatch (emergency only)

The `pre_tool_use.sh` hook enforces the brief-first protocol: no Write/Edit
proceeds unless an `In Progress` brief exists in the brain DB (or, as a
fallback, in the v6 filesystem brief-cache at
`~/.igris/projects/<slug>/briefs/`). In an emergency where the brief gate
is wrongly blocking work (e.g. a corrupt brain DB during recovery, or you
need a one-off escape hatch while you fix the underlying problem), the
hook honours the env var **`IGRIS_BYPASS_BRIEF_GATE=1`**:

```bash
# One-shot per command — DO NOT `export` this variable.
IGRIS_BYPASS_BRIEF_GATE=1 <command>
```

When the bypass fires, the hook emits a loud WARNING on stderr and writes
a `brief_gate.bypassed` row into the brain DB's `event_log` table, so the
bypass leaves an audit trail. Symmetric with `IGRIS_BYPASS_PHASE_GUARD=1`
in `scripts/git-hooks/pre-commit`.

**Critical:** never `export IGRIS_BYPASS_BRIEF_GATE=1` in your shell or rc
file. Exported env vars inherit into every subprocess — including subagent
spawns (forger, sentinel) during a `/hunt` — and would silently disable
the brief gate across the whole session. Always pass it one-shot, prefixed
to the single command that needs it.

### 4. Commit Your Changes

Follow conventional commits format:

```bash
git commit -m "feat(skills): add sync skill for VPS deployment

Implemented /sync skill with code, data, and status modes.

closes #FR-045"
```

**Commit types:**
- `feat` - New feature
- `fix` - Bug fix
- `refactor` - Code refactoring
- `docs` - Documentation
- `chore` - Maintenance
- `test` - Tests

**See the coding guidelines (section 17: Conventional Commits) for details.**

### 5. Push and Create PR

```bash
# Push to your fork
git push origin feature/my-feature

# Create pull request on GitHub
# Use the PR template (will be auto-populated)
```

---

## 🎯 Pull Request Guidelines

### PR Checklist

Before submitting, ensure:

- [ ] Code follows coding guidelines (`~/.igris/projects/{project}/context/coding_guidelines.md`)
- [ ] All scripts pass `shellcheck`
- [ ] Tests added/updated (if applicable)
- [ ] Documentation updated (if needed)
- [ ] Commit messages follow conventional format
- [ ] PR description explains changes clearly
- [ ] Tested on macOS and/or Linux
- [ ] No hardcoded paths
- [ ] Variables are quoted
- [ ] Error messages are clear and actionable

### PR Description Template

```markdown
## Summary
What does this PR do?

## Related Issue
closes #XX
fixes #YY

## Changes
- Change 1
- Change 2

## Testing
How was this tested?

## Screenshots
(if applicable)
```

---

## 🧪 Testing

### Automated Testing

Igris AI has a comprehensive test suite using the bats framework. Test files use the `.test.bash` extension.

**Test Framework:** [bats-core](https://github.com/bats-core/bats-core)

**Install bats:**

```bash
# macOS
brew install bats-core

# Ubuntu/Debian
sudo apt install bats
```

**Run all tests:**

```bash
bats test/
```

**Run specific test file:**

```bash
bats test/igris_worker.test.bash
bats test/verify_mirror.test.bash
```

**Run with verbose output:**

```bash
bats test/ --tap
```

### Writing Tests

When adding new functionality:

1. **Add tests for new scripts** - Create `test/script_name.test.bash`
2. **Use test helpers** - Load `test_helper.bash` for common utilities
3. **Follow test patterns** - See existing tests for examples
4. **Test error handling** - Add negative test cases
5. **Test edge cases** - Special characters, empty inputs, etc.

**Test helper utilities:**

```bash
load test_helper

@test "example test" {
  # Setup
  setup_test_project

  # Execute
  run "$SCRIPTS_DIR/your_script.sh" "args"

  # Assert
  assert_success
  assert_file_exists "$TEST_PROJECT_DIR/some/file"
  assert_file_contains "$TEST_PROJECT_DIR/file" "content"
}
```

See `test/README.md` for full testing documentation.

### Manual Testing

Test your changes on a real project:

```bash
# Bootstrap the brain from your checkout, then install into a test project
node cli/dist/index.js init --from-source .
mkdir -p /tmp/test-project
node cli/dist/index.js install /tmp/test-project

# Test the feature/fix
# ...
```

### Test Coverage Requirements

**For new scripts:**
- ✅ Critical paths: 100% coverage
- ✅ Error handling: 80% coverage
- ✅ Edge cases: 60% coverage

**For modified scripts:**
- ✅ Add tests for new functionality
- ✅ Ensure existing tests still pass
- ✅ Add regression tests if fixing bugs

### CI/CD

Tests run automatically on:
- Every push to `main` branch
- Every pull request
- Both Ubuntu and macOS environments

See `.github/workflows/test.yml` for CI configuration.

---

## 📖 Documentation

### What Needs Documentation

- **New features:** Update README.md and relevant docs
- **Changed behavior:** Update affected docs
- **New scripts:** Add inline documentation
- **API changes:** Update integration guides

### Documentation Standards

See the coding guidelines (section 14: Documentation)

**Key points:**
- Comment the WHY, not the WHAT
- Use clear, actionable language
- Provide examples
- Keep docs up to date

---

## 🔍 Code Review Process

### What Reviewers Look For

1. **Follows guidelines:** All coding standards met
2. **Tests pass:** shellcheck clean, tests green
3. **Clear purpose:** PR has clear objective
4. **No breaking changes:** Unless absolutely necessary
5. **Documentation:** Changes are documented
6. **Security:** No vulnerabilities introduced

### Review Timeline

- **Initial response:** Within 2-3 days
- **Full review:** Within 1 week
- **Merge (if approved):** Within 1-2 days after approval

---

## 🏗️ Project Structure

```
igris-ai/
├── .claude/
│   ├── agents/              # Symlinks → ~/.igris/core/agents/
│   ├── hooks/               # Hook scripts
│   ├── rules/               # Symlink → ~/.igris/core/rules/
│   ├── skills/              # Symlinks → ~/.igris/core/skills/
│   └── settings.json        # Claude Code config
├── core/                    # Distribution source for ~/.igris/core/
│   ├── agents/              # Native subagents
│   ├── prompts/             # System prompts (igris_os.md)
│   ├── rules/               # 1 universal rule (v7)
│   ├── skills/              # Skills
│   ├── scripts/             # Mirrored helpers (verify_mirror.sh, cli-adapters/)
│   ├── templates/           # PR/brief templates
│   ├── task-handlers/       # Worker daemon handlers
│   ├── SOUL.md              # Persona identity
│   └── igris_tree.json      # Context routing tree (v7)
├── brain-mcp-server/        # Brain MCP server (TypeScript)
├── cli/                     # The `igris` npm CLI (TypeScript)
├── docs/                    # Documentation
├── scripts/                 # Repo-only scripts (validators, brain ops; see "scripts/ inventory")
│   └── archive/             # Completed one-shots (see scripts/archive/README.md)
├── test/                    # Tests (bats framework)
└── CLAUDE.md                # Slim context pointer (v7)
```

Project version lives in `package.json` (`node -p "require('./package.json').version"`); the machine-local `.igris_version` stamp written by the CLI installer is gitignored.

---

## 🧰 scripts/ inventory

Every script under `scripts/` (excluding `scripts/archive/`, covered by its own
README) and `core/scripts/`, and how each is invoked. If you add or remove a
script here, update this table in the same PR.

| Script | Invoked by | Purpose |
|--------|-----------|---------|
| `scripts/git-hooks/pre-commit` | symlinked into `.git/hooks/pre-commit` (one-time, via `scripts/install_git_hooks.sh`) | Conditional pre-commit validators (enum drift, tree line-ranges, lockfile sync) — runs only when the relevant files are staged. Also enforces the PI-004 phase guard. |
| `scripts/install_git_hooks.sh` | manual (one-time, per contributor / fresh checkout) | Symlinks every file in `scripts/git-hooks/` into `.git/hooks/`; backs up any pre-existing non-symlink hook before clobbering (TD-072 F3). Idempotent. |
| `scripts/validate_brain_stewardship_enums.sh` | `scripts/git-hooks/pre-commit` (and standalone) | Asserts every `memory_store` enum value (`category`/`scope`/`provenance`) appears in the `brain_stewardship` section of `core/prompts/brain_stewardship.md`, plus schema-shrinkage reverse check. (Renamed from `validate_memory_agency_enums.sh` in TD-148.) |
| `scripts/validate_igris_tree_lineranges.py` | `scripts/git-hooks/pre-commit` (and standalone) | Asserts every section declared in `igris_tree.json` has matching `<!-- SECTION: … -->` markers at the declared line ranges in `igris_os.md`. |
| `scripts/validate_lockfile_in_sync.sh` | `scripts/git-hooks/pre-commit` (and standalone) | Asserts `npm ci --dry-run --ignore-scripts` from repo root succeeds — the workspace lockfile is in sync with all `package.json` files. |
| `scripts/validate_agent.sh` | manual / docs (`docs/archive/MIGRATION_GUIDE-v5-to-v6.md`) | Validates an agent-definition `.md`'s frontmatter and structure. Not yet CI-wired. |
| `scripts/emit_skill_event.sh` | `core/skills/*/SKILL.md` (21 skills, on invoke) | Emits a `SkillInvoke` event to the brain REST API. |
| `scripts/igris_worker.sh` + `scripts/igris_worker_config.sh` | manual (`igris_worker.sh start`) | Autonomous-worker daemon: polls the brain REST API for tasks and spawns Claude Code sessions. (Not orchestrated in v7; see arch-review §2.2.) |
| `scripts/igris_brain_backup.sh` / `scripts/igris_brain_restore.sh` | manual | Backup / restore `~/.igris/memory/knowledge.db` (`sqlite3 .backup`; backup rotates the last 5; restore safety-backs-up before overwriting). |
| `scripts/igris_brain_switch.sh` | manual | Switch `~/.claude.json` brain mode: local / remote / dual. (Configures the MCP server deployed to `~/.igris/mcp-server/` runtime dir; `igris_brain_deploy.sh` populates that dir from `brain-mcp-server/`.) |
| `scripts/igris_brain_deploy.sh` | manual (on a VPS) | Deploy the brain MCP server with PM2 + nginx reverse-proxy config + API-key generation; copies `brain-mcp-server/` source into `~/.igris/mcp-server/`. |
| `core/scripts/verify_mirror.sh` | forger MIRROR_SYNC protocol, sentinel MIRROR_CHECK contract, `/hunt` skill, architect plan template | Byte-equality check between repo `core/*` files and their `~/.igris/core/*` runtime mirrors (realpath-resolved, exit-code-checked, verdict-per-pair output). |
| `core/scripts/cli_smoke.sh` | manual diagnostic | CLI smoke test. |
| `core/scripts/cli-adapters/_common.sh` | sourced by every adapter | Shared helpers (parse_frontmatter, atomic_symlink, validate_manifest, merge_overlay_manifest). FR-153 RETIRED `md_to_agents_md.sh` + `md_to_gemini_toml.sh` (codex + gemini now read SKILL.md natively via symlink — no aggregation/conversion). FR-152 RETIRED `sync_claude_agents.sh` (claude reads symlink to registry-vendored canonical). `sync_codex_agents.sh` is the only remaining format converter (MD → TOML for codex agents). |

> Build-time helper (not under top-level `scripts/`): `cli/scripts/copy-templates.sh` is run from `cli/` by `npm run build` (`tsc && bash scripts/copy-templates.sh`) to copy template assets into `cli/dist/`.

---

## 📚 Documentation Invariants

Docs rot when no rule says "when you change X, update Y". The list below is
the contributor maintenance contract. Every item names what to update and
the surface that holds it. Mirror this list during code review (warden
enforces) and during pre-commit (the §13 "Enumeration surfaces" rule in
`~/.igris/projects/igris-ai/context/coding_guidelines.md` is the wider
form of this contract).

1. **When you add a brain MCP tool** → list it in:
   - `docs/architecture/SYSTEM.md`'s "Brain DB" section (or the relevant
     per-feature doc — the tool count + the component bullet).
   - The relevant `docs/architecture/<component>.md` per-feature doc (e.g.,
     a new edges tool → `docs/architecture/typed_edges.md`).
   - `core/prompts/brain_stewardship.md` decision trigger if the tool is a
     READ surface (per L-95 / `coding_guidelines.md` §13).

2. **When you add or remove a hook handler** → list it in:
   - `docs/HOOK_EVENT_SCHEMA.md` (handler table + behavior).
   - `docs/multi-cli.md` if the handler is cross-CLI-aware.
   - The `events_covered` list in `~/.igris/config.json:cli_targets.*.hooks`.

3. **When you add or remove an agent** → register it in:
   - `core/agents/<name>.md` (the agent definition itself).
   - `core/igris_tree.json:agents` (the LIVE routing — the canonical
     source for which context files the agent loads).
   - `core/agents/manifest.yaml` (DEPRECATED registry, but kept for
     reference until removed).
   - `CLAUDE.md` "Available Agents" line + `scripts/templates/CLAUDE.md.template`.
   - `docs/architecture/SYSTEM.md`'s agent roster table.
   - `README.md` if agent count or list appears.

4. **When you add or remove a skill** → register it in:
   - `core/skills/<name>/SKILL.md` (the skill itself).
   - `CLAUDE.md` "Available Skills" list + `scripts/templates/CLAUDE.md.template`.
   - `docs/architecture/SYSTEM.md`'s skill inventory table.
   - `README.md` slash-command tables (both the Workflow section and the
     Skills section).
   - `docs/<feature>.md` if a feature doc references the skill.

5. **When you change a `core/` file that has a runtime mirror** → follow
   the **TD-096 mirror-sync protocol**:
   ```bash
   cp <repo-core-file> ~/.igris/core/<same-path>
   bash core/scripts/verify_mirror.sh <file>
   # Verdict must say MATCH.
   ```
   This applies to: `core/agents/*.md`, `core/skills/*/SKILL.md`,
   `core/prompts/*.md`, `core/rules/*.md`, `core/SOUL.md`, `core/igris_tree.json`,
   `core/hooks/**`, `core/scripts/**`. The sentinel runs MIRROR_CHECK on
   every changed `core/` file during /hunt TESTING; uncommitted drift
   blocks the commit.

6. **When you change the `/hunt` state machine** → update:
   - `docs/architecture/SYSTEM.md`'s state-machine diagram (the mermaid
     block).
   - `core/skills/hunt/SKILL.md` (the canonical state machine).
   - `core/prompts/igris_os.md` "Workflow (Strict)" section — these
     two MUST stay in sync; the §13 enumeration rule lists this.

7. **When you bump a current-system version string** → sweep ALL of:
   - `package.json:version` (canonical).
   - `core/igris_tree.json:version`.
   - `CLAUDE.md:4` (orchestrator identity line).
   - `core/prompts/igris_os.md` (multiple lines — grep first).
   - `CONTRIBUTING.md` "Project structure" version notes.
   - Any README banner or footer that names a version.
   - This is the **TD-147 lesson**: a v6→v7 sweep missed multiple
     surfaces and shipped self-contradicting docs.

8. **When you add a deprecated or disabled feature** → add a
   prominent callout at the top of its docs immediately under the H1.
   - Format: `> **Status (vN): DISABLED/EXPERIMENTAL/DEPRECATED.** <reason>.
     See <brief-id>.` followed by the technical content.
   - Example: `docs/architecture/subconscious_engine.md` carries the
     TD-102 / FR-118 callout. (Without it, a contributor reading the
     doc wastes time troubleshooting an engine that's switched off.)

### Pre-commit reflex

Before any PR that touches an enumeration surface (skill, agent, tool,
component, hook, brief type, config key), run:

```bash
# Find every place the thing's name appears
git grep -n "<thing-name>" -- ':!*.lock' ':!node_modules'
```

Cross-check the hits against the table above. If a surface that should
list the thing doesn't, or one that shouldn't still does, fix it in this
commit. Warden enforces this in /hunt REVIEWING; do not let a PR with
drift across surfaces reach the gate.

---

## 🎨 Code Style

### Shell Scripts

```bash
#!/bin/bash
set -e  # MANDATORY

# Good function
check_dependency() {
  if ! command -v "$1" &> /dev/null; then
    echo "❌ Error: $1 is required but not installed"
    exit 1
  fi
}

# Good variable naming
IGRIS_VERSION="7.0.0"  # Constants: UPPERCASE
target_dir="/path"      # Local vars: lowercase

# Good error message
echo "❌ Error: Python 3 is required but not installed"
echo ""
echo "Install Python 3:"
echo "  macOS:  brew install python3"
echo "  Ubuntu: sudo apt install python3"
```

**Full standards:** `~/.igris/projects/{project}/context/coding_guidelines.md`

---

## ⚠️ Common Mistakes

### DON'T

- ❌ Skip `set -e`
- ❌ Use sed for multi-line substitution
- ❌ Leave variables unquoted
- ❌ Write cryptic error messages
- ❌ Hardcode paths
- ❌ Skip dependency validation
- ❌ Use eval with user input

### DO

- ✅ Use `set -e` in all scripts
- ✅ Use perl for multi-line substitution
- ✅ Quote all variables: `"$VAR"`
- ✅ Provide actionable error messages
- ✅ Use variables for paths
- ✅ Validate dependencies upfront
- ✅ Use safe command substitution

---

## 🤝 Getting Help

### Documentation

- **[README.md](README.md)** - Project overview
- **`~/.igris/projects/{project}/context/coding_guidelines.md`** - Coding standards
- **`~/.igris/core/prompts/igris_os.md`** - Igris AI operating system

### Questions?

- **GitHub Issues** - For bugs and feature requests
- **GitHub Discussions** - For questions and ideas

---

## 📜 License

By contributing to Igris AI, you agree that your contributions will be licensed under the same license as the project.

---

## 🙏 Recognition

Contributors who make significant improvements will be recognized in:
- **README.md** - Contributors section
- **CHANGELOG.md** - Release notes
- **GitHub releases** - Release announcements

---

**Thank you for contributing to Igris AI!**

We build better code together.

---

**Created:** 2025-10-26
**Last Updated:** 2026-02-22
**Maintained By:** Igris AI Team
