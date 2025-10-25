# TD-008: Add Privacy-Respecting Usage Metrics and Error Tracking

**Type:** Technical Debt
**Priority:** P3-Low
**Effort:** M-Medium (1-2d)
**Assignee:** AI Assistant
**Status:** Ready

---

## What is the Technical Debt?

**Current situation:**

Igris AI has **zero visibility** into how it's being used in the wild:
- How many users install Igris successfully?
- What are common failure points?
- Which scripts are used most?
- What errors do users encounter?
- Which features are valuable vs unused?
- Where do users get stuck?

**Why is it technical debt?**

- **Blind development** - Building features without knowing if they're used
- **No failure detection** - Can't identify broken installation flows
- **Poor prioritization** - Don't know which bugs affect most users
- **No success metrics** - Can't measure improvement over time

**Examples:**
```bash
# Current reality:
- User installs Igris → we don't know
- User hits bug → we don't know (unless they report it)
- User never uses feature X → we waste time maintaining it
- Installation fails on Ubuntu → we don't know it's Ubuntu-specific
```

---

## Why It Matters

**Consequences of not fixing:**

- [ ] **Maintainability:** Hard to justify maintenance without usage data
- [ ] **Readability:** (Not affected)
- [ ] **Performance:** Can't identify performance bottlenecks
- [ ] **Security:** Can't detect security-related failures
- [ ] **Scalability:** Can't plan infrastructure without growth data
- [x] **Developer Experience:** Can't improve UX without feedback

**Impact:** Low (but valuable long-term)

Metrics help us:
- Prioritize bugs (fix what affects most users)
- Measure success (adoption rate, retention)
- Identify pain points (where users struggle)
- Validate features (are they used?)

---

## Cleanup Steps

**How to pay off this debt:**

1. [ ] Design privacy-respecting metrics system
2. [ ] Implement opt-in analytics (user consent required)
3. [ ] Add local metrics collection (no phone-home)
4. [ ] Create aggregation scripts for insights
5. [ ] Add error tracking (anonymized)
6. [ ] Document in README (transparency)
7. [ ] Update CHANGELOG.md

---

## Benefits of Fixing

**What improves after cleanup:**

- ✅ **Data-driven decisions** - Build what users need
- ✅ **Bug prioritization** - Fix common issues first
- ✅ **Success tracking** - Measure adoption and retention
- ✅ **Pain point identification** - Know where users struggle
- ✅ **Feature validation** - See what's used vs ignored
- ✅ **Documentation improvement** - Fix docs where users get stuck
- ✅ **Trust** - Transparent, opt-in, privacy-first

**Return on Investment:** Medium (long-term value)

---

## Affected Areas

### Files to Create
- `.igris_metrics.json` - Local metrics file (gitignored)
- `scripts/igris_metrics.sh` - Metrics helper functions
- `scripts/analyze_metrics.sh` - Local analysis tool
- `docs/PRIVACY.md` - Privacy policy for metrics

### Files to Modify
- `scripts/igris_init.sh` - Add metrics opt-in prompt
- `scripts/plugin_install.sh` - Track plugin installs
- `.gitignore` - Ignore metrics files
- `README.md` - Document metrics (transparency)

### Count
**Total files affected:** 8 (4 new, 4 modified)
**Total lines to add:** ~300-400

---

## Privacy-First Design Principles

### 1. Opt-In Only (Never Opt-Out)
```bash
# First run prompt
read -p "Enable anonymous usage metrics to help improve Igris? [y/N]: " ENABLE_METRICS
if [[ "$ENABLE_METRICS" =~ ^[Yy]$ ]]; then
  echo '{"enabled": true, "anonymous_id": "'$(uuidgen)'"}' > .igris_metrics.json
else
  echo '{"enabled": false}' > .igris_metrics.json
fi
```

### 2. Local-First (No Phone-Home)
```bash
# Metrics stored locally only
{
  "enabled": true,
  "anonymous_id": "uuid-goes-here",
  "events": [
    {"type": "init", "timestamp": "2025-10-25T10:30:00Z", "version": "2.0.0"},
    {"type": "plugin_install", "plugin": "igris-ai-persona", "timestamp": "..."}
  ]
}

# User controls when/if to share
# Future: Optional "upload metrics" command
```

### 3. Anonymous Only
```bash
# ✅ COLLECT
- Installation count
- Script usage frequency
- Error types (anonymized)
- Platform (macOS/Linux)
- Igris AI version

# ❌ NEVER COLLECT
- User identity
- Project names
- File paths
- Code content
- IP addresses
- Personal information
```

### 4. Transparent Documentation
```markdown
# README.md section

## Privacy & Metrics

Igris AI can collect **anonymous usage metrics** to help improve the product.

**What we collect (if you opt-in):**
- Installation events (count, version, platform)
- Script usage (which scripts run)
- Anonymous error logs (error type, not content)

**What we NEVER collect:**
- Your identity
- Your project names or code
- File paths or content
- IP addresses

**How it works:**
- **Opt-in only** - You choose during installation
- **Local storage** - Data stays on your machine
- **Your control** - You choose if/when to share
- **Disable anytime** - Delete .igris_metrics.json

**Why metrics help:**
- Prioritize bug fixes (fix common issues first)
- Improve documentation (see where users struggle)
- Validate features (build what's used)
```

