# BR-013: Preserve Custom Tier 5 Agents During Update

**Type:** Bug Fix
**Priority:** P2-Medium
**Effort:** S-Small (< 4h)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2025-12-24
**Completed:** 2025-12-24

---

## Problem

When running `igris_update.sh`, the script overwrites `.claude/agents/manifest.yaml` entirely with the remote version. This causes user-created Tier 5 custom agents to be removed from the manifest, even though their `.md` files are preserved.

**Current behavior (Line 299):**
```bash
cp "$TEMP_DIR/.claude/agents/manifest.yaml" .claude/agents/ 2>/dev/null || true
```

This replaces the entire manifest, losing any custom agent entries.

---

## Goal

Merge the remote manifest.yaml with local custom agents, preserving any Tier 5 entries that exist locally but not in the remote repo.

**Expected behavior:**
1. Fetch remote manifest.yaml
2. Identify local Tier 5 agents not in remote
3. Merge local Tier 5 agents into remote manifest
4. Save merged result
5. Update agent_count accordingly

---

## Solution

Use Python to merge YAML files, preserving local Tier 5 custom agents:

```python
import yaml

# Load both manifests
with open('local_manifest.yaml') as f:
    local = yaml.safe_load(f)
with open('remote_manifest.yaml') as f:
    remote = yaml.safe_load(f)

# Find local Tier 5 agents not in remote
local_tier5 = [a for a in local.get('agents', []) if a.get('tier') == 5]
remote_names = {a['name'] for a in remote.get('agents', [])}
custom_agents = [a for a in local_tier5 if a['name'] not in remote_names]

# Merge
remote['agents'].extend(custom_agents)
remote['metadata']['agent_count'] = len(remote['agents'])

# Save
with open('merged_manifest.yaml', 'w') as f:
    yaml.dump(remote, f, default_flow_style=False)
```

---

## Tasks

### Pending
_(none)_

### In Progress
_(none)_

### Completed
- [x] Create brief (completed: 2025-12-24)
- [x] Implement manifest merge in igris_update.sh (completed: 2025-12-24)

---

## Acceptance Criteria

1. [x] Brief created
2. [x] igris_update.sh merges manifests instead of replacing
3. [x] User's Tier 5 custom agents preserved after update
4. [x] agent_count updated correctly after merge
5. [x] Works with Python 3 (uses regex, no PyYAML needed)

---

**Created:** 2025-12-24
**Brief Owner:** Crimson (Igris AI)
