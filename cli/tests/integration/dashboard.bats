#!/usr/bin/env bats
# FR-238 — `igris dashboard` lifecycle + the PACK-EXTRACT PACKAGING SMOKE.
#
# The pack-extract test (T8) is the packaging AC's only automated proof. R1 says
# the failure modes live in the `files` glob, `prepublishOnly` ordering, asset
# base paths, and `import.meta.url` resolution under a global npm prefix — none
# of which a unit test can reach. Packing the real package, extracting it to a
# temp dir with NO node_modules, and running the extracted binary is as close to
# `npm i -g` as CI can get without a container.
#
# The remaining manual gate (T11 — a genuine global install on a clean machine)
# is a Phase-5 operator checkpoint, documented in docs/dashboard.md.

load '_helpers'

setup() {
  stage_brain
  HOME_SANDBOX="$(stage_home)"
  export HOME="$HOME_SANDBOX"
}

teardown() {
  # Never leave a listener or a lock behind, even on a failed assertion.
  if [ -n "${DASH_PID:-}" ] && kill -0 "$DASH_PID" 2>/dev/null; then
    kill -TERM "$DASH_PID" 2>/dev/null || true
    wait "$DASH_PID" 2>/dev/null || true
  fi
  rm -f "$IGRIS_BRAIN_DIR/dashboard.lock"
}

# --- helpers ---------------------------------------------------------------

# free_port — an OS-assigned free TCP port, so tests never squat 7317 (the
# operator may have a real dashboard open).
#
# TD-355 — `process.stdout.write`, NOT `console.log`. This is a DATA channel
# (the value is captured by `port="$(free_port)"` and passed to `--port`), and
# `console.log` is a display API: it routes any non-string argument through
# `util.inspect`, which colorizes. `s.address().port` is a NUMBER, so under
# `FORCE_COLOR` (set in the operator's shell) node emitted colour even to a
# pipe and the port reached the CLI as `<ESC>[33m55890<ESC>[39m`, which the
# --port validator correctly rejected. Measured on node v22.23.2:
#   FORCE_COLOR=3 node -e 'console.log(12345)'                 -> ^[[33m12345^[[39m
#   FORCE_COLOR=3 node -e 'process.stdout.write(12345+"\n")'   -> 12345
# `console.log(String(p))` is equally plain (measured). `process.stdout.write`
# is used instead because it FAILS LOUD on the shape that caused this bug:
#   node -e 'process.stdout.write(12345)'  -> TypeError [ERR_INVALID_ARG_TYPE]
#   node -e 'console.log(12345)'           -> 12345, silently inspect-formatted
# i.e. a future edit that hands `write()` a non-string ARGUMENT — one that
# drops the `+ "\n"`, say — throws instead of quietly re-entering the
# colouring path. Note `p` is itself a non-string TODAY (it is a number) and
# this line does not throw, because `p + "\n"` coerces it; the loud-failure
# property belongs to write()'s signature and is armed only when nothing
# coerces. So the residual: if `s.address().port` ever yields an object, this
# emits `[object Object]` silently. That residual is DETECTED — the regression
# test's `[[ "$port" =~ ^[0-9]+$ ]]` assertion reddens on it.
# That is a claim about THIS line only;
# the regression test "TD-355: free_port emits a bare integer under
# FORCE_COLOR" below is what actually re-checks the emitted bytes.
#
# SCOPE OF "one exposed site", so a reader is not surprised: one exposed DATA
# channel. Colorized numbers DO still survive in this file — a dozen-ish
# `console.log`/`console.error` diagnostics pass a number as an argument.
# Enumerate them rather than trusting a count written here, which would rot at
# the next edit with nothing to detect the rot:
#   grep -nE "console\.(log|error)\(" dashboard.bats
# The clearest example is `get_json`'s error path, `console.error('status',
# r.statusCode, …)` — `r.statusCode` is a NUMBER, measured emitting
# `status ^[[33m404^[[39m body` under FORCE_COLOR=3.
#
# WHY THEY CHANGE NO VERDICT — and NOT for the reason you might assume. They
# are NOT "uncaptured": bats `run` MERGES stderr into `$output`, and this file
# DEPENDS on that merge — the `--port` rejection test greps "must be an
# integer" out of `$output`, and cli/src/lib/log.ts's `error()` writes it with
# process.stderr.write. The actual mechanism is the STATUS GATE: every
# `run get_json` call site is immediately followed by `[ "$status" -eq 0 ]`
# and the error path exits 1, so a colorized diagnostic cannot reach an
# assertion that a non-zero status has not already failed. Measured 8/8 at the
# time of writing; re-check with
#   grep -A1 -n "run get_json" dashboard.bats
#
# NOTE the whole-suite FORCE_COLOR=3-vs-unset name-set identity is only WEAK
# support for this particular claim: under the standing better-sqlite3 ABI
# breakage that error path plausibly never executes, so the equivalence is
# CONSISTENT with the claim rather than a measurement of it. The status gate
# is what makes it true.
#
# NEAR MISS, worth knowing before you tidy anything: the T4 probe-summary
# helper emits numbers into a stream that IS asserted on (its "N read paths
# all 200, M write path 400" summary line is grepped — quoted by SHAPE, so
# this comment is not a second, ungated mirror of the figure the assertion
# below carries), and is safe ONLY because it
# builds that string by concatenation. Rewriting it to comma-separated console
# arguments re-arms exactly this bug on an asserted channel.
#
# Left as-is deliberately; do not read "one exposed site" as "nothing in this
# file ever colorizes a number".
free_port() {
  node -e '
    const s = require("node:net").createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => process.stdout.write(p + "\n")); });
  '
}

