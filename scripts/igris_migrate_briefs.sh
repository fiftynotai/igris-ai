#!/bin/bash
set -euo pipefail

# Description: Migrate project-local briefs and session files into the brain DB
# Usage: igris_migrate_briefs.sh [project_path]
#   If project_path provided: migrate only that project
#   If no args: migrate all registered projects
# Dependencies: sqlite3, python3
# Exit codes:
#   0 - Success
#   1 - Error (brain not found, dependency missing)

main() {

# ============================================================
# Dependency validation
# ============================================================

if ! command -v sqlite3 &> /dev/null; then
  echo "Error: sqlite3 is required but not installed"
  echo ""
  echo "Install sqlite3:"
  echo "  macOS:  brew install sqlite3"
  echo "  Ubuntu: sudo apt install sqlite3"
  exit 1
fi

if ! command -v python3 &> /dev/null; then
  echo "Error: python3 is required but not installed"
  echo ""
  echo "Install Python 3:"
  echo "  macOS:  brew install python3"
  echo "  Ubuntu: sudo apt install python3"
  exit 1
fi

# ============================================================
# Configuration
# ============================================================

BRAIN_DIR="$HOME/.igris"
DB_PATH="$BRAIN_DIR/memory/knowledge.db"

if [ ! -d "$BRAIN_DIR" ]; then
  echo "Error: Brain not found at $BRAIN_DIR"
  echo "Run igris_brain_init.sh first."
  exit 1
fi

if [ ! -f "$DB_PATH" ]; then
  echo "Error: Brain database not found at $DB_PATH"
  echo "Run igris_brain_init.sh first."
  exit 1
fi

echo "Igris AI - Brief & Session Migration"
echo "======================================"
echo ""

# Ensure required tables exist (schema v6 + v7)
# These tables are normally created by brain-mcp-server, but the migration
# script may run before the MCP server has been started.
python3 -c "
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
db.execute('PRAGMA busy_timeout = 5000;')
db.execute('PRAGMA journal_mode = WAL;')

db.execute('''
    CREATE TABLE IF NOT EXISTS brief_files (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        brief_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project, brief_id)
    )
''')
db.execute('CREATE INDEX IF NOT EXISTS idx_brief_files_project ON brief_files(project)')

db.execute('''
    CREATE TABLE IF NOT EXISTS session_files (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        filename TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project, filename)
    )
''')
db.execute('CREATE INDEX IF NOT EXISTS idx_session_files_project ON session_files(project)')

db.execute('''
    CREATE TABLE IF NOT EXISTS brief_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        brief_id TEXT NOT NULL,
        brief_type TEXT,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'Ready',
        priority TEXT,
        effort TEXT,
        phase TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
''')
db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_brief_status_unique ON brief_status(project, brief_id)')
db.execute('CREATE INDEX IF NOT EXISTS idx_brief_status_project ON brief_status(project)')

db.commit()
db.close()
" "$DB_PATH"

echo "Database tables verified."
echo ""

# ============================================================
# Build project list
# ============================================================

if [ -n "${1:-}" ]; then
  # Single project mode
  PROJECT_PATH="$1"
  if [ ! -d "$PROJECT_PATH" ]; then
    echo "Error: Directory '$PROJECT_PATH' does not exist"
    exit 1
  fi
  # Resolve to absolute path
  PROJECT_PATH="$(cd "$PROJECT_PATH" && pwd)"
  PROJECT_SLUG="$(basename "$PROJECT_PATH")"

  echo "Mode: Single project"
  echo "Project: $PROJECT_SLUG ($PROJECT_PATH)"
  echo ""

  # Build a simple list: slug|path
  PROJECT_LIST="$PROJECT_SLUG|$PROJECT_PATH"
else
  # All registered projects mode
  echo "Mode: All registered projects"
  echo ""

  PROJECT_LIST=$(sqlite3 "$DB_PATH" "
    PRAGMA busy_timeout = 5000;
    SELECT slug || '|' || path FROM projects WHERE status = 'active';
  " 2>/dev/null || echo "")

  if [ -z "$PROJECT_LIST" ]; then
    echo "No active projects found in brain."
    echo "Register projects first with igris_migrate_to_v4.sh or igris_brain_init.sh."
    exit 0
  fi
fi

# ============================================================
# Migrate each project
# ============================================================

TOTAL_PROJECTS=0
TOTAL_BRIEFS=0
TOTAL_SESSIONS=0

while IFS='|' read -r slug project_path; do
  [ -z "$slug" ] && continue

  echo "--- Project: $slug ---"

  if [ ! -d "$project_path" ]; then
    echo "  Warning: Directory '$project_path' does not exist, skipping"
    echo ""
    continue
  fi

  TOTAL_PROJECTS=$((TOTAL_PROJECTS + 1))

  # ----------------------------------------------------------
  # 1. Migrate briefs
  # ----------------------------------------------------------

  BRIEFS_DIR="$project_path/ai/briefs"
  BRIEF_COUNT=0

  if [ -d "$BRIEFS_DIR" ]; then
    BRIEF_COUNT=$(python3 -c "
import sqlite3
import sys
import os
import re
import hashlib
import glob
import uuid

db_path = sys.argv[1]
project = sys.argv[2]
briefs_dir = sys.argv[3]

db = sqlite3.connect(db_path)
db.execute('PRAGMA busy_timeout = 5000;')
db.execute('PRAGMA journal_mode = WAL;')

count = 0

for filepath in sorted(glob.glob(os.path.join(briefs_dir, '*.md'))):
    filename = os.path.basename(filepath)

    # Skip templates
    if 'TEMPLATE' in filename:
        continue

    # Parse brief_id from filename (XX-NNN or XXX-NNN pattern)
    id_match = re.match(r'^([A-Z]{2,}-\d{3})', filename)
    if not id_match:
        continue

    brief_id = id_match.group(1)

    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Compute SHA-256
    content_hash = hashlib.sha256(content.encode('utf-8')).hexdigest()

    # Parse metadata from content
    def parse_field(name, text):
        m = re.search(r'\*\*' + name + r':\*\*\s*(.+)', text)
        return m.group(1).strip() if m else None

    # Parse title: try '# XXX-NNN: Title' or '# XXX-NNN - Title' or '**Title:** ...'
    title_match = re.search(r'^#\s+.*?[-:]\s*(.+)$', content, re.MULTILINE)
    title = title_match.group(1).strip() if title_match else parse_field('Title', content)
    if not title:
        title = filename.replace('.md', '')

    file_id = str(uuid.uuid4())

    # Upsert into brief_files
    db.execute('''
        INSERT INTO brief_files(id, project, brief_id, filename, content, content_hash, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(project, brief_id) DO UPDATE SET
            filename = excluded.filename,
            content = excluded.content,
            content_hash = excluded.content_hash,
            updated_at = excluded.updated_at
    ''', (file_id, project, brief_id, filename, content, content_hash))

    brief_type = parse_field('Type', content)
    status = parse_field('Status', content) or 'Unknown'
    priority = parse_field('Priority', content)
    effort = parse_field('Effort', content)

    # Upsert into brief_status
    db.execute('''
        INSERT INTO brief_status(project, brief_id, brief_type, title, status, priority, effort, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(project, brief_id) DO UPDATE SET
            brief_type = excluded.brief_type,
            title = excluded.title,
            status = excluded.status,
            priority = excluded.priority,
            effort = excluded.effort,
            updated_at = excluded.updated_at
    ''', (project, brief_id, brief_type, title, status, priority, effort))

    count += 1

db.commit()
db.close()
print(count)
" "$DB_PATH" "$slug" "$BRIEFS_DIR")

    echo "  Briefs migrated: $BRIEF_COUNT"
  else
    echo "  No ai/briefs/ directory found, skipping briefs"
  fi

  TOTAL_BRIEFS=$((TOTAL_BRIEFS + BRIEF_COUNT))

  # ----------------------------------------------------------
  # 2. Migrate session files
  # ----------------------------------------------------------

  SESSION_DIR="$project_path/ai/session"
  SESSION_COUNT=0

  if [ -d "$SESSION_DIR" ]; then
    SESSION_COUNT=$(python3 -c "
import sqlite3
import sys
import os
import hashlib
import glob
import uuid

db_path = sys.argv[1]
project = sys.argv[2]
session_dir = sys.argv[3]

db = sqlite3.connect(db_path)
db.execute('PRAGMA busy_timeout = 5000;')
db.execute('PRAGMA journal_mode = WAL;')

count = 0

# Only scan top-level .md files (not subdirectories)
for filepath in sorted(glob.glob(os.path.join(session_dir, '*.md'))):
    filename = os.path.basename(filepath)

    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Compute SHA-256
    content_hash = hashlib.sha256(content.encode('utf-8')).hexdigest()

    file_id = str(uuid.uuid4())

    # Upsert into session_files
    db.execute('''
        INSERT INTO session_files(id, project, filename, content, content_hash, updated_at)
        VALUES(?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(project, filename) DO UPDATE SET
            content = excluded.content,
            content_hash = excluded.content_hash,
            updated_at = excluded.updated_at
    ''', (file_id, project, filename, content, content_hash))

    count += 1

db.commit()
db.close()
print(count)
" "$DB_PATH" "$slug" "$SESSION_DIR")

    echo "  Session files migrated: $SESSION_COUNT"
  else
    echo "  No ai/session/ directory found, skipping sessions"
  fi

  TOTAL_SESSIONS=$((TOTAL_SESSIONS + SESSION_COUNT))

  echo ""

done <<< "$PROJECT_LIST"

# ============================================================
# Summary
# ============================================================

echo "======================================"
echo "Migration complete!"
echo "======================================"
echo ""
echo "Summary:"
echo "  Projects processed: $TOTAL_PROJECTS"
echo "  Briefs migrated:    $TOTAL_BRIEFS"
echo "  Sessions migrated:  $TOTAL_SESSIONS"
echo "  Database: $DB_PATH"
echo ""
echo "Run 'igris_cache_rebuild' MCP tool to generate filesystem cache."

}

main "$@"
