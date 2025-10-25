# TD-001: Implement Hooks-Based Auto-Loading for Claude Code CLI

**Type:** Technical Debt
**Priority:** P1-High
**Effort:** L-Large (3-5d)
**Assignee:** AI Assistant
**Status:** Done

---

## What is the Technical Debt?

**Current situation:**

v1.0.2 implements "automatic Claude Code integration" using `.claude/prompt.md` which:
- Doesn't actually work (Claude Code CLI doesn't use this file)
- Requires user to send a message before loading
- Not truly "zero-configuration" as advertised
- Missing 3 critical scripts during installation

**Why is it technical debt?**

The feature was implemented without proper research of Claude Code CLI conventions:
- Wrong file location (`.claude/prompt.md` vs `CLAUDE.md`)
- Wrong approach (context file vs hooks)
- Misleading documentation ("automatic" when it requires user action)
- Incomplete script installation breaks update system

**Examples:**
```bash
# Current broken behavior
$ claude
[Generic welcome message]
User: "implement BR-001"  # User must type first
Claude: [loads .claude/prompt.md context]

# What was advertised in v1.0.2 release
$ claude
🚀 Welcome to Igris AI...  # Should show BEFORE user input
Ready for your command!
```

---

## Why It Matters

**Consequences of not fixing:**

- [x] **User Experience:** Users get misleading documentation, feature doesn't work as described
- [x] **Reliability:** Update system broken (missing scripts can't update Igris AI)
- [x] **Adoption:** Users won't trust "automatic" features if they don't work
- [x] **Maintainability:** Wrong architecture makes future improvements difficult
- [x] **Reputation:** v1.0.2 release has fundamental bugs found by first real user

**Impact:** High

First production test revealed:
1. install_shell_integration.sh not copied
2. igris_update.sh not copied
3. plugin_update.sh not copied
4. .claude/prompt.md doesn't work (wrong file)
5. No true auto-initialization

---

## Cleanup Steps

**How to pay off this debt:**

1. [x] Research Claude Code CLI conventions (DONE - user discovered CLAUDE.md + hooks)
2. [ ] Create `.claude/hooks/startup.sh` template
3. [ ] Create `CLAUDE.md` template with detection mechanism
4. [ ] Update `igris_init.sh` to create hooks
5. [ ] Remove `.claude/prompt.md` creation
6. [ ] Fix script copying (add missing 3 scripts)
7. [ ] Test in fresh installation
8. [ ] Update README.md with correct behavior
9. [ ] Update CHANGELOG.md (add v1.0.3 or correct v1.0.2)
10. [ ] Update ROADMAP.md with accurate description
11. [ ] Update GitHub release notes
12. [ ] Test in example project

---

## Benefits of Fixing

**What improves after cleanup:**

- ✅ True zero-configuration startup (no user action required)
- ✅ Welcome message before any user input (hooks auto-run)
- ✅ Accurate documentation matching actual behavior
- ✅ Complete script installation (update system works)
- ✅ Proper Claude Code CLI integration
- ✅ Detection mechanism ("Is Igris AI loaded?")
- ✅ Ships via git (committed hooks work for all users)
- ✅ Validated by real production usage

**Return on Investment:** High

This is the core v1.0.2 feature - must work correctly.

---

## Affected Areas

### Files to Create
- `scripts/templates/startup.sh.template` - NEW
- `scripts/templates/CLAUDE.md.template` - NEW

### Files to Modify
- `scripts/igris_init.sh` - Add hooks creation, fix script copying
- `README.md` - Correct automatic loading description
- `CHANGELOG.md` - Add v1.0.3 fixes
- `ROADMAP.md` - Update automatic loading section

### Files to Remove
- `.claude/prompt.md` creation (wrong approach)

### Count
**Total files affected:** 6
**Total new files:** 2
**Total lines to change:** ~500

---

## Testing

### Regression Testing
- [ ] All existing Igris AI workflows still work
- [ ] Brief registration works
- [ ] Session tracking works
- [ ] Plugin system works
- [ ] Update system works (after fixing script copying)

### New Feature Testing
- [ ] startup.sh runs automatically on `claude` command
- [ ] Welcome message appears before user input
- [ ] CLAUDE.md loads on first message
- [ ] Detection works ("Is Igris AI loaded?")
- [ ] Project summary accurate (briefs, status, blockers)
- [ ] Hooks ship via git (committed to repo)

### Verification
**How to verify cleanup is successful:**

1. Fresh installation in /tmp directory
2. Run `claude` - verify welcome message appears before typing
3. Send first message - verify Igris AI context loads
4. Ask "Is Igris AI loaded?" - verify detection works
5. Check all 6 scripts exist in scripts/
6. Git commit .claude/ - verify hooks are committed
7. Clone to new location - verify hooks work automatically

---

## Acceptance Criteria

**The debt is paid off when:**

1. [ ] `.claude/hooks/startup.sh` created by igris_init.sh
2. [ ] startup.sh shows welcome message automatically (before user input)
3. [ ] startup.sh displays accurate project summary
4. [ ] `CLAUDE.md` created with Igris AI initialization instructions
5. [ ] `CLAUDE.md` includes detection mechanism
6. [ ] All 6 scripts copied during installation
7. [ ] `.claude/prompt.md` creation removed
8. [ ] README.md accurately describes behavior
9. [ ] CHANGELOG.md documents fixes (v1.0.3)
10. [ ] ROADMAP.md reflects correct implementation
11. [ ] Tested in fresh installation
12. [ ] Tested in example project
13. [ ] No AI signatures in commits
14. [ ] Conventional commit format used

---

## References

**Coding Guidelines:**
- `ai/templates/commit_message.md` - No AI signatures rule
- `ai/prompts/claude_bootstrap.md` - Igris AI workflow

**Claude Code CLI Documentation:**
- CLAUDE.md - Context file (loaded on first message)
- .claude/hooks/ - Auto-run scripts (startup, prompt-submit)

**Related Briefs:**
- This is TD-001 (first technical debt brief)

**User Testing:**
- Real production test revealed all issues
- User provided correct Claude Code CLI conventions
- Hooks approach confirmed working

---

## Notes

### Discovery Process

This technical debt was discovered through first real-world production test. User found:
1. Missing scripts (install_shell_integration, igris_update, plugin_update)
2. .claude/prompt.md doesn't work
3. Ran `/init` and discovered CLAUDE.md convention
4. Researched and found hooks system for true auto-execution

### Correct Architecture

**Hooks System:**
- `.claude/hooks/startup.sh` - Runs when CLI starts (before any input)
- Shows welcome message
- Displays project summary
- Pure bash, fast execution

**Context File:**
- `CLAUDE.md` - Loaded when user sends first message
- Contains Igris AI initialization instructions
- Includes detection mechanism
- Can be enhanced with `/init` for project-specific analysis

**Ship via Git:**
- Both files committed to repo
- Clone/pull gets hooks automatically
- No user setup required

### Version Strategy

**Option A:** Update v1.0.2 release with corrections
**Option B:** Release v1.0.3 with fixes (recommended)

Recommendation: v1.0.3 because:
- Multiple significant bug fixes
- Implementation approach changed
- Clearer for users to "upgrade to v1.0.3"

---

**Created:** 2025-10-14
**Last Updated:** 2025-10-14
**Brief Owner:** Claude (AI Assistant)
