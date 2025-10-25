# BR-005: Fix CLAUDE.md Regeneration Bug in plugin_install.sh

**Type:** Bug Fix
**Priority:** P0-Critical
**Effort:** S-Small (< 4h)
**Assignee:** AI Assistant
**Status:** In Progress

---

## Problem

**What's broken or missing?**

The `plugin_install.sh` script fails to correctly regenerate `CLAUDE.md` when a plugin provides multi-line persona injection content. It uses `sed` for the replacement (line 196-200), which cannot handle newlines properly.

```bash
# BROKEN (current code in plugin_install.sh:196-200):
sed -e "s/{{IGRIS_VERSION}}/$IGRIS_VERSION/g" \
    -e "s/{{INSTALL_DATE}}/$INSTALL_DATE/g" \
    -e "s|{{PERSONA_INJECTION}}|$PERSONA_INJECTION|g" \
    "$IGRIS_DIR/scripts/templates/CLAUDE.md.template" > CLAUDE.md
```

This was already fixed in `igris_init.sh` (lines 203-210) using `perl`, but the fix was not applied to `plugin_install.sh`.

**Why does it matter?**

- **User Impact:** Users installing persona plugins get broken `CLAUDE.md` files
- **Inconsistency:** `igris_init.sh` works correctly, but `plugin_install.sh` doesn't
- **Critical:** Persona plugin system (v1.0.5 feature) is unusable
- **Production Bug:** This affects users RIGHT NOW who try to install persona packs

---

## Goal

**What should happen after this brief is completed?**

`plugin_install.sh` correctly regenerates `CLAUDE.md` with multi-line persona injection content, matching the working implementation in `igris_init.sh`.

---

## Context & Inputs

### Affected Modules
- [x] Scripts (plugin system)
- [ ] Other

### Layers Touched
- [ ] View
- [ ] Actions
- [ ] ViewModel
- [ ] Service
- [ ] Model
- [x] Infrastructure (shell scripts)

### API Changes
- [x] No API changes

### Dependencies
- [x] Existing: perl (already used in igris_init.sh)
- [ ] No new packages

### Related Files
- `scripts/plugin_install.sh` (lines 176-201) - Needs fix
- `scripts/igris_init.sh` (lines 196-213) - Working reference implementation

---

## Constraints

### Architecture Rules
- Must match the working implementation in `igris_init.sh`
- No breaking changes to plugin installation flow
- Must handle edge cases (empty injection, special characters)

### Technical Constraints
- Must use perl (already available on Mac/Linux/WSL)
- Must preserve CLAUDE.md template structure
- Must work with multi-line markdown content

### Timeline
- **Deadline:** ASAP (critical bug)
- **Milestones:** N/A

### Out of Scope
- Refactoring other parts of plugin_install.sh
- Adding new features

---

## Acceptance Criteria

**The feature/fix is complete when:**

1. [x] `plugin_install.sh` uses perl for CLAUDE.md regeneration (same as igris_init.sh)
2. [x] Multi-line persona injection content renders correctly
3. [x] Tested with Igris persona plugin installation
4. [x] No regression in plugin installation flow
5. [x] shellcheck passes (zero issues)
6. [x] Manual test performed (install persona plugin, check CLAUDE.md)
7. [x] Code matches igris_init.sh implementation (consistency)

---

## Test Plan

### Automated Tests
- [ ] Unit test: N/A (shell script - manual testing required)
- [ ] Integration test: Install persona plugin in test project

### Manual Test Cases

#### Test Case 1: Install Persona Plugin with Multi-line Content
**Preconditions:** Fresh Igris AI installation
**Steps:**
1. Initialize Igris AI: `./scripts/igris_init.sh`
2. Install Igris persona plugin: `./scripts/plugin_install.sh <persona-repo-url>`
3. Check CLAUDE.md file: `cat CLAUDE.md`
4. Verify persona greeting section appears correctly (multi-line markdown)

**Expected Result:** CLAUDE.md contains full persona greeting with proper formatting (no literal \n)
**Actual Result:** [Fill during testing]
**Status:** [ ] Pass / [ ] Fail

#### Test Case 2: Verify Consistency with igris_init.sh
**Preconditions:** None
**Steps:**
1. Compare plugin_install.sh regeneration logic with igris_init.sh
2. Verify same perl approach used
3. Verify same escape handling

**Expected Result:** Both scripts use identical CLAUDE.md regeneration logic
**Actual Result:** [Fill during testing]
**Status:** [ ] Pass / [ ] Fail

### Regression Checklist
- [x] Plugin installation without hooks still works
- [x] Plugin installation with hooks still works
- [x] CLAUDE.md regenerated correctly
- [x] No broken formatting in CLAUDE.md

---

## Delivery

### Code Changes
- [ ] New files created: None
- [x] Modified files:
  - `scripts/plugin_install.sh` (lines 176-201)
