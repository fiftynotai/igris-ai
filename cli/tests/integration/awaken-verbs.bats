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
#   TD-327: 8. `igris cognition health` on a brain with no roster → degraded, exit 0.
#           9. `igris cognition health` renders an instance the CLI never heard of.
#          10. `igris cognition bogus` → exit 2.
#   TD-423: 11. `igris cognition yield` on a brain with no roster → degraded, exit 0.
#           12. `igris cognition yield` scores an instance the CLI never heard of,
#               and reports one with no verdicts as unmeasured rather than zero.
#           13. `igris cognition bogus` names BOTH actions in its exit-2 message.

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
-- FR-190 liveness metadata. This DDL used to STOP at `metadata`, which meant
-- `registerOrUpdateInstanceState` silently took its legacy-columns compat path
-- here and wrote no owner metadata at all — so no liveness assertion in this
-- file could ever be more than vacuous (TD-411).
ALTER TABLE instances ADD COLUMN harness TEXT;
ALTER TABLE instances ADD COLUMN harness_session_id TEXT;
ALTER TABLE instances ADD COLUMN owner_pid INTEGER;
ALTER TABLE instances ADD COLUMN owner_started_at TEXT;
ALTER TABLE instances ADD COLUMN liveness_method TEXT;
ALTER TABLE instances ADD COLUMN liveness_status TEXT;
ALTER TABLE instances ADD COLUMN liveness_checked_at TEXT;
ALTER TABLE instances ADD COLUMN lease_expires_at TEXT;
ALTER TABLE instances ADD COLUMN state_updated_at TEXT;

-- A genuine handoff: rested file whose owning instance is absent from the
-- registry. content carries the resume fields the digest parses.
INSERT INTO session_files (id, project, filename, content, content_hash, updated_at, instance_id, state)
VALUES ('h1', 'demo', 'instances/i-gone.md',
        '**Mode:** REST MODE' || char(10) || '**Resume Point:** wire the gather verb',
        'hash-h1', '2026-06-09 12:00:00', 'i-gone', 'rested');
SQL
}

# unset_harness_markers — clear EVERY env var `inferHarness` reads, plus the
# owner-pid override, so a run hosted inside a live harness behaves exactly
# like CI (TD-299 precedent, and TD-411 made it load-bearing: the owner-identity
# walk branches on the inferred harness).
#
# The list is DERIVED from the shipped table rather than hand-copied here, so a
# harness added to `HARNESS_MARKER_TABLE` cannot leave this fixture stale.
unset_harness_markers() {
  local marker
  for marker in $(node -e '
    import(process.argv[1] + "/lib/detect.js")
      .then((d) => console.log(d.HARNESS_ENV_MARKERS.join(" ")));
  ' "$CLI_DIST"); do
    unset "$marker"
  done
  unset IGRIS_INSTANCE_OWNER_PID
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

# TD-411 — THE end-to-end red. This is the only layer where the DEAD-PARENT
# CONDITION reproduces.
#
# Stated narrowly on purpose. It is NOT the only layer that would catch a
# reintroduced `process.ppid` fallback. Re-measured 2026-08-21 by mutation
# (replacing ALL THREE of tier 2's null-guards — `if (entry === undefined)`,
# `if (table === null)` and `if (pid === null)` — with `walked ?? process.ppid`;
# mutating only the last one measures 0 red, because under a live harness
# `walked` is never null and the no-marker tests return at the FIRST guard), that defect also reddens 6 of the 56 vitest tests
# across `process-liveness.test.ts`, `session-register.test.ts` and
# `session-gather.test.ts`. What those 56 cannot reproduce is the CONDITION:
# under vitest the test-pool parent is long-lived, so the pre-fix
# `owner_pid = process.ppid` was ALIVE and every downstream liveness assertion
# passed on the broken code. That is why the vitest reds sit on the RESOLVER's
# return value, while the observable consequence — an instance landing in
# `crashed[]` — can only be shown here.
#
# The condition needs a parent that really exits: the per-tool-call shell
# every harness spawns. `bash -c` with TWO commands gives exactly that (a
# single-command `bash -c` is exec-optimised into the CLI process itself,
# which would silently destroy the fixture).
@test "session register in a TRANSIENT shell: gather does NOT report it crashed (TD-411)" {
  seed_brain_db
  unset_harness_markers

  local pidfile="$BATS_TEST_TMPDIR/parent.pid"
  run env CLI_INNER="$CLI_BIN" PIDFILE="$pidfile" \
    bash -c 'echo $$ > "$PIDFILE"; $CLI_INNER session register --project demo'
  [ "$status" -eq 0 ]

  local iid
  iid="$(printf '%s' "$output" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => process.stdout.write(JSON.parse(s.trim()).instance_id));
  ')"
  [ -n "$iid" ] || return 1

  local parent_pid
  parent_pid="$(cat "$pidfile")"
  [ -n "$parent_pid" ] || return 1

  # ARM CHECK. Everything below is vacuous unless that shell is genuinely gone;
  # a fixture that quietly stopped being transient would turn this whole test
  # into a false green, which is precisely how TD-411 survived until now.
  run kill -0 "$parent_pid"
  [ "$status" -ne 0 ] || return 1

  # The load-bearing assertion: the dead shell was NOT recorded as the owner.
  # Before the fix this row read "<parent_pid>|dead".
  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" \
    "SELECT ifnull(owner_pid,'NULL') || '|' || ifnull(liveness_status,'NULL')
       FROM instances WHERE id = '$iid';"
  [ "$status" -eq 0 ]
  [ "$output" = "NULL|unknown_no_metadata" ]

  # And the observable consequence the operator actually reads (D-411-c): an
  # unclassifiable instance renders as a SIBLING, never as a crashed scratchpad
  # an operator might reclaim.
  run $CLI_BIN session gather --project demo
  [ "$status" -eq 0 ]
  printf '%s' "$output" | IGRIS_TEST_IID="$iid" node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      const o = JSON.parse(s.trim());
      const id = process.env.IGRIS_TEST_IID;
      if (o.crashed.some((c) => c.instance_id === id)) {
        console.error("REGRESSION: the live instance is in crashed[]: " + id);
        process.exit(1);
      }
      const self = o.siblings.find((x) => x.instance_id === id);
      if (!self) {
        console.error("the instance is in neither list; siblings=" +
          JSON.stringify(o.siblings.map((x) => x.instance_id)));
        process.exit(1);
      }
      if (self.liveness_status !== "unknown_no_metadata") {
        console.error("bad liveness_status: " + self.liveness_status);
        process.exit(1);
      }
      process.exit(0);
    });
  '
}