# wait_for_url <url> — poll until it answers 200, up to ~10s.
wait_for_url() {
  local url="$1" i
  for i in $(seq 1 50); do
    if node -e "
      require('node:http').get('$url', {agent:false}, r => process.exit(r.statusCode === 200 ? 0 : 1))
        .on('error', () => process.exit(1));
    " 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

# --- TD-355 — the helper's own regression gate -----------------------------

@test "TD-355: free_port emits a bare integer under FORCE_COLOR" {
  # SELF-ARMING. This test EXPORTS FORCE_COLOR itself rather than inheriting it,
  # so it is the same verdict whether or not the caller's shell sets it — and so
  # that a future central `unset FORCE_COLOR` in _helpers.bash could not turn
  # `FORCE_COLOR=3 npm run test:bats` into a vacuous green.
  #
  # SCOPE — this asserts ONE helper, `free_port`. It says nothing about the
  # other node invocations in this file or elsewhere in the test tree; those
  # were classified by hand at TD-355 and are recorded in the brief, not here.
  local esc; esc=$'\033'
  export FORCE_COLOR=3

  # ARM CHECK — prove colour actually reaches a child `node` in this
  # environment. If this probe comes back plain, FORCE_COLOR is not taking
  # effect and the assertion below would pass for the wrong reason, so treat a
  # disarmed probe as a hard failure rather than a pass.
  local probe; probe="$(node -e 'console.log(12345)')"
  if [[ "$probe" != *"$esc"* ]]; then
    echo "ARM CHECK FAILED: node emitted no ANSI escape for console.log(12345)" >&2
    echo "  under FORCE_COLOR=3 (got '$probe'). This test cannot detect the" >&2
    echo "  TD-355 defect in this environment." >&2
    return 1
  fi

  # THE ASSERTION — free_port called exactly the way every test calls it.
  local port; port="$(free_port)"
  if [[ "$port" == *"$esc"* ]]; then
    echo "free_port leaked an ANSI escape: $(printf '%s' "$port" | cat -v)" >&2
    return 1
  fi
  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  [ "$port" -ge 1 ]
  [ "$port" -le 65535 ]
}

# --- T1/T3 — smoke mode ----------------------------------------------------

@test "dashboard --smoke exits 0 and prints a JSON digest" {
  local port; port="$(free_port)"
  run $CLI_BIN dashboard --smoke --no-open --port "$port"
  [ "$status" -eq 0 ]
  echo "$output" | grep '"ok": true' >/dev/null
  echo "$output" | grep '"bundle_present": true' >/dev/null
  # Every probed path must be 200 — including /api/graph/stats, which must
  # DEGRADE cleanly rather than error on this empty sandboxed brain.
  echo "$output" | grep '"/api/health"' >/dev/null
  echo "$output" | grep '"/api/graph/stats"' >/dev/null
  [ "$(echo "$output" | grep -c '"ok": false')" -eq 0 ]
}

@test "dashboard --smoke probes EVERY documented endpoint path (row 108)" {
  # THE ANTI-DRIFT CASE. `SMOKE_PROBE_PATHS` in `cli/src/verbs/dashboard.ts` is
  # the digest's path list; MAINTAINING row 108 and `docs/dashboard.md`'s API
  # table are its prose twins. A path added to `server.ts` and forgotten here
  # ships with no end-to-end probe at all — which is what happened to
  # `/api/graph` between FR-239 and FR-240.
  #
  # Asserted as an EXACT set, not a subset: a subset check passes while the list
  # rots, and `grep -c` on a superset would too.
  local port; port="$(free_port)"
  run $CLI_BIN dashboard --smoke --no-open --port "$port"
  [ "$status" -eq 0 ]

  # FR-241 adds TWO entries: the triage READ half (`/api/suggestions`) and the
  # WRITE half, which is listed as `POST /api/triage` because the digest records
  # the METHOD for it. That prefix is load-bearing here — it is what makes the
  # set-equality check able to tell "the write path is probed" from "some other
  # GET was added", and it is why the block below can single the POST out.
  # FR-246 adds exactly ONE: `/api/briefs/search`. Goals, context docs,
  # suggestions and candidates gained a `q` PARAMETER on paths that already
  # exist, which is why this set moves once rather than five times.
  # FR-248 adds exactly ONE more: `/api/search`, the fused cross-layer surface.
  # Its ROW SHAPE is new (mixed row types plus a per-layer availability block),
  # which is what makes it a new path rather than a `&layers=` parameter on
  # `/api/briefs/search` — FR-246's own rule, applied. It sorts between
  # `/api/projects` and `/api/suggestions`.
  # FR-266 adds exactly ONE more: `/api/cognition`, the diagnostics spine's read.
  # It takes NO parameters at all — the digest is per-MACHINE and per-REGISTRY,
  # so there is no project axis to scope it to — which is why it is a path rather
  # than a parameter on anything. It sorts between `/api/briefs/search` and
  # `/api/context-doc`.
  local expected="/ /api/brief /api/briefs /api/briefs/search /api/cognition /api/context-doc /api/context-docs /api/goal /api/goals /api/graph /api/graph/stats /api/health /api/learning /api/learnings /api/learnings/search /api/projects /api/search /api/suggestions /api/summary POST /api/triage"
  local actual
  actual="$(echo "$output" | node -e "
    let s=''; process.stdin.on('data',c=>s+=c).on('end',()=>{
      const d = JSON.parse(s);
      console.log(d.checks.map(c => c.path).sort().join(' '));
    });
  ")"
  if [ "$actual" != "$expected" ]; then
    echo "probe list drifted." >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    return 1
  fi

  # Every READ path 200s on a brain that does not exist yet (the FR-238 degraded
  # contract), and the ONE WRITE path 400s.
  #
  # FR-241 — THE INVERTED EXPECTATION IS ASSERTED, NOT SMUGGLED. `POST
  # /api/triage` is probed with `{"action":"__invalid__"}`, so a **400** is the
  # PASS: it proves the POST was routed, cleared the Host/Origin/Content-Type
  # fences, was read and reached the body parser — while mutating nothing, which
  # is what keeps `--smoke` safe to run against the operator's real brain. A 200
  # would mean `__invalid__` resolved to a brain tool, and that is precisely the
  # outcome this gate must fail on. Folding it into a blanket "all 200" (or
  # excluding it from the check) would make the write probe unfalsifiable.
  run node -e "
    let s=''; process.stdin.on('data',c=>s+=c).on('end',()=>{
      const d = JSON.parse(s);
      const reads = d.checks.filter(c => !c.path.startsWith('POST '));
      const writes = d.checks.filter(c => c.path.startsWith('POST '));
      const badReads = reads.filter(c => c.status !== 200);
      if (badReads.length > 0) { console.error('non-200 read:', JSON.stringify(badReads)); process.exit(1); }
      if (writes.length !== 1) { console.error('expected exactly 1 write probe, got ' + writes.length); process.exit(1); }
      if (writes[0].path !== 'POST /api/triage') { console.error('unexpected write probe: ' + writes[0].path); process.exit(1); }
      if (writes[0].status !== 400) { console.error('write probe must 400 on an invalid action, got ' + writes[0].status); process.exit(1); }
      if (writes[0].ok !== true) { console.error('write probe ok flag must be true on a 400'); process.exit(1); }
      console.log(reads.length + ' read paths all 200, ' + writes.length + ' write path 400');
    });
  " <<< "$output"
  [ "$status" -eq 0 ]
  # 16 -> 17 -> 18 -> 19: FR-246 added `/api/briefs/search`, FR-248 added
  # `/api/search` and FR-266 added `/api/cognition`, one path each. This count is
  # the digest's OWN summary line, computed from `reads.length` above — so it is
  # a SECOND place the endpoint count is spelled out, and the exact-set assertion
  # earlier in this test does not cover it.
  echo "$output" | grep '19 read paths all 200, 1 write path 400' >/dev/null
}

@test "dashboard --smoke releases the lock on exit" {
  local port; port="$(free_port)"
  run $CLI_BIN dashboard --smoke --no-open --port "$port"
  [ "$status" -eq 0 ]
  [ ! -f "$IGRIS_BRAIN_DIR/dashboard.lock" ]
}

@test "dashboard --smoke digest reports the resolved bundle dir" {
  local port; port="$(free_port)"
  run $CLI_BIN dashboard --smoke --no-open --port "$port"
  [ "$status" -eq 0 ]
  echo "$output" | grep '"bundle_dir"' >/dev/null
  echo "$output" | grep 'dist/dashboard' >/dev/null
}

# --- T5 — lifecycle + single instance --------------------------------------

@test "a foreground instance writes the lock, serves, and SIGTERM releases it" {
  local port; port="$(free_port)"
  $CLI_BIN dashboard --no-open --port "$port" >/dev/null 2>&1 &
  DASH_PID=$!

  run wait_for_url "http://127.0.0.1:$port/api/health"
  [ "$status" -eq 0 ]

  [ -f "$IGRIS_BRAIN_DIR/dashboard.lock" ]
  run node -e "
    // NOT require(): node picks a loader by extension, and a '.lock' file is
    // handed to the JS loader, where a JSON object literal is a syntax error.
    const l = JSON.parse(require('node:fs').readFileSync('$IGRIS_BRAIN_DIR/dashboard.lock', 'utf-8'));
    if (l.port !== $port) { console.error('port mismatch', l.port); process.exit(1); }
    if (typeof l.pid !== 'number') process.exit(1);
    if (!l.url.startsWith('http://127.0.0.1:')) process.exit(1);
  "
  [ "$status" -eq 0 ]

  kill -TERM "$DASH_PID"
  wait "$DASH_PID" || true
  DASH_PID=""

  [ ! -f "$IGRIS_BRAIN_DIR/dashboard.lock" ]
}

@test "a second invocation re-opens the running instance and does NOT bind a second port" {
  local port; port="$(free_port)"
  $CLI_BIN dashboard --no-open --port "$port" >/dev/null 2>&1 &
  DASH_PID=$!
  run wait_for_url "http://127.0.0.1:$port/api/health"
  [ "$status" -eq 0 ]

  # Second invocation: must exit 0 immediately, report the RUNNING url, and
  # leave the first instance's lock (same pid) untouched.
  run $CLI_BIN dashboard --no-open
  [ "$status" -eq 0 ]
  echo "$output" | grep "already running" >/dev/null
  echo "$output" | grep "http://127.0.0.1:$port/" >/dev/null

  run node -e "
    const l = JSON.parse(require('node:fs').readFileSync('$IGRIS_BRAIN_DIR/dashboard.lock', 'utf-8'));
    if (l.pid !== $DASH_PID) { console.error('lock stolen:', l.pid, 'expected', $DASH_PID); process.exit(1); }
  "
  [ "$status" -eq 0 ]

  # And the first instance is still serving.
  run wait_for_url "http://127.0.0.1:$port/api/health"
  [ "$status" -eq 0 ]

  kill -TERM "$DASH_PID"; wait "$DASH_PID" || true; DASH_PID=""
}

@test "a STALE lock (dead pid) is reclaimed rather than wedging the verb" {
  # Seed a lock for a pid that is guaranteed dead.
  local dead; dead="$(node -e '
    const cp = require("node:child_process");
    const r = cp.spawnSync("sh", ["-c", "echo $$"], {encoding: "utf-8"});
    console.log(r.stdout.trim());
  ')"
  cat > "$IGRIS_BRAIN_DIR/dashboard.lock" <<EOF
{ "pid": $dead, "port": 65000, "url": "http://127.0.0.1:65000/",
  "started_at": "2001-01-01T00:00:00.000Z",
  "process_start_time": "Mon Jan  1 00:00:00 2001" }
EOF

  local port; port="$(free_port)"
  run $CLI_BIN dashboard --smoke --no-open --port "$port"
  [ "$status" -eq 0 ]
  echo "$output" | grep '"ok": true' >/dev/null
}

@test "a MALFORMED lock is reclaimed, never fatal" {
  printf '{ not json' > "$IGRIS_BRAIN_DIR/dashboard.lock"
  local port; port="$(free_port)"
  run $CLI_BIN dashboard --smoke --no-open --port "$port"
  [ "$status" -eq 0 ]
}

@test "an explicit --port that is taken HARD-FAILS (never silently reassigned)" {
  local port; port="$(free_port)"
  $CLI_BIN dashboard --no-open --port "$port" >/dev/null 2>&1 &
  DASH_PID=$!
  run wait_for_url "http://127.0.0.1:$port/api/health"
  [ "$status" -eq 0 ]

  # Remove the lock so the single-instance guard does not short-circuit — we
  # want the BIND to be the thing that fails, which is the contract under test.
  rm -f "$IGRIS_BRAIN_DIR/dashboard.lock"

  run $CLI_BIN dashboard --no-open --port "$port" --smoke
  [ "$status" -eq 1 ]
  echo "$output" | grep "in use" >/dev/null

  # Restore so teardown's kill still cleans up predictably.
  kill -TERM "$DASH_PID"; wait "$DASH_PID" || true; DASH_PID=""
}

@test "--port rejects a non-numeric value with exit 2" {
  run $CLI_BIN dashboard --no-open --port abc --smoke
  [ "$status" -eq 2 ]
  echo "$output" | grep "must be an integer" >/dev/null
}

# --- degraded brain --------------------------------------------------------

# --- T22 (FR-239) — /api/graph on a seeded brain and on a missing one ------
#
# The node/edge endpoint is the one surface where the CLI, the vendored FR-237
# builder, and a real `better-sqlite3` handle all have to line up in an
# INSTALLED layout. A unit test drives the same code path, but only this one
# proves the bridge still resolves when the verb is launched as a real process.

@test "T22: /api/graph serves node and edge arrays from a seeded brain" {
  # A minimal real brain: two briefs and one edge between them.
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE brief_status (
      brief_id TEXT PRIMARY KEY, project TEXT NOT NULL, brief_type TEXT,
      title TEXT, status TEXT NOT NULL, priority TEXT, effort TEXT,
      phase TEXT, updated_at TEXT
    );
    INSERT INTO brief_status VALUES
      ('FR-1','alpha','Feature','First','pending','P1-High','M',NULL,'2026-07-01'),
      ('FR-2','alpha','Feature','Second','pending','P2-Medium','S',NULL,'2026-07-02');
    CREATE TABLE entity_edges (
      id INTEGER PRIMARY KEY, from_type TEXT, from_id TEXT, to_type TEXT,
      to_id TEXT, edge_type TEXT, confidence REAL, provenance TEXT,
      metadata TEXT DEFAULT '{}'
    );
    INSERT INTO entity_edges VALUES
      (1,'brief','FR-1','brief','FR-2','parent_of',0.9,'observed','{}');
  "

  local port; port="$(free_port)"
  $CLI_BIN dashboard --no-open --port "$port" >/dev/null 2>&1 &
  DASH_PID=$!
  run wait_for_url "http://127.0.0.1:$port/api/health"
  [ "$status" -eq 0 ]

  run node -e "
    require('node:http').get('http://127.0.0.1:$port/api/graph', {agent:false}, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => {
        if (r.statusCode !== 200) { console.error('status', r.statusCode); process.exit(1); }
        const g = JSON.parse(b);
        if (!Array.isArray(g.nodes) || g.nodes.length !== 2) { console.error('nodes', g.nodes && g.nodes.length); process.exit(1); }
        if (!Array.isArray(g.edges) || g.edges.length !== 1) { console.error('edges', g.edges && g.edges.length); process.exit(1); }
        // The composite key is the builder's, not a bare id.
        if (g.nodes[0].key !== 'brief|alpha|FR-1') { console.error('key', g.nodes[0].key); process.exit(1); }
        // Exemption 04 — the twin is composed SERVER-side and always ships.
        if (!g.query || g.query.surface !== 'igris-brain-graph') { console.error('twin', JSON.stringify(g.query)); process.exit(1); }
        if (g.query.as_of !== g.generated_at) { console.error('as_of drift'); process.exit(1); }
        console.log('ok', g.query.scale);
      });
    }).on('error', e => { console.error(e.message); process.exit(1); });
  "
  [ "$status" -eq 0 ]
  echo "$output" | grep '2 NODES · 1 EDGES' >/dev/null

  # The project drill-down is the SAME endpoint with a scope (D6).
  run node -e "
    require('node:http').get('http://127.0.0.1:$port/api/graph?project=alpha', {agent:false}, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => {
        const g = JSON.parse(b);
        if (g.project !== 'alpha') process.exit(1);
        if (g.query.surface !== 'igris-brain-graph/alpha') process.exit(1);
        process.exit(0);
      });
    }).on('error', () => process.exit(1));
  "
  [ "$status" -eq 0 ]

  kill -TERM "$DASH_PID"
  wait "$DASH_PID" || true
  DASH_PID=""
}