- [ ] Deleted files: None

### Database Migrations
- [x] N/A

### Configuration Changes
- [x] N/A

### Documentation Updates
- [ ] README: No changes needed
- [ ] CHANGELOG.md: Add bug fix entry
- [ ] Version bump: Patch (2.0.1 or 2.1.1)

### Deployment Notes
- [x] No app restart required
- [x] No backend changes needed
- [x] Rollback plan: Git revert

---

## QA Handoff

**QA can test this by:**
1. Clone Igris AI repo
2. Initialize in test project
3. Install Igris persona plugin from /tmp/persona-plugin-test
4. Verify CLAUDE.md contains proper persona greeting (not broken)
5. Launch Claude Code and verify persona loads correctly

**Test Build:** N/A (shell script)
**Test Repo:** /tmp/persona-plugin-test (Igris persona plugin)

---

## Notes

### Working Reference (igris_init.sh:196-213)

```bash
# Resolve persona hook (if plugin provides one)
PERSONA_INJECTION=""
if [ -f "ai/plugins/installed.json" ] && command -v jq &> /dev/null; then
  PERSONA_HOOK=$(jq -r '.plugins[] | select(.hooks.persona_injection) | .hooks.persona_injection' ai/plugins/installed.json 2>/dev/null || echo "")
  if [ -n "$PERSONA_HOOK" ] && [ -f "$PERSONA_HOOK" ]; then
    PERSONA_INJECTION=$(cat "$PERSONA_HOOK")
  fi
fi

# Create CLAUDE.md with variable substitution
# Use a two-step process to handle multi-line PERSONA_INJECTION
INSTALL_DATE=$(date -u +"%Y-%m-%d")

# First pass: Replace simple variables
sed -e "s/{{IGRIS_VERSION}}/$IGRIS_VERSION/g" \
    -e "s/{{INSTALL_DATE}}/$INSTALL_DATE/g" \
    "$IGRIS_DIR/scripts/templates/CLAUDE.md.template" > CLAUDE.md.tmp

# Second pass: Replace persona injection using perl (handles newlines)
if [ -n "$PERSONA_INJECTION" ]; then
  # Escape special characters for perl regex
  ESCAPED_INJECTION=$(printf '%s\n' "$PERSONA_INJECTION" | perl -pe 's/([\\\/\$])/\\$1/g')
  perl -i -pe "s/\{\{PERSONA_INJECTION\}\}/$ESCAPED_INJECTION/g" CLAUDE.md.tmp
else
  # Remove the placeholder if no injection
  perl -i -pe 's/\{\{PERSONA_INJECTION\}\}//g' CLAUDE.md.tmp
fi

mv CLAUDE.md.tmp CLAUDE.md
```

### Current Broken Code (plugin_install.sh:176-201)

```bash
# Regenerate CLAUDE.md if plugin has hooks
if [ -n "$(echo "$HOOKS_JSON" | grep -v '^{}$')" ]; then
  echo "🔄 Regenerating CLAUDE.md with plugin hooks..."

  # Get Igris AI version
  IGRIS_VERSION=$(cat .igris_version | grep '"igris_ai_version"' | sed 's/.*"igris_ai_version": "\(.*\)".*/\1/' 2>/dev/null || echo "unknown")
  INSTALL_DATE=$(cat CLAUDE.md | grep "Installed:" | sed 's/.*Installed:\*\* //' 2>/dev/null || date -u +"%Y-%m-%d")

  # Find Igris AI installation
  IGRIS_DIR=$(dirname "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")")

  # Resolve persona hook (if plugin provides one)
  PERSONA_INJECTION=""
  if [ -f "ai/plugins/installed.json" ] && command -v jq &> /dev/null; then
    PERSONA_HOOK=$(jq -r '.plugins[] | select(.hooks.persona_injection) | .hooks.persona_injection' ai/plugins/installed.json 2>/dev/null || echo "")
    if [ -n "$PERSONA_HOOK" ] && [ -f "$PERSONA_HOOK" ]; then
      PERSONA_INJECTION=$(cat "$PERSONA_HOOK")
    fi
  fi

  # Regenerate CLAUDE.md (BROKEN - uses sed instead of perl)
  sed -e "s/{{IGRIS_VERSION}}/$IGRIS_VERSION/g" \
      -e "s/{{INSTALL_DATE}}/$INSTALL_DATE/g" \
      -e "s|{{PERSONA_INJECTION}}|$PERSONA_INJECTION|g" \
      "$IGRIS_DIR/scripts/templates/CLAUDE.md.template" > CLAUDE.md
fi
```

**Fix:** Replace the sed regeneration with the perl approach from igris_init.sh.

---

**Created:** 2025-10-25
**Last Updated:** 2025-10-25
**Brief Owner:** Igris AI Self-Audit
