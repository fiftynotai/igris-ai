#!/usr/bin/env bats
# Hook System Tests
# Tests for Enhancement Hook System (TD-012)

setup() {
  # Create temp test directory
  export TEST_DIR=$(mktemp -d)
  cd "$TEST_DIR"

  # Initialize minimal Igris structure
  mkdir -p ai/plugins
  cat > ai/plugins/installed.json <<'JSON'
{
  "plugins": [],
  "last_updated": null
}
JSON

  # Source hook functions from igris_init.sh
  # Note: In production, these functions are defined in igris_init.sh
  # For testing, we inline them here
  source_hook_functions
}

teardown() {
  # Clean up test directory
  rm -rf "$TEST_DIR"
}

# Inline hook functions for testing
source_hook_functions() {
  # Define resolve_hooks function
  resolve_hooks() {
    local hook_type="$1"

    if [ ! -f "ai/plugins/installed.json" ]; then
      return 1
    fi

    local hook_script=""
    hook_script=$(python3 <<EOF 2>/dev/null
import json
try:
    with open('ai/plugins/installed.json', 'r') as f:
        data = json.load(f)
    for plugin in data.get('plugins', []):
        if '$hook_type' in plugin.get('hooks', {}):
            print(plugin['hooks']['$hook_type'])
            break
except:
    pass
EOF
)

    if [ -n "$hook_script" ] && [ -f "$hook_script" ] && [ -x "$hook_script" ]; then
      echo "$hook_script"
      return 0
    fi

    return 1
  }

  # Define execute_hook function
  execute_hook() {
    local hook_type="$1"
    local input_data="$2"

    local hook_script
    hook_script=$(resolve_hooks "$hook_type")
    if [ $? -ne 0 ]; then
      return 2
    fi

    export IGRIS_HOOK_TYPE="$hook_type"
    export IGRIS_PROJECT_ROOT="$(pwd)"
    export IGRIS_VERSION="test"

    local output
    local exit_code
    output=$(echo "$input_data" | "$hook_script" 2>&1)
    exit_code=$?

    case $exit_code in
      0)
        echo "$output"
        return 0
        ;;
      1)
        echo "⚠️ Hook $hook_type failed:" >&2
        echo "$output" >&2
        return 1
        ;;
      2)
        return 2
        ;;
      *)
        echo "⚠️ Hook $hook_type returned unexpected exit code: $exit_code" >&2
        return 1
        ;;
    esac
  }
}

@test "resolve_hooks returns error when no plugins installed" {
  run resolve_hooks "TEST_HOOK"
  [ "$status" -eq 1 ]
}

@test "resolve_hooks finds registered hook" {
  # Create test hook
  cat > test_hook.sh <<'HOOK'
#!/bin/bash
echo "test hook"
exit 0
HOOK
  chmod +x test_hook.sh

  # Register in installed.json
  cat > ai/plugins/installed.json <<'JSON'
{
  "plugins": [
    {
      "name": "test-plugin",
      "hooks": {
        "TEST_HOOK": "test_hook.sh"
      }
    }
  ]
}
JSON

  run resolve_hooks "TEST_HOOK"
  [ "$status" -eq 0 ]
  [ "$output" = "test_hook.sh" ]
}

@test "execute_hook runs script with correct environment" {
  # Create test hook
  cat > test_hook.sh <<'HOOK'
#!/bin/bash
echo "Hook Type: $IGRIS_HOOK_TYPE"
echo "Version: $IGRIS_VERSION"
exit 0
HOOK
  chmod +x test_hook.sh

  # Register hook
  cat > ai/plugins/installed.json <<'JSON'
{
  "plugins": [
    {
      "name": "test-plugin",
      "hooks": {
        "TEST_HOOK": "test_hook.sh"
      }
    }
  ]
}
JSON

  run execute_hook "TEST_HOOK" "input_data"
  [ "$status" -eq 0 ]
  [[ "$output" =~ "Hook Type: TEST_HOOK" ]]
  [[ "$output" =~ "Version: test" ]]
}

@test "hook exit code 0 returns success" {
  cat > success_hook.sh <<'HOOK'
#!/bin/bash
echo "success"
exit 0
HOOK
  chmod +x success_hook.sh

  cat > ai/plugins/installed.json <<'JSON'
{
  "plugins": [
    {
      "name": "test",
      "hooks": {
        "SUCCESS": "success_hook.sh"
      }
    }
  ]
}
JSON

  run execute_hook "SUCCESS" ""
  [ "$status" -eq 0 ]
  [[ "$output" =~ "success" ]]
}

@test "hook exit code 1 returns error" {
  cat > error_hook.sh <<'HOOK'
#!/bin/bash
echo "error occurred"
exit 1
HOOK
  chmod +x error_hook.sh

  cat > ai/plugins/installed.json <<'JSON'
{
  "plugins": [
    {
      "name": "test",
      "hooks": {
        "ERROR": "error_hook.sh"
      }
    }
  ]
}
JSON

  run execute_hook "ERROR" ""
  [ "$status" -eq 1 ]
}

@test "hook exit code 2 returns skip" {
  cat > skip_hook.sh <<'HOOK'
#!/bin/bash
exit 2
HOOK
  chmod +x skip_hook.sh

  cat > ai/plugins/installed.json <<'JSON'
{
  "plugins": [
    {
      "name": "test",
      "hooks": {
        "SKIP": "skip_hook.sh"
      }
    }
  ]
}
JSON

  run execute_hook "SKIP" ""
  [ "$status" -eq 2 ]
}

@test "execute_hook skips when no hook registered" {
  run execute_hook "NONEXISTENT_HOOK" "data"
  [ "$status" -eq 2 ]
}
