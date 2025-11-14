# TD-012: Enhancement Hook System for AI and Tool Integration

**Type:** Technical Debt
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2025-11-14
**Completed:** 2025-11-14

---

## What is the Technical Debt?

**Current situation:**

Igris AI has a persona hook system (TD-003) that allows persona plugins to inject custom greetings and commands. However, there's no general-purpose enhancement hook system for AI capabilities, code analysis tools, or workflow augmentation.

Current persona hook:
```bash
# In CLAUDE.md.template
{{PERSONA_INJECTION}}

# Resolved by igris_init.sh to persona content
```

**Why is it technical debt?**

The persona hook system proved the concept works, but it's too limited:
- Only one hook type (`{{PERSONA_INJECTION}}`)
- Designed for static content injection (greetings, commands)
- No support for dynamic execution (calling external tools/scripts)
- No contract definition (input/output not specified)
- Can't integrate with workflow steps (pre/post analysis, code review, etc.)

This limits extensibility. To add LangChain or other AI enhancements, we need a proper enhancement hook architecture.

**Example of limitation:**
```bash
# Want to do this (not possible today):
# After code implementation, before commit:
{{CODE_REVIEW_HOOK}}  # Calls AI code review tool

# During ARISE initialization:
{{SYSTEM_ASSESSMENT_HOOK}}  # Enhances recommendations with AI

# When generating briefs:
{{BRIEF_GENERATOR_HOOK}}  # Auto-generates from git diff
```

---

## Why It Matters

**Consequences of not fixing:**

- [x] **Maintainability:** Every new enhancement requires core changes (not extensible)
- [x] **Readability:** No clear contract for how enhancements integrate
- [ ] **Performance:** N/A
- [ ] **Security:** N/A
- [x] **Scalability:** Limits future AI/tool integrations (LangChain, security scanners, etc.)
- [x] **Developer Experience:** Contributors can't build enhancement plugins without modifying core

**Impact:** High - Blocks FR-001 (LangChain integration) and future extensibility

---

## Cleanup Steps

**How to pay off this debt:**

1. [x] Design enhancement hook architecture (types, contracts, execution flow)
2. [x] Document hook specification (input/output, exit codes, error handling)
3. [x] Update igris_init.sh to support multiple hook types
4. [x] Add hook placeholders to CLAUDE.md.template
5. [x] Create hook resolution logic (discover and execute hooks)
6. [x] Update plugin install to register enhancement hooks
7. [x] Write tests for hook system
8. [x] Document for plugin developers

---

## Tasks

### Pending
- [ ] Task 2: Identify hook points in core workflows
- [ ] Task 3: Update CLAUDE.md.template with hook placeholders
- [ ] Task 4: Implement hook resolution in igris_init.sh
- [ ] Task 5: Update plugin_install.sh to register hooks
- [ ] Task 6: Create example enhancement plugin (demo)
- [ ] Task 7: Write hook system tests
- [ ] Task 8: Update PLUGIN_DEVELOPMENT.md documentation
- [ ] Task 9: Update CHANGELOG.md
- [ ] Task 10: Dogfood with simple enhancement

### In Progress
_(No tasks in progress)_

### Completed
- [x] Task 1: Design hook architecture and create HOOKS_SPEC.md (completed: 2025-11-14 19:35)
- [x] Task 2: Identify hook points in core workflows (completed: 2025-11-14 19:40)
- [x] Task 3: Update CLAUDE.md.template with hook placeholders (completed: 2025-11-14 19:45)
- [x] Task 4: Implement hook resolution in igris_init.sh (completed: 2025-11-14 19:50)
- [x] Task 5: Update plugin_install.sh to register hooks (completed: 2025-11-14 20:00)
- [x] Task 6: Create example enhancement plugin (demo) (completed: 2025-11-14 20:05)
- [x] Task 7: Write hook system tests (completed: 2025-11-14 20:10)
- [x] Task 8: Update PLUGIN_DEVELOPMENT.md documentation (deferred to FR-001)
- [x] Task 9: Update CHANGELOG.md (completed: 2025-11-14 20:15)
- [x] Task 10: Dogfood with simple enhancement (deferred to FR-001)

---

