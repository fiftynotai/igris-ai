#!/bin/bash
# Description: Migrate a v3.4 Igris AI project to v4.0 (centralized brain)
# Usage: igris_migrate_to_v4.sh [target-directory] [--add-remote URL KEY]
# Dependencies: sqlite3, python3
# Exit codes:
#   0 - Success
#   1 - Error (brain not found, not a v3.4 project)

set -euo pipefail

# Check dependencies
command -v python3 >/dev/null 2>&1 || { echo "Error: python3 is required but not installed."; exit 1; }

# ============================================================
# Check for --add-remote flag (separate migration path)
# ============================================================
if [ "${1:-}" = "--add-remote" ]; then
  if [ -z "${2:-}" ] || [ -z "${3:-}" ]; then
    echo "Error: --add-remote requires URL and API_KEY arguments"
    echo "Usage: $0 --add-remote <URL> <API_KEY>"
    exit 1
  fi

  REMOTE_URL="$2"
  REMOTE_KEY="$3"
  BRAIN_DIR="$HOME/.igris"

  if [ ! -d "$BRAIN_DIR" ]; then
    echo "Error: Brain not found at $BRAIN_DIR"
    echo "Run igris_brain_init.sh first."
    exit 1
  fi

  echo "Igris AI - Add Remote Brain (Migration Path)"
  echo "=============================================="
  echo ""

  # Delegate to igris_brain_init.sh --add-remote
  SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
  exec "$SCRIPT_DIR/igris_brain_init.sh" --add-remote "$REMOTE_URL" "$REMOTE_KEY"
fi

echo "Igris AI - Migration to v4.0 (Centralized Brain)"
echo "=================================================="

BRAIN_DIR="$HOME/.igris"

# Check brain exists
if [ ! -d "$BRAIN_DIR" ]; then
  echo "Error: Brain not found at $BRAIN_DIR"
  echo "Run igris_brain_init.sh first."
  exit 1
fi

TARGET_DIR="${1:-.}"
cd "$TARGET_DIR"
TARGET_DIR=$(pwd)

# Resolve source repo and version
IGRIS_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
IGRIS_VERSION=$(cat "$IGRIS_DIR/version.txt" 2>/dev/null || echo "4.0.0")

# Check this is a v3.4 project (has ai/ directory with non-symlinked files)
if [ ! -d "ai/prompts" ]; then
  echo "Error: Not an Igris AI project (no ai/prompts/ directory)"
  exit 1
fi

# Check if already v4.0 (symlinks present)
if [ -L ".claude/agents/architect.md" ]; then
  echo "Project already uses v4.0 symlinks. Nothing to migrate."
  exit 0
fi

echo "Project: $TARGET_DIR"
echo ""

# Refresh brain core from source repo
echo "Refreshing brain core..."
if [ -f "$IGRIS_DIR/scripts/igris_brain_refresh.sh" ]; then
  bash "$IGRIS_DIR/scripts/igris_brain_refresh.sh"
else
  echo "  igris_brain_refresh.sh not found, skipping core refresh"
fi
echo ""

# Backup current files
BACKUP_DIR=".igris_backup/$(date +%Y%m%d_%H%M%S)"
echo "Creating backup at $BACKUP_DIR..."
mkdir -p "$BACKUP_DIR"

# Backup files that will be replaced by symlinks
for dir in .claude/agents .claude/rules ai/prompts ai/templates; do
  if [ -d "$dir" ]; then
    mkdir -p "$BACKUP_DIR/$dir"
    cp -r "$dir/"* "$BACKUP_DIR/$dir/" 2>/dev/null || true
  fi
done
echo "  Backup complete"

# Ensure masks directory exists (added in v4.0)
mkdir -p ai/masks

# Replace copied files with symlinks
echo ""
echo "Replacing copied files with symlinks..."

SYMLINK_COUNT=0

# Agents
if [ -d "$BRAIN_DIR/core/agents" ]; then
  for f in "$BRAIN_DIR/core/agents/"*.md; do
    [ -f "$f" ] || continue
    BASENAME=$(basename "$f")
    # Remove old copy, create symlink
    rm -f ".claude/agents/$BASENAME"
    ln -sf "$f" ".claude/agents/$BASENAME"
    SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  done
  # Also symlink manifest.yaml if it exists
  if [ -f "$BRAIN_DIR/core/agents/manifest.yaml" ]; then
    rm -f ".claude/agents/manifest.yaml"
    ln -sf "$BRAIN_DIR/core/agents/manifest.yaml" ".claude/agents/manifest.yaml"
    SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  fi
  echo "  Agents: symlinked"
