# Igris AI Test Suite

**Framework:** bats (Bash Automated Testing System)

---

## Directory Structure

```
test/
├── README.md                    # This file
├── test_helper.bash            # Shared test utilities
├── fixtures/                   # Test data (mock projects, etc.)
│   └── mock_project/          # Sample project for testing
├── igris_init.test.bash       # Tests for igris_init.sh
├── igris_update.test.bash     # Tests for igris_update.sh
└── error_handling.test.bash   # Error handling tests
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

**Recommended (Sequential):**
```bash
# Run test files one at a time
for test_file in test/*.test.bash; do
  bats "$test_file"
done
```

**Quick (Parallel - May Have Issues):**
```bash
bats test/
```

**Note:** Running `bats test/*.test.bash` (all files together) may cause intermittent failures due to bats parallel execution and temp directory cleanup timing. This is a known issue with bats when tests run concurrently. Tests pass reliably when run individually.

### Run Specific Test File
```bash
bats test/igris_init.test.bash
```

### Run with Verbose Output
```bash
bats test/igris_init.test.bash --tap
```

---

## Known Issues

### Parallel Test Execution

**Issue:** When running all test files together (`bats test/*.test.bash`), some tests may fail intermittently due to:
- Bats parallel execution of test files
- Temporary directory cleanup race conditions
- File system timing issues

**Symptoms:**
- Tests pass individually but fail when run together
- Failures are non-deterministic
- Error messages about missing files or directories

**Workaround:**
Run test files sequentially (recommended):
```bash
for test_file in test/*.test.bash; do
  bats "$test_file" || exit 1
done
```

**Status:**
- All tests pass when run individually (136/136)
- CI/CD configured to run sequentially
- No impact on functionality

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
