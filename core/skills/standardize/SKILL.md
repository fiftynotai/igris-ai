---
name: standardize
description: Generate coding_guidelines.md from codebase analysis or base architecture repo (4 modes)
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Grep
  - Glob
  - Bash
triggers:
  - "STANDARDIZE"
  - "LAWKEEPER"
  - "generate guidelines"
  - "generate standards"
  - "generate coding guidelines"
  - "coding standards"
---

# Standardize Skill

Generate comprehensive coding guidelines for a project. Supports 4 modes for different scenarios.

## Arguments

`$ARGUMENTS` selects the mode:
- `analyze` → Mode B: Analyze current project (default)
- `from-base` → Mode A: Extract from base architecture repo
- `hybrid` → Mode C: Merge base repo + project analysis
- `minimal` → Mode D: Platform-specific best practices only

If empty, ask the user which mode to use.

## Modes

### Mode A: Base Repository
**When:** User has a reference architecture or base project.
1. Ask for base repo path or URL
2. Analyze base repo structure, patterns, naming
3. Extract architecture decisions
4. Generate guidelines based on base repo patterns

### Mode B: Project Analysis (Default)
**When:** Existing project, no base repo.
1. Scan project structure (`find` / `glob`)
2. Detect platform/framework (Flutter, React, Vue, etc.)
3. Analyze naming conventions, patterns, architecture
4. Infer coding standards from existing code
5. Generate guidelines reflecting current patterns

### Mode C: Merge
**When:** Both base repo and project exist.
1. Run Mode A on base repo
2. Run Mode B on current project
3. Identify conflicts between base and project patterns
4. Merge with base repo taking precedence for architecture
5. Project-specific overrides documented

### Mode D: Best Practices
**When:** New project, no base repo, no existing code.
1. Ask for platform (Flutter, React, Node, Python, etc.)
2. Apply industry best practices for that platform
3. Generate starter guidelines
4. Include common patterns and anti-patterns

## Workflow

### 0. Track Invocation
Silently emit a skill invocation event (never blocks execution):
```bash
bash "$CLAUDE_PROJECT_DIR/scripts/emit_skill_event.sh" "standardize" 2>/dev/null || true
```

### Step 1: Gather Inputs
- Do you have a base architecture repository? (Mode A/C)
- Should I analyze your current project? (Mode B/C)
- What platform/framework? (all modes)

### Step 2: Execute Selected Mode
- Scan, analyze, extract patterns per mode logic above

### Step 3: Generate coding_guidelines.md
Create `~/.igris/projects/{project}/context/coding_guidelines.md` with:
- File structure conventions
- Naming conventions
- Architecture patterns (layers, modules)
- Error handling patterns
- Testing requirements
- Documentation standards
- Commit conventions
- Code review checklist
- Platform-specific best practices

## Constraints

1. **NEVER modify source code** - Only create guidelines
2. **ALWAYS ask about base repo first** - Before starting
3. **ALWAYS detect platform** - For relevant best practices
4. **ALWAYS include examples** - Concrete code examples in guidelines
5. **ALWAYS note source mode** - Document which mode (A/B/C/D) was used

## Output

`~/.igris/projects/{project}/context/coding_guidelines.md` -- comprehensive, project-specific coding standards.
