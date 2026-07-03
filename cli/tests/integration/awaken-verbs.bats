#!/usr/bin/env bats

# awaken-verbs.bats — FR-195 (M1+M2) integration tests for the awaken verbs.
#
# Exercises the CLI bridge end-to-end via $CLI_BIN (L-330: producer verb TS +
# consumer index.ts bridge), NOT just the unit layer. Hermetic via
# IGRIS_BRAIN_DIR. The brain DB is seeded with `sqlite3` using the brain's
# authoritative DDL (sessions component schema v1+v2 + instances v4); only the
# tables M1/M2 touch are seeded (#287) — no *_vec tables.
#
# Covered:
#   M1: 1. `igris detect` emits valid JSON with the expected fields.
#       2. `igris session gather` on a seeded brain returns the expected handoff.
#       3. `igris session bogus` → exit 2.
#   M2: 4. `igris housekeeping` run-twice is idempotent (valid JSON both runs).
#       5. `igris assess` emits valid JSON with the D-A fields.
#   M3: 6. `igris boot-sync` with remote unconfigured → degraded, valid JSON, exit 0.
#       7. `igris boot-sync` with an unreachable remote → valid JSON, exit 0 (never blocks).

load _helpers.bash

# `run --separate-stderr` (the boot-sync unreachable-remote case) needs bats
# 1.5.0+; declare it so bats does not emit a BW02 warning.
bats_require_minimum_version 1.5.0

# seed_brain_db — create the knowledge.db with session_files + instances and
# (optionally) a genuine-handoff rested row owned by an absent instance.
seed_brain_db() {
  local db="$IGRIS_BRAIN_DIR/memory/knowledge.db"
  sqlite3 "$db" <<'SQL'
CREATE TABLE IF NOT EXISTS session_files (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project, filename)
);
ALTER TABLE session_files ADD COLUMN instance_id TEXT;
ALTER TABLE session_files ADD COLUMN state TEXT NOT NULL DEFAULT 'live'
  CHECK (state IN ('live','rested','archived'));

CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  machine_hostname TEXT NOT NULL,
  machine_os TEXT,
  project_slug TEXT,
  project_path TEXT,
  current_brief TEXT,
  current_phase TEXT,
  current_task TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','idle','stale')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}'
);

-- A genuine handoff: rested file whose owning instance is absent from the
-- registry. content carries the resume fields the digest parses.
INSERT INTO session_files (id, project, filename, content, content_hash, updated_at, instance_id, state)
VALUES ('h1', 'demo', 'instances/i-gone.md',
        '**Mode:** REST MODE' || char(10) || '**Resume Point:** wire the gather verb',
        'hash-h1', '2026-06-09 12:00:00', 'i-gone', 'rested');
SQL
}

setup() {
  stage_brain
}

@test "detect: emits valid JSON with expected fields" {
  run $CLI_BIN detect
  [ "$status" -eq 0 ]
  # Valid JSON parseable by node, with the documented keys.
  echo "$output" | node -e '
    let s = "";
    process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      const o = JSON.parse(s);
      for (const k of ["harness","project_slug","project_path","brain_root","brain_db","sqlite3","remote_brain","mode"]) {
        if (!(k in o)) { console.error("missing key: " + k); process.exit(1); }
      }
      process.exit(0);
    });
  '
}

@test "detect: reports degraded-no-db when no brain DB present" {
  # stage_brain creates memory/ but no knowledge.db file.
  run $CLI_BIN detect
  [ "$status" -eq 0 ]
  [[ "$output" == *'"mode":"degraded-no-db"'* ]]
  [[ "$output" == *'"brain_db":false'* ]]
}

@test "session gather: on a seeded brain returns the expected handoff" {
  seed_brain_db
  run $CLI_BIN session gather --project demo
  [ "$status" -eq 0 ]
  # The genuine handoff is selected and its resume point parsed.
  [[ "$output" == *'"fresh_start":false'* ]]
  [[ "$output" == *'instances/i-gone.md'* ]]
  [[ "$output" == *'wire the gather verb'* ]]
  [[ "$output" == *'"is_legacy":false'* ]]
  # Validate the digest shape via node too.
  echo "$output" | node -e '
    let s = "";
    process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      const o = JSON.parse(s);
      if (o.handoff === null) { console.error("handoff is null"); process.exit(1); }
      if (o.handoff.mode !== "REST MODE") { console.error("bad mode: " + o.handoff.mode); process.exit(1); }
      process.exit(0);
    });
  '
}

@test "session gather: empty seeded brain → fresh_start true" {
  # Seed the schema with NO rows.
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" <<'SQL'
CREATE TABLE IF NOT EXISTS session_files (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, filename TEXT NOT NULL,
  content TEXT NOT NULL, content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project, filename)
);
ALTER TABLE session_files ADD COLUMN instance_id TEXT;
ALTER TABLE session_files ADD COLUMN state TEXT NOT NULL DEFAULT 'live';
SQL
  run $CLI_BIN session gather --project demo
  [ "$status" -eq 0 ]
  [[ "$output" == *'"fresh_start":true'* ]]
}

@test "session <unknown>: returns exit 2" {
  run $CLI_BIN session bogus
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown session action"* ]] || [[ "$output" == *"Valid:"* ]]
}

