# Hook Integration Points in Igris AI

**Document Purpose:** Define where and how hooks integrate with Igris AI v4.0

**Version:** 3.0.0
**Last Updated:** 2026-02-22
**Status:** v4.0 - Brain integration, staging guards, session hooks

---

## What Changed in v3.2

Most AI-powered hooks have been **replaced by native Claude Code subagents**. This document now focuses on the remaining active hooks.

### Deprecated Integration Points

| Old Hook | Old Integration | v3.2 Replacement |
|----------|-----------------|------------------|
| BRIEF_GENERATOR | `scripts/igris_generate_brief.sh` | Main agent handles brief creation |
| CODE_REVIEWER | `scripts/igris_review.sh` | `reviewer` subagent |
| TEST_GENERATOR | `scripts/igris_generate_tests.sh` | `tester` subagent |
| PRE_ANALYSIS | Brief implementation start | `planner` subagent |
| POST_ANALYSIS | Implementation complete | `reviewer` subagent |

**Note:** The scripts referenced above have been removed. Use native subagents instead.

---

## Active Integration Points

### 1. SYSTEM_ASSESSMENT Hook

**Integration Point:** Session Initialization
**Location:** `.claude/hooks/session_start.sh`
**Timing:** After loading session state, before displaying recommendations
**Purpose:** Enhance system assessment with additional analysis via `additionalContext`

**How It Works:**
The `session_start.sh` hook (registered as a `SessionStart` event in `.claude/settings.json`) injects session context including brief counts and git status into the Claude Code session.

**Fallback:** Standard system assessment from igris_os.md

---

### 2. PERSONA_INJECTION Hook

**Integration Point:** CLAUDE.md Initialization
**Location:** `scripts/igris_init.sh`
**Timing:** At init time, when generating CLAUDE.md
**Purpose:** Inject persona greeting content

**How It Works:**
```bash
# igris_init.sh reads persona greeting from masks/ folder
# Content is injected into CLAUDE.md greeting section
```

**Fallback:** Standard Igris AI greeting (no persona)

---

### 3. PRE_COMMIT Hook

**Integration Point:** Git Pre-Commit
**Location:** `.git/hooks/pre-commit` (user-installed)
**Timing:** Before git commit executes
**Purpose:** Run checks before allowing commit

**How It Works:**
```bash
#!/bin/bash
# .git/hooks/pre-commit

# Run any pre-commit hook scripts
if [ -x .claude/hooks/pre-commit.sh ]; then
  .claude/hooks/pre-commit.sh
  if [ $? -ne 0 ]; then
    echo "Pre-commit check failed"
    exit 1
  fi
fi

exit 0
```

**Exit Codes:**
- 0 = Pass (allow commit)
- 1 = Fail (block commit)

---

### 4. POST_COMMIT Hook

**Integration Point:** Git Post-Commit
**Location:** `.git/hooks/post-commit` (user-installed)
**Timing:** After git commit completes
**Purpose:** Run actions after successful commit

**How It Works:**
```bash
#!/bin/bash
# .git/hooks/post-commit

# Run any post-commit hook scripts
if [ -x .claude/hooks/post-commit.sh ]; then
  .claude/hooks/post-commit.sh
fi

exit 0
```

**Exit Codes:**
- 0 = Success
- 1 = Warning (non-blocking)

---

## Integration Summary

| Hook | Integration Point | Trigger | Blocking |
|------|------------------|---------|----------|
| SYSTEM_ASSESSMENT | session_start.sh | Automatic | No |
| PERSONA_INJECTION | igris_init.sh | At init | No |
| PRE_COMMIT | .git/hooks/pre-commit | Before commit | Yes |
| POST_COMMIT | .git/hooks/post-commit | After commit | No |

---

## Creating Custom Hooks

### Example: Custom Pre-Commit Hook

```bash
#!/bin/bash
# .claude/hooks/pre-commit.sh
set -e

echo "Running pre-commit checks..."

# Check for TODO comments in staged files
if git diff --cached --name-only | xargs grep -l "TODO" 2>/dev/null; then
  echo "Warning: TODO comments found in staged files"
  # exit 1  # Uncomment to block commits with TODOs
fi

# Check for console.log statements
if git diff --cached --name-only -- '*.ts' '*.js' | xargs grep -l "console.log" 2>/dev/null; then
  echo "Warning: console.log found in staged files"
fi

echo "Pre-commit checks passed"
exit 0
```

### Example: Custom Post-Commit Hook

```bash
#!/bin/bash
# .claude/hooks/post-commit.sh

commit_hash=$(git rev-parse HEAD)
commit_msg=$(git log -1 --format="%s")

echo "Committed: $commit_hash"
echo "Message: $commit_msg"

# Optional: Update session state
# Optional: Trigger notifications
# Optional: Run additional scripts

exit 0
```

---

## Migration from v2.5

If you had custom hook scripts for deprecated types:

| Old Script | Migration |
|------------|-----------|
| `igris_generate_brief.sh` | Use main agent: "Register a brief for..." |
| `igris_review.sh` | Use `reviewer` subagent or HUNT workflow |
| `igris_generate_tests.sh` | Use `tester` subagent |

The native subagents provide the same functionality at zero additional cost.

---

**Created:** 2025-11-14
**Updated:** 2025-12-03
**Version:** 2.0.0