@test "T22: /api/graph on a MISSING brain degrades with 200, never a 500" {
  [ ! -f "$IGRIS_BRAIN_DIR/memory/knowledge.db" ]
  local port; port="$(free_port)"
  $CLI_BIN dashboard --no-open --port "$port" >/dev/null 2>&1 &
  DASH_PID=$!
  run wait_for_url "http://127.0.0.1:$port/api/health"
  [ "$status" -eq 0 ]

  run node -e "
    require('node:http').get('http://127.0.0.1:$port/api/graph', {agent:false}, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => {
        if (r.statusCode !== 200) { console.error('status', r.statusCode); process.exit(1); }
        const g = JSON.parse(b);
        if (g.degraded === null) { console.error('expected degraded'); process.exit(1); }
        if (g.nodes.length !== 0 || g.edges.length !== 0) process.exit(1);
        // A canvas with no twin is unreproducible, so the twin ships even here.
        if (!g.query.scale.startsWith('DEGRADED')) { console.error('twin', g.query.scale); process.exit(1); }
        // No stack trace ever reaches the wire.
        if (b.includes('    at ')) process.exit(1);
        console.log('ok');
      });
    }).on('error', () => process.exit(1));
  "
  [ "$status" -eq 0 ]

  kill -TERM "$DASH_PID"
  wait "$DASH_PID" || true
  DASH_PID=""
}

