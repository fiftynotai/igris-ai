# Contributing to Igris AI

Welcome! Igris AI is an open-source code quality and architecture management system. We welcome contributions that improve the system.

---

## 🚀 Quick Start

1. **Fork** the repository
2. **Clone** your fork
3. **Create a branch** from `main`
4. **Make your changes** following our coding guidelines
5. **Test your changes**
6. **Submit a pull request**

---

## 📋 Coding Guidelines

**All contributions MUST follow the Igris AI Coding Guidelines:**

📄 **[ai/context/coding_guidelines.md](context/coding_guidelines.md)**

This document defines:
- Bash scripting standards
- Error handling patterns
- Testing requirements
- Documentation standards
- Security best practices
- Commit message format

**Please read the coding guidelines before contributing.**

---

## 🐛 Reporting Bugs

### Before Reporting

1. **Search existing issues** - Check if it's already reported
2. **Check latest version** - Update and test again
3. **Reproduce** - Can you consistently reproduce it?

### Bug Report Template

Create an issue with:

```markdown
**Bug Description:**
Clear description of what's broken

**Steps to Reproduce:**
1. Step one
2. Step two
3. Bug occurs

**Expected Behavior:**
What should happen

**Actual Behavior:**
What actually happens

**Environment:**
- OS: (macOS 14.0, Ubuntu 22.04, etc.)
- Igris AI Version: (run `cat version.txt`)
- Shell: (bash 5.2, zsh, etc.)

**Error Messages:**
Paste relevant error output
```

---

## ✨ Suggesting Features

### Feature Request Template

Create an issue with:

```markdown
**Feature Name:**
Brief name

**Problem:**
What problem does this solve?

**Proposed Solution:**
How should it work?

**Alternatives Considered:**
What other approaches did you consider?

**Additional Context:**
Screenshots, examples, references
```

---

## 🔧 Development Workflow

### 1. Set Up Development Environment

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/igris-ai.git
cd igris-ai

# Add upstream remote
git remote add upstream https://github.com/fiftynotai/igris-ai.git

