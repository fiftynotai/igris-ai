# FR-028: Install Scripts — Remote Brain & Dual-Mode Support

**Type:** Feature Request
**Priority:** P1-High
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Completed:** 2026-02-16
**Created:** 2026-02-16

---

## Feature Description

**What is the proposed feature?**

Update the Igris AI installation scripts (`igris_brain_init.sh`, `igris_install.sh`, `igris_init.sh`, `igris_migrate_to_v4.sh`) to support remote/HTTP brain configuration alongside the existing local stdio mode. Add the ability to configure `remote_brain` settings during installation, integrate the Crimson Arena dashboard into the install workflow, and investigate dual-mode (local + remote brain simultaneously).

**Why is this valuable?**

After FR-025 (VPS brain deployment) and FR-027 (Crimson Arena dashboard), the brain can run remotely and be visualized via the dashboard. However, the install scripts have no awareness of remote brain support — they only configure stdio (local) transport. Users must manually edit `~/.claude.json` and `~/.igris/config.json` to use a remote brain. This creates a fragmented setup experience and makes it impossible to run local and remote brain in parallel.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)
- [x] Contributors (extending Igris AI)
- [x] System (Igris AI itself)

### Pain Point Solved
**Current situation:**
- `igris_brain_init.sh` only registers the brain MCP server in stdio mode (local `~/.igris/memory/knowledge.db`)
- `config.json` generated during init has no `remote_brain` settings
- No script to switch between local and remote brain modes
- Cannot run local AND remote brain simultaneously (only one `igris-brain` entry in `~/.claude.json`)
- Dashboard (Crimson Arena) not integrated into install scripts
- No health check for the brain in project installers
- API key management for remote brain is entirely manual

**With this feature:**
- During installation, user can choose: local-only, remote-only, or dual-mode brain
- `remote_brain.url` and `remote_brain.api_key` configured automatically when remote mode selected
- `~/.claude.json` supports both `igris-brain-local` (stdio) and `igris-brain-remote` (HTTP) entries
- Dashboard install option included in setup workflow
- Health checks verify brain connectivity after configuration

---

## Use Cases

### Use Case 1: Fresh Install with Remote Brain
**Actor:** Developer setting up Igris AI for the first time
**Goal:** Configure Igris to use a remote VPS brain
**Steps:**
1. Run `./igris_brain_init.sh`
2. Script prompts: "Brain mode? [local/remote/dual]"
3. User selects "remote"
4. Script prompts for VPS URL and API key
5. Script registers `igris-brain` as HTTP transport in `~/.claude.json`
6. Script writes `remote_brain` block to `~/.igris/config.json`
7. Script runs health check against remote brain

**Expected Outcome:** Remote brain configured and verified, ready to use.

### Use Case 2: Upgrade Existing Local to Dual-Mode
**Actor:** Developer who already has local brain, wants to add remote
**Goal:** Add remote brain alongside existing local brain
**Steps:**
1. Run `./igris_brain_init.sh --add-remote`
2. Script prompts for VPS URL and API key
3. Script adds `igris-brain-remote` entry to `~/.claude.json` (keeps `igris-brain` as local)
4. Script adds `remote_brain` block to `~/.igris/config.json`
5. Script verifies both local and remote are accessible

**Expected Outcome:** Both local and remote brain available as separate MCP servers.

### Use Case 3: Switch Brain Mode
**Actor:** Developer wanting to toggle between local and remote
**Goal:** Quickly switch which brain is active
**Steps:**
1. Run `./igris_brain_switch.sh remote` (or `local` or `dual`)
2. Script updates `~/.claude.json` MCP entries accordingly
3. Script verifies new mode works

**Expected Outcome:** Brain mode switched without manual JSON editing.

---

## Technical Approach

### High-Level Design

1. **Dual MCP Registration:** Instead of one `igris-brain` entry in `~/.claude.json`, support two: `igris-brain` (local, stdio) and `igris-brain-remote` (HTTP). Claude Code can use both simultaneously since they have different names.

2. **Install Script Updates:** Add interactive prompts to `igris_brain_init.sh` for brain mode selection. Support `--local`, `--remote`, and `--dual` flags for non-interactive use.

3. **Config Generation:** Update `~/.igris/config.json` generation to include `remote_brain` settings when remote mode is selected.

4. **Mode Switching Script:** New `igris_brain_switch.sh` to enable/disable MCP entries in `~/.claude.json` without losing configuration.

5. **Dashboard Integration:** Add optional dashboard setup step to `igris_install.sh` — copy dashboard files, install Python deps, create local run script.

6. **Health Checks:** Add brain health verification to both init and project setup scripts.

### Components Affected

