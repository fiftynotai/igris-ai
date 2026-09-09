# Igris AI Test Suite

**Framework:** bats (Bash Automated Testing System)

---

## Directory Structure

```
test/
├── README.md                              # This file
├── test_helper.bash                       # Shared test utilities
├── fixtures/                              # Test data (mock projects, etc.)
│   └── mock_project/                      # Sample project for testing
├── validate_brain_stewardship_enums.test.bash  # Tests for the enum-drift validator
├── verify_mirror.test.bash                # Tests for core/scripts/verify_mirror.sh
└── error_handling.test.bash               # Error handling tests
```

> **No zero-test files (TD-434, 2026-08-31).** `edge_cases.test.bash` was
> deleted: TD-148 had removed its last test (slug-validation edge cases moved
> to `cli/src/__tests__/install.test.ts`), leaving a 0-test stub. CI runs
> bats PER FILE, and bats ≥ 1.11 hard-errors on an empty suite
> (`ERROR: Found no tests.`) — locally the whole-glob invocation
> `bats test/*.test.bash` masked it because the combined suite is non-empty.
> New top-level-script edge-case tests get a NEW file; never commit a
> @test-less `.test.bash`.

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
bats test/verify_mirror.test.bash
```

### Run with Verbose Output
```bash
bats test/verify_mirror.test.bash --tap
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
  run "$SCRIPTS_DIR/your_script.sh" "$TEST_PROJECT_DIR"

  # Assert (verify)
  [ "$status" -eq 0 ]
  assert_file_exists "$TEST_PROJECT_DIR/expected/file"
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