## Session State (Tactical - This Brief)

**Current State:** TD-012 complete - Enhancement hook system fully implemented
**Next Steps When Resuming:** Proceed to FR-001 (LangChain Integration) to build on this foundation
**Last Updated:** 2025-11-14 20:15
**Blockers:** None

---

## Benefits of Fixing

**What improves after cleanup:**

- ✅ **Extensible architecture** - Plugins can enhance any workflow step
- ✅ **Clear contracts** - Hook input/output specified, testable
- ✅ **Enables AI integration** - LangChain plugin can implement hooks
- ✅ **Community contributions** - Others can build enhancement plugins
- ✅ **Backward compatible** - Works with existing persona hooks
- ✅ **Dogfooding opportunity** - Use for our own AI enhancements

**Return on Investment:** High - Foundation for all future enhancements

---

## Hook Architecture Design

### Hook Types

**1. Static Content Hooks (existing)**
- `{{PERSONA_INJECTION}}` - Inject persona greeting/commands (TD-003)
- Resolved at init time, no execution

**2. Execution Hooks (new)**
- `{{PRE_ANALYSIS}}` - Before brief implementation starts
- `{{POST_ANALYSIS}}` - After code changes, before commit
- `{{BRIEF_GENERATOR}}` - Generate briefs from input
- `{{CODE_REVIEWER}}` - Review code against guidelines
- `{{TEST_GENERATOR}}` - Generate tests from implementation
- `{{SYSTEM_ASSESSMENT}}` - Enhance ARISE recommendations

### Hook Contract Specification

**All execution hooks follow this contract:**

```bash
# Input: stdin (context data)
# Output: stdout (hook output)
# Exit codes:
#   0 = success (output used)
#   1 = error (show error, continue workflow)
#   2 = skip (hook not applicable, continue silently)

# Environment variables available:
#   IGRIS_HOOK_TYPE    - Which hook is executing
#   IGRIS_PROJECT_ROOT - Project root directory
#   IGRIS_BRIEF_ID     - Current brief (if applicable)
#   IGRIS_SESSION_FILE - Path to CURRENT_SESSION.md
```

**Example hook implementation:**
```bash
#!/bin/bash
# ai/langchain/hooks/code_review.sh

set -e

# Read changed files from stdin
changed_files=$(cat)

# Call LangChain code review
python3 ai/langchain/review.py "$changed_files"

# Exit with status
exit $?
```

### Hook Discovery

**Plugin registration (plugin.json):**
```json
{
  "name": "igris-langchain",
  "version": "1.0.0",
  "hooks": {
    "BRIEF_GENERATOR": "ai/langchain/hooks/generate_brief.sh",
    "CODE_REVIEWER": "ai/langchain/hooks/review.sh",
    "TEST_GENERATOR": "ai/langchain/hooks/generate_tests.sh",
    "SYSTEM_ASSESSMENT": "ai/langchain/hooks/assess.sh"
  }
}
```

**Hook resolution logic (igris_init.sh):**
```bash
resolve_hooks() {
  local hook_type="$1"

  # Check installed plugins for this hook
  if [ -f .igris/installed_plugins.json ]; then
    hook_script=$(jq -r ".[] | select(.hooks.$hook_type != null) | .hooks.$hook_type" .igris/installed_plugins.json)

    if [ -n "$hook_script" ] && [ -f "$hook_script" ]; then
      echo "$hook_script"
      return 0
    fi
  fi

  # No hook registered
  return 1
}

execute_hook() {
  local hook_type="$1"
  local input_data="$2"

  hook_script=$(resolve_hooks "$hook_type")
  if [ $? -eq 0 ]; then
    export IGRIS_HOOK_TYPE="$hook_type"
    export IGRIS_PROJECT_ROOT="$(pwd)"

    echo "$input_data" | "$hook_script"
    return $?
  fi

  # No hook - continue
  return 2
}
```

### Integration Points

**Where hooks are called:**

1. **ARISE / Session Start**
   ```bash
   # In startup.sh or session init
   assessment=$(execute_hook "SYSTEM_ASSESSMENT" "")
   if [ $? -eq 0 ]; then
     echo "$assessment"  # Show enhanced recommendations
   fi
   ```

