# TD-003: Add Persona Hook System for Plugin Extensibility

**Type:** Technical Debt
**Priority:** P2-Medium
**Effort:** S-Small (< 4h)
**Assignee:** AI Assistant
**Status:** Done
**Completed:** 2025-10-25

---

## What is the Technical Debt?

**Current situation:**

Blueprint AI currently has a plugin system that allows installation of plugins (like `blueprint-ai-distribution-flutter`), but plugins can only add files - they cannot inject content into core Blueprint AI prompts or configuration files.

The `CLAUDE.md` template is static and doesn't support content injection from plugins.

**Why is this technical debt?**

- Plugins are limited to additive functionality only
- No way for plugins to enhance or modify Claude's behavior/tone
- Plugin system is incomplete - missing a common extension pattern (hooks/filters)
- Future plugins (like persona packs) need injection points without forking core

**Examples:**
```markdown
# Current CLAUDE.md.template (static, no injection points)

# Blueprint AI - Project Instructions

**Version:** {{BLUEPRINT_VERSION}}
**Installed:** {{INSTALL_DATE}}

This project uses Blueprint AI for code quality...

# (No way for plugins to inject here)
```

---

## Why It Matters

**Consequences of not fixing:**

- [x] **Maintainability:** Plugins requiring behavior changes must fork core or manually edit files
- [x] **Scalability:** Plugin system cannot support enhancement-type plugins (only additive ones)
- [x] **Developer Experience:** Plugin authors can't create rich integrations
- [ ] **Readability:** (Not affected)
- [ ] **Performance:** (Not affected)
- [ ] **Security:** (Not affected)

**Impact:** Medium

Without this, we cannot support:
- Persona packs plugin (planned)
- Future UI/UX enhancement plugins
- Custom prompt modification plugins
- Theme/branding plugins

---

## Cleanup Steps

**How to pay off this debt:**

1. [x] Design hook system contract
2. [ ] Add hook placeholder to `CLAUDE.md.template`
3. [ ] Create hook injection logic in `blueprint_init.sh`
4. [ ] Update plugin.json schema to support hooks
5. [ ] Update `plugin_install.sh` to process hooks
6. [ ] Document hook system in `PLUGIN_DEVELOPMENT.md`
7. [ ] Test with mock plugin
8. [ ] Update CHANGELOG.md

---

## Benefits of Fixing

**What improves after cleanup:**

- ✅ Plugins can inject content into core prompts
- ✅ Enables persona packs plugin
- ✅ Future-proofs plugin system for enhancement plugins
- ✅ Maintains clean separation (core stays focused, plugins extend)
- ✅ No breaking changes for existing users or plugins
- ✅ Complete plugin architecture (add files + inject content)

**Return on Investment:** High

This unblocks the persona packs feature and future enhancement plugins.

---

## Affected Areas

### Files

**Templates:**
- `scripts/templates/CLAUDE.md.template` - Add `{{PERSONA_INJECTION}}` hook

**Scripts:**
- `scripts/blueprint_init.sh` - Add hook processing (default to empty string)
- `scripts/plugin_install.sh` - Add hook injection when plugin provides hooks

**Documentation:**
- `docs/PLUGIN_DEVELOPMENT.md` - Document hook system
- `CHANGELOG.md` - Add v1.0.5 entry

### Modules
- Plugin system - Add hook support

### Count
**Total files affected:** 4
**Total lines to add:** ~50-75

---

## Technical Design

### Hook Placeholder Format

```markdown
# In CLAUDE.md.template

# Blueprint AI - Project Instructions

{{PERSONA_INJECTION}}

**Version:** {{BLUEPRINT_VERSION}}
**Installed:** {{INSTALL_DATE}}
```

### Plugin Manifest Hook Definition

```json
{
  "name": "blueprint-ai-persona-packs",
  "version": "1.0.0",
  "hooks": {
    "persona_injection": "ai/prompts/persona_loader.md"
  }
}
```

