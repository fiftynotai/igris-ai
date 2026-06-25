---
name: document
tier: opt-in
description: Documentation workflow - README updates, API docs, architecture docs, code comments
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
triggers:
  - "DOCUMENT"
  - "CHRONICLE"
  - "update docs"
  - "update README"
  - "write docs"
  - "document architecture"
  - "write documentation"
---

# Document Skill

Documentation workflow for writing and maintaining project documentation.

## Arguments

`$ARGUMENTS` describes what to document or which docs to update.

## Capabilities

1. **README Updates** - Keep README current with features
2. **API Documentation** - Document public APIs and interfaces
3. **Code Comments** - Add/update inline documentation
4. **Architecture Docs** - Document system design decisions
5. **Migration Guides** - Write upgrade instructions
6. **Changelog Entries** - Document changes per version

## Workflow

### Step 1: Identify Documentation Scope

- What changed? (read git diff or brief)
- What docs need updating?
- Are there new public APIs?
- Are there removed features or breaking changes?

### Step 2: Read Existing Docs

- Current README.md
- Existing API documentation
- Architecture documents
- Related documentation files

### Step 3: Write/Update Documentation

- Update affected docs with accurate information
- Add new sections as needed
- Ensure consistency across all documentation
- Use examples to illustrate concepts
- Follow existing documentation style

### Step 4: Validate

- All links work (internal and external)
- Code examples are correct and runnable
- No stale references to removed features
- Consistent formatting throughout
- No TODO placeholders left behind

## Constraints

1. **NEVER modify source code** - Documentation only
2. **ALWAYS keep docs in sync** - With actual code behavior
3. **ALWAYS use examples** - Show, don't just tell
4. **NEVER leave TODOs in docs** - Complete or don't write
5. **ALWAYS check for stale content** - Remove outdated info

## Output

Updated documentation files with clear, accurate, maintainable content.