# The tier-1 escape hatch, end-to-end: an explicit override still wins, so the
# seam TD-411 kept (rather than deleted) is proven reachable and not dead code.
@test "session register: IGRIS_INSTANCE_OWNER_PID overrides the walk (TD-411 tier 1)" {
  seed_brain_db
  unset_harness_markers

  # $$ is this bats process — guaranteed alive for the duration of the test.
  local owner="$$"
  run env IGRIS_INSTANCE_OWNER_PID="$owner" CLI_INNER="$CLI_BIN" \
    bash -c '$CLI_INNER session register --project demo; :'
  [ "$status" -eq 0 ]

  local iid
  iid="$(printf '%s' "$output" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => process.stdout.write(JSON.parse(s.trim()).instance_id));
  ')"
  [ -n "$iid" ] || return 1

  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" \
    "SELECT ifnull(owner_pid,'NULL') || '|' || ifnull(liveness_status,'NULL')
       FROM instances WHERE id = '$iid';"
  [ "$status" -eq 0 ]
  # `alive` here is DERIVED (D-411-d), not stamped: the override names a pid
  # that really is running with the recorded start time.
  [ "$output" = "$owner|alive" ]
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

@test "cognition health: no roster projection → degraded, valid JSON, exit 0" {
  # stage_brain creates memory/ but no knowledge.db. A health question must
  # never block session start, so this is exit 0 with a NAMED reason.
  run $CLI_BIN cognition health
  [ "$status" -eq 0 ]
  echo "$output" | node -e '
    let s = ""; process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      const o = JSON.parse(s);
      for (const k of ["degraded","degraded_reason","hostname","event_log_retention_days","instances","warnings"]) {
        if (!(k in o)) { console.error("missing key: " + k); process.exit(1); }
      }
      if (o.degraded !== true) { console.error("expected degraded=true"); process.exit(1); }
      if (o.instances.length !== 0) { console.error("expected an empty roster"); process.exit(1); }
      process.exit(0);
    });
  '
}

