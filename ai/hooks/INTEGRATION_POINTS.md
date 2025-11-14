# Hook Integration Points in Igris AI

**Document Purpose:** Define exactly where and how enhancement hooks are called in core workflows

---

## 1. SYSTEM_ASSESSMENT Hook

### Integration Point: Session Initialization (ARISE)

**Location:** `.claude/hooks/startup.sh`
**Timing:** After loading session state, before displaying recommendations
**Purpose:** Enhance system assessment with AI analysis

**Implementation:**
```bash
# In .claude/hooks/startup.sh (or wherever ARISE logic lives)

# Load standard system state
session_status=$(cat ai/session/CURRENT_SESSION.md | grep "Status:" | head -1)
brief_count=$(ls ai/briefs/*.md | grep -v TEMPLATE | wc -l)
git_status=$(git status --short)

# Call SYSTEM_ASSESSMENT hook if available
if command -v execute_hook &> /dev/null; then
  assessment_input=$(cat <<JSON
{
  "session_status": "$session_status",
  "brief_count": $brief_count,
  "git_status": "$git_status"
}
JSON
)

  hook_output=$(echo "$assessment_input" | execute_hook "SYSTEM_ASSESSMENT" "")
  hook_exit=$?

  if [ $hook_exit -eq 0 ]; then
    # Hook provided enhanced assessment
    echo "$hook_output"
  fi
fi

# Continue with standard recommendations
```

**Fallback:** If no hook installed, show standard system assessment

---

## 2. BRIEF_GENERATOR Hook

### Integration Point: New Command `igris generate-brief`

**Location:** New script `scripts/igris_generate_brief.sh`
**Timing:** On-demand, user-initiated
**Purpose:** Auto-generate briefs from git diffs or natural language

**Implementation:**
```bash
#!/bin/bash
# scripts/igris_generate_brief.sh

set -e

# Load hook execution logic
source scripts/igris_init.sh

# Check if hook available
hook_script=$(resolve_hooks "BRIEF_GENERATOR")
if [ $? -ne 0 ]; then
  echo "❌ BRIEF_GENERATOR hook not installed"
  echo ""
  echo "Install a plugin that provides brief generation:"
  echo "  igris plugin install igris-langchain.tar.gz"
  exit 1
fi

# Read input from stdin or argument
if [ -t 0 ]; then
  # No stdin, treat argument as natural language
  input="$*"
else
  # stdin provided (git diff piped in)
  input=$(cat)
fi

if [ -z "$input" ]; then
  echo "Usage:"
  echo "  git diff main...feature | igris generate-brief"
  echo "  igris generate-brief \"add authentication with JWT\""
  exit 2
fi

# Execute hook
brief_content=$(echo "$input" | execute_hook "BRIEF_GENERATOR" "")
hook_exit=$?

if [ $hook_exit -eq 0 ]; then
  # Determine next brief number
  next_num=$(ls ai/briefs/BR-*.md 2>/dev/null | grep -v TEMPLATE | sed 's/.*BR-0*//' | sed 's/-.*//' | sort -n | tail -1)
  next_num=$((next_num + 1))
  brief_id=$(printf "BR-%03d" $next_num)

  # Extract title from first line of generated brief
  title=$(echo "$brief_content" | grep "^# BR-" | sed 's/^# BR-[0-9]*: //' | tr '[:upper:]' '[:lower:]' | tr ' ' '-')

  # Write brief file
  brief_file="ai/briefs/${brief_id}-${title}.md"
  echo "$brief_content" > "$brief_file"

  echo "✅ Brief generated: $brief_file"
  echo ""
  echo "Next steps:"
  echo "  1. Review and refine the brief"
  echo "  2. Update priority and effort estimates"
  echo "  3. Mark as Ready when satisfied"
  echo "  4. Implement: igris implement $brief_id"
else
  echo "❌ Brief generation failed"
  exit 1
fi
```

**Fallback:** Manual brief creation (existing workflow)

---

## 3. CODE_REVIEWER Hook

### Integration Point A: Pre-Commit Review