---

## Metrics to Collect

### Installation Metrics
```json
{
  "type": "igris_init",
  "timestamp": "2025-10-25T10:30:00Z",
  "version": "2.0.0",
  "platform": "darwin",
  "python_available": true,
  "jq_available": false,
  "success": true
}
```

### Script Usage
```json
{
  "type": "script_run",
  "script": "plugin_install",
  "timestamp": "2025-10-25T10:35:00Z",
  "success": true,
  "duration_ms": 4521
}
```

### Error Events
```json
{
  "type": "error",
  "script": "plugin_install",
  "error_type": "missing_dependency",
  "dependency": "python3",
  "timestamp": "2025-10-25T10:40:00Z"
}
```

### Feature Usage
```json
{
  "type": "feature_use",
  "feature": "persona_plugin",
  "timestamp": "2025-10-25T10:45:00Z"
}
```

---

## Testing

### Regression Testing
- [ ] All scripts work with metrics enabled
- [ ] All scripts work with metrics disabled
- [ ] No functionality changes

### Verification
**How to verify cleanup is successful:**

1. Install with metrics disabled → no .igris_metrics.json
2. Install with metrics enabled → .igris_metrics.json created
3. Run scripts → events logged locally
4. Check file contents → no personal data
5. Delete metrics file → still works normally

---

## Acceptance Criteria

**The debt is paid off when:**

1. [ ] Opt-in prompt during installation
2. [ ] Local metrics file created (if opted in)
3. [ ] Key events tracked (init, plugin ops, errors)
4. [ ] No personal data collected
5. [ ] Privacy policy documented (docs/PRIVACY.md)
6. [ ] README explains metrics transparently
7. [ ] Can disable anytime (delete file)
8. [ ] .gitignore includes metrics files

---

## Implementation Phases

### Phase 1: Local Collection (v2.1.0)
- Opt-in prompt
- Local .igris_metrics.json storage
- Track key events
- Privacy documentation

### Phase 2: Analysis Tools (v2.2.0)
- Local analysis script
- Show user their own metrics
- Export capability

### Phase 3: Optional Sharing (Future)
- User-controlled upload
- Aggregated dashboard
- Public metrics (adoption, growth)

**Start with Phase 1 only** - Keep it simple.

---

## Alternative: No Metrics

**If we decide NOT to implement metrics:**

**Pros:**
- ✅ Simpler codebase
- ✅ No privacy concerns
- ✅ Less maintenance

**Cons:**
- ❌ Blind to usage patterns
- ❌ Can't prioritize effectively
- ❌ No success measurement
- ❌ Missed optimization opportunities

**Decision:** Implement Phase 1 (local-only, opt-in) as compromise.

---

## References

**Privacy-First Examples:**
- [Homebrew Analytics](https://docs.brew.sh/Analytics) - Opt-in, anonymous
- [Volta Metrics](https://docs.volta.sh/advanced/hooks) - Local-first
- [Telemetry Specification](https://telemetry.shafranov.com/) - Best practices

**Best Practices:**
- GDPR compliance (even if not required)
- Transparency (clear documentation)
- User control (opt-in, disable anytime)
- Minimal collection (only what's needed)

**Related Briefs:**
- TD-005 - Automated Testing (metrics help prioritize test coverage)
- TD-007 - Coding Guidelines (document metrics patterns)

---

## Notes

### Why P3-Low Priority?

This is valuable long-term but not urgent because:
- We're still early (small user base)
- Can gather feedback through GitHub issues
- Critical bugs found through testing (TD-005)
- Focus on quality first, metrics second

**Raise priority when:**
- User base grows significantly
- Multiple similar bug reports (need to prioritize)
- Want to measure impact of improvements
- Considering paid features (need usage data)

### Example Insights

With metrics, we could learn:
```
📊 Igris AI Usage Report (Last 30 Days)

Installations: 1,234
  - macOS: 856 (69%)
  - Linux: 378 (31%)

Most Used Scripts:
  1. igris_init.sh (1,234 runs)
  2. plugin_install.sh (456 runs)
  3. igris_update.sh (123 runs)

Common Errors:
  1. python3: command not found (89 instances)
     → Fix: Better error message (TD-004)
  2. plugin.json not found (23 instances)
     → Fix: Better docs on plugin structure
  3. Permission denied (12 instances)
     → Fix: Add permission checks to scripts

Least Used Features:
  - persona_mask.sh (only 5 runs)
     → Consider: Better docs or remove feature?
```

These insights drive better decisions.

---

**Created:** 2025-10-25
**Last Updated:** 2025-10-25
**Brief Owner:** Igris AI Self-Audit