@test "a MISSING brain DB yields an empty state, not a stack trace" {
  # stage_brain creates memory/ but no knowledge.db — that IS the missing case.
  [ ! -f "$IGRIS_BRAIN_DIR/memory/knowledge.db" ]
  local port; port="$(free_port)"
  run $CLI_BIN dashboard --smoke --no-open --port "$port"
  [ "$status" -eq 0 ]
  echo "$output" | grep '"brain_present": false' >/dev/null
  # Every probe still 200s.
  [ "$(echo "$output" | grep -c '"ok": false')" -eq 0 ]
  # No stack trace anywhere in the output.
  ! echo "$output" | grep "    at " >/dev/null
}

# --- T23 (FR-240) — the layer endpoints on a seeded brain and on a missing one
#
# Same reason T22 exists, one tier further in. The layer reads travel
# CLI -> `brain-bridge.ts#loadLayerReaders` -> three modules inside the VENDORED
# `dist/brain-mcp-server/dist/`, on a `{readonly:true}` handle with
# `query_only = ON`. A vitest run imports those modules from the repo checkout;
# only this case proves they still RESOLVE and read when the verb is launched as
# a real process against a real file. `loadLayerReaders()` degrades rather than
# throwing, so a resolution failure would otherwise present as four empty views
# that look exactly like an empty brain.

