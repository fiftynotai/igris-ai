#!/bin/bash
set -euo pipefail

# Description: Propose and apply goal backfills from legacy "master" briefs
# Usage:
#   backfill_goals.sh [--project SLUG]            # Pass 1: write proposal file
#   backfill_goals.sh --apply [--project SLUG]    # Pass 2: read proposal, create goals
#
# Workflow:
#   1. Without --apply, the script scans entity_edges for briefs that have
#      outgoing parent_of children and writes a proposal file to
#      ~/.igris/projects/{project}/goals_backfill_proposal.md
#   2. The user edits the file: ticks [x] on candidates to promote, fills in
#      outcome/deadline/priority, and re-runs with --apply.
#   3. With --apply, the script parses the same file, calls
#      igris_goal_create + igris_edge_create for each ticked entry, and
#      records the promotion as a learning so the master brief is auditable.
#
# Idempotent on --apply: candidates that already have a serves_goal edge
# from at least one child brief are skipped.
#
# Dependencies: sqlite3, python3
# Exit codes:
#   0 - Success
#   1 - Error (brain not found, dependency missing, malformed proposal file)
#   2 - Usage error

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
  # Argument parsing
  # ============================================================

  APPLY=false
  PROJECT=""

  while [ $# -gt 0 ]; do
    case "$1" in
      --apply)
        APPLY=true
        shift
        ;;
      --project)
        if [ -z "${2:-}" ]; then
          echo "Error: --project requires a value"
          exit 2
        fi
        PROJECT="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Error: unknown argument '$1'"
        usage
        exit 2
        ;;
    esac
  done

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
    echo "Error: Brain DB not found at $DB_PATH"
    exit 1
  fi

  # If no project provided, derive from current working directory.
  if [ -z "$PROJECT" ]; then
    PROJECT="$(basename "$(pwd)")"
    echo "No --project specified. Using current directory: $PROJECT"
  fi

  PROJECT_DIR="$BRAIN_DIR/projects/$PROJECT"
  if [ ! -d "$PROJECT_DIR" ]; then
    echo "Error: Project not registered: $PROJECT"
    echo "Expected directory: $PROJECT_DIR"
    exit 1
  fi

  PROPOSAL_FILE="$PROJECT_DIR/goals_backfill_proposal.md"

  # ============================================================
  # Dispatch
  # ============================================================

  if [ "$APPLY" = "true" ]; then
    apply_proposal
  else
    write_proposal
  fi
}

# ============================================================
# Function: usage
# ============================================================

usage() {
  cat <<EOF
Usage: backfill_goals.sh [--project SLUG] [--apply]

Without --apply: scan brain for master briefs and write a proposal file
With --apply:    read the proposal file and create goals for ticked entries

Options:
  --project SLUG    Project slug (default: current directory name)
  --apply           Apply ticked entries from the proposal file
  -h, --help        Show this help

Examples:
  backfill_goals.sh                       # Pass 1 (current project)
  backfill_goals.sh --project igris-ai    # Pass 1 (explicit project)
  backfill_goals.sh --apply               # Pass 2 after editing proposal
EOF
}

# ============================================================
# Function: write_proposal
#
# Generates the proposal file by querying entity_edges for briefs with
# outgoing parent_of children scoped to the requested project.
# ============================================================

