# Igris AI Test Suite

**Framework:** bats (Bash Automated Testing System)

---

## Directory Structure

```
test/
├── README.md                    # This file
├── test_helper.bash            # Shared test utilities
├── fixtures/                   # Test data (mock projects, plugins, etc.)
│   ├── mock_plugin/           # Sample plugin for testing
│   └── mock_project/          # Sample project for testing
├── igris_init.test.bash       # Tests for igris_init.sh
├── plugin_install.test.bash   # Tests for plugin_install.sh
├── plugin_update.test.bash    # Tests for plugin_update.sh
├── plugin_uninstall.test.bash # Tests for plugin_uninstall.sh
└── igris_update.test.bash     # Tests for igris_update.sh
```

---

## Running Tests

### Install bats

**macOS (Homebrew):**
```bash
brew install bats-core
```

**Ubuntu/Debian:**
```bash
sudo apt install bats
```

**Manual install:**
```bash
git clone https://github.com/bats-core/bats-core.git
cd bats-core
sudo ./install.sh /usr/local
```

### Run All Tests
```bash
bats test/
```

### Run Specific Test File
```bash
bats test/igris_init.test.bash
```

### Run with Verbose Output
```bash

bats test/ --tap
```

---

## Writing Tests

### Basic Test Structure

```bash
#!/usr/bin/env bats

# Load shared utilities
load test_helper

@test "description of what is being tested" {
  # Arrange (setup)
  setup_test_project

  # Act (execute)
  run ./scripts/igris_init.sh "$TEST_DIR"

  # Assert (verify)
  [ "$status" -eq 0 ]
  [ -d "$TEST_DIR/ai" ]
}
```

### Test Helpers

Use functions from `test_helper.bash`:
- `setup_test_project` - Create temporary test project
- `teardown_test_project` - Clean up after test
- `create_mock_plugin` - Create mock plugin for testing
- `assert_file_exists` - Check file exists
- `assert_file_contains` - Check file contains text

---

## Coverage Goals

- **Critical paths:** 100%
- **Error handling:** 80%
- **Edge cases:** 60%
- **Overall:** 75%+

---

## CI/CD Integration

Tests run automatically on:
- Every push to `main` branch
- Every pull request
- Via GitHub Actions (`.github/workflows/test.yml`)

Tests must pass before merging.

---

**Version:** 1.0.0
**Last Updated:** 2025-10-26
