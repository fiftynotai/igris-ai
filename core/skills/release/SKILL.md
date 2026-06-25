---
name: release
tier: opt-in
description: Release preparation - changelog generation, version bumps, release notes
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
triggers:
  - "RELEASE"
  - "HERALD"
  - "prepare release"
  - "generate changelog"
  - "version bump"
  - "release notes"
---

# Release Skill

Release preparation workflow for generating changelogs, determining version bumps, and drafting release notes.

## Arguments

`$ARGUMENTS` can specify:
- Empty: Full release preparation
- `changelog`: Generate changelog only
- `version`: Determine version bump only
- `notes`: Draft release notes only

## Workflow

### Step 1: Gather Changes

Parse commits since last tag:
```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```

Categorize commits by type:
- `feat` → Features (MINOR bump)
- `fix` → Bug Fixes (PATCH bump)
- `refactor` → Refactoring
- `docs` → Documentation
- `chore` → Maintenance
- `BREAKING CHANGE` → Breaking Changes (MAJOR bump)

### Step 2: Determine Version Bump

Semantic versioning decision tree:
- **BREAKING CHANGE present?** → MAJOR (x.0.0)
- **New features present?** → MINOR (0.x.0)
- **Only fixes/refactors?** → PATCH (0.0.x)

### Step 3: Generate Changelog Entry

Format for CHANGELOG.md:
```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- feat: description (brief ref)

### Fixed
- fix: description (brief ref)

### Changed
- refactor: description

### Breaking Changes
- BREAKING: description
```

### Step 4: Draft Release Notes

User-friendly release notes highlighting:
- Key new features
- Important bug fixes
- Breaking changes with migration steps
- Brief references for traceability

## Constraints

1. **ALWAYS follow semantic versioning** - major.minor.patch
2. **ALWAYS highlight breaking changes** - They're critical for users
3. **ALWAYS reference briefs** - Traceability matters
4. **NEVER skip version determination** - Always calculate the bump
5. **ALWAYS include date** - ISO format YYYY-MM-DD

## Output

Updated CHANGELOG.md and release notes draft.