# seed_legacy_for_housekeeping — a legacy CURRENT_SESSION.md row + its on-disk
# file so H0 has work to do the first run (then no-op the second).
seed_legacy_for_housekeeping() {
  local db="$IGRIS_BRAIN_DIR/memory/knowledge.db"
  sqlite3 "$db" <<'SQL'
CREATE TABLE IF NOT EXISTS session_files (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, filename TEXT NOT NULL,
  content TEXT NOT NULL, content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project, filename)
);
ALTER TABLE session_files ADD COLUMN instance_id TEXT;
ALTER TABLE session_files ADD COLUMN state TEXT NOT NULL DEFAULT 'live'
  CHECK (state IN ('live','rested','archived'));

-- A legacy row: CURRENT_SESSION.md with instance_id NULL, still live.
INSERT INTO session_files (id, project, filename, content, content_hash, updated_at, instance_id, state)
VALUES ('legacy', 'demo', 'CURRENT_SESSION.md', 'LEGACY BODY', 'hash-legacy',
        '2026-06-02 09:00:00', NULL, 'live');
SQL
  # On-disk legacy file at the live location.
  mkdir -p "$IGRIS_BRAIN_DIR/projects/demo/session"
  printf 'LEGACY BODY\n' > "$IGRIS_BRAIN_DIR/projects/demo/session/CURRENT_SESSION.md"
}

@test "housekeeping: run twice is idempotent (valid JSON both runs)" {
  seed_legacy_for_housekeeping

  # First run retires the legacy row.
  run $CLI_BIN housekeeping --project demo
  [ "$status" -eq 0 ]
  [[ "$output" == *'"h0_legacy_retired":true'* ]]
  echo "$output" | node -e '
    let s = ""; process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      const o = JSON.parse(s);
      for (const k of ["degraded","h0_legacy_retired","h1_archived","h2_rolled","h3_ceiling_rolled","noop"]) {
        if (!(k in o)) { console.error("missing key: " + k); process.exit(1); }
      }
      process.exit(0);
    });
  '
  # The legacy DB row is now archived.
  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" \
    "SELECT state FROM session_files WHERE filename='CURRENT_SESSION.md';"
  [ "$output" = "archived" ]

  # Second run is a no-op (already archived) — still valid JSON, exit 0.
  run $CLI_BIN housekeeping --project demo
  [ "$status" -eq 0 ]
  [[ "$output" == *'"h0_legacy_retired":false'* ]]
}

@test "assess: emits valid JSON with the D-A fields" {
  # Seed brief_status so the summary has counts; no goals/blockers needed.
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" <<'SQL'
CREATE TABLE IF NOT EXISTS brief_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, brief_id TEXT NOT NULL,
  brief_type TEXT, title TEXT NOT NULL, status TEXT NOT NULL, priority TEXT,
  effort TEXT, phase TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO brief_status (project, brief_id, title, status, priority)
VALUES ('demo', 'FR-1', 't1', 'Ready', 'P0');
SQL
  run $CLI_BIN assess --project demo
  [ "$status" -eq 0 ]
  echo "$output" | node -e '
    let s = ""; process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      const o = JSON.parse(s);
      for (const k of ["degraded","briefs","blockers","git","active_instances","goals_upcoming"]) {
        if (!(k in o)) { console.error("missing key: " + k); process.exit(1); }
      }
      // D-A guardrail: the omitted surfaces must NOT be present.
      for (const k of ["tasks","perception","recall","cross_project"]) {
        if (k in o) { console.error("unexpected key: " + k); process.exit(1); }
      }
      if (o.briefs.total !== 1) { console.error("bad brief total: " + o.briefs.total); process.exit(1); }
      process.exit(0);
    });
  '
}

@test "boot-sync: remote unconfigured → degraded, valid JSON, exit 0" {
  # stage_brain writes no config.json → readRemoteBrainConfig() is null.
  run $CLI_BIN boot-sync --project demo
  [ "$status" -eq 0 ]
  [[ "$output" == *'"degraded":true'* ]]
  [[ "$output" == *'remote unconfigured'* ]]
  echo "$output" | node -e '
    let s = ""; process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      const o = JSON.parse(s);
      for (const k of ["degraded","brain_pull","queue_drain","session_files_pulled","definitions_updated","skipped"]) {
        if (!(k in o)) { console.error("missing key: " + k); process.exit(1); }
      }
      if (o.brain_pull.ok !== false) { console.error("expected brain_pull.ok=false"); process.exit(1); }
      if (o.queue_drain.ok !== false) { console.error("expected queue_drain.ok=false"); process.exit(1); }
      process.exit(0);
    });
  '
}

@test "boot-sync: unreachable remote → valid JSON, exit 0 (never blocks)" {
  # Configure a remote that is not listening (port 1). Both parts skip-on-fail
  # but the verb still exits 0 with a clean, parseable digest.
  #
  # --separate-stderr: the digest is on STDOUT; the unreachable drain emits an
  # `error:` diagnostic to STDERR. bats merges streams into $output by default,
  # which would corrupt the JSON parse — so isolate stdout ($output) from
  # stderr ($stderr). This mirrors the real awaken contract: the skill reads
  # the verb's stdout (clean digest), stderr is operator diagnostics.
  printf '{"remote_brain":{"url":"http://127.0.0.1:1","api_key":"k"}}\n' \
    > "$IGRIS_BRAIN_DIR/config.json"
  run --separate-stderr $CLI_BIN boot-sync --project demo
  [ "$status" -eq 0 ]
  echo "$output" | node -e '
    let s = ""; process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      const o = JSON.parse(s);
      // degraded is false (remote IS configured) but the pull failed (unreachable).
      if (o.degraded !== false) { console.error("expected degraded=false"); process.exit(1); }
      if (o.brain_pull.ok !== false) { console.error("expected brain_pull.ok=false"); process.exit(1); }
      process.exit(0);
    });
  '
}
