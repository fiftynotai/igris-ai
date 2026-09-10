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
  - mcp__igris-brain__igris_context_sync
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
- Read `~/.igris/core/context-doc-types/INDEX.md` when implementation changes
  may affect a durable project standard. Use each doc type's `maintain_when` to
  decide whether an existing project context doc under
  `~/.igris/projects/{project}/context/` needs maintenance.

### Step 2: Read Existing Docs

- Current README.md
- Existing API documentation
- Architecture documents
- Related documentation files
- Relevant existing project context docs selected by catalog `maintain_when`

### Step 3: Write/Update Documentation

- Update affected docs with accurate information
- Add new sections as needed
- Ensure consistency across all documentation
- Use examples to illustrate concepts
- Follow existing documentation style
- Update existing project context docs when the change clearly modifies a
  durable convention, pattern, API shape, architecture boundary, UI standard, or
  test standard.
- If the relevant context doc is missing or the standard is not yet clear,
  report `/ground <type>` or an operator follow-up instead of inventing a thin
  placeholder.

### Step 4: Replicate any edited context doc (TD-460)

If Step 3 edited a doc under `~/.igris/projects/{project}/context/`, call:
```
igris_context_sync { project: "<slug>" }
```
The FILE stays the authority; this absorbs the edit into the `context_files`
replica and auto-pushes it, so the updated standard is reachable from every
machine on the same VPS. This is the hop that covers `/hunt` Phase 7, which
delegates its context-doc maintenance here — the edits arrive as plain `Edit`
calls that no hook can intercept, so nothing else would carry them.

Expect each edited filename in the digest's `absorbed[]`. Skipping it is not
data loss (`/boot` Mount runs the same reconciler as a catch-all), but the doc
then replicates one session late. Skip the call entirely when Step 3 touched no
context doc.

### Step 5: Validate

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
6. **NEVER reimplement applies_when** - project-level context-doc presence is
   owned by `igris context-docs inventory`

## Output

Updated documentation files with clear, accurate, maintainable content.