**Location:** New command `scripts/igris_review.sh`
**Timing:** Before git commit (user-initiated or pre-commit hook)
**Purpose:** Review code against coding guidelines

**Implementation:**
```bash
#!/bin/bash
# scripts/igris_review.sh

set -e

source scripts/igris_init.sh

# Check if hook available
hook_script=$(resolve_hooks "CODE_REVIEWER")
if [ $? -ne 0 ]; then
  echo "⚠️ CODE_REVIEWER hook not installed"
  echo "Skipping code review..."
  exit 0  # Non-blocking
fi

# Get changed files
if [ -n "$1" ]; then
  # Specific files provided
  changed_files="$@"
else
  # All staged/modified files
  changed_files=$(git diff --name-only --cached)
  if [ -z "$changed_files" ]; then
    changed_files=$(git diff --name-only)
  fi
fi

if [ -z "$changed_files" ]; then
  echo "No changed files to review"
  exit 0
fi

echo "🔍 Reviewing code changes..."
echo "$changed_files" | while read -r file; do
  echo "  - $file"
done
echo ""

# Execute review hook
review_output=$(echo "$changed_files" | execute_hook "CODE_REVIEWER" "")
hook_exit=$?

if [ $hook_exit -eq 0 ]; then
  echo "$review_output"
  echo ""
  echo "✅ Code review complete"
  exit 0
elif [ $hook_exit -eq 1 ]; then
  echo "$review_output"
  echo ""
  echo "⚠️ Code review found issues (see above)"
  echo ""
  echo "Options:"
  echo "  1. Fix issues and review again: igris review"
  echo "  2. Commit anyway (not recommended)"
  exit 1
else
  # Hook skipped
  exit 0
fi
```

### Integration Point B: Optional Pre-Commit Git Hook

**Location:** `.git/hooks/pre-commit` (user can install)
**Timing:** Automatic before every commit
**Purpose:** Enforce code quality

**Implementation:**
```bash
#!/bin/bash
# .git/hooks/pre-commit (optional, user installs)

# Run code review
./scripts/igris_review.sh

if [ $? -eq 1 ]; then
  echo ""
  echo "❌ Pre-commit review failed"
  echo "Fix issues or commit with --no-verify to skip"
  exit 1
fi

exit 0
```

**Fallback:** Manual review or linting

---

## 4. TEST_GENERATOR Hook

### Integration Point: New Command `igris generate-tests`

**Location:** New script `scripts/igris_generate_tests.sh`
**Timing:** After implementation, before tests written
**Purpose:** Auto-generate test scaffolding

**Implementation:**
```bash
#!/bin/bash
# scripts/igris_generate_tests.sh

set -e

source scripts/igris_init.sh

if [ -z "$1" ]; then
  echo "Usage: igris generate-tests <file_path>"
  echo ""
  echo "Example:"
  echo "  igris generate-tests src/auth/LoginService.ts"
  exit 2
fi

target_file="$1"

if [ ! -f "$target_file" ]; then
  echo "❌ File not found: $target_file"
  exit 1
fi

# Check if hook available
hook_script=$(resolve_hooks "TEST_GENERATOR")
if [ $? -ne 0 ]; then
  echo "❌ TEST_GENERATOR hook not installed"
  echo ""
  echo "Install a plugin that provides test generation:"
  echo "  igris plugin install igris-langchain.tar.gz"
  exit 1
fi

echo "🧪 Generating tests for: $target_file"
echo ""

# Execute hook
test_content=$(echo "$target_file" | execute_hook "TEST_GENERATOR" "")
hook_exit=$?

if [ $hook_exit -eq 0 ]; then
  # Determine test file path
  test_file=$(echo "$target_file" | sed 's/src/test/' | sed 's/\.\([^.]*\)$/.test.\1/')
  test_dir=$(dirname "$test_file")

  # Create test directory if needed
  mkdir -p "$test_dir"

  # Write test file
  echo "$test_content" > "$test_file"

  echo "✅ Tests generated: $test_file"
  echo ""
  echo "Next steps:"
  echo "  1. Review and refine generated tests"
  echo "  2. Add edge cases and assertions"
  echo "  3. Run tests to verify: npm test (or appropriate command)"
else
  echo "❌ Test generation failed"
  exit 1
fi
```

