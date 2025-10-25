# TD-006: Standardize jq Dependency Handling Across Scripts

**Type:** Technical Debt
**Priority:** P2-Medium
**Effort:** S-Small (< 4h)
**Assignee:** AI Assistant
**Status:** Done
**Completed:** 2025-10-25

---

## What is the Technical Debt?

**Current situation:**

Igris AI scripts use `jq` (JSON processor) inconsistently:
- Some scripts check if jq exists before using it
- Some scripts silently skip jq operations if missing
- Some scripts may fail with cryptic errors
- README doesn't list jq in requirements
- Unclear whether jq is optional or required

**Why is it technical debt?**

- Inconsistent dependency handling across codebase
- No clear documentation on whether jq is needed
- Poor user experience (silent failures vs errors)
- Violates principle of least surprise

**Examples:**

```bash
# igris_init.sh:188 - Checks if jq exists
if [ -f "ai/plugins/installed.json" ] && command -v jq &> /dev/null; then
  PERSONA_HOOK=$(jq -r '.plugins[] | select(.hooks.persona_injection) | .hooks.persona_injection' ai/plugins/installed.json 2>/dev/null || echo "")
  # ... silently skips if jq missing
fi

# Other scripts - Similar pattern but inconsistent
```

**Questions:**
- Is jq required or optional?
- What happens if jq is missing?
- Should users be warned?
- Should installation fail or continue?

---

## Why It Matters

**Consequences of not fixing:**

- [x] **Maintainability:** Hard to understand dependency requirements
- [x] **Readability:** Inconsistent patterns confuse developers
- [ ] **Performance:** (Not affected)
- [ ] **Security:** (Not affected)
- [ ] **Scalability:** (Not affected)
- [x] **Developer Experience:** Users unsure if they need jq

**Impact:** Medium

Users may:
1. Install Igris AI without jq
2. Plugin hooks silently fail to load
3. Wonder why persona plugin doesn't work
4. Not realize jq is the issue

---

## Cleanup Steps

**How to pay off this debt:**

1. [ ] Decide: Is jq required or optional?
2. [ ] Document decision in README.md
3. [ ] Implement consistent handling pattern
4. [ ] Add validation or warnings where needed
5. [ ] Test with and without jq installed
6. [ ] Update CHANGELOG.md

---

## Benefits of Fixing

**What improves after cleanup:**

- ✅ **Clear documentation** - README states if jq is required
- ✅ **Consistent behavior** - All scripts handle jq the same way
- ✅ **Better UX** - Users know upfront if they need jq
- ✅ **Predictable** - Same pattern everywhere (easier to maintain)
- ✅ **Fail-fast or graceful degradation** - Clear strategy

**Return on Investment:** Medium

Simple fix (2-3 hours) improves clarity and UX.

---

## Affected Areas

### Files
- `scripts/igris_init.sh` - Hook resolution logic
- `scripts/plugin_install.sh` - Hook processing
- `scripts/plugin_update.sh` - Hook processing
- `README.md` - Requirements section
- `docs/SETUP_GUIDE.md` - Dependencies section

### Modules
- Plugin system - Hook resolution
- Init system - Persona injection

### Count
**Total files affected:** 5
**Total lines to change:** ~50

---

## Decision: Required vs Optional

### Option A: Make jq Required

**Pros:**
- ✅ Simpler code (no conditional checks)
- ✅ Plugin hooks always work
- ✅ Fail-fast if missing

**Cons:**
- ❌ Extra dependency for users
- ❌ Igris AI won't work without it

**Implementation:**
```bash
# At script start
if ! command -v jq &> /dev/null; then
  echo "❌ Error: jq is required but not installed"
  echo ""
  echo "Install jq:"
  echo "  macOS: brew install jq"
  echo "  Ubuntu: sudo apt install jq"
  echo "  Download: https://stedolan.github.io/jq/"
  echo ""
  exit 1
fi
```

### Option B: Make jq Optional (Recommended)

**Pros:**
- ✅ Igris AI works without jq (basic features)
- ✅ Graceful degradation
- ✅ Plugin hooks optional (not everyone needs them)

**Cons:**
- ❌ More complex code (conditional checks)
- ❌ Silent failures possible

**Implementation:**
```bash
# Check jq availability
JQ_AVAILABLE=false
if command -v jq &> /dev/null; then
  JQ_AVAILABLE=true
fi

# Use jq if available
if [ "$JQ_AVAILABLE" = true ]; then
  PERSONA_HOOK=$(jq -r '.plugins[] | select(.hooks.persona_injection) | .hooks.persona_injection' ai/plugins/installed.json 2>/dev/null || echo "")
else
  echo "⚠️  Warning: jq not found - plugin hooks will not be processed"
  echo "   Install jq for persona plugin support: brew install jq"
fi
```

