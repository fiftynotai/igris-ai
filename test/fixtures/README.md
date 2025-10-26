# Test Fixtures

Static test data used across the Igris AI test suite.

## Directory Structure

```
fixtures/
├── mock_plugin_minimal/         # Minimal plugin (no hooks)
│   ├── plugin.json
│   └── install.sh
├── mock_plugin_with_hooks/      # Plugin with persona_injection hook
│   ├── plugin.json
│   ├── install.sh
│   └── ai/prompts/mock_persona.md
├── mock_plugin_multiline/       # Plugin with multi-line content (BR-005 test)
│   ├── plugin.json
│   ├── install.sh
│   └── ai/prompts/multiline_persona.md
├── mock_plugin_invalid/         # Malformed plugin.json (error testing)
│   └── plugin.json
├── mock_project/                # Basic project structure
│   └── README.md
├── mock_project_with_git/       # Project with git initialized
│   └── .gitkeep
├── sample_persona.json          # Sample persona configuration
├── sample_installed.json        # Sample plugin registry
└── README.md                    # This file
```

## Usage

### In Test Helper Functions

Most fixtures are used via `test_helper.bash` functions that create dynamic mocks:

```bash
# Dynamic mock creation (preferred for most tests)
create_mock_plugin "my-plugin" false    # No hooks
create_mock_plugin "my-plugin" true     # With hooks
create_mock_plugin_multiline            # Multi-line content

# Setup test projects
setup_test_project                      # Empty project
init_igris_in_test_project             # Project with Igris initialized
```

### Direct Fixture Usage

Static fixtures are useful for tests that need consistent data:

```bash
@test "plugin_install handles invalid JSON" {
  setup_test_project

  # Copy invalid fixture
  cp -r "$BATS_TEST_DIRNAME/fixtures/mock_plugin_invalid" "$TEST_TEMP_DIR/"

  # Attempt install (should fail gracefully)
  run "$SCRIPTS_DIR/plugin_install.sh" "$TEST_TEMP_DIR/mock_plugin_invalid"

  assert_failure
  assert_output_contains "invalid JSON"
}
```

## Fixture Descriptions

### mock_plugin_minimal
- **Purpose:** Test basic plugin installation without hooks
- **Use cases:** Plugin install/uninstall, version checking, registry updates
- **Key feature:** Minimal valid plugin.json

### mock_plugin_with_hooks
- **Purpose:** Test plugin with persona_injection hook
- **Use cases:** CLAUDE.md regeneration, hook resolution
- **Key feature:** Valid persona_injection hook pointing to mock_persona.md

### mock_plugin_multiline
- **Purpose:** Test multi-line content handling (BR-005 regression test)
- **Use cases:** Newline preservation in CLAUDE.md
- **Key feature:** Multi-line persona content with formatting

### mock_plugin_invalid
- **Purpose:** Test error handling for malformed plugin.json
- **Use cases:** Validation, error messages, graceful failures
- **Key feature:** Intentionally broken JSON syntax

### mock_project
- **Purpose:** Basic project structure for initialization tests
- **Use cases:** Testing igris_init.sh on empty project
- **Key feature:** Minimal README.md only

### mock_project_with_git
- **Purpose:** Git-initialized project for git-aware tests
- **Use cases:** Testing git operations, .gitignore handling
- **Key feature:** Contains .git directory

### sample_persona.json
- **Purpose:** Valid persona configuration for testing
- **Use cases:** Persona loading, mask switching, name resolution
- **Key feature:** All required fields populated

### sample_installed.json
- **Purpose:** Plugin registry with multiple plugins
- **Use cases:** Plugin listing, update checks, hook aggregation
- **Key feature:** 2 plugins (1 with hooks, 1 without)

## Maintenance

When adding new fixtures:
1. Create fixture directory/file
2. Document purpose and use cases in this README
3. Add example usage in test files
4. Ensure fixture data is minimal but realistic

---

**Created:** 2025-10-26
**Last Updated:** 2025-10-26