**Fallback:** Manual test writing

---

## 5. PRE_ANALYSIS Hook

### Integration Point: Brief Implementation Start

**Location:** Within brief implementation workflow (when user says "implement BR-XXX")
**Timing:** After loading brief, before creating TodoWrite tasks
**Purpose:** Analyze codebase and suggest implementation approach

**Implementation:**
```bash
# In brief implementation logic (not in a separate script yet)

# Load brief
brief_file="ai/briefs/BR-005-*.md"
brief_content=$(cat "$brief_file")

# Call PRE_ANALYSIS hook if available
if command -v execute_hook &> /dev/null; then
  analysis_input=$(cat <<JSON
{
  "brief_id": "BR-005",
  "brief_file": "$brief_file",
  "brief_content": "$brief_content"
}
JSON
)

  analysis_output=$(echo "$analysis_input" | execute_hook "PRE_ANALYSIS" "")
  hook_exit=$?

  if [ $hook_exit -eq 0 ]; then
    echo "🧠 Pre-Analysis Results:"
    echo "$analysis_output"
    echo ""
  fi
fi

# Continue with normal workflow (create TodoWrite, etc.)
```

**Note:** This hook is primarily for Claude to use during implementation, not a standalone command

**Fallback:** Manual codebase exploration

---

## 6. POST_ANALYSIS Hook

### Integration Point: After Implementation, Before Commit

**Location:** Within brief completion workflow
**Timing:** After all tasks complete, before committing
**Purpose:** Verify acceptance criteria, suggest follow-ups

**Implementation:**
```bash
# In brief completion logic

# Get changed files
changed_files=$(git diff --name-only)
git_diff=$(git diff)

# Call POST_ANALYSIS hook if available
if command -v execute_hook &> /dev/null; then
  analysis_input=$(cat <<JSON
{
  "brief_id": "$brief_id",
  "changed_files": "$changed_files",
  "diff": "$git_diff"
}
JSON
)

  analysis_output=$(echo "$analysis_input" | execute_hook "POST_ANALYSIS" "")
  hook_exit=$?

  if [ $hook_exit -eq 0 ]; then
    echo "📊 Post-Analysis Results:"
    echo "$analysis_output"
    echo ""
  fi
fi

# Continue with commit workflow
```

**Note:** This hook is primarily for Claude to use, not a standalone command

**Fallback:** Manual verification

---

## Summary of Integration Points

| Hook Type | Integration Point | User-Facing | Script Location |
|-----------|------------------|-------------|-----------------|
| `SYSTEM_ASSESSMENT` | ARISE/startup | Yes (automatic) | `.claude/hooks/startup.sh` |
| `BRIEF_GENERATOR` | Generate brief command | Yes (manual) | `scripts/igris_generate_brief.sh` |
| `CODE_REVIEWER` | Review command | Yes (manual/auto) | `scripts/igris_review.sh` |
| `TEST_GENERATOR` | Generate tests command | Yes (manual) | `scripts/igris_generate_tests.sh` |
| `PRE_ANALYSIS` | Brief implementation start | No (Claude only) | Inline in workflow |
| `POST_ANALYSIS` | Implementation complete | No (Claude only) | Inline in workflow |

---

## Hook Execution Function Location

The core `resolve_hooks()` and `execute_hook()` functions should live in:
- **Primary:** `scripts/igris_init.sh` (can be sourced by other scripts)
- **Alternative:** New file `scripts/hook_utils.sh` (sourced by all scripts that need hooks)

**Recommended:** Keep in `igris_init.sh` to avoid creating new files unnecessarily

---

**Next Tasks:**
1. Implement `resolve_hooks()` and `execute_hook()` in `scripts/igris_init.sh`
2. Create user-facing command scripts (generate-brief, review, generate-tests)
3. Document new commands in README.md

---

**Created:** 2025-11-14
**Updated:** 2025-11-14
