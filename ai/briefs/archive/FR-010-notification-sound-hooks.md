# FR-010: Notification Sound Hooks (Attention Alerts)

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** S-Small (< 1d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-09
**Completed:** 2026-02-09

---

## Feature Description

**What is the proposed feature?**

Play a notification sound and show a system notification when the main agent needs user attention — permission prompts, idle input, or task completion. Uses Claude Code's `Notification` and `Stop` hooks to trigger macOS native alerts.

**Why is this valuable?**

When Claude Code is running long tasks (HUNT workflows, multi-agent builds), developers often switch to other windows. Without notifications, they miss permission prompts and the agent sits idle waiting. A sound alert brings them back immediately, reducing wasted time.

---

## User Value

### Who Benefits?
- [x] Developers (building with Igris AI)

### Pain Point Solved
**Current situation:** When Claude needs permission or finishes a task, there's no audible/visual alert outside the terminal. Developers must keep the terminal visible or manually check back.

**With this feature:** A distinct notification sound plays and a macOS notification appears when Claude needs attention. Different sounds for different events (permission = urgent, completion = success). Configurable via environment variables.

---

## Technical Approach

### Hook Events to Capture

| Hook | Notification Type | Sound | Purpose |
|------|-------------------|-------|---------|
| `Notification` | `permission_prompt` | Submarine.aiff | Claude needs permission for a tool |
| `Notification` | `idle_prompt` | Ping.aiff | Input idle for 60+ seconds |
| `Stop` | _(all)_ | Hero.aiff | Main agent finished a response |

### Implementation

**Single script:** `.claude/hooks/notification_sound.sh`

```
Input (stdin JSON) -> Parse notification_type -> Cooldown check -> Play sound + System notification
```

### macOS Native Approach (No Dependencies)

1. **Sound:** `afplay /System/Library/Sounds/<name>.aiff &` (background, non-blocking)
2. **Notification:** `osascript -e 'display notification "message" with title "Claude Code" sound name "sound"'`
3. **Fallback:** Terminal bell `printf '\a'` if sounds unavailable

### Enhanced Approach (Optional Dependency)

If `terminal-notifier` is installed (`brew install terminal-notifier`):
- Clickable notifications that focus the terminal
- Custom icon support
- Notification grouping (replaces previous notification)

### Configuration via Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_NOTIFY_ENABLED` | `1` | Enable/disable all notifications |
| `CLAUDE_NOTIFY_SOUND` | `1` | Enable/disable sound (keep visual notification) |
| `CLAUDE_NOTIFY_VOLUME` | `0.7` | Sound volume (0.0 - 1.0) |
| `CLAUDE_NOTIFY_COOLDOWN` | `10` | Seconds between notifications (anti-spam) |
| `CLAUDE_NOTIFY_ON_STOP` | `0` | Notify on every Stop event (noisy, off by default) |

### Cooldown Mechanism

Prevent notification spam during rapid permission prompts:
- Store last notification timestamp in `/tmp/igris_notify_cooldown`
- Skip notification if within cooldown window
- Different cooldowns per notification type (permission: 5s, stop: 30s)

### Cross-Platform Support

```bash
case "$OSTYPE" in
  darwin*)  # macOS: afplay + osascript
  linux*)   # Linux: paplay + notify-send
esac
```

### Files to Create/Modify

- `.claude/hooks/notification_sound.sh` — New notification hook script
- `.claude/settings.json` — Add Notification hook entries

### settings.json Changes

```json
{
  "Notification": [
    {
      "matcher": "permission_prompt|idle_prompt",
      "hooks": [
        {
          "type": "command",
          "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/notification_sound.sh",
          "timeout": 5
        }
      ]
    }
  ]
}
```

---

## Constraints

### Technical Constraints
- Hook must complete in < 5 seconds (Claude Code timeout)
- Sound playback must be non-blocking (background `&`)
- Must not interfere with existing hooks on same events
- Must gracefully handle missing sound files or disabled audio
- Must exit 0 always (hook failures should not block Claude)

### Out of Scope
- Custom sound file uploads (just use system sounds)
- Per-agent notification sounds
- Mobile/remote notifications
- Slack/Discord integration

---

## Acceptance Criteria

1. [ ] Sound plays when Claude asks for permission (Notification: permission_prompt)
2. [ ] Sound plays when input is idle 60+ seconds (Notification: idle_prompt)
3. [ ] macOS system notification appears with message context
4. [ ] Notifications respect cooldown (no spam on rapid permission prompts)
5. [ ] Configurable via environment variables (enable/disable, volume, cooldown)
6. [ ] Non-blocking — sound plays in background, hook exits immediately
7. [ ] Graceful degradation — works without terminal-notifier, falls back to afplay+osascript
8. [ ] Linux support via notify-send + paplay

---

## Test Plan

### Functional Tests

**Test Case 1: Permission notification**
1. Run Claude Code with notification hook active
2. Trigger a tool that requires permission
3. Verify sound plays and notification appears

**Test Case 2: Cooldown**
1. Trigger two permission prompts within 5 seconds
2. Verify only the first produces a notification

**Test Case 3: Disable via env**
1. Set `CLAUDE_NOTIFY_ENABLED=0`
2. Trigger permission prompt
3. Verify no sound or notification

**Test Case 4: Volume control**
1. Set `CLAUDE_NOTIFY_VOLUME=0.3`
2. Trigger notification
3. Verify sound is quieter

---

## Notes

- macOS system sounds are at `/System/Library/Sounds/` — no installation needed
- `afplay` supports `-v` flag for volume control (0.0 to 1.0)
- `terminal-notifier` is optional but recommended for clickable notifications: `brew install terminal-notifier`
- The `Notification` hook provides `notification_type` field to distinguish between permission_prompt, idle_prompt, auth_success, etc.
- Consider adding Stop hook notification as opt-in (`CLAUDE_NOTIFY_ON_STOP=1`) for task completion alerts

---

**Created:** 2026-02-09
**Last Updated:** 2026-02-09
**Brief Owner:** Fifty.ai
