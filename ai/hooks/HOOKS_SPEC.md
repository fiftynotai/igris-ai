# Igris AI Hook System Specification

**Version:** 3.0.0
**Last Updated:** 2026-02-22
**Status:** v4.0 - Brain integration, config-guarded staging

---

## Overview

The **Hook System** allows optional extensions to Igris AI workflows. With v4.0's native subagent architecture, most AI functionality is now built-in. Hooks remain for:

1. **Persona customization** (greetings, theming)
2. **Session start enhancements** (system assessment)
3. **Git workflow hooks** (pre-commit, post-commit)

---

## What Changed in v3.2

### Deprecated Hooks (Replaced by Native Subagents)

| Old Hook | Replacement |
|----------|-------------|
| BRIEF_GENERATOR | Main agent handles brief creation |
| CODE_REVIEWER | `reviewer` subagent |
| TEST_GENERATOR | `tester` subagent |
| AUTONOMOUS_IMPLEMENTER | HUNT workflow with orchestration |
| MULTI_AGENT_REVIEWER | `reviewer` subagent |
| SELF_HEALER | `debugger` subagent |
| BRIEF_PLANNER | `planner` subagent |
| CONVERSATIONAL_REFINER | Main agent interaction |
| MAINTENANCE_AGENT | `auditor` subagent |

### Active Hooks

| Hook | Purpose | Still Used |
|------|---------|------------|
| PERSONA_INJECTION | Inject persona content | Yes |
| SYSTEM_ASSESSMENT | Startup recommendations | Yes |
| PRE_COMMIT | Pre-commit checks | Yes |
| POST_COMMIT | Post-commit actions | Yes |

---

## Hook Types

### Static Content Hooks

#### `PERSONA_INJECTION`
**Purpose:** Inject persona greetings into CLAUDE.md
**Resolved:** At init time by igris_init.sh
**Format:** Markdown content (no execution)

```markdown
## From the Shadows
Your persona greeting content here...
```

---

### Execution Hooks

#### `SYSTEM_ASSESSMENT`
**Purpose:** Enhance startup recommendations
**Input:** None
**Output:** Enhanced recommendations (markdown)
**Called by:** `.claude/hooks/session_start.sh`

**Example output:**
```markdown
Enhanced Recommendations:
- High priority brief BR-007 ready
- 3 TODOs added this week in UserService
```

---

#### `PRE_COMMIT`
**Purpose:** Run checks before commit
**Input:** Staged files list
**Output:** Pass/fail with messages
**Exit codes:** 0 = pass, 1 = fail (block commit)

---

#### `POST_COMMIT`
**Purpose:** Run actions after commit
**Input:** Commit hash
**Output:** Status messages
**Exit codes:** 0 = success, 1 = warning (non-blocking)

---

## Hook Contract

All execution hooks must follow:

```bash
#!/bin/bash
set -e

# Input: Read from stdin
input_data=$(cat)

# Process...

# Output: Write to stdout
echo "Hook output"

# Exit with status
exit 0  # 0=success, 1=error, 2=skip
```

### Requirements

1. First line: `#!/bin/bash`
2. Executable: `chmod +x`
3. Input via stdin
4. Output to stdout
5. Exit codes: 0, 1, or 2

---

## Exit Codes

| Code | Meaning | Workflow Behavior |
|------|---------|-------------------|
| 0 | Success | Use output, continue |
| 1 | Error | Show error, continue (non-blocking) |
| 2 | Skip | Continue silently |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `IGRIS_HOOK_TYPE` | Which hook is executing |
| `IGRIS_PROJECT_ROOT` | Project root path |
| `IGRIS_VERSION` | Igris AI version |

---

## Plugin Integration

### Declaring Hooks

In `plugin.json`:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "hooks": {
    "SYSTEM_ASSESSMENT": "ai/my-plugin/hooks/assess.sh"
  }
}
```

### Registration

Hooks are registered in `.igris/installed_plugins.json` when plugin is installed.

---

## Creating Custom Hooks

### Example: Simple Assessment Hook

```bash
#!/bin/bash
# ai/my-plugin/hooks/assess.sh
set -e

echo "Project Statistics"
echo ""

# Count briefs
brief_count=$(ls ai/briefs/*.md 2>/dev/null | grep -v TEMPLATE | wc -l)
echo "Total briefs: $brief_count"

# Recent commits
echo ""
echo "Recent commits:"
git log --oneline -3

exit 0
```

---

## Security Model

- Hooks execute with user permissions
- No sandboxing - hooks are trusted code
- Review hook scripts before installing plugins

---

## Migration from v2.5

If you have custom hooks for deprecated types:

1. **BRIEF_GENERATOR** → Use main agent: "Create a brief for..."
2. **CODE_REVIEWER** → Use `reviewer` subagent or HUNT workflow
3. **TEST_GENERATOR** → Use `tester` subagent
4. **AUTONOMOUS_IMPLEMENTER** → Use `HUNT {brief-id}`

The native subagents provide the same functionality at zero additional cost.

---

## Version History

- **v2.0.0** (2025-12-03): Simplified for v3.2 native subagents
  - Deprecated 9 LangChain/LangGraph hooks
  - Retained core hooks (PERSONA, SYSTEM_ASSESSMENT, commit hooks)

- **v1.0.0** (2025-11-14): Initial specification
  - Defined hook system for LangChain/LangGraph integration

---

**Maintained by:** Igris AI / Fifty.ai