- `igris_brain_init.sh` — Add remote mode prompts, dual MCP registration, config.json remote_brain block
- `igris_install.sh` — Add optional dashboard setup step
- `igris_init.sh` — Add brain health check during project init
- `igris_migrate_to_v4.sh` — Add migration path for existing users to add remote brain
- `~/.igris/config.json` — Template updated with `remote_brain` section
- `~/.claude.json` — Support dual MCP entries (`igris-brain` + `igris-brain-remote`)

### API/Interface Design

**New CLI flags for igris_brain_init.sh:**
```bash
./igris_brain_init.sh                    # Interactive (prompts for mode)
./igris_brain_init.sh --local            # Local stdio only (current behavior)
./igris_brain_init.sh --remote URL KEY   # Remote HTTP only
./igris_brain_init.sh --dual URL KEY     # Both local and remote
./igris_brain_init.sh --add-remote URL KEY  # Add remote to existing local
```

**New script: igris_brain_switch.sh**
```bash
./igris_brain_switch.sh status   # Show current mode
./igris_brain_switch.sh local    # Switch to local only
./igris_brain_switch.sh remote   # Switch to remote only
./igris_brain_switch.sh dual     # Enable both
```

**Dual-mode ~/.claude.json structure:**
```json
{
  "mcpServers": {
    "igris-brain": {
      "command": "node",
      "args": ["~/.igris/mcp-server/dist/index.js"],
      "env": { "BRAIN_API_KEY": "..." }
    },
    "igris-brain-remote": {
      "type": "streamable-http",
      "url": "http://<VPS_IP>:3001/mcp",
      "headers": { "Authorization": "Bearer <API_KEY>" }
    }
  }
}
```

---

## Context & Inputs

### Dependencies
- [x] FR-022: VPS Remote Brain HTTP Transport (DONE)
- [x] FR-025: Deploy Brain MCP Server to VPS (DONE)
- [x] FR-027: Crimson Arena Unified Dashboard (DONE)
- [x] Existing install scripts in repo root

### Files to Create
- `igris_brain_switch.sh` — Mode switching utility

### Files to Modify
- `igris_brain_init.sh` — Add remote/dual mode support, config.json remote_brain generation
- `igris_install.sh` — Add optional dashboard setup step
- `igris_init.sh` — Add brain health check
- `igris_migrate_to_v4.sh` — Add migration path for remote brain
- `README.md` — Update installation section with new options

### Configuration Changes
- [x] `~/.igris/config.json` — Add `remote_brain` section to template
- [x] `~/.claude.json` — Support dual MCP entries

---

## Alternatives Considered

### Alternative 1: Single MCP Entry with Mode Flag
**Pros:**
- Simpler config (one entry)
- No naming confusion

**Cons:**
- Cannot use local and remote simultaneously
- Requires restart to switch modes
- Claude Code MCP config doesn't support mode flags natively

**Why not chosen:** Dual separate entries allows both brains active simultaneously, which is needed for sync and fallback.

### Alternative 2: Proxy Layer (Local Brain Forwards to Remote)
**Pros:**
- Single MCP entry, transparent forwarding
- Could merge local + remote data

**Cons:**
- Complex proxy logic
- Extra latency
- Single point of failure

**Why not chosen:** Over-engineered for current needs. Separate entries are simpler and let Claude Code handle routing.

---

## Constraints

### Technical Constraints
- Must be backward compatible (existing local-only installs still work)
- Must not break `~/.claude.json` for users without remote brain
- Shell scripts must work on macOS (zsh) and Linux (bash)
- API keys must never be displayed in logs or script output
- `jq` dependency acceptable (already used in existing scripts)

### UX Constraints
- Interactive prompts must have sensible defaults (local-only as default)
- Non-interactive flags for CI/automated setups
- Clear success/failure messages with next steps

### Out of Scope
- Automatic brain sync (covered by FR-023)
- VPS provisioning/deployment (covered by FR-025)
- Brain load balancing or failover
- GUI installer

---

## Tasks

### Pending
- [ ] Phase 1: Update `igris_brain_init.sh` — add `--local`/`--remote`/`--dual` flags
- [ ] Phase 1: Update `igris_brain_init.sh` — add interactive mode prompt
- [ ] Phase 1: Update `igris_brain_init.sh` — generate `remote_brain` block in config.json
- [ ] Phase 1: Update `igris_brain_init.sh` — register dual MCP entries in `~/.claude.json`
- [ ] Phase 1: Add health check verification (local and/or remote)
- [ ] Phase 2: Create `igris_brain_switch.sh` — mode switching utility
- [ ] Phase 3: Update `igris_install.sh` — add optional dashboard setup
- [ ] Phase 3: Update `igris_init.sh` — add brain health check during project init
- [ ] Phase 4: Update `igris_migrate_to_v4.sh` — add `--add-remote` migration path
- [ ] Phase 4: Update README.md installation section
- [ ] Test: Fresh install with each mode (local, remote, dual)
- [ ] Test: Upgrade existing local install to dual-mode
- [ ] Test: Mode switching with igris_brain_switch.sh