@test "cognition health: renders an instance the CLI has never heard of" {
  # THE DERIVATION PROOF, end-to-end through the built CLI. `roadmap_drift`
  # appears nowhere in cli/src — the roster is read out of the brain's own
  # projection of its OPEN registry, so a new extractor needs no CLI edit.
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" <<'SQL'
-- DUPLICATED DDL — schema.ts#cognitionMigrations is the SOURCE OF TRUTH.
-- This arm drives the CLI end-to-end without booting the engine, so it hand-
-- writes the table. A column added to the migration will NOT drift-fail here.
-- Mitigated rather than solved: readCognitionRoster reads tolerantly and
-- withReadonlyBrain degrades, so a shape change surfaces as a degraded digest
-- rather than a crash. If this drifts often enough to hurt, export the DDL.
-- `produced` is migration v2 (TD-423).
CREATE TABLE IF NOT EXISTS cognition_instances (
  id TEXT PRIMARY KEY, component TEXT NOT NULL, event_prefix TEXT NOT NULL,
  gate_keys TEXT NOT NULL, gate_default INTEGER NOT NULL DEFAULT 0,
  driver TEXT NOT NULL, driver_ref TEXT,
  output TEXT NOT NULL, produced TEXT NOT NULL DEFAULT '',
  registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO cognition_instances (id, component, event_prefix, gate_keys, gate_default, driver, driver_ref, output, produced)
VALUES ('roadmap_drift', 'cognition.roadmap_drift', 'cognition.roadmap_drift',
        '["cognition.roadmap_drift.enabled"]', 0, 'manual', NULL,
        'suggestions[source_module=''roadmap_drift'']',
        'suggestions[source_module=''roadmap_drift'']');
SQL
  printf '{"cognition":{"roadmap_drift":{"enabled":true}}}\n' > "$IGRIS_BRAIN_DIR/config.json"

  run $CLI_BIN cognition health
  [ "$status" -eq 0 ]
  echo "$output" | node -e '
    let s = ""; process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      const o = JSON.parse(s);
      if (o.degraded !== false) { console.error("expected degraded=false"); process.exit(1); }
      const inst = o.instances.find(i => i.id === "roadmap_drift");
      if (!inst) { console.error("roadmap_drift absent from the digest"); process.exit(1); }
      if (inst.enabled !== true) { console.error("expected enabled=true"); process.exit(1); }
      // No events at all, and the purge window makes absence unprovable — so
      // the verdict must be no_signal, never "never ran".
      if (inst.status !== "no_signal") { console.error("bad status: " + inst.status); process.exit(1); }
      process.exit(0);
    });
  '
}

@test "cognition yield: no roster projection → degraded, valid JSON, exit 0" {
  # TD-423. Same posture as its liveness sibling: a yield question is still a
  # question, and a question never blocks session start.
  run $CLI_BIN cognition yield
  [ "$status" -eq 0 ]
  echo "$output" | node -e '
    let s = ""; process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      const o = JSON.parse(s);
      for (const k of ["degraded","degraded_reason","hostname","judged_channels","channels","instances","warnings"]) {
        if (!(k in o)) { console.error("missing key: " + k); process.exit(1); }
      }
      if (o.degraded !== true) { console.error("expected degraded=true"); process.exit(1); }
      if (o.instances.length !== 0) { console.error("expected an empty roster"); process.exit(1); }
      // The CLOSED half of the stated bound reaches the wire even when degraded:
      // a reader must be able to see WHICH tables a judgment model exists for.
      if (!Array.isArray(o.judged_channels) || o.judged_channels.length === 0) {
        console.error("judged_channels absent from the degraded digest"); process.exit(1);
      }
      process.exit(0);
    });
  '
}

