# Igris AI Commit Standards

These rules define commit message format and quality standards for all Igris AI managed projects.

---

## Commit Message Format

**Format:** Conventional Commits

```
<type>(<scope>): <short summary>

<optional body>

<optional footer>
```

### Types

| Type | Purpose |
|------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code refactoring (no behavior change) |
| `docs` | Documentation only |
| `chore` | Maintenance tasks |
| `test` | Test additions/changes |

---

## Critical Rules

### DO NOT Add AI Signatures

- **DO NOT** add "Generated with Claude Code"
- **DO NOT** add Co-Authored-By tags
- **DO NOT** add any AI attribution in commits

The code quality speaks for itself.

### DO Use These Practices

- Use clean conventional commits only
- Reference briefs in footer: "closes #BR-XXX"
- Keep summary under 72 characters
- Use imperative mood ("add feature" not "added feature")

---

## Quality Standards Checklist

**Before committing:**

- [ ] Linter/analyzer passes (zero issues)
- [ ] Test suite passes (all tests green)
- [ ] New code has documentation comments
- [ ] Follows coding_guidelines.md patterns
- [ ] Session state updated in CURRENT_SESSION.md
- [ ] Conventional commit format used
- [ ] No AI signatures in commit message

---

## PR Checklist

Before submitting PR:

- [ ] Brief path referenced in PR description
- [ ] Linter/analyzer passes (zero issues)
- [ ] Test suite passes (all tests green)
- [ ] New code has documentation comments (public APIs)
- [ ] UI strings use internationalization (no hardcoded text)
- [ ] Tests added/updated for logic changes
- [ ] README updated if user-facing feature
- [ ] Conventional Commit message format
- [ ] Follows `coding_guidelines.md` standards
- [ ] Session archived to `ai/session/archive/`

---

## Workflow Steps

### Standard Commit Flow

1. **PLAN** - Read brief, identify changes, create TodoWrite list
2. **PATCH** - Implement changes respecting architecture
3. **TESTS** - Write unit/integration tests
4. **RUN** - Execute linter and test suite
5. **COMMIT** - Use Conventional Commits format

### Pre-Commit Verification

1. Run linter/analyzer (must pass)
2. Run test suite (must pass)
3. Manual smoke test if UI/behavior changes
4. Verify session state is current

---

## Architecture Enforcement

**From coding_guidelines.md:**
- Respect layer boundaries (UI -> Business Logic -> Data)
- Follow naming conventions
- Use dependency injection for testability
- Add documentation comments to public APIs
- Run linter/analyzer before committing

**From architecture_map.md (if exists):**
- Project-specific patterns and conventions
- Module organization
- State management approach

---

## Code Quality Rules

### DO

- Add documentation comments to all public APIs
- Follow API patterns defined in `api_pattern.md` (if exists)
- Make models immutable (follow language best practices)
- Run linter/analyzer and fix all issues
- Follow naming conventions from `coding_guidelines.md`

### DON'T

- Commit code with lint errors
- Skip tests for critical business logic
- Leave hardcoded strings in UI
- Violate layer boundaries

---

## Testing Standards

- Write unit tests for business logic (mock dependencies)
- Test state transitions and edge cases
- Run test suite and ensure all tests pass
- Follow testing standards from `coding_guidelines.md`

---

**Rule Purpose:** Maintain consistent, high-quality commits with proper attribution and quality gates.