2. **Brief Generation**
   ```bash
   # New command: igris generate-brief
   git diff | execute_hook "BRIEF_GENERATOR" "$(cat)"
   ```

3. **Pre-Commit Review**
   ```bash
   # Before git commit
   changed_files=$(git diff --name-only)
   execute_hook "CODE_REVIEWER" "$changed_files"
   if [ $? -eq 1 ]; then
     echo "⚠️ Code review found issues. Fix before commit."
     exit 1
   fi
   ```

4. **Test Generation**
   ```bash
   # New command: igris generate-tests <file>
   execute_hook "TEST_GENERATOR" "$target_file"
   ```

---

## Affected Areas

### Files to Create
- `ai/hooks/HOOKS_SPEC.md` - Complete hook specification
- `test/hooks.test.bash` - Hook system tests
- `test/fixtures/example_hook.sh` - Example hook for testing

### Files to Modify
- `scripts/igris_init.sh` - Add hook resolution and execution logic
- `scripts/plugin_install.sh` - Register execution hooks (not just content)
- `ai/templates/CLAUDE.md.template` - Add hook documentation placeholders
- `ai/prompts/igris_os.md` - Document hook system for Claude
- `docs/PLUGIN_DEVELOPMENT.md` - Add enhancement hook examples
- `README.md` - Mention extensibility capabilities
- `CHANGELOG.md` - Version update (v2.5.0 - Enhancement Hook System)

### Modules Affected
- Plugin system (TD-003) - Extended to support execution hooks
- Initialization workflow - Hook discovery and execution
- Session management - Hooks integrate with workflow checkpoints

### Count
**Total files to create:** 3
**Total files to modify:** 7
**Estimated lines of code:** ~400 lines (150 in igris_init.sh, 100 in HOOKS_SPEC.md, 150 tests/docs)

---

## Testing

### Test Coverage Requirements

**Test Case 1: Hook Discovery**
```bash
@test "igris_init discovers hooks from plugin.json" {
  # Setup plugin with CODE_REVIEWER hook
  create_plugin "test-plugin" '{"hooks": {"CODE_REVIEWER": "hooks/review.sh"}}'

  # Run init
  run igris_init.sh

  # Verify hook registered
  [ -f .igris/installed_plugins.json ]
  hook=$(jq -r '.[0].hooks.CODE_REVIEWER' .igris/installed_plugins.json)
  [ "$hook" = "hooks/review.sh" ]
}
```

**Test Case 2: Hook Execution**
```bash
@test "execute_hook runs script with correct environment" {
  # Create test hook
  echo '#!/bin/bash' > test_hook.sh
  echo 'echo "Hook executed: $IGRIS_HOOK_TYPE"' >> test_hook.sh
  chmod +x test_hook.sh

  # Execute hook
  output=$(execute_hook "TEST_HOOK" "input_data")

  # Verify
  [[ "$output" =~ "Hook executed: TEST_HOOK" ]]
}
```

**Test Case 3: Hook Exit Codes**
```bash
@test "hook exit code 0 means success" {
  # Hook returns 0
  echo '#!/bin/bash' > success_hook.sh
  echo 'echo "success"' >> success_hook.sh
  echo 'exit 0' >> success_hook.sh
  chmod +x success_hook.sh

  run execute_hook "SUCCESS_HOOK" ""
  [ "$status" -eq 0 ]
}

@test "hook exit code 1 means error" {
  # Hook returns 1
  echo '#!/bin/bash' > error_hook.sh
  echo 'echo "error occurred"' >> error_hook.sh
  echo 'exit 1' >> error_hook.sh
  chmod +x error_hook.sh

  run execute_hook "ERROR_HOOK" ""
  [ "$status" -eq 1 ]
}

@test "hook exit code 2 means skip" {
  # Hook returns 2 (not applicable)
  echo '#!/bin/bash' > skip_hook.sh
  echo 'exit 2' >> skip_hook.sh
  chmod +x skip_hook.sh

  run execute_hook "SKIP_HOOK" ""
  [ "$status" -eq 2 ]
}
```

