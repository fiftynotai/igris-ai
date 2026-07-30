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
free_port() {
  node -e '
    const s = require("node:net").createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => console.log(p)); });
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

# --- T1/T3 — smoke mode ----------------------------------------------------

@test "dashboard --smoke exits 0 and prints a JSON digest" {
  local port; port="$(free_port)"
  run $CLI_BIN dashboard --smoke --no-open --port "$port"
  [ "$status" -eq 0 ]
  echo "$output" | grep -q '"ok": true'
  echo "$output" | grep -q '"bundle_present": true'
  # All four probed paths must be 200 — including /api/graph/stats, which must
  # DEGRADE cleanly rather than error on this empty sandboxed brain.
  echo "$output" | grep -q '"/api/health"'
  echo "$output" | grep -q '"/api/graph/stats"'
  [ "$(echo "$output" | grep -c '"ok": false')" -eq 0 ]
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
  echo "$output" | grep -q '"bundle_dir"'
  echo "$output" | grep -q 'dist/dashboard'
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
  echo "$output" | grep -q "already running"
  echo "$output" | grep -q "http://127.0.0.1:$port/"

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
  echo "$output" | grep -q '"ok": true'
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
  echo "$output" | grep -q "in use"

  # Restore so teardown's kill still cleans up predictably.
  kill -TERM "$DASH_PID"; wait "$DASH_PID" || true; DASH_PID=""
}

@test "--port rejects a non-numeric value with exit 2" {
  run $CLI_BIN dashboard --no-open --port abc --smoke
  [ "$status" -eq 2 ]
  echo "$output" | grep -q "must be an integer"
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
  echo "$output" | grep -q '2 NODES · 1 EDGES'

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
  echo "$output" | grep -q '"brain_present": false'
  # Every probe still 200s.
  [ "$(echo "$output" | grep -c '"ok": false')" -eq 0 ]
  # No stack trace anywhere in the output.
  ! echo "$output" | grep -q "    at "
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
  echo "$output" | grep -q '"bundle_present": true'
  echo "$output" | grep -q "$work/package/dist/dashboard"

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