---

## Workflow State

**Phase:** REVIEWING
**Active Agent:** warden
**Retry Count:** 0

### Current Work
All 4 phases implemented. Syntax and shellcheck passed. Awaiting final review and commit.

### Next Steps
Team lead to review and commit changes.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|
| 2026-02-16 | architect | Plan implementation | 4-phase plan created |
| 2026-02-16 | forger | Phase 1: igris_brain_init.sh | CLI flags, interactive mode, dual MCP, health checks |
| 2026-02-16 | forger | Phase 2: igris_brain_switch.sh | New mode switching utility created |
| 2026-02-16 | forger | Phase 3: igris_install.sh + igris_init.sh | Dashboard setup + brain health checks |
| 2026-02-16 | forger | Phase 4: igris_migrate_to_v4.sh + README.md | --add-remote migration + docs |
| 2026-02-16 | sentinel | bash -n + shellcheck | All 5 scripts PASS |

### Blockers
None

---

## Acceptance Criteria

1. [ ] `igris_brain_init.sh --local` works identically to current behavior
2. [ ] `igris_brain_init.sh --remote URL KEY` configures remote-only brain
3. [ ] `igris_brain_init.sh --dual URL KEY` configures both local and remote
4. [ ] Interactive mode prompts for brain mode when no flags given
5. [ ] `~/.igris/config.json` includes `remote_brain` block when remote configured
6. [ ] `~/.claude.json` has correct MCP entries for selected mode
7. [ ] `igris_brain_switch.sh status` shows current mode accurately
8. [ ] `igris_brain_switch.sh` can switch between modes without data loss
9. [ ] Health check verifies brain connectivity after configuration
10. [ ] Existing local-only installations unaffected (backward compatible)
11. [ ] API keys never displayed in terminal output

---

## Test Plan

### Functional Tests

**Test Case 1: Fresh Local Install**
1. Remove existing brain config
2. Run `./igris_brain_init.sh --local`
**Expected Result:** Local stdio brain configured, health check passes, no remote_brain in config.json

**Test Case 2: Fresh Remote Install**
1. Remove existing brain config
2. Run `./igris_brain_init.sh --remote http://<VPS>:3001 <API_KEY>`
**Expected Result:** Remote HTTP brain configured, health check passes, remote_brain in config.json

**Test Case 3: Fresh Dual Install**
1. Remove existing brain config
2. Run `./igris_brain_init.sh --dual http://<VPS>:3001 <API_KEY>`
**Expected Result:** Both local and remote configured, both health checks pass

**Test Case 4: Add Remote to Existing Local**
1. Start with local-only install
2. Run `./igris_brain_init.sh --add-remote http://<VPS>:3001 <API_KEY>`
**Expected Result:** Remote added, local preserved, both functional

**Test Case 5: Mode Switching**
1. Start with dual mode
2. Run `./igris_brain_switch.sh local`
3. Verify only local active
4. Run `./igris_brain_switch.sh dual`
5. Verify both active
**Expected Result:** Modes switch correctly, inactive configs preserved but disabled

### Regression Tests
- [ ] Existing `igris_brain_init.sh` (no flags) still works as before
- [ ] `igris_install.sh` full install workflow unbroken
- [ ] `igris_init.sh` project init still functional
- [ ] No changes to brain-mcp-server itself

---

## Delivery

- [ ] Updated `igris_brain_init.sh` with multi-mode support
- [ ] New `igris_brain_switch.sh` utility
- [ ] Updated `igris_install.sh` with dashboard option
- [ ] Updated `igris_init.sh` with health checks
- [ ] Updated `igris_migrate_to_v4.sh` with remote migration
- [ ] Updated README.md installation section

---

## Notes

**Depends on:** FR-022, FR-025, FR-027 (all DONE)
**Enables:** Seamless multi-machine Igris deployments, easier onboarding

**Key Finding from Investigation:**
The current `~/.claude.json` only allows one MCP server per name. The dual-mode solution uses two separate names (`igris-brain` for local, `igris-brain-remote` for remote) so Claude Code treats them as independent MCP servers. Both can be active simultaneously — Claude Code will have access to tools from both, and the brain tools are identical so it can use either.

**Existing Install Scripts (reference):**
- `igris_brain_init.sh` (~215 lines) — Brain-specific init, registers MCP in `~/.claude.json`
- `igris_install.sh` (~276 lines) — Full Igris install (symlinks, hooks, brain init)
- `igris_init.sh` (~183 lines) — Per-project init (CLAUDE.md, briefs, session dirs)
- `igris_migrate_to_v4.sh` (~185 lines) — v3→v4 migration with brain setup
- `igris_brain_deploy.sh` (~68 lines) — VPS deployment via GitHub pull

---

**Created:** 2026-02-16
**Last Updated:** 2026-02-16
**Brief Owner:** Crimson (Fifty.ai)