**Recommendation:** **Option B (Optional)** - Most flexible, degrades gracefully.

---

## Testing

### Regression Testing
- [ ] All scripts work with jq installed
- [ ] All scripts work without jq installed (graceful degradation)
- [ ] Hook processing works when jq present
- [ ] Warning displayed when jq missing

### Verification
**How to verify cleanup is successful:**

1. Install Igris AI with jq → hooks work
2. Install Igris AI without jq → warning shown, basic features work
3. Install plugin without jq → warning shown, plugin installs but hooks skip
4. README clearly states jq is optional
5. Consistent behavior across all scripts

---

## Acceptance Criteria

**The debt is paid off when:**

1. [ ] Decision documented (required or optional)
2. [ ] README.md lists jq status clearly
3. [ ] All scripts handle jq consistently
4. [ ] Warning message shown if jq missing (if optional)
5. [ ] Error message shown if jq required but missing (if required)
6. [ ] Tested with and without jq
7. [ ] No silent failures

---

## Implementation Design

### Consistent Pattern (If Optional)

Create shared jq availability check:

```bash
# scripts/igris_init.sh, plugin_install.sh, etc.

# Check jq availability (once at script start)
JQ_AVAILABLE=false
if command -v jq &> /dev/null; then
  JQ_AVAILABLE=true
else
  echo "⚠️  Note: jq not found - plugin hooks will not be processed"
  echo "   Install for full plugin support:"
  echo "   macOS: brew install jq"
  echo "   Ubuntu: sudo apt install jq"
  echo "   Download: https://stedolan.github.io/jq/"
  echo ""
fi

# Use jq conditionally
if [ "$JQ_AVAILABLE" = true ] && [ -f "ai/plugins/installed.json" ]; then
  PERSONA_HOOK=$(jq -r '.plugins[] | select(.hooks.persona_injection) | .hooks.persona_injection' ai/plugins/installed.json 2>/dev/null || echo "")
  if [ -n "$PERSONA_HOOK" ] && [ -f "$PERSONA_HOOK" ]; then
    PERSONA_INJECTION=$(cat "$PERSONA_HOOK")
  fi
fi
```

### README Update

```markdown
## Requirements

- **Git** - Version control (required)
- **Claude AI** - AI assistant (required)
- **Python 3** - For JSON manipulation in scripts (required)
- **Bash** - Shell scripts (Mac/Linux/WSL) (required)
- **jq** - JSON processor (optional - needed for plugin hooks)

### Installing jq (Optional)

jq is used to process plugin hooks (persona plugins, etc.). Igris AI works without it, but plugin hook features will be disabled.

**macOS:**
```bash
brew install jq
```

**Ubuntu/Debian:**
```bash
sudo apt install jq
```

**Download:** https://stedolan.github.io/jq/
```

---

## References

**Coding Guidelines:**
- N/A (need to create for Igris AI - see TD-007)

**Best Practices:**
- Graceful degradation
- Clear dependency documentation
- Consistent error handling

**Related Briefs:**
- TD-004 - Python3 Dependency Validation (similar pattern)
- TD-007 - Missing Coding Guidelines (would document this pattern)

---

## Notes

### Current Behavior (Unclear)

```bash
# User installs without jq
$ ./scripts/igris_init.sh
[No warning]
[Installation succeeds]

# Later, user installs persona plugin
$ ./scripts/plugin_install.sh https://github.com/user/persona-plugin
[Plugin installs]
[Hooks silently don't work]
[User confused why persona doesn't appear]
```

### Improved Behavior (Clear)

```bash
# User installs without jq
$ ./scripts/igris_init.sh
⚠️  Note: jq not found - plugin hooks will not be processed
   Install for full plugin support:
   macOS: brew install jq
   Ubuntu: sudo apt install jq
[Installation succeeds]

# Later, user installs persona plugin
$ ./scripts/plugin_install.sh https://github.com/user/persona-plugin
⚠️  Note: jq not found - plugin hooks will not be processed
   Your plugin installed but persona features won't work.
   Install jq to enable hooks: brew install jq
[Plugin installs, user knows why hooks don't work]
```

---

**Created:** 2025-10-25
**Last Updated:** 2025-10-25
**Brief Owner:** Igris AI Self-Audit