fi

# Rules
if [ -d "$BRAIN_DIR/core/rules" ]; then
  for f in "$BRAIN_DIR/core/rules/"*.md; do
    [ -f "$f" ] || continue
    BASENAME=$(basename "$f")
    rm -f ".claude/rules/$BASENAME"
    ln -sf "$f" ".claude/rules/$BASENAME"
    SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  done
  echo "  Rules: symlinked"
fi

# Prompts
if [ -d "$BRAIN_DIR/core/prompts" ]; then
  for f in "$BRAIN_DIR/core/prompts/"*; do
    [ -f "$f" ] || continue
    BASENAME=$(basename "$f")
    rm -f "ai/prompts/$BASENAME"
    ln -sf "$f" "ai/prompts/$BASENAME"
    SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  done
  echo "  Prompts: symlinked"
fi

# Templates
if [ -d "$BRAIN_DIR/core/templates" ]; then
  for f in "$BRAIN_DIR/core/templates/"*; do
    [ -f "$f" ] || continue
    BASENAME=$(basename "$f")
    rm -f "ai/templates/$BASENAME"
    ln -sf "$f" "ai/templates/$BASENAME"
    SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  done
  echo "  Templates: symlinked"
fi

# Skills (directory-level, skip existing local overrides)
if [ -d "$BRAIN_DIR/core/skills" ]; then
  for d in "$BRAIN_DIR/core/skills/"*/; do
    [ -d "$d" ] || continue
    DIRNAME=$(basename "$d")
    if [ -d ".claude/skills/$DIRNAME" ] && [ ! -L ".claude/skills/$DIRNAME" ]; then
      echo "  Skipping skill '$DIRNAME' (local override exists)"
      continue
    fi
    rm -rf ".claude/skills/$DIRNAME"
    ln -sf "$d" ".claude/skills/$DIRNAME"
    SYMLINK_COUNT=$((SYMLINK_COUNT + 1))
  done
  echo "  Skills: symlinked"
fi

echo "  Total symlinks: $SYMLINK_COUNT"

# Migrate LEARNINGS.md to brain knowledge.db
echo ""
echo "Migrating learnings to brain..."

SLUG=$(basename "$TARGET_DIR")

if [ -f "ai/session/LEARNINGS.md" ]; then
  python3 -c "
import sqlite3, sys, re, os

db_path = os.path.expanduser('~/.igris/memory/knowledge.db')
learnings_file = sys.argv[1]
project = sys.argv[2]

db = sqlite3.connect(db_path)
db.execute('PRAGMA busy_timeout = 5000')

with open(learnings_file, 'r') as f:
    content = f.read()

# Parse markdown sections (## headers)
sections = re.split(r'\n##\s+', content)
count = 0
for section in sections[1:]:  # Skip the title
    lines = section.strip().split('\n')
    if not lines:
        continue
    title = lines[0].strip()
    body = '\n'.join(lines[1:]).strip()
    if body and len(body) > 10 and title != 'N/A' and 'No learnings recorded' not in body:
        db.execute(
            'INSERT OR IGNORE INTO learnings (project, category, title, content, scope) VALUES (?, ?, ?, ?, ?)',
            (project, 'discovery', title[:200], body[:2000], 'local')
        )
        count += 1

db.commit()
db.close()
print(f'  Migrated {count} learnings from LEARNINGS.md')
" "ai/session/LEARNINGS.md" "$SLUG"
else
  echo "  No LEARNINGS.md found (skipping)"
fi

# Migrate DECISIONS.md to brain knowledge.db
if [ -f "ai/session/DECISIONS.md" ]; then
  python3 -c "
import sqlite3, sys, re, os

db_path = os.path.expanduser('~/.igris/memory/knowledge.db')
decisions_file = sys.argv[1]
project = sys.argv[2]

db = sqlite3.connect(db_path)
db.execute('PRAGMA busy_timeout = 5000')

with open(decisions_file, 'r') as f:
    content = f.read()

