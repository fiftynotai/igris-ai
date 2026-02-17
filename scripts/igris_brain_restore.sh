#!/bin/bash
set -euo pipefail

# Description: Restore the Igris Brain knowledge database from a backup
# Usage: igris_brain_restore.sh <backup_file>
# Dependencies: sqlite3
# Exit codes:
#   0 - Success (database restored)
#   1 - Error (invalid backup, missing file, sqlite3 missing)

BRAIN_DIR="${IGRIS_BRAIN_DIR:-$HOME/.igris}"
DB_FILE="$BRAIN_DIR/memory/knowledge.db"

# ============================================================
# Functions
# ============================================================

print_usage() {
  echo "Usage: igris_brain_restore.sh <backup_file>"
  echo ""
  echo "Restores ~/.igris/memory/knowledge.db from a backup file."
  echo "A safety backup of the current DB is created before overwriting."
  echo ""
  echo "Arguments:"
  echo "  backup_file  Path to the .db backup file to restore"
  echo ""
  echo "Options:"
  echo "  -h, --help   Show this help message"
  echo ""
  echo "Examples:"
  echo "  igris_brain_restore.sh ~/.igris/backups/knowledge_2026-02-17_120000.db"
}

check_prerequisites() {
  if ! command -v sqlite3 &> /dev/null; then
    echo "ERROR: sqlite3 is not installed."
    echo "  macOS:  brew install sqlite3"
    echo "  Ubuntu: sudo apt install sqlite3"
    exit 1
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

BACKUP_FILE="${1:-}"

if [ -z "$BACKUP_FILE" ]; then
  echo "ERROR: No backup file specified."
  echo ""
  print_usage
  exit 1
fi

echo "Igris AI - Brain Database Restore"
echo "===================================="
echo ""

check_prerequisites

# Validate backup file exists
if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: $BACKUP_FILE"
  exit 1
fi

# Validate backup is a valid SQLite database
echo "  Validating backup file..."
if ! sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" > /dev/null 2>&1; then
  echo "  [FAIL] File is not a valid SQLite database: $BACKUP_FILE"
  exit 1
fi

BACKUP_INTEGRITY=$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" 2>/dev/null)
if [ "$BACKUP_INTEGRITY" != "ok" ]; then
  echo "  [FAIL] Backup integrity check failed: $BACKUP_INTEGRITY"
  exit 1
fi

# Verify backup has expected tables
TABLE_COUNT=$(sqlite3 "$BACKUP_FILE" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';" 2>/dev/null || echo "0")
if [ "$TABLE_COUNT" -eq 0 ]; then
  echo "  [FAIL] Backup contains no tables. This does not appear to be a knowledge.db backup."
  exit 1
fi

echo "  [ok] Backup is a valid SQLite database ($TABLE_COUNT tables)."
echo ""

# Show backup info
BACKUP_SIZE=$(ls -lh "$BACKUP_FILE" | awk '{print $5}')
echo "  Backup file:   $BACKUP_FILE"
echo "  Backup size:   $BACKUP_SIZE"
echo "  Target:        $DB_FILE"
echo ""

# Ensure brain memory directory exists
mkdir -p "$BRAIN_DIR/memory"

# Create safety backup of current DB before overwriting
if [ -f "$DB_FILE" ]; then
  SAFETY_TIMESTAMP=$(date -u +"%Y-%m-%d_%H%M%S")
  SAFETY_BACKUP="$BRAIN_DIR/memory/knowledge_pre_restore_${SAFETY_TIMESTAMP}.db"
  echo "  Creating safety backup of current database..."
  if cp "$DB_FILE" "$SAFETY_BACKUP"; then
    echo "  [ok] Safety backup: $SAFETY_BACKUP"
  else
    echo "  [FAIL] Could not create safety backup. Aborting restore."
    exit 1
  fi
else
  echo "  No existing database found. Proceeding with restore."
fi

# Restore the backup
echo ""
echo "  Restoring database..."
if cp "$BACKUP_FILE" "$DB_FILE"; then
  echo "  [ok] Database restored."
else
  echo "  [FAIL] Restore failed."
  exit 1
fi

# Re-apply WAL mode (idempotent)
sqlite3 "$DB_FILE" "PRAGMA journal_mode=WAL;" > /dev/null 2>&1 || true

# Verify restored database
RESTORED_INTEGRITY=$(sqlite3 "$DB_FILE" "PRAGMA integrity_check;" 2>/dev/null || echo "failed")
if [ "$RESTORED_INTEGRITY" = "ok" ]; then
  echo "  [ok] Restored database integrity verified."
else
  echo "  [WARN] Restored database integrity: $RESTORED_INTEGRITY"
fi

RESTORED_TABLE_COUNT=$(sqlite3 "$DB_FILE" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';" 2>/dev/null || echo "0")
echo "  [ok] Restored database: $RESTORED_TABLE_COUNT tables"

echo ""
echo "Restore complete."
echo "  Database: $DB_FILE"
if [ -n "${SAFETY_BACKUP:-}" ]; then
  echo "  Rollback: cp $SAFETY_BACKUP $DB_FILE"
fi
echo ""