@test "cognition yield: scores an instance the CLI has never heard of" {
  # THE DERIVATION PROOF for yield, end-to-end through the built CLI.
  # `roadmap_drift` appears nowhere in cli/src; its `produced` predicate is read
  # out of the brain's own projection, so a new extractor is SCORED with no CLI
  # edit — not merely listed.
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" <<'SQL'
-- DUPLICATED DDL — schema.ts#cognitionMigrations v1 + v2 is the SOURCE OF TRUTH.
CREATE TABLE IF NOT EXISTS cognition_instances (
  id TEXT PRIMARY KEY, component TEXT NOT NULL, event_prefix TEXT NOT NULL,
  gate_keys TEXT NOT NULL, gate_default INTEGER NOT NULL DEFAULT 0,
  driver TEXT NOT NULL, driver_ref TEXT,
  output TEXT NOT NULL, produced TEXT NOT NULL DEFAULT '',
  registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source_module TEXT NOT NULL,
  project_slug TEXT, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','dismissed','acted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT, dismissed_at TEXT, acted_at TEXT,
  type_inferred INTEGER NOT NULL DEFAULT 0
);
INSERT INTO cognition_instances (id, component, event_prefix, gate_keys, gate_default, driver, driver_ref, output, produced)
VALUES ('roadmap_drift', 'cognition.roadmap_drift', 'cognition.roadmap_drift',
        '["cognition.roadmap_drift.enabled"]', 0, 'manual', NULL,
        'suggestions[source_module=''roadmap_drift'']',
        'suggestions[source_module=''roadmap_drift'']'),
       ('quiet_one', 'cognition.quiet_one', 'cognition.quiet_one',
        '["cognition.quiet_one.enabled"]', 0, 'manual', NULL,
        'suggestions[source_module=''quiet_one'']',
        'suggestions[source_module=''quiet_one'']');
-- roadmap_drift: 2 rows, both acted. quiet_one: 1 row, nobody has looked at it.
INSERT INTO suggestions (source_module, title, status, type_inferred)
VALUES ('roadmap_drift','a','acted',1), ('roadmap_drift','b','acted',1),
       ('quiet_one','c','pending',1), ('legacy_orphan','d','pending',0);
SQL
  printf '{"cognition":{"roadmap_drift":{"enabled":true}}}\n' > "$IGRIS_BRAIN_DIR/config.json"

  run $CLI_BIN cognition yield
  [ "$status" -eq 0 ]
  echo "$output" | node -e '
    let s = ""; process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      const o = JSON.parse(s);
      if (o.degraded !== false) { console.error("expected degraded=false"); process.exit(1); }

      const drift = o.instances.find(i => i.id === "roadmap_drift");
      if (!drift) { console.error("roadmap_drift absent from the digest"); process.exit(1); }
      if (drift.produced_rows !== 2) { console.error("produced_rows: " + drift.produced_rows); process.exit(1); }
      if (drift.kept !== 2) { console.error("kept: " + drift.kept); process.exit(1); }
      if (drift.measured !== true) { console.error("expected measured=true"); process.exit(1); }

      // AC-7 end-to-end: rows produced, no verdicts, so the RATE is unmeasured
      // and null — never a zero score.
      const quiet = o.instances.find(i => i.id === "quiet_one");
      if (!quiet) { console.error("quiet_one absent"); process.exit(1); }
      if (quiet.produced_rows !== 1) { console.error("quiet produced: " + quiet.produced_rows); process.exit(1); }
      if (quiet.measured !== false) { console.error("expected quiet_one unmeasured"); process.exit(1); }
      if (quiet.keep_rate_of_judged.value !== null) { console.error("expected a null keep rate"); process.exit(1); }

      // AC-3 structurally: every rate names its denominator.
      for (const inst of o.instances) {
        for (const k of ["judged_share_of_produced","keep_rate_of_judged","pending_share_of_queue","expiry_share_of_produced"]) {
          const r = inst[k];
          if (r === null) continue;
          if (typeof r.denominator_label !== "string" || r.denominator_label.length === 0) {
            console.error(inst.id + "." + k + " has no denominator_label"); process.exit(1);
          }
        }
      }

      // D8: the row no roster predicate claims is found as a COMPLEMENT — the
      // bats fixture never names `legacy_orphan` to the verb.
      const unclaimed = o.instances.find(i => i.id === "(unclaimed:suggestions)");
      if (!unclaimed) { console.error("no unclaimed bucket"); process.exit(1); }
      if (unclaimed.produced_rows !== 1) { console.error("unclaimed: " + unclaimed.produced_rows); process.exit(1); }

      const ch = o.channels.find(c => c.table === "suggestions");
      if (!ch || ch.reconciled !== true) { console.error("suggestions did not reconcile"); process.exit(1); }
      process.exit(0);
    });
  '
}

@test "cognition <unknown>: returns exit 2, and the message names both actions" {
  run $CLI_BIN cognition bogus
  [ "$status" -eq 2 ]
  # The message is the only discovery surface for a HIDDEN command, so it must
  # name every action rather than just refusing.
  [[ "$output" == *"health, yield"* ]] || return 1
}