# seed_layer_brain — a minimal real brain for the four layers. The DDL mirrors
# `cli/src/__tests__/dashboard-layers-fixture.ts`, which mirrors the owning
# migrations; a column drift shows up here as a failed read, not a silent empty.
seed_layer_brain() {
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT DEFAULT '', archetype TEXT DEFAULT 'unclassified',
      igris_version TEXT DEFAULT '7.0.0',
      status TEXT DEFAULT 'active' CHECK (status IN ('active','archived','inactive')),
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_session_at TEXT, metadata TEXT DEFAULT '{}'
    );
    INSERT INTO projects (slug, name, path, last_session_at)
      VALUES ('demo', 'Demo', '/tmp/demo', '2026-07-28 09:00:00');

    CREATE TABLE brief_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL, brief_id TEXT NOT NULL, brief_type TEXT,
      title TEXT NOT NULL, status TEXT NOT NULL, priority TEXT,
      effort TEXT, phase TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_brief_status_unique ON brief_status(project, brief_id);
    INSERT INTO brief_status (project, brief_id, brief_type, title, status, priority, effort, phase, updated_at)
      VALUES ('demo','FR-240','feature','Dashboard layer views','In Progress','P1-High','XL','BUILDING','2026-07-30 09:00:00');

    CREATE TABLE brief_files (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, brief_id TEXT NOT NULL,
      filename TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project, brief_id)
    );
    INSERT INTO brief_files (id, project, brief_id, filename, content, content_hash, updated_at)
      VALUES ('bf-1','demo','FR-240','FR-240.md','# FR-240 body from disk','hash-fr240','2026-07-30 08:00:00');

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('pattern','decision','discovery','mistake','optimization')),
      title TEXT NOT NULL, content TEXT NOT NULL,
      tags TEXT DEFAULT '', tech_stack TEXT DEFAULT '',
      scope TEXT DEFAULT 'local' CHECK (scope IN ('local','global')),
      source_brief TEXT DEFAULT '',
      confidence REAL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0, last_accessed_at TEXT,
      provenance TEXT NOT NULL DEFAULT 'observed'
        CHECK(provenance IN ('observed','inferred','synthesized','ambiguous','human_asserted')),
      review_status TEXT NOT NULL DEFAULT 'approved',
      source_extractor TEXT NOT NULL DEFAULT 'manual',
      -- FR-241: perception/schema.ts:106 + janitor/schema.ts:109. The THIRD
      -- hand-rolled mirror of this table (the others are
      -- src/__tests__/dashboard-layers-fixture.ts and the brain's own
      -- memory-read.test.ts). listLearnings projects both columns, so a fixture
      -- missing them makes the endpoint degrade instead of returning rows.
      seen_again_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      deleted_at TEXT,
      promoted_to_doc TEXT
    );
    CREATE VIRTUAL TABLE learnings_fts USING fts5(
      title, content, tags, tech_stack, content=learnings, content_rowid=id
    );
    CREATE TRIGGER learnings_ai AFTER INSERT ON learnings BEGIN
      INSERT INTO learnings_fts(rowid, title, content, tags, tech_stack)
      VALUES (new.id, new.title, new.content, new.tags, new.tech_stack);
    END;
    INSERT INTO learnings (project, category, title, content, created_at, updated_at, access_count)
      VALUES ('demo','pattern','Wrapper split','The MCP handler becomes a thin wrapper.','2026-07-01 10:00:00','2026-07-01 10:00:00', 7);

    CREATE TABLE goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL UNIQUE, project_slug TEXT,
      title TEXT NOT NULL, description TEXT, outcome TEXT NOT NULL,
      deadline TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','achieved','abandoned','deferred')),
      priority TEXT NOT NULL DEFAULT 'P2-Medium',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      achieved_at TEXT, metadata TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO goals (goal_id, project_slug, title, outcome, deadline, status, priority)
      VALUES ('GL-001','demo','Ship the lens','Browsable brain','2026-08-31','active','P1-High');

    CREATE TABLE entity_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_type TEXT NOT NULL, from_id TEXT NOT NULL,
      to_type TEXT NOT NULL, to_id TEXT NOT NULL, edge_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      provenance TEXT NOT NULL DEFAULT 'observed',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata TEXT NOT NULL DEFAULT '{}',
      UNIQUE(from_type, from_id, to_type, to_id, edge_type)
    );
    INSERT INTO entity_edges (from_type, from_id, to_type, to_id, edge_type)
      VALUES ('brief','FR-240','goal','GL-001','serves_goal');
  "

  # The context-doc layer reads DISK, not the brain (D8) — so it needs a catalog
  # entry and a project doc, and nothing in the database.
  mkdir -p "$IGRIS_BRAIN_DIR/core/context-doc-types" "$IGRIS_BRAIN_DIR/projects/demo/context"
  cat > "$IGRIS_BRAIN_DIR/core/context-doc-types/coding_guidelines.md" <<'EOF'
