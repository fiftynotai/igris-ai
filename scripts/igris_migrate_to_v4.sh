#!/bin/bash
# Description: Migrate a v3.4 Igris AI project to v4.0 (centralized brain)
# Usage: igris_migrate_to_v4.sh [target-directory]
# Dependencies: sqlite3, python3
# Exit codes:
#   0 - Success
#   1 - Error (brain not found, not a v3.4 project)

set -e

# Check dependencies
command -v python3 >/dev/null 2>&1 || { echo "Error: python3 is required but not installed."; exit 1; }

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

# Register project in brain
echo ""
echo "Registering project in brain..."

python3 -c "
import sqlite3, sys, os

db_path = os.path.expanduser('~/.igris/memory/knowledge.db')
db = sqlite3.connect(db_path)
db.execute('PRAGMA busy_timeout = 5000')
db.execute('INSERT OR IGNORE INTO projects (slug, name, path) VALUES (?, ?, ?)',
           (sys.argv[1], sys.argv[1], sys.argv[2]))
db.commit()
db.close()
" "$SLUG" "$TARGET_DIR"

echo "  Registered: $SLUG"

# Update .igris_version
echo ""
echo "Updating version tracking..."

python3 -c "
import json, sys, os

version_file = '.igris_version'
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

if os.path.exists(version_file):
    with open(version_file, 'r') as f:
        data = json.load(f)
else:
    data = {}

data['igris_ai_version'] = '4.0.0'
data['install_mode'] = 'symlink'
data['brain_path'] = os.path.expanduser('~/.igris')
data['last_updated'] = now
data['migrated_from'] = data.get('igris_ai_version', '3.4.0')
data['migration_date'] = now

with open(version_file, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"

echo "  .igris_version updated to 4.0.0"

# Done
echo ""
echo "=================================================="
echo "Migration complete!"
echo "=================================================="
echo ""
echo "Summary:"
echo "  Symlinks created: $SYMLINK_COUNT"
echo "  Backup location: $BACKUP_DIR"
echo "  Brain registered: $SLUG"
echo ""
echo "Your project now uses centralized brain at ~/.igris/"
echo "All existing briefs, sessions, and context files are preserved."
echo ""
echo "Rollback: Copy files from $BACKUP_DIR back to their original locations."