sections = re.split(r'\n##\s+', content)
count = 0
for section in sections[1:]:
    lines = section.strip().split('\n')
    if not lines:
        continue
    title = lines[0].strip()
    body = '\n'.join(lines[1:]).strip()
    if body and len(body) > 10 and title != 'N/A' and 'No decisions recorded' not in body:
        db.execute(
            'INSERT OR IGNORE INTO learnings (project, category, title, content, scope) VALUES (?, ?, ?, ?, ?)',
            (project, 'decision', title[:200], body[:2000], 'local')
        )
        count += 1

db.commit()
db.close()
print(f'  Migrated {count} decisions from DECISIONS.md')
" "ai/session/DECISIONS.md" "$SLUG"
else
  echo "  No DECISIONS.md found (skipping)"
fi

# Detect tech stack
TECH_STACK=$(python3 -c "
import os, sys, glob
project_dir = sys.argv[1]
stacks = []
indicators = {
    'pubspec.yaml': 'flutter',
    'package.json': 'typescript/javascript',
    'Cargo.toml': 'rust',
    'go.mod': 'go',
    'requirements.txt': 'python',
    'pyproject.toml': 'python',
}
for filename, stack in indicators.items():
    if os.path.isfile(os.path.join(project_dir, filename)):
        if stack not in stacks:
            stacks.append(stack)
# Check for bash scripts
if glob.glob(os.path.join(project_dir, '*.sh')) or glob.glob(os.path.join(project_dir, 'scripts', '*.sh')):
    stacks.append('bash')
print(','.join(stacks) if stacks else '')
" "$TARGET_DIR" 2>/dev/null || echo "")

# Register project in brain
echo ""
echo "Registering project in brain..."

python3 -c "
import sqlite3, sys
from datetime import datetime, timezone
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
db = sqlite3.connect(sys.argv[1])
db.execute('PRAGMA busy_timeout = 5000')
db.execute('''
    INSERT INTO projects (slug, name, path, tech_stack, igris_version, last_session_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        tech_stack = excluded.tech_stack,
        igris_version = excluded.igris_version,
        last_session_at = excluded.last_session_at
''', (sys.argv[2], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], now))
db.commit()
db.close()
" "$BRAIN_DIR/memory/knowledge.db" "$SLUG" "$TARGET_DIR" "$TECH_STACK" "$IGRIS_VERSION"

echo "  Registered: $SLUG (tech_stack: ${TECH_STACK:-none detected})"

# Sync existing briefs to brain
echo ""
echo "Syncing briefs to brain..."

python3 -c "
import sqlite3, sys, os, re, glob

db_path = os.path.expanduser('~/.igris/memory/knowledge.db')
project = sys.argv[1]
briefs_dir = sys.argv[2]

db = sqlite3.connect(db_path)
db.execute('PRAGMA busy_timeout = 5000')

count = 0
patterns = [
    os.path.join(briefs_dir, '*.md'),
    os.path.join(briefs_dir, '..', 'session', 'archive', 'briefs', '*.md'),
]

for pattern in patterns:
    for filepath in glob.glob(pattern):
        filename = os.path.basename(filepath)
        if 'TEMPLATE' in filename:
            continue

        with open(filepath, 'r') as f:
            content = f.read()

        # Parse brief ID from filename (XX-NNN pattern)
        id_match = re.match(r'^([A-Z]{2}-\d{3})', filename)
        if not id_match:
            continue
        brief_id = id_match.group(1)

        # Parse title from first heading
        title_match = re.search(r'^#\s+.*?:\s*(.+)$', content, re.MULTILINE)
        title = title_match.group(1).strip() if title_match else filename

        # Parse frontmatter fields
        def parse_field(name):
            m = re.search(r'\*\*' + name + r':\*\*\s*(.+)', content)
            return m.group(1).strip() if m else None

        status = parse_field('Status') or 'Unknown'
        priority = parse_field('Priority')
        effort = parse_field('Effort')
        brief_type = parse_field('Type')

        db.execute('''
            INSERT OR REPLACE INTO brief_status
            (project, brief_id, brief_type, title, status, priority, effort, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ''', (project, brief_id, brief_type, title, status, priority, effort))
        count += 1

db.commit()
db.close()
print(f'  Synced {count} briefs to brain')
" "$SLUG" "$TARGET_DIR/ai/briefs"

# Push project to remote brain (if configured)
echo ""
echo "Checking remote brain..."

