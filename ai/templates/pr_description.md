# [feat/fix/refactor]: [Short Title]

## Summary
[1-2 sentences describing what this PR does]

## Brief Reference
**Closes:** BR-XXX ([link to brief file: ai/briefs/BR-XXX-title.md])

---

## Changes

### Added
- [New file/feature 1]
- [New file/feature 2]

### Modified
- [Changed file 1] - [reason]
- [Changed file 2] - [reason]

### Deleted
- [Removed file 1] - [reason]

---

## Architecture Adherence

- [x] Follows MVVM + Actions pattern
- [x] Layers don't skip (View → Actions → ViewModel → Service → Model)
- [x] Uses `ApiResponse<T>` for async operations
- [x] Uses `actionHandler()` for user-triggered actions
- [x] Models are immutable (`final` fields)

---

## Testing

### Automated Tests
- [x] Unit tests added/updated: [file paths]
- [x] Widget tests added/updated: [file paths if applicable]
- [x] `flutter test` passes locally

### Manual Testing
- [x] Tested on device: [Android 13 / iOS 17]
- [x] Tested scenarios: [list key scenarios]
- [x] Regression tested: [critical flows verified]

---

## Code Quality

- [x] `flutter analyze` passes (zero issues)
- [x] Follows coding guidelines (`ai/context/coding_guidelines.md`)
- [x] Structured Dart doc-comments added to public APIs
- [x] No hardcoded strings (i18n keys used)

---

## Documentation

- [x] README updated (if user-facing feature)
- [x] Module catalog updated (if new module)
- [x] i18n keys added to `keys.dart` and translations
- [x] API reference updated (if API changes)

---

## Deployment Notes

- [ ] Requires backend changes first: [Yes/No]
- [ ] Requires app force update: [Yes/No]
- [ ] Feature flag needed: [Yes/No]
- [ ] Database migration needed: [Yes/No]

---

## Screenshots/Videos

[Attach screenshots or screen recordings showing the feature/fix]

---

## Rollback Plan

[How to revert this change if issues arise in production]

---

## Checklist (for reviewer)

- [ ] Brief path referenced and valid
- [ ] Code follows architecture guidelines
- [ ] Tests cover new logic
- [ ] No lint errors
- [ ] Documentation updated
- [ ] Manual testing evidence provided