---
type: coding_guidelines
target: coding_guidelines.md
applies_when: writing or reviewing code
optional: false
summary: Code conventions and naming rules
---
Body of the catalog entry.
EOF
  printf '# Demo guidelines\n\nRead me over HTTP.\n' \
    > "$IGRIS_BRAIN_DIR/projects/demo/context/coding_guidelines.md"
}

# get_json <port> <path> — fetch and print the body, failing on a non-200.
get_json() {
  node -e "
    require('node:http').get('http://127.0.0.1:$1$2', {agent:false}, r => {
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => {
        if (r.statusCode !== 200) { console.error('status', r.statusCode, b.slice(0,200)); process.exit(1); }
        process.stdout.write(b);
      });
    }).on('error', e => { console.error(e.message); process.exit(1); });
  "
}

@test "T23: the four layer endpoints read a seeded brain through the vendored readers" {
  seed_layer_brain
  local port; port="$(free_port)"
  $CLI_BIN dashboard --no-open --port "$port" >/dev/null 2>&1 &
  DASH_PID=$!
  run wait_for_url "http://127.0.0.1:$port/api/health"
  [ "$status" -eq 0 ]

  # The bridge must actually have loaded the three vendored read modules. If it
  # degraded, every assertion below would read an EMPTY list — indistinguishable
  # from an empty brain — so the reason is asserted to be absent FIRST.
  run get_json "$port" "/api/briefs"
  [ "$status" -eq 0 ]
  run node -e "
    const p = JSON.parse(process.argv[1]);
    if (p.degraded !== null) { console.error('degraded:', JSON.stringify(p.degraded)); process.exit(1); }
    if (p.total !== 1 || p.count !== 1) { console.error('counts', p.total, p.count); process.exit(1); }
    if (p.items[0].brief_id !== 'FR-240') { console.error('id', p.items[0].brief_id); process.exit(1); }
    // D7 — a LIST carries no body content.
    if ('content' in p.items[0]) { console.error('list leaked content'); process.exit(1); }
    for (const k of ['items','count','total','limit','offset','params']) {
      if (!(k in p)) { console.error('missing envelope key', k); process.exit(1); }
    }
    console.log('briefs ok');
  " "$output"
  [ "$status" -eq 0 ]

  # The DETAIL carries the body, and BOTH identifiers are required (BR-078).
  run get_json "$port" "/api/brief?project=demo&id=FR-240"
  [ "$status" -eq 0 ]
  echo "$output" | grep 'FR-240 body from disk' >/dev/null

  run get_json "$port" "/api/brief?id=FR-240"
  [ "$status" -eq 0 ]
  run node -e "
    const p = JSON.parse(process.argv[1]);
    if (p.brief !== null) { console.error('id-only lookup RESOLVED — BR-078 fusion'); process.exit(1); }
    if (p.degraded === null || !/project/.test(p.degraded.reason)) { console.error('reason', JSON.stringify(p.degraded)); process.exit(1); }
    console.log('brief refusal ok');
  " "$output"
  [ "$status" -eq 0 ]

  run get_json "$port" "/api/learnings"
  [ "$status" -eq 0 ]
  echo "$output" | grep '"Wrapper split"' >/dev/null

  run get_json "$port" "/api/goals"
  [ "$status" -eq 0 ]
  echo "$output" | grep '"GL-001"' >/dev/null

  run get_json "$port" "/api/context-docs?project=demo"
  [ "$status" -eq 0 ]
  echo "$output" | grep '"coding_guidelines"' >/dev/null

  run get_json "$port" "/api/context-doc?project=demo&type=coding_guidelines"
  [ "$status" -eq 0 ]
  echo "$output" | grep 'Read me over HTTP' >/dev/null

  # AC #7, end to end: a full crawl of the layer surface must not touch the file.
  # `access_count` is the sharpest probe — `handleMemoryGet` bumps it and the
  # dashboard's non-bumping `getLearning` must not (TD-092).
  run get_json "$port" "/api/learning?id=1"
  [ "$status" -eq 0 ]
  run sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "SELECT access_count FROM learnings WHERE id = 1;"
  [ "$status" -eq 0 ]
  [ "$output" = "7" ]

  kill -TERM "$DASH_PID"
  wait "$DASH_PID" || true
  DASH_PID=""
}

