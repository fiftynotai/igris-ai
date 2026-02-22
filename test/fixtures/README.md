# Test Fixtures

Static test data used across the Igris AI test suite.

## Directory Structure

```
fixtures/
├── mock_project/                # Basic project structure
│   └── README.md
├── mock_project_with_git/       # Project with git initialized
│   └── .gitkeep
└── README.md                    # This file
```

## Usage

### In Test Helper Functions

```bash
# Setup test projects
setup_test_project                      # Empty project
init_igris_in_test_project             # Project with Igris initialized
```

## Fixture Descriptions

### mock_project
- **Purpose:** Basic project structure for initialization tests
- **Use cases:** Testing igris_init.sh on empty project
- **Key feature:** Minimal README.md only

### mock_project_with_git
- **Purpose:** Git-initialized project for git-aware tests
- **Use cases:** Testing git operations, .gitignore handling
- **Key feature:** Contains .git directory

## Maintenance

When adding new fixtures:
1. Create fixture directory/file
2. Document purpose and use cases in this README
3. Add example usage in test files
4. Ensure fixture data is minimal but realistic

---

**Created:** 2025-10-26
**Last Updated:** 2026-02-22
