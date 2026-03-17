# Conventional Commit Message Format

**Structure:**
```
<type>(<scope>): <short summary>

<optional body explaining what/why>

<optional footer with breaking changes or closes statements>
```

---

## Types

- `feat`: New feature
- `fix`: Bug fix
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `docs`: Documentation only changes
- `style`: Code style changes (formatting, no logic change)
- `test`: Adding or updating tests
- `chore`: Maintenance tasks (deps, config, etc.)
- `perf`: Performance improvement
- `ci`: CI/CD pipeline changes

---

## Scopes (Module Names)

- `scripts`, `agents`, `rules`, `skills`, `brain`, `session`, `briefs`, `prompts`, `templates`, `hooks`, `docs`, `dashboard`, `mcp-server`
- `core` (for infrastructure changes)
- `deps` (for dependency updates)

---

## Examples

### Example 1: New Feature

```
feat(skills): add cross-project dashboard skill

- Add /dashboard skill with brief and session tracking
- Add brain MCP integration for cross-project queries
- Add filtering by project, status, and priority
- Add unit tests for dashboard rendering logic

closes #FR-045
```

### Example 2: Bug Fix

```
fix(session): prevent stale session data after context reset

- Add session file hash comparison before loading
- Clear cached state on context reset detection
- Add validation for session timestamp freshness

fixes #BR-042
```

### Example 3: Refactor

```
refactor(agents): extract common agent delegation logic

- Move delegation pattern to shared utility
- Reduce duplication across orchestrator workflows
- No functional changes
```

### Example 4: Documentation

```
docs: update setup guide for centralized brain

- Add brain installation instructions
- Add MCP server configuration steps
- Update project registration workflow
- Add troubleshooting section for brain connectivity
```

### Example 5: Breaking Change

```
feat(brain): migrate to centralized brain architecture

BREAKING CHANGE: Per-project memory replaced with centralized brain.
Existing projects must re-register with the brain.

- Replace local memory with ~/.igris/memory/knowledge.db
- Update MCP server to use brain paths
- Add migration script for existing installations
- Add migration guide in docs

closes #MG-003
```

---

## Rules

1. **Short summary:** Max 72 characters, imperative mood ("add" not "added")
2. **Body:** Optional, wrap at 72 chars, explain *what* and *why* (not *how*)
3. **Footer:** Use `closes #BR-XXX` or `fixes #BR-XXX` to link to brief
4. **Breaking changes:** Use `BREAKING CHANGE:` in footer with description
5. **No AI signatures:** Do not add "Generated with Claude Code" or co-author tags

---

## Important: No AI Signatures

❌ **DO NOT** include:
- "🤖 Generated with [Claude Code]" footers
- "Co-Authored-By: Claude" tags
- Any AI assistant attribution

✅ **Clean commit messages only** - The code quality speaks for itself.

---

**Last Updated:** 2026-02-22