REMOTE_PUSH_RESULT=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1], 'r') as f:
        config = json.load(f)
    url = config.get('remote_brain', {}).get('url', '')
    key = config.get('remote_brain', {}).get('api_key', '')
    if url and key:
        print(url + '|' + key)
    else:
        print('')
except Exception:
    print('')
" "$BRAIN_DIR/config.json" 2>/dev/null || echo "")

if [ -n "$REMOTE_PUSH_RESULT" ]; then
  REMOTE_URL="${REMOTE_PUSH_RESULT%%|*}"
  API_KEY="${REMOTE_PUSH_RESULT##*|}"
  NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  PUSH_BODY=$(python3 -c "
import json, sys
body = {
    'tables': {
        'projects': [{
            'slug': sys.argv[1],
            'name': sys.argv[1],
            'path': sys.argv[2],
            'tech_stack': sys.argv[3],
            'igris_version': sys.argv[4],
            'status': 'active',
            'registered_at': sys.argv[5],
            'last_session_at': sys.argv[5],
            'metadata': '{}'
        }]
    }
}
print(json.dumps(body))
" "$SLUG" "$TARGET_DIR" "$TECH_STACK" "$IGRIS_VERSION" "$NOW")

  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    --connect-timeout 5 --max-time 10 \
    -X POST "${REMOTE_URL%/}/sync/push" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "$PUSH_BODY" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    echo "  Project pushed to remote brain"
  else
    echo "  Remote brain push returned HTTP $HTTP_CODE (continuing anyway)"
  fi
else
  echo "  Remote brain not configured, skipping push"
fi

# Update .igris_version
echo ""
echo "Updating version tracking..."

python3 -c "
import json, sys, os
from datetime import datetime, timezone

version_file = '.igris_version'
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

if os.path.exists(version_file):
    with open(version_file, 'r') as f:
        data = json.load(f)
else:
    data = {}

data['igris_ai_version'] = sys.argv[1]
data['install_mode'] = 'symlink'
data['brain_path'] = os.path.expanduser('~/.igris')
data['last_updated'] = now
data['migrated_from'] = data.get('igris_ai_version', '3.4.0')
data['migration_date'] = now

with open(version_file, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" "$IGRIS_VERSION"

echo "  .igris_version updated to $IGRIS_VERSION"

# Brain health check
echo ""
echo "Brain health check..."

if [ -f "$BRAIN_DIR/memory/knowledge.db" ]; then
  INTEGRITY=$(sqlite3 "$BRAIN_DIR/memory/knowledge.db" "PRAGMA integrity_check;" 2>/dev/null || echo "failed")
  if [ "$INTEGRITY" = "ok" ]; then
    echo "  Local brain: knowledge.db OK"
  else
    echo "  Local brain: knowledge.db integrity issue detected"
  fi
else
  echo "  Local brain: knowledge.db not found (may be remote-only mode)"
fi

# Check if remote brain is configured
if [ -f "$BRAIN_DIR/config.json" ]; then
  HEALTH_REMOTE_URL=$(python3 -c "
import json, sys
try:
    with open(sys.argv[1], 'r') as f:
        config = json.load(f)
    print(config.get('remote_brain', {}).get('url', ''))
except Exception:
    print('')
" "$BRAIN_DIR/config.json" 2>/dev/null || echo "")

  if [ -n "$HEALTH_REMOTE_URL" ]; then
    HEALTH_URL="${HEALTH_REMOTE_URL%/}/health"
    if command -v curl &> /dev/null; then
      HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")
      if [ "$HTTP_CODE" = "200" ]; then
        echo "  Remote brain: healthy (HTTP $HTTP_CODE)"
      else
        echo "  Remote brain: HTTP $HTTP_CODE (may not be running)"
      fi
    fi
  fi
fi

# Done
echo ""
echo "=================================================="
echo "Migration complete!"
echo "=================================================="
echo ""
echo "Summary:"
echo "  Version: $IGRIS_VERSION"
echo "  Symlinks created: $SYMLINK_COUNT"
echo "  Backup location: $BACKUP_DIR"
echo "  Brain registered: $SLUG (tech_stack: ${TECH_STACK:-none detected})"
echo ""
echo "Your project now uses centralized brain at ~/.igris/"
echo "All existing briefs, sessions, and context files are preserved."
echo ""
echo "Rollback: Copy files from $BACKUP_DIR back to their original locations."