@test "T23: every layer endpoint on a MISSING brain degrades with 200, never a 500" {
  [ ! -f "$IGRIS_BRAIN_DIR/memory/knowledge.db" ]
  local port; port="$(free_port)"
  $CLI_BIN dashboard --no-open --port "$port" >/dev/null 2>&1 &
  DASH_PID=$!
  run wait_for_url "http://127.0.0.1:$port/api/health"
  [ "$status" -eq 0 ]

  local p
  for p in "/api/briefs" "/api/brief?project=demo&id=FR-240" "/api/learnings" \
           "/api/learnings/search?q=wrapper" "/api/learning?id=1" \
           "/api/context-docs?project=demo" "/api/context-doc?project=demo&type=coding_guidelines" \
           "/api/goals" "/api/goal?id=GL-001"; do
    run node -e "
      require('node:http').get('http://127.0.0.1:$port$p', {agent:false}, r => {
        let b = '';
        r.on('data', c => b += c);
        r.on('end', () => {
          if (r.statusCode !== 200) { console.error('$p status', r.statusCode); process.exit(1); }
          const j = JSON.parse(b);
          if (j.degraded === null) { console.error('$p expected degraded'); process.exit(1); }
          // No stack trace ever reaches the wire.
          if (b.includes('    at ')) { console.error('$p leaked a stack'); process.exit(1); }
          console.log('$p ok');
        });
      }).on('error', e => { console.error(e.message); process.exit(1); });
    "
    [ "$status" -eq 0 ]
  done

  # A GET must not CREATE the brain it could not find. `registry.ts`'s WRITE
  # door (`getDb()` / `listProjects()`) creates the database when absent, so
  # reaching it from this tier would materialise one — a write, on the
  # operator's machine, from a GET whose contract is that every GET changes no
  # row. (Not "this surface never writes" — since FR-241 POST /api/triage does.)
  # Since TD-319 the tier reaches `listProjectsReadonly()` instead, whose handle
  # is opened `fileMustExist: true`; this stays as the black-box half of that
  # claim, asserted over the wire rather than from inside the process.
  [ ! -f "$IGRIS_BRAIN_DIR/memory/knowledge.db" ]

  kill -TERM "$DASH_PID"
  wait "$DASH_PID" || true
  DASH_PID=""
}

# --- T8 — PACK-EXTRACT PACKAGING SMOKE (the AC's only automated proof) ------