### Hook Resolution Logic

```bash
# In blueprint_init.sh

PERSONA_INJECTION=""

# Check if persona plugin installed
if [ -f "ai/plugins/installed.json" ]; then
  PERSONA_HOOK=$(jq -r '.plugins[] | select(.hooks.persona_injection) | .hooks.persona_injection' ai/plugins/installed.json)
  if [ -n "$PERSONA_HOOK" ] && [ -f "$PERSONA_HOOK" ]; then
    PERSONA_INJECTION=$(cat "$PERSONA_HOOK")
  fi
fi

# Replace in template
sed "s|{{PERSONA_INJECTION}}|$PERSONA_INJECTION|g" templates/CLAUDE.md.template > CLAUDE.md
```

---

## Testing

### Regression Testing
- [ ] Blueprint AI works normally without any plugins
- [ ] Existing plugins (distribution-flutter) still work
- [ ] No functionality changes to core workflows

### New Functionality Testing
- [ ] Hook placeholder exists in generated CLAUDE.md
- [ ] Hook resolves to empty string when no plugin
- [ ] Hook injects content when plugin provides it
- [ ] Multiple hooks can coexist

### Verification
**How to verify cleanup is successful:**

1. Fresh install without plugins → CLAUDE.md has no persona content
2. Install mock persona plugin → CLAUDE.md contains injected content
3. Uninstall persona plugin → CLAUDE.md returns to normal
4. Existing workflows (briefs, sessions) unaffected

---

## Acceptance Criteria

**The debt is paid off when:**

1. [ ] `{{PERSONA_INJECTION}}` hook exists in CLAUDE.md.template
2. [ ] Hook resolves to empty string by default
3. [ ] Plugins can define hooks in plugin.json
4. [ ] plugin_install.sh processes hooks correctly
5. [ ] Documentation explains hook system
6. [ ] No breaking changes for existing users
7. [ ] No breaking changes for existing plugins
8. [ ] Tested with mock plugin

---

## Implementation Phases

### Phase 1: Core Hook System (v1.0.5)
- Add hook placeholder to template
- Update init script to process hooks
- Update plugin install script
- Document in PLUGIN_DEVELOPMENT.md

### Phase 2: Persona Plugin (separate repo)
- Create `blueprint-ai-persona-packs` repository
- Use hook system for persona injection
- Test integration with v1.0.5+

---

## References

**Coding Guidelines:**
- N/A (script-level change)

**Best Practices:**
- Hook/filter pattern (common in WordPress, Jekyll, etc.)
- Placeholder injection pattern

**Related Briefs:**
- TD-001 - Hooks-based auto-loading (similar hook concept)
- TD-002 - Workflow enforcement (uses CLAUDE.md)

**External:**
- Persona Packs Feature Plan (user request)

---

## Notes

**Design Decisions:**

1. **Why {{PLACEHOLDER}} format?**
   - Already used for {{BLUEPRINT_VERSION}}, consistent pattern
   - Easy to identify in templates
   - Simple string replacement

2. **Why only persona_injection hook for now?**
   - Start small, add more hooks as needed
   - YAGNI principle - don't build unused features
   - Easy to add more hooks later (breaking: no, additive: yes)

3. **Why not use a full template engine?**
   - Bash-friendly
   - No external dependencies
   - Keeps scripts simple
   - Good enough for current needs

4. **Hook naming convention:**
   - snake_case for hook names
   - Descriptive (e.g., `persona_injection`, not `hook1`)
   - Can add prefixes later if needed (`before_init`, `after_brief`, etc.)

**Future Hook Ideas (not in scope now):**
- `{{THEME_INJECTION}}` - Custom styling/formatting
- `{{TOOL_INJECTION}}` - Custom tool integrations
- `{{BANNER_INJECTION}}` - Custom startup banners

---

**Created:** 2025-10-25
**Last Updated:** 2025-10-25
**Brief Owner:** Blueprint AI Core Team
