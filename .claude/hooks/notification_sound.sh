#!/bin/bash
set -e

# Description: Notification hook for Claude Code lifecycle integration.
#              Plays macOS/Linux notification sounds and shows system notifications
#              when Claude needs user attention (permission prompts, idle input).
# Usage: Called automatically by Claude Code on Notification/Stop events. Reads JSON from stdin.
# Dependencies: afplay (macOS) or paplay (Linux), osascript (macOS) or notify-send (Linux)
# Exit codes:
#   0 - Always (hooks must never fail)

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
cd "$PROJECT_DIR"

# Configuration (environment variable overrides)
NOTIFY_ENABLED="${CLAUDE_NOTIFY_ENABLED:-1}"
NOTIFY_SOUND="${CLAUDE_NOTIFY_SOUND:-1}"
NOTIFY_VOLUME="${CLAUDE_NOTIFY_VOLUME:-0.7}"
NOTIFY_COOLDOWN="${CLAUDE_NOTIFY_COOLDOWN:-10}"
NOTIFY_ON_STOP="${CLAUDE_NOTIFY_ON_STOP:-0}"

# Early exit if disabled
if [ "$NOTIFY_ENABLED" != "1" ]; then
  exit 0
fi

# Read stdin
INPUT=$(cat)

# Parse hook event name, notification_type, message, title from JSON
parse_input() {
  if command -v jq &> /dev/null; then
    HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // ""' 2>/dev/null) || HOOK_EVENT=""
    NOTIFICATION_TYPE=$(echo "$INPUT" | jq -r '.notification_type // ""' 2>/dev/null) || NOTIFICATION_TYPE=""
    NOTIFY_MESSAGE=$(echo "$INPUT" | jq -r '.message // ""' 2>/dev/null) || NOTIFY_MESSAGE=""
    NOTIFY_TITLE=$(echo "$INPUT" | jq -r '.title // ""' 2>/dev/null) || NOTIFY_TITLE=""
  else
    local py_output
    py_output=$(echo "$INPUT" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    print(data.get('hook_event_name', ''))
    print(data.get('notification_type', ''))
    print(data.get('message', ''))
    print(data.get('title', ''))
except Exception:
    print('')
    print('')
    print('')
    print('')
" 2>/dev/null) || {
      HOOK_EVENT=""
      NOTIFICATION_TYPE=""
      NOTIFY_MESSAGE=""
      NOTIFY_TITLE=""
      return
    }
    HOOK_EVENT=$(echo "$py_output" | sed -n '1p')
    NOTIFICATION_TYPE=$(echo "$py_output" | sed -n '2p')
    NOTIFY_MESSAGE=$(echo "$py_output" | sed -n '3p')
    NOTIFY_TITLE=$(echo "$py_output" | sed -n '4p')
  fi
}

# Check cooldown — returns 0 if OK to notify, 1 if within cooldown
check_cooldown() {
  local notification_type="$1"
  local cooldown_file="/tmp/igris_notify_cooldown_${notification_type}"
  local now
  now=$(date +%s)

  if [ -f "$cooldown_file" ]; then
    local last_time
    last_time=$(cat "$cooldown_file" 2>/dev/null) || last_time=0
    local diff=$((now - last_time))
    if [ "$diff" -lt "$NOTIFY_COOLDOWN" ]; then
      return 1
    fi
  fi

  echo "$now" > "$cooldown_file" 2>/dev/null || true
  return 0
}

# Map notification type to sound name
resolve_sound() {
  local notification_type="$1"
  case "$notification_type" in
    permission_prompt) echo "Submarine" ;;
    idle_prompt)       echo "Ping" ;;
    stop)              echo "Hero" ;;
    *)                 echo "Tink" ;;
  esac
}

# Play sound (cross-platform, non-blocking)
play_sound() {
  local sound_name="$1"

  case "$OSTYPE" in
    darwin*)
      local sound_path="/System/Library/Sounds/${sound_name}.aiff"
      if [ -f "$sound_path" ]; then
        afplay -v "$NOTIFY_VOLUME" "$sound_path" &
        disown 2>/dev/null || true
      else
        printf '\a'
      fi
      ;;
    linux*)
      if command -v paplay &> /dev/null; then
        local linux_sound=""
        case "$sound_name" in
          Submarine) linux_sound="/usr/share/sounds/freedesktop/stereo/bell.oga" ;;
          Ping)      linux_sound="/usr/share/sounds/freedesktop/stereo/complete.oga" ;;
          Hero)      linux_sound="/usr/share/sounds/freedesktop/stereo/dialog-information.oga" ;;
          *)         linux_sound="/usr/share/sounds/freedesktop/stereo/message.oga" ;;
        esac
        if [ -f "$linux_sound" ]; then
          paplay "$linux_sound" &
          disown 2>/dev/null || true
        else
          printf '\a'
        fi
      else
        printf '\a'
      fi
      ;;
    *)
      printf '\a'
      ;;
  esac
}

# Show system notification (cross-platform)
show_notification() {
  local title="${1:-Claude Code}"
  local message="${2:-Needs your attention}"

  case "$OSTYPE" in
    darwin*)
      if command -v terminal-notifier &> /dev/null; then
        terminal-notifier -title "$title" -message "$message" -group "claude-code" -sound "" &
        disown 2>/dev/null || true
      else
        osascript -e "display notification \"$message\" with title \"$title\"" 2>/dev/null || true
      fi
      ;;
    linux*)
      if command -v notify-send &> /dev/null; then
        notify-send "$title" "$message" --expire-time=5000 2>/dev/null || true
      fi
      ;;
  esac
}

# Build human-friendly notification message
resolve_notification_message() {
  local notification_type="$1"
  local raw_message="$2"
  if [ -n "$raw_message" ]; then
    echo "$raw_message"
    return
  fi
  case "$notification_type" in
    permission_prompt) echo "Claude needs permission to use a tool" ;;
    idle_prompt)       echo "Claude is waiting for your input" ;;
    stop)              echo "Claude has finished its response" ;;
    *)                 echo "Claude needs your attention" ;;
  esac
}

# Main execution
main() {
  parse_input

  # Determine effective notification type
  local effective_type=""

  if [ "$HOOK_EVENT" = "Stop" ]; then
    if [ "$NOTIFY_ON_STOP" != "1" ]; then
      exit 0
    fi
    effective_type="stop"
  elif [ "$HOOK_EVENT" = "Notification" ]; then
    effective_type="${NOTIFICATION_TYPE:-unknown}"
  fi

  if [ -z "$effective_type" ]; then
    exit 0
  fi

  # Cooldown check
  if ! check_cooldown "$effective_type"; then
    exit 0
  fi

  # Resolve sound and message
  local sound_name
  sound_name=$(resolve_sound "$effective_type")

  local message
  message=$(resolve_notification_message "$effective_type" "$NOTIFY_MESSAGE")

  local title="${NOTIFY_TITLE:-Claude Code}"

  # Play sound (if enabled)
  if [ "$NOTIFY_SOUND" = "1" ]; then
    play_sound "$sound_name"
  fi

  # Show system notification
  show_notification "$title" "$message"

  exit 0
}

# Run main, catch any unexpected errors
main "$@" 2>/dev/null || true
exit 0