#
# WHAT THIS PROVES: the `files` glob actually carries `dist/dashboard/**`; the
# `base: './'` asset URLs resolve; and `dashboardBundleDir()`'s
# `import.meta.url` walk-up lands on the real bundle from a package directory
# OUTSIDE the repo checkout. Those are R1's four named failure modes minus one.
#
# WHAT IT DOES NOT PROVE: the runtime-dependency install. An extracted tarball
# has no `node_modules`, so the CLI cannot even boot — `commander` is a runtime
# dep and `better-sqlite3` is a native module whose binary is fetched by an
# install script. Reproducing that in-test would mean a network install of a
# native addon inside a bats case, which is slow and flaky for no extra signal
# about THIS brief. Instead the extract borrows the repo's already-installed
# node_modules via a sibling symlink: node resolves runtime deps there, while
# every path the dashboard itself computes still comes from the extracted
# package. The genuine `npm i -g` is the manual T11 operator checkpoint
# (docs/dashboard.md), and it stays required.
@test "T8: a packed-and-extracted tarball serves a working dashboard" {
  local cli_root; cli_root="$(cd "$CLI_DIST/.." && pwd)"
  local repo_root; repo_root="$(cd "$cli_root/.." && pwd)"
  local work="$BATS_TEST_TMPDIR/packsmoke"
  mkdir -p "$work"

  # Pack the REAL package. --ignore-scripts so prepublishOnly does not rebuild
  # (the built tree is what CI just produced and what we want to measure).
  run bash -c "cd '$cli_root' && npm pack --ignore-scripts --pack-destination '$work' 2>/dev/null"
  [ "$status" -eq 0 ]

  local tgz; tgz="$(ls "$work"/*.tgz | head -1)"
  [ -n "$tgz" ]
  tar -xzf "$tgz" -C "$work"
  [ -f "$work/package/dist/index.js" ]

  # The bundle must be IN the tarball. This is the `files`-glob guard.
  [ -f "$work/package/dist/dashboard/index.html" ]
  [ -f "$work/package/dist/dashboard/fonts/anton-latin-400-normal.woff2" ]
  [ -f "$work/package/dist/dashboard/fonts/space-grotesk-latin-wght-normal.woff2" ]
  [ -f "$work/package/dist/dashboard/fonts/jetbrains-mono-latin-400-normal.woff2" ]

  # Runtime deps only — see the header comment. Workspaces hoist to the repo
  # root, so that is the tree that actually holds `commander` et al.
  if [ -d "$repo_root/node_modules/commander" ]; then
    ln -sfn "$repo_root/node_modules" "$work/package/node_modules"
  else
    ln -sfn "$cli_root/node_modules" "$work/package/node_modules"
  fi

  local port; port="$(free_port)"
  run node "$work/package/dist/index.js" dashboard --smoke --no-open --port "$port"
  [ "$status" -eq 0 ]

  # The bundle root must resolve to the EXTRACTED package, not to the repo.
  echo "$output" | grep '"bundle_present": true' >/dev/null
  echo "$output" | grep "$work/package/dist/dashboard" >/dev/null

  # `/` and every /api/* path must be 200 from the extracted layout.
  [ "$(echo "$output" | grep -c '"ok": false')" -eq 0 ]

  # --- the ASSET assertions ------------------------------------------------
  # `--smoke` probes `/` and the API only. A wrong Vite `base` (say
  # `/dashboard/` instead of `./`) leaves `/` at 200 and slips straight through
  # — and that is one of R1's named failure modes. So fetch the real hashed
  # assets the extracted index.html actually references.
  #
  # Filenames are DERIVED from index.html, never pinned: the content hash
  # changes on every build, so a literal would rot within one commit.
  # Run the EXTRACTED binary in the foreground so the assets are served from
  # the extracted bundle root, not the repo's.
  node "$work/package/dist/index.js" dashboard --no-open --port "$port" >/dev/null 2>&1 &
  DASH_PID=$!
  run wait_for_url "http://127.0.0.1:$port/api/health"
  [ "$status" -eq 0 ]

  local base="http://127.0.0.1:$port"

  # Extract EVERY asset reference, whatever its form — do not pre-filter to
  # `./`, or a wrong base yields an empty list and the loop below vacuously
  # passes. Collect first, then assert the shape.
  local raw
  raw="$(grep -oE '(src|href)="[^"]*assets/[^"]+"' "$work/package/dist/dashboard/index.html" \
         | sed -E 's/^(src|href)="//; s/"$//')"
  [ -n "$raw" ]

  # Every reference must be ORIGIN-RELATIVE (`./assets/...`). An absolute
  # `/dashboard/assets/...` means vite.config.ts's `base` regressed away from
  # './' — R1's asset-base failure mode, which a `/`-only probe cannot see.
  local r
  for r in $raw; do
    if [ "${r#./assets/}" = "$r" ]; then
      echo "asset ref is not origin-relative: '$r' (vite base must stay './')" >&2
      return 1
    fi
  done

  local refs
  refs="$(echo "$raw" | sed -E 's/^\.//')"

  local ref
  for ref in $refs; do
    # 200 + a non-empty body + the right content type. A `base` bug shows up
    # here as a 404 (asset not where index.html says it is).
    run node -e "
      require('node:http').get('$base$ref', {agent:false}, r => {
        let n = 0;
        r.on('data', c => { n += c.length; });
        r.on('end', () => {
          const ct = r.headers['content-type'] || '';
          const okType = '$ref'.endsWith('.js')  ? ct.includes('javascript')
                       : '$ref'.endsWith('.css') ? ct.includes('css') : true;
          console.log('$ref', r.statusCode, n, ct);
          process.exit(r.statusCode === 200 && n > 0 && okType ? 0 : 1);
        });
      }).on('error', () => process.exit(1));
    "
    [ "$status" -eq 0 ]
  done

  # The vendored fonts must be reachable over HTTP too — they are referenced
  # from the CSS, so a broken /fonts/* route is invisible to an index.html scan.
  run node -e "
    require('node:http').get('$base/fonts/anton-latin-400-normal.woff2', {agent:false}, r => {
      let n = 0;
      r.on('data', c => { n += c.length; });
      r.on('end', () => {
        console.log('/fonts/anton', r.statusCode, n, r.headers['content-type']);
        process.exit(r.statusCode === 200 && n > 0 && r.headers['content-type'] === 'font/woff2' ? 0 : 1);
      });
    }).on('error', () => process.exit(1));
  "
  [ "$status" -eq 0 ]

  kill -TERM "$DASH_PID"; wait "$DASH_PID" 2>/dev/null; DASH_PID=""
}
