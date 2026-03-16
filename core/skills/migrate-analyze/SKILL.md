---
name: migrate-analyze
description: Migration analysis - gap analysis, migration roadmaps, MG-XXX brief generation
disable-model-invocation: false
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - mcp__igris-brain__igris_brief_create
triggers:
  - "MIGRATE"
  - "PATHFINDER"
  - "MIGRATE analyze"
  - "migration analysis"
  - "migration roadmap"
  - "gap analysis"
---

# Migrate Analyze Skill

Migration analysis workflow. Compares current codebase against target standards, identifies gaps, and generates migration briefs with prioritized roadmaps.

## Arguments

`$ARGUMENTS` can specify:
- Empty: Full gap analysis against coding_guidelines.md
- Path to a base repo or standards file to compare against

## Workflow

### 0. Track Invocation
Silently emit a skill invocation event (never blocks execution):
```bash
bash "$CLAUDE_PROJECT_DIR/scripts/emit_skill_event.sh" "migrate-analyze" 2>/dev/null || true
```

### Step 1: Load Standards (Target State)

Read `~/.igris/projects/{project}/context/coding_guidelines.md` as the target architecture standard.

If a base repo path is provided in `$ARGUMENTS`, also analyze it for patterns.

### Step 2: Analyze Current Code

Scan the project:
- Directory structure and organization
- Naming conventions (files, classes, functions, variables)
- Architecture patterns (layers, modules, dependencies)
- Error handling approaches
- Test coverage and patterns
- Documentation state

### Step 3: Identify Gaps

Compare current state vs target standards:
- List every deviation from the guidelines
- Categorize by severity (Critical, High, Medium, Low)
- Estimate effort to fix each gap (S/M/L/XL)
- Count affected files per gap

### Step 4: Generate Migration Briefs

Create MG-XXX briefs for each significant gap:
- Ordered by priority (Critical -> Low)
- Consider dependencies (some migrations must happen before others)
- Group related gaps into single briefs where logical
- Create via `igris_brief_create` MCP tool, fallback to cache write at `~/.igris/projects/{project}/briefs/MG-XXX-{name}.md`

## Output Format

```markdown
# Migration Analysis

**Current State:** {summary of current architecture}
**Target State:** {from coding_guidelines.md}

## Gaps Found

| # | Gap | Severity | Files Affected | Effort | Brief |
|---|-----|----------|----------------|--------|-------|
| 1 | {gap description} | Critical | {count} | L | MG-XXX |
| 2 | {gap description} | High | {count} | M | MG-XXX |

## Migration Roadmap

### Phase 1: {name} (Critical)
- MG-XXX: {task description}
- MG-XXX: {task description}

### Phase 2: {name} (High Priority)
- MG-XXX: {task description}

### Phase 3: {name} (Medium Priority)
- MG-XXX: {task description}

## Recommended Order
1. {highest priority migration} -- because {reason}
2. {next priority} -- depends on #1
3. ...
```

## Constraints

1. **NEVER modify code** - Analysis and brief creation only
2. **ALWAYS reference coding_guidelines.md** - As the target standard
3. **ALWAYS estimate effort** - S/M/L/XL per migration task
4. **ALWAYS consider dependencies** - Migration order matters
5. **ALWAYS create briefs** - MG-XXX format for actionable tracking
