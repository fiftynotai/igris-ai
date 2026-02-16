---
name: portfolio
description: Cross-project dashboard with analytics and brain health
disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
triggers:
  - "portfolio"
  - "dashboard"
  - "cross-project"
  - "brain status"
---

# PORTFOLIO - Cross-Project Dashboard

Display a comprehensive dashboard of all managed projects with analytics.

## Usage

```
/portfolio
```

## Execution

### 1. Check Brain Exists

Check `~/.igris/memory/knowledge.db`. Error if not found.

### 2. Query Brain Health

```bash
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA integrity_check;"
sqlite3 ~/.igris/memory/knowledge.db "PRAGMA journal_mode;"
```

### 3. Gather Statistics

Run these queries against the brain DB:

```bash
# Project count
sqlite3 ~/.igris/memory/knowledge.db "SELECT COUNT(*) FROM projects WHERE status='active';"

# Total learnings
sqlite3 ~/.igris/memory/knowledge.db "SELECT COUNT(*) FROM learnings;"

# Global learnings
sqlite3 ~/.igris/memory/knowledge.db "SELECT COUNT(*) FROM learnings WHERE scope='global';"

# Total errors cataloged
sqlite3 ~/.igris/memory/knowledge.db "SELECT COUNT(*) FROM errors;"

# Errors with solutions
sqlite3 ~/.igris/memory/knowledge.db "SELECT COUNT(*) FROM errors WHERE solution != '';"

# Agent metrics summary
sqlite3 ~/.igris/memory/knowledge.db "
  PRAGMA trusted_schema=ON;
  SELECT agent,
         COUNT(*) as total,
         SUM(CASE WHEN result='success' THEN 1 ELSE 0 END) as successes,
         ROUND(AVG(duration_ms), 0) as avg_ms
  FROM agent_metrics
  GROUP BY agent
  ORDER BY total DESC;
"

# Recent activity (last 7 days)
sqlite3 ~/.igris/memory/knowledge.db "
  SELECT project, COUNT(*) as actions
  FROM agent_metrics
  WHERE recorded_at >= datetime('now', '-7 days')
  GROUP BY project
  ORDER BY actions DESC;
"

# Top learnings (most accessed)
sqlite3 ~/.igris/memory/knowledge.db "
  PRAGMA trusted_schema=ON;
  SELECT title, project, access_count
  FROM learnings
  WHERE access_count > 0
  ORDER BY access_count DESC
  LIMIT 5;
"
```

### 4. Display Dashboard

Format as:

```
## Igris Brain -- Portfolio Dashboard

### Brain Health
- Status: OK (integrity check passed)
- Mode: WAL (concurrent access enabled)
- DB Size: X KB

### Projects
- Active: X projects
- Archived: Y projects

### Knowledge Base
- Learnings: X total (Y global, Z local)
- Errors cataloged: X (Y with solutions)
- Patterns: X in library

### Agent Performance
| Agent | Actions | Success Rate | Avg Duration |
|-------|---------|-------------|-------------|
| forger | 45 | 92% | 5200ms |
| sentinel | 38 | 100% | 3100ms |

### Recent Activity (7 days)
| Project | Actions |
|---------|---------|
| igris-ai | 12 |
| my-app | 5 |

### Most Accessed Learnings
1. "SQLite WAL Mode" (igris-ai) -- accessed 8 times
2. "Error Fingerprinting" (igris-ai) -- accessed 5 times

### Recommendations
Based on the data, suggest:
1. Projects with no recent activity that may need attention
2. Agents with low success rates that may need investigation
3. Learnings that could be promoted to global scope
```