# Create development branch
git checkout -b feature/my-feature
```

### 2. Make Changes

Follow the coding guidelines:
- Use `set -e` in all scripts
- Validate dependencies upfront
- Use perl for multi-line substitution
- Quote all variables
- Provide clear error messages

### 3. Test Your Changes

```bash
# Run shellcheck on modified scripts
shellcheck scripts/*.sh

# Run tests (once TD-005 is implemented)
bats test/

# Manual testing
./scripts/igris_init.sh /tmp/test-project
```

### 4. Commit Your Changes

Follow conventional commits format:

```bash
git commit -m "feat(plugin): add hook system for persona injection

Implemented {{PERSONA_INJECTION}} placeholder in CLAUDE.md template.

closes #42"
```

**Commit types:**
- `feat` - New feature
- `fix` - Bug fix
- `refactor` - Code refactoring
- `docs` - Documentation
- `chore` - Maintenance
- `test` - Tests

**See [ai/context/coding_guidelines.md#11-conventional-commits](context/coding_guidelines.md#11-conventional-commits) for details.**

### 5. Push and Create PR

```bash
# Push to your fork
git push origin feature/my-feature

# Create pull request on GitHub
# Use the PR template (will be auto-populated)
```

---

## 🎯 Pull Request Guidelines

### PR Checklist

Before submitting, ensure:

- [ ] Code follows [coding guidelines](context/coding_guidelines.md)
- [ ] All scripts pass `shellcheck`
- [ ] Tests added/updated (if applicable)
- [ ] Documentation updated (if needed)
- [ ] Commit messages follow conventional format
- [ ] PR description explains changes clearly
- [ ] Tested on macOS and/or Linux
- [ ] No hardcoded paths
- [ ] Variables are quoted
- [ ] Error messages are clear and actionable

### PR Description Template

```markdown
## Summary
What does this PR do?

## Related Issue
closes #XX
fixes #YY

## Changes
- Change 1
- Change 2

## Testing
How was this tested?

## Screenshots
(if applicable)
```

---

## 🧪 Testing

### Automated Testing

Igris AI has a comprehensive test suite with 166 tests across 7 test files.

**Test Framework:** [bats-core](https://github.com/bats-core/bats-core)

**Install bats:**

```bash
# macOS
brew install bats-core

# Ubuntu/Debian
sudo apt install bats
```

**Run all tests:**

```bash
bats test/
```

**Run specific test file:**

```bash
bats test/igris_init.test.bash
bats test/plugin_install.test.bash
```

**Run with verbose output:**

```bash
bats test/ --tap
```

### Writing Tests

When adding new functionality:

1. **Add tests for new scripts** - Create `test/script_name.test.bash`
2. **Use test helpers** - Load `test_helper.bash` for common utilities
3. **Follow test patterns** - See existing tests for examples
4. **Test error handling** - Add negative test cases
5. **Test edge cases** - Special characters, empty inputs, etc.

**Test helper utilities:**

```bash
load test_helper

@test "example test" {
  # Setup
  setup_test_project
  init_igris_in_test_project

  # Execute
  run "$SCRIPTS_DIR/your_script.sh" "args"

  # Assert
  assert_success
  assert_file_exists "$TEST_PROJECT_DIR/some/file"
  assert_file_contains "$TEST_PROJECT_DIR/file" "content"
}
```

See `test/README.md` for full testing documentation.

### Manual Testing

Test your changes on a real project:

```bash
# Create test project
mkdir /tmp/test-igris-project
cd /tmp/test-igris-project
git init

# Run igris_init.sh from your branch
/path/to/your-fork/scripts/igris_init.sh .

# Test the feature/fix
# ...
```

### Test Coverage Requirements

**For new scripts:**
- ✅ Critical paths: 100% coverage
- ✅ Error handling: 80% coverage
- ✅ Edge cases: 60% coverage

**For modified scripts:**
- ✅ Add tests for new functionality
- ✅ Ensure existing tests still pass
- ✅ Add regression tests if fixing bugs

### CI/CD

Tests run automatically on:
- Every push to `main` branch
- Every pull request
- Both Ubuntu and macOS environments

See `.github/workflows/test.yml` for CI configuration.

---

## 📖 Documentation

### What Needs Documentation

- **New features:** Update README.md and relevant docs
- **Changed behavior:** Update affected docs
- **New scripts:** Add inline documentation
- **API changes:** Update integration guides

### Documentation Standards

See [ai/context/coding_guidelines.md#8-documentation](context/coding_guidelines.md#8-documentation)

**Key points:**
- Comment the WHY, not the WHAT
- Use clear, actionable language
- Provide examples
- Keep docs up to date

---

## 🔍 Code Review Process

### What Reviewers Look For

1. **Follows guidelines:** All coding standards met
2. **Tests pass:** shellcheck clean, tests green
3. **Clear purpose:** PR has clear objective
4. **No breaking changes:** Unless absolutely necessary
5. **Documentation:** Changes are documented
6. **Security:** No vulnerabilities introduced

### Review Timeline

- **Initial response:** Within 2-3 days
- **Full review:** Within 1 week
- **Merge (if approved):** Within 1-2 days after approval

---

## 🏗️ Project Structure

```
igris-ai/
├── scripts/                  # Core scripts
│   ├── igris_init.sh        # Initialize Igris AI
│   ├── plugin_install.sh    # Install plugins
│   ├── plugin_update.sh     # Update plugins
│   └── templates/           # File templates
├── ai/                      # Igris AI operational files
│   ├── briefs/              # Brief templates
│   ├── context/             # Project context
│   │   └── coding_guidelines.md  # Coding standards
│   ├── prompts/             # System prompts
│   └── session/             # Session management
├── docs/                    # Documentation
├── test/                    # Tests (bats framework)
└── README.md                # Project README
```

---

## 🎨 Code Style

### Shell Scripts

```bash
#!/bin/bash
set -e  # MANDATORY

# Good function
check_dependency() {
  if ! command -v "$1" &> /dev/null; then
    echo "❌ Error: $1 is required but not installed"
    exit 1
  fi
}

# Good variable naming
IGRIS_VERSION="2.0.0"  # Constants: UPPERCASE
target_dir="/path"      # Local vars: lowercase

# Good error message
echo "❌ Error: Python 3 is required but not installed"
echo ""
echo "Install Python 3:"
echo "  macOS:  brew install python3"
echo "  Ubuntu: sudo apt install python3"
```

**Full standards:** [ai/context/coding_guidelines.md](context/coding_guidelines.md)

---

## ⚠️ Common Mistakes

### DON'T

- ❌ Skip `set -e`
- ❌ Use sed for multi-line substitution
- ❌ Leave variables unquoted
- ❌ Write cryptic error messages
- ❌ Hardcode paths
- ❌ Skip dependency validation
- ❌ Use eval with user input

### DO

- ✅ Use `set -e` in all scripts
- ✅ Use perl for multi-line substitution
- ✅ Quote all variables: `"$VAR"`
- ✅ Provide actionable error messages
- ✅ Use variables for paths
- ✅ Validate dependencies upfront
- ✅ Use safe command substitution

---

## 🤝 Getting Help

### Documentation

- **[README.md](../README.md)** - Project overview
- **[ai/context/coding_guidelines.md](context/coding_guidelines.md)** - Coding standards
- **[ai/prompts/igris_os.md](prompts/igris_os.md)** - Igris AI operating system

### Questions?

- **GitHub Issues** - For bugs and feature requests
- **GitHub Discussions** - For questions and ideas

---

## 📜 License

By contributing to Igris AI, you agree that your contributions will be licensed under the same license as the project.

---

## 🙏 Recognition

Contributors who make significant improvements will be recognized in:
- **README.md** - Contributors section
- **CHANGELOG.md** - Release notes
- **GitHub releases** - Release announcements

---

**Thank you for contributing to Igris AI!**

We build better code together.

---

**Created:** 2025-10-26
**Last Updated:** 2025-10-26
**Maintained By:** Igris AI Team
