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

- `auth`, `event`, `venue`, `details`, `kds`, `settings`, `history`, `home`, `app_version`, `connections`, `locale`
- `core` (for infrastructure changes)
- `deps` (for dependency updates)

---

## Examples

### Example 1: New Feature

```
feat(settings): add printer connection status indicator

- Add checkPrinterStatus() in SettingsViewModel
- Add PrinterStatusIndicator widget with colored dot
- Add auto-refresh timer (10s interval)
- Add manual refresh via pull-to-refresh
- Add unit tests for status check logic
- Add i18n keys for Connected/Offline/Connecting

closes #BR-001
```

### Example 2: Bug Fix

```
fix(event): prevent duplicate events from socket

- Add event ID deduplication in EventsViewModel
- Clear duplicate events on each socket message
- Add unit test for deduplication logic

fixes #BR-042
```

### Example 3: Refactor

```
refactor(venue): extract zone picker to separate widget

- Move zone picker logic from VenuePage to ZonePicker widget
- Improve code reusability
- No functional changes
```

### Example 4: Documentation

```
docs: add Igris AI pilot structure

- Add /ai folder with context, prompts, briefs, checks, templates, session
- Add architecture_map.md referencing flutter-mvvm-actions-arch
- Add igris_os.md with session management
- Add BR-001 pilot brief
- Update README with Igris AI section
```

### Example 5: Breaking Change

```
feat(auth): migrate to Firebase Auth

BREAKING CHANGE: Custom JWT auth replaced with Firebase Auth.
Users will need to re-login after this update.

- Replace AuthService with FirebaseAuthService
- Update AuthViewModel to use Firebase methods
- Migrate MemoryService token storage
- Add migration guide in README

closes #BR-089
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

**Last Updated:** 2025-10-14
