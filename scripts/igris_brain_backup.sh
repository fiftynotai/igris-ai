#!/bin/bash
set -euo pipefail

# Description: Back up the Igris Brain knowledge database
# Usage: igris_brain_backup.sh [backup_dir]
# Dependencies: sqlite3
# Exit codes:
#   0 - Success (backup created)
#   1 - Error (DB not found, sqlite3 missing, write failure)

BRAIN_DIR="${IGRIS_BRAIN_DIR:-$HOME/.igris}"
DB_FILE="$BRAIN_DIR/memory/knowledge.db"
DEFAULT_BACKUP_DIR="$BRAIN_DIR/backups"
BACKUP_DIR="${1:-$DEFAULT_BACKUP_DIR}"
MAX_BACKUPS=5

# ============================================================
# Functions
# ============================================================

print_usage() {
  echo "Usage: igris_brain_backup.sh [backup_dir]"
  echo ""
  echo "Backs up ~/.igris/memory/knowledge.db to a timestamped file."
  echo ""
  echo "Arguments:"
  echo "  backup_dir   Directory to store backups (default: ~/.igris/backups/)"
  echo ""
  echo "Options:"
  echo "  -h, --help   Show this help message"
  echo ""
  echo "Examples:"
  echo "  igris_brain_backup.sh                    # Backup to default location"
  echo "  igris_brain_backup.sh /tmp/brain-backup  # Backup to custom directory"
}

check_prerequisites() {
  if ! command -v sqlite3 &> /dev/null; then
    echo "ERROR: sqlite3 is not installed."
    echo "  macOS:  brew install sqlite3"
    echo "  Ubuntu: sudo apt install sqlite3"
    exit 1
  fi

  if [ ! -f "$DB_FILE" ]; then
    echo "ERROR: Knowledge database not found at $DB_FILE"
    echo "  Run igris_brain_init.sh first to create the brain."
    exit 1
  fi
}

rotate_old_backups() {
  local dir="$1"
  local count

  # Count existing backups (knowledge_*.db files only)
  count=$(find "$dir" -maxdepth 1 -name "knowledge_*.db" -type f 2>/dev/null | wc -l | tr -d ' ')

  if [ "$count" -ge "$MAX_BACKUPS" ]; then
    echo "  Rotating old backups (keeping last $MAX_BACKUPS)..."
    # List by modification time (oldest first), remove excess
    local excess=$((count - MAX_BACKUPS + 1))
    find "$dir" -maxdepth 1 -name "knowledge_*.db" -type f -print0 \
      | xargs -0 ls -t \
      | tail -n "$excess" \
      | while IFS= read -r old_backup; do
          rm -f "$old_backup"
          echo "    Removed: $(basename "$old_backup")"
        done
  fi
}

# ============================================================
# Main
# ============================================================

# Handle help flag
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  print_usage
  exit 0
fi

echo "Igris AI - Brain Database Backup"
echo "=================================="
echo ""

check_prerequisites

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Verify write permissions
if [ ! -w "$BACKUP_DIR" ]; then
  echo "ERROR: No write permission on $BACKUP_DIR"
  exit 1
fi

# Generate timestamped filename
TIMESTAMP=$(date -u +"%Y-%m-%d_%H%M%S")
BACKUP_FILE="$BACKUP_DIR/knowledge_${TIMESTAMP}.db"

echo "  Source:  $DB_FILE"
echo "  Target:  $BACKUP_FILE"
echo ""

# Integrity check before backup
echo "  Running integrity check..."
INTEGRITY=$(sqlite3 "$DB_FILE" "PRAGMA integrity_check;" 2>/dev/null || echo "failed")
if [ "$INTEGRITY" != "ok" ]; then
  echo "  WARNING: Database integrity check returned: $INTEGRITY"
  echo "  Proceeding with backup anyway (you may want to investigate)."
  echo ""
fi

# Use sqlite3 .backup for a safe online backup (handles WAL correctly)
echo "  Creating backup..."
if sqlite3 "$DB_FILE" ".backup '$BACKUP_FILE'" 2>/dev/null; then
  echo "  [ok] Backup created: $BACKUP_FILE"
else
  echo "  [FAIL] sqlite3 .backup command failed."
  echo "  Falling back to file copy..."
  if cp "$DB_FILE" "$BACKUP_FILE"; then
    echo "  [ok] Backup created via file copy: $BACKUP_FILE"
  else
    echo "  [FAIL] Backup failed."
    exit 1
  fi
fi

# Verify the backup
BACKUP_INTEGRITY=$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" 2>/dev/null || echo "failed")
if [ "$BACKUP_INTEGRITY" = "ok" ]; then
  echo "  [ok] Backup integrity verified."
else
  echo "  [WARN] Backup integrity check returned: $BACKUP_INTEGRITY"
fi

# Show backup size
BACKUP_SIZE=$(ls -lh "$BACKUP_FILE" | awk '{print $5}')
echo "  [ok] Backup size: $BACKUP_SIZE"

# Rotate old backups
rotate_old_backups "$BACKUP_DIR"

echo ""
echo "Backup complete."
echo "  Location: $BACKUP_FILE"
echo "  Restore:  igris_brain_restore.sh $BACKUP_FILE"
echo ""