write_proposal() {

  if [ -f "$PROPOSAL_FILE" ]; then
    echo "Proposal file already exists: $PROPOSAL_FILE"
    # Default to "no" when stdin is not a TTY (CI / automation).
    if [ -t 0 ]; then
      read -r -p "Overwrite? [y/N]: " CONFIRM
      if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        echo "Operation cancelled"
        exit 0
      fi
    else
      echo "Stdin is not a TTY; refusing to overwrite without --apply confirmation."
      exit 1
    fi
  fi

  # Find candidate master briefs: any brief with at least one outgoing
  # parent_of edge to another brief, scoped to the requested project.
  # We join through brief_status to scope candidates to the project.
  CANDIDATES_JSON=$(sqlite3 -json "$DB_PATH" "
    SELECT
      bs.brief_id      AS brief_id,
      bs.title         AS title,
      bs.priority      AS priority,
      COUNT(e.id)      AS child_count,
      GROUP_CONCAT(e.from_id, ',') AS children
    FROM brief_status bs
    JOIN entity_edges e
      ON e.to_id   = bs.brief_id
     AND e.to_type = 'brief'
     AND e.from_type = 'brief'
     AND e.edge_type = 'parent_of'
     AND COALESCE(json_extract(e.metadata, '\$.deleted'), 0) != 1
    WHERE bs.project = '$(printf '%s' "$PROJECT" | sed "s/'/''/g")'
    GROUP BY bs.brief_id, bs.title, bs.priority
    ORDER BY bs.brief_id
  ")

  if [ -z "$CANDIDATES_JSON" ] || [ "$CANDIDATES_JSON" = "[]" ]; then
    echo "No master briefs (parent_of children) found for project '$PROJECT'."
    echo "Nothing to propose."
    exit 0
  fi

  # Render candidates into the proposal markdown using python3 for
  # multi-line composition (avoiding sed pitfalls with newlines).
  python3 <<PYEOF > "$PROPOSAL_FILE"
import json
candidates = json.loads('''${CANDIDATES_JSON}''')
print("# Goals Backfill Proposal — ${PROJECT}")
print("")
print("Tick [x] on candidates you want to promote to goals, fill in the")
print("outcome and (optional) deadline, then re-run:")
print("")
print("    scripts/backfill_goals.sh --project ${PROJECT} --apply")
print("")
print("Each ticked candidate will:")
print("  1. Create a new goal via igris_goal_create")
print("  2. Add a serves_goal edge from each child brief to the new goal")
print("  3. Leave the master brief intact (recoverable for audit)")
print("")
print("Outcome examples: 'shipped', 'measured', 'audited', 'deployed to prod'.")
print("Deadline format: ISO date (YYYY-MM-DD). Leave blank if none.")
print("")
print("---")
print("")
for c in candidates:
    children = (c.get("children") or "").split(",")
    children_pretty = ", ".join(sorted(set(filter(None, children))))
    print(f"## Candidate: {c['brief_id']} (master brief)")
    print(f"")
    print(f"- **Children:** {children_pretty}")
    print(f"- **Original title:** {c['title']}")
    print(f"- **Original priority:** {c.get('priority') or 'P2-Medium'}")
    print(f"")
    print(f"- [ ] Promote to goal? (set to [x] to apply)")
    print(f"- title: {c['title']}")
    print(f"- outcome:")
    print(f"- deadline:")
    print(f"- priority: {c.get('priority') or 'P2-Medium'}")
    print(f"")
    print(f"---")
    print(f"")
PYEOF

  COUNT=$(printf '%s' "$CANDIDATES_JSON" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
  echo "Proposal written to $PROPOSAL_FILE"
  echo "Candidates found: $COUNT"
  echo ""
  echo "Edit the file and tick [x] on the candidates you want to promote."
  echo "Then run: scripts/backfill_goals.sh --project $PROJECT --apply"
}

# ============================================================
# Function: apply_proposal
#
# Reads the proposal file, identifies ticked entries, and creates goals
# + serves_goal edges via direct sqlite3 writes (no MCP client needed).
# ============================================================

apply_proposal() {

  if [ ! -f "$PROPOSAL_FILE" ]; then
    echo "Error: Proposal file not found: $PROPOSAL_FILE"
    echo "Run without --apply first to generate the proposal."
    exit 1
  fi

  # Parse proposal with python3 so multi-line block parsing is reliable.
  # Output: JSON array of {brief_id, title, outcome, deadline, priority, children}
  export PROPOSAL_FILE
  ENTRIES_JSON=$(PROPOSAL_FILE="$PROPOSAL_FILE" python3 <<'PYEOF'
import re, json, sys, os
path = os.environ["PROPOSAL_FILE"]
with open(path, "r") as f:
    text = f.read()

entries = []
blocks = re.split(r'(?m)^## Candidate: ', text)[1:]
for block in blocks:
    first_line, _, _ = block.partition("\n")
    m = re.match(r'^([A-Z]{2,4}-\d+)', first_line.strip())
    if not m:
        continue
    brief_id = m.group(1)

    children_match = re.search(r'\*\*Children:\*\*\s*(.+)', block)
    children = []
    if children_match:
        children = [c.strip() for c in children_match.group(1).split(",") if c.strip()]

    tick_match = re.search(r'-\s*\[([ xX])\]\s*Promote to goal', block)
    if not tick_match or tick_match.group(1).strip().lower() != "x":
        continue

    def field(name, default=""):
        mm = re.search(r'^- ' + re.escape(name) + r':\s*(.*?)\s*$', block, re.MULTILINE)
        return mm.group(1) if mm else default

    title = field("title")
    outcome = field("outcome")
    deadline = field("deadline")
    priority = field("priority", "P2-Medium")

    if not title:
        sys.stderr.write(f"WARNING: candidate {brief_id} ticked but title is empty; skipping\n")
        continue
    if not outcome:
        sys.stderr.write(f"WARNING: candidate {brief_id} ticked but outcome is empty; skipping\n")
        continue

    entries.append({
        "brief_id": brief_id,
        "title": title,
        "outcome": outcome,
        "deadline": deadline or None,
        "priority": priority or "P2-Medium",
        "children": children,
    })

print(json.dumps(entries))
PYEOF
)

  if [ -z "$ENTRIES_JSON" ] || [ "$ENTRIES_JSON" = "[]" ]; then
    echo "No ticked candidates found in $PROPOSAL_FILE."
    echo "Edit the file and set [x] on the entries you want to promote."
    exit 0
  fi

  # For each entry, allocate a goal_id, insert the goal, and add edges.
  # We use sqlite3 for writes (no MCP client dependency) and rely on
  # the same SQL the handler runs.
  python3 <<PYEOF
import json, os, subprocess, sys
entries = json.loads('''${ENTRIES_JSON}''')
db = "${DB_PATH}"
project = "${PROJECT}"

def sql(query, *params):
    args = ["sqlite3", db, query]
    if params:
        # Use parameterized via .param? Easier: inline-escape via json — bad.
        # Instead, use python's sqlite3 module directly.
        pass
    raise RuntimeError("use python sqlite3 directly")

import sqlite3
conn = sqlite3.connect(db)
conn.execute("PRAGMA foreign_keys = ON")
cur = conn.cursor()

created = 0
skipped = 0
for entry in entries:
    brief_id = entry["brief_id"]
    children = entry.get("children", [])

    # Idempotency: if any child already has a serves_goal edge to a goal,
    # skip — this candidate has been promoted already.
    existing = None
    if children:
        placeholders = ",".join("?" * len(children))
        cur.execute(
            f"""SELECT to_id FROM entity_edges
                WHERE from_type='brief' AND edge_type='serves_goal'
                  AND from_id IN ({placeholders})
                  AND COALESCE(json_extract(metadata, '\$.deleted'), 0) != 1
                LIMIT 1""",
            children,
        )
        row = cur.fetchone()
        if row:
            existing = row[0]
    if existing:
        sys.stderr.write(f"SKIP {brief_id}: children already serve goal {existing}\n")
        skipped += 1
        continue

    # Allocate next GL-XXX
    cur.execute(
        "SELECT MAX(CAST(SUBSTR(goal_id, 4) AS INTEGER)) FROM goals WHERE goal_id LIKE 'GL-%'"
    )
    max_n = cur.fetchone()[0] or 0
    goal_id = f"GL-{max_n + 1:03d}"

    # Insert goal
    cur.execute(
        """INSERT INTO goals
             (goal_id, project_slug, title, outcome, deadline, priority, status)
           VALUES (?, ?, ?, ?, ?, ?, 'active')""",
        (goal_id, project, entry["title"], entry["outcome"],
         entry.get("deadline"), entry.get("priority", "P2-Medium")),
    )

    # Add serves_goal edge from each child brief
    for child in children:
        cur.execute(
            """INSERT OR IGNORE INTO entity_edges
                 (from_type, from_id, to_type, to_id, edge_type,
                  confidence, provenance, metadata)
               VALUES ('brief', ?, 'goal', ?, 'serves_goal',
                       1.0, 'backfill', ?)""",
            (child, goal_id, json.dumps({"source": "backfill_goals.sh", "master_brief": brief_id})),
        )

    print(f"CREATED {goal_id} from master {brief_id} with {len(children)} serving brief(s)")
    created += 1

conn.commit()
conn.close()

print("")
print(f"Backfill complete: {created} goal(s) created, {skipped} skipped (already promoted).")
PYEOF
}

# ============================================================
# Run main
# ============================================================

main "$@"
