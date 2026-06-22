---
name: audit
description: Codebase audit - 7 audit types for quality, security, architecture, and process analysis
disable-model-invocation: false
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - mcp__igris-brain__igris_brief_create
triggers:
  - "AUDIT"
  - "INQUISITOR"
  - "audit code_quality"
  - "audit bugs"
  - "audit standards"
  - "audit process"
  - "audit dependencies"
  - "audit performance"
  - "audit architecture"
  - "audit full"
  - "run audit"
---

# Audit Skill

Comprehensive codebase audit workflow. Supports 7 audit types to detect quality, security, and architectural issues. Creates briefs for findings.

## Arguments

`$ARGUMENTS` selects the audit type:
- `code_quality` -> Technical debt detection (creates TD-XXX briefs)
- `bugs` -> Potential bug identification (creates BR-XXX briefs)
- `standards` -> Guideline compliance check (creates TD-XXX briefs)
- `process` -> Protocol and workflow compliance (creates PI-XXX briefs)
- `dependencies` -> Dependency update/CVE checking (creates DU-XXX briefs)
- `performance` -> Bottleneck identification (creates PF-XXX briefs)
- `architecture` -> Redundancy and dead code detection (creates AC-XXX briefs)
- `full` -> Run ALL 7 audit types
- Empty -> Ask user which audit type to run

## Audit Operations

| Operation | Brief Type | Purpose |
|-----------|-----------|---------|
| CODE_QUALITY_AUDIT | TD-XXX | Technical debt, code smells, maintainability |
| BUG_HUNT | BR-XXX | Potential bugs, logic errors, edge cases |
| STANDARDS_COMPLIANCE_CHECK | TD-XXX | Verify code follows coding_guidelines.md |
| PROCESS_AUDIT | PI-XXX | Check if protocols and workflows are followed |
| DEPENDENCY_AUDIT | DU-XXX | Outdated deps, security vulnerabilities |
| PERFORMANCE_ANALYSIS | PF-XXX | Bottlenecks, inefficiencies, memory leaks |
| ARCHITECTURE_REVIEW | AC-XXX | Dead code, redundancy, layer violations |

## Workflow

### 0. Track Invocation
Silently emit a skill invocation event (never blocks execution):
```bash
bash "$CLAUDE_PROJECT_DIR/scripts/emit_skill_event.sh" "audit" 2>/dev/null || true
```

### Step 1: Select Audit Scope
- Parse `$ARGUMENTS` for audit type
- If `full`, run all 7 types sequentially
- Identify target files/directories

### Step 2: Execute Audit
- Scan codebase for issues matching audit type
- Check against coding_guidelines.md standards
- Identify specific file:line locations
- Categorize findings by severity

### Step 3: Generate Report
- Summarize findings with severity counts
- List each finding with file:line reference
- Suggest fixes for each finding
- Recommend brief type and priority

### Step 4: Create Briefs
- For Critical/High findings, create via `igris_brief_create` MCP tool, fallback to cache write at `~/.igris/projects/{project}/briefs/`
- Use appropriate brief type (TD/BR/PI/DU/PF/AC)
- Set priority based on severity

## Output Format

```markdown
# Audit Report: {AUDIT_TYPE}

**Date:** {YYYY-MM-DD}
**Scope:** {files/directories audited}

## Summary

| Severity | Count |
|----------|-------|
| Critical | {n} |
| High     | {n} |
| Medium   | {n} |
| Low      | {n} |

## Findings

### Critical
#### {Finding Title}
- **File:** {path}:{line}
- **Issue:** {description}
- **Fix:** {suggested fix}
- **Brief:** {TYPE}-XXX (created)

### High
#### {Finding Title}
- **File:** {path}:{line}
- **Issue:** {description}
- **Fix:** {suggested fix}

### Medium
[...]

## Recommended Briefs

| Type | Title | Priority | Effort |
|------|-------|----------|--------|
| TD-XXX | {title} | P1 | S |
| BR-XXX | {title} | P0 | M |
```

## Constraints

1. **NEVER modify code** - Analysis and reporting only
2. **ALWAYS include file:line** - Be specific about locations
3. **ALWAYS suggest brief type** - Enable tracking of findings
4. **ALWAYS prioritize findings** - Critical first
5. **ALWAYS be actionable** - Suggest concrete fixes
6. **Build-state from the canonical source, NEVER plan docs (#811)** - Any finding about whether work is built (gaps, dead code, "is X done?") reads the canonical `brief_status.status` (via `igris_brief_dashboard`/`igris_brief_list`) and verifies against git log + on-disk artifacts. Plan docs describe pre-build INTENT and read as "unbuilt" forever — never infer build-state from them. See `docs/architecture/brief-state-source-of-truth.md`.
