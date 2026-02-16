# MG-011: Migration Script — Brief Sync to Brain

**Type:** Migration
**Priority:** P2-Medium
**Effort:** S-Small (< 1 day)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-16
**Completed:** 2026-02-16

---

## Problem

The `igris_migrate_to_v4.sh` migration script registers projects and migrates learnings/decisions to the brain, but does **not** sync existing briefs to the `brief_status` table. This means the brain's `/dashboard` and `igris_brief_dashboard` tool show no briefs until the user manually `/hunt`s or `/rest`s in each project.

For a developer with 3 projects and 20+ briefs across them, the cross-project dashboard is empty after migration — defeating the purpose of MG-010.

---

## Goal

After this migration enhancement:
1. Running `igris_migrate_to_v4.sh` on a project also bulk-syncs all existing briefs to `brief_status`
2. Running `/dashboard` immediately after migration shows all briefs across all migrated projects
3. No manual intervention needed — briefs appear in the brain automatically

---

## Context and Inputs

### Existing Infrastructure
- `scripts/igris_migrate_to_v4.sh` — v3.4 → v4.0 migration (from MG-009)
- `brief_status` table in `knowledge.db` — added by MG-010, schema version 2
- Brief files live in `ai/briefs/*.md` with frontmatter: Type, Priority, Effort, Status, etc.
- Brief IDs follow format: `XX-NNN` (e.g., BR-008, MG-010, FR-014)

### Brief Metadata Format (from brief files)
```markdown
# XX-NNN: Title

**Type:** Bug | Feature | Migration | ...
**Priority:** P0-Critical | P1-High | P2-Medium | P3-Low
**Effort:** S-Small | M-Medium | L-Large | XL-Extra Large
**Status:** Draft | Ready | In Progress | Done | Blocked
```

---

## Constraints

- Must work with existing Python3 + sqlite3 approach in the migration script
- Must parse markdown frontmatter reliably (grep-based, not full markdown parser)
- Skip template files (`*-TEMPLATE.md`)
- Skip already-synced briefs (use `INSERT OR REPLACE` for idempotency)
- Must not break existing migration flow

---

## Acceptance Criteria

1. [ ] Migration script scans `ai/briefs/*.md` (excluding templates)
2. [ ] Parses brief ID, title, type, status, priority, effort from each brief
3. [ ] Bulk-inserts into `brief_status` table via `INSERT OR REPLACE`
4. [ ] Reports count of synced briefs
5. [ ] Idempotent — running migration twice doesn't create duplicates
6. [ ] Archived briefs in `ai/session/archive/briefs/` also synced (with status=Done)

---

## Implementation Sketch

Add a new section to `igris_migrate_to_v4.sh` after the learnings migration:

```bash
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
for pattern in [briefs_dir + '/*.md', briefs_dir + '/../session/archive/briefs/*.md']:
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
```

---

## Test Plan

### Automated
- Run migration on a project with 5+ briefs — verify all appear in `brief_status`
- Run migration twice — verify no duplicate rows (idempotent)
- Verify template files are skipped
- Verify archived briefs are synced with correct status

### Manual
- Migrate 2 projects, run `/dashboard` — see briefs from both

---

## Delivery

- [ ] Updated `scripts/igris_migrate_to_v4.sh` with brief sync section
- [ ] Tested on igris-ai project (self-dogfood)

---

## References

- **Depends on:** MG-010 (Cross-Project Session & Brief Sync) — completed
- **Depends on:** MG-009 (Centralized Brain Architecture) — completed

---

## Notes

- This is a small enhancement to the existing migration script
- The Python3 inline approach matches the existing learnings/decisions migration pattern
- `INSERT OR REPLACE` ensures idempotency via the UNIQUE index on (project, brief_id)

---

## Workflow State

**Phase:** COMPLETE
**Active Agent:** none
**Retry Count:** 0

### Current Work
Loading brief and preparing for implementation.

### Next Steps
Proceed to PLANNING phase.

### Agent Log
| Time | Agent | Action | Result |
|------|-------|--------|--------|

### Blockers
None

---

**Created:** 2026-02-16
**Last Updated:** 2026-02-16
**Brief Owner:** Crimson (Fifty.ai)