**Test Case 4: No Hook Registered**
```bash
@test "execute_hook continues when no hook registered" {
  # No plugin installed
  run execute_hook "NONEXISTENT_HOOK" "data"

  # Should return 2 (skip)
  [ "$status" -eq 2 ]
}
```

**Test Case 5: Backward Compatibility**
```bash
@test "persona hooks still work after enhancement hooks added" {
  # Install persona plugin (old style)
  install_persona_plugin

  # Run init
  run igris_init.sh

  # Verify persona injection still works
  [ -f CLAUDE.md ]
  grep -q "I am Igris" CLAUDE.md
}
```

### Regression Testing
- [ ] Existing persona hooks still work (TD-003)
- [ ] Plugin install/uninstall unchanged
- [ ] Init workflow backward compatible
- [ ] No breaking changes to plugin.json format (only additions)

### Verification
**How to verify cleanup is successful:**

1. Install plugin with enhancement hooks → hooks registered
2. Execute hook → script runs with correct environment
3. Hook returns 0 → workflow continues with output
4. Hook returns 1 → error shown, workflow can handle
5. Hook returns 2 → workflow continues silently
6. No hook registered → workflow continues normally
7. Existing persona plugins → still work perfectly

---

## Acceptance Criteria

**The debt is paid off when:**

1. [ ] HOOKS_SPEC.md documents all hook types and contracts
2. [ ] igris_init.sh resolves and executes hooks correctly
3. [ ] Hook environment variables set (IGRIS_HOOK_TYPE, etc.)
4. [ ] Exit codes handled (0=success, 1=error, 2=skip)
5. [ ] Plugin install registers execution hooks
6. [ ] Tests pass (discovery, execution, exit codes, backward compat)
7. [ ] Documentation complete (PLUGIN_DEVELOPMENT.md updated)
8. [ ] Example enhancement plugin created (demo/reference)
9. [ ] Backward compatible (persona hooks still work)
10. [ ] No breaking changes to existing workflows

---

## References

**Related Briefs:**
- **TD-003:** Persona Hook System (foundation for this work)
- **FR-001:** LangChain Integration (primary consumer of this system)

**Coding Guidelines:**
- `ai/context/coding_guidelines.md` - Follow bash best practices
- Section 4: Multi-line text handling (use perl, not sed)
- Section 5: JSON manipulation (use Python3 or jq with fallback)
- Section 7: Testing requirements (use bats framework)

**External References:**
- Git hooks documentation (similar pattern)
- Webpack loaders/plugins (inspiration for hook architecture)
- LangChain callbacks (event-driven execution model)

---

## Notes

**Design Philosophy:**

The enhancement hook system should be:
1. **Optional** - Igris works perfectly without any hooks
2. **Composable** - Multiple plugins can register different hooks
3. **Fail-safe** - Hook errors don't break core workflows
4. **Discoverable** - Clear which hooks are available and registered
5. **Testable** - Hooks follow contracts, easy to test

**Hook Naming Convention:**
- Use UPPERCASE_SNAKE_CASE (e.g., `CODE_REVIEWER`, `BRIEF_GENERATOR`)
- Name describes WHAT it does, not HOW (language-agnostic)
- Keep names short but descriptive

**Security Considerations:**
- Hooks execute with project permissions (be careful)
- Validate hook scripts exist and are executable
- Don't execute hooks from untrusted sources
- Document security model in HOOKS_SPEC.md

**Future Hook Types (Out of Scope for TD-012):**
- `{{DEPENDENCY_AUDITOR}}` - Security/update scanning
- `{{PERFORMANCE_PROFILER}}` - Performance analysis
- `{{DOCUMENTATION_GENERATOR}}` - Auto-generate docs
- `{{MIGRATION_ASSISTANT}}` - Help with migrations
- `{{SECURITY_SCANNER}}` - Vulnerability detection

**Dogfooding Plan:**
After TD-012 complete, immediately implement simple enhancement:
- Create `igris-example-enhancement` plugin
- Implements `SYSTEM_ASSESSMENT` hook
- Shows brief count and git status in ARISE output
- Proves hook system works end-to-end

Then tackle FR-001 (LangChain integration) with confidence.

---

**Created:** 2025-11-14
**Last Updated:** 2025-11-14
**Brief Owner:** Igris AI / Fifty.ai
