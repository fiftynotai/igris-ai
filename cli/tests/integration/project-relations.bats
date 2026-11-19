#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/../../../test/require_bats.bash" || exit 2
# project-relations.bats — `igris project relations` / `kinds list` end to end
# through the BUILT cli (FR-273, round A).
#
# The #1533 cross-package guard: the brain schema here is created by the
# VENDORED engine (`cli/dist/brain-mcp-server/dist/` — `migrateSchema`, then
# `createProjectsComponent().schema()` through the real `runMigrations`), and
# the edges are seeded through the VENDORED `relations/actions.js`. A stale
# `cli/dist` without projects:3 reds E1 instead of passing.
#
#   E1  boot_vendored 3: chain 1,2,3 and the 5 seed kinds;
#   E2  READ PARITY (AC6): the MCP tool through the vendored bootEngine +
#       gateway.dispatch equals the CLI's `.relations` under `jq -S`;
#   E3  --boot prints the exact D5 line for moca-agent-web;
#   E4  a registered project with no edges: "line":null;
#   E5  boot_vendored 2 (no projects:3): degraded, line null, exit 0;
#   E6  no brain DB: degraded, exit 0, and no DB file is created;
#   E7  the digest is exactly one line on stdout, nothing on stderr;
#   E8  `kinds list` parity with the MCP tool (`jq -S`);
#   E9  `project` is visible in `igris --help` and its help names the write verbs.
#
# Every test runs under stage_brain (HOME + IGRIS_BRAIN_DIR fenced, TD-456);
# IGRIS_RELATIONS_SEMANTIC=off so no path can load the embedding model.

load _helpers.bash

setup() {
  stage_brain
  export IGRIS_RELATIONS_SEMANTIC=off
  unset IGRIS_DB_PATH
  VENDORED="$CLI_DIST/brain-mcp-server/dist"
  [ -f "$VENDORED/engine/components/projects/index.js" ] || skip "vendored brain missing — run 'npm run build' in cli/ first"
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  command -v jq >/dev/null 2>&1 || skip "jq not available"
  DB="$IGRIS_BRAIN_DIR/memory/knowledge.db"
  ROOT="$BATS_TEST_TMPDIR/repos"
  mkdir -p "$ROOT"
}

# boot_vendored <max-projects-version> — the vendored legacy chain + the
# projects component chain up to <max> (3 = FR-273, 2 = a pre-FR-273 bundle).
boot_vendored() {
  (cd "$CLI_DIST/.." && V="file://$VENDORED" DB="$DB" MAXV="$1" node --input-type=module -e '
    const { createSqliteAdapter } = await import(`${process.env.V}/engine/storage/sqlite.js`);
    const { migrateSchema } = await import(`${process.env.V}/db.js`);
    const { createProjectsComponent } = await import(`${process.env.V}/engine/components/projects/index.js`);
    const s = createSqliteAdapter(process.env.DB);
    migrateSchema(s.rawConnection);
    const max = Number(process.env.MAXV);
    s.runMigrations("projects", createProjectsComponent().schema().filter((m) => m.version <= max));
    s.close();
  ' 2>/dev/null)
}

register() {
  mkdir -p "$ROOT/$1"
  sqlite3 "$DB" "INSERT INTO projects (slug, name, path, repo_url) VALUES ('$1', '$1', '$ROOT/$1', 'https://github.com/KalvadTech/$1');"
}

# seed_edges — the moca chain, declared through the VENDORED action layer.
seed_edges() {
  for s in moca-agent-web moca-agent-flutter-client moca-ai-agent moca-app; do register "$s"; done
  (cd "$CLI_DIST/.." && V="file://$VENDORED" DB="$DB" node --input-type=module -e '
    const { createSqliteAdapter } = await import(`${process.env.V}/engine/storage/sqlite.js`);
    const { relateAction } = await import(`${process.env.V}/engine/components/projects/relations/actions.js`);
    const s = createSqliteAdapter(process.env.DB);
    for (const [from, kind, to, detail] of [
      ["moca-agent-web", "uses_package", "moca-agent-flutter-client", { package: "moca_agent_client_ui", ref: "v2.0.0" }],
      ["moca-app", "uses_package", "moca-agent-flutter-client", undefined],
      ["moca-agent-flutter-client", "calls_service", "moca-ai-agent", { protocol: "HTTP/SSE" }],
    ]) {
      const r = await relateAction(s.rawConnection, { action: "declare", from, kind, to, detail });
      if (!r.ok) { console.error(JSON.stringify(r)); process.exit(1); }
    }
    s.close();
  ')
}

# mcp <tool> <json-args> — the tool's text through the vendored bootEngine +
# gateway.dispatch (sync, schedules and cognition disabled: hermetic).
mcp() {
  (cd "$CLI_DIST/.." && V="file://$VENDORED" DB="$DB" TOOL="$1" ARGS="$2" node --input-type=module -e '
    const { bootEngine } = await import(`${process.env.V}/engine/index.js`);
    const e = bootEngine({ dbPath: process.env.DB, components: {
      sync: { enabled: false }, schedules: { enabled: false }, cognition: { enabled: false } } });
    try {
      const r = await e.gateway.dispatch(process.env.TOOL, JSON.parse(process.env.ARGS));
      process.stdout.write(r.content[0].text + "\n");
    } finally { e.shutdown(); }
  ' 2>/dev/null)
}

@test "E1: the VENDORED engine's projects chain reads 1,2,3 and holds the 5 seed kinds" {
  boot_vendored 3
  [ "$(sqlite3 "$DB" "SELECT group_concat(version) FROM (SELECT version FROM engine_migrations WHERE component='projects' ORDER BY version)")" = "1,2,3" ]
  [ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM project_relation_kinds WHERE status='active'")" = "5" ]
  [ "$(sqlite3 "$DB" "SELECT group_concat(name) FROM (SELECT name FROM project_relation_kinds ORDER BY name)")" = "calls_service,supersedes,uses_package,variant_of,white_label_of" ]
}

@test "E2 (AC6): READ PARITY — the MCP tool equals the CLI verb's .relations under jq -S" {
  boot_vendored 3
  seed_edges
  a="$(mcp igris_project_relations '{"slug":"moca-agent-web","depth":2}' | jq -S .)"
  [ -n "$a" ] || { echo "empty MCP result"; false; }
  [ "$(printf '%s' "$a" | jq -r .ok)" = "true" ] || { echo "$a"; false; }
  b="$($CLI_BIN project relations --project moca-agent-web --depth 2 | jq -S .relations)"
  [ "$a" = "$b" ] || { diff <(echo "$a") <(echo "$b"); false; }
  # …and the chain itself: client (d1) → agent (d2), moca-app (d2, in).
  [ "$(printf '%s' "$b" | jq -c '[.data.neighbours[] | [.slug, .depth]]')" = '[["moca-agent-flutter-client",1],["moca-ai-agent",2],["moca-app",2]]' ]
  [ "$(printf '%s' "$b" | jq -r '.data.neighbours[0].detail.ref')" = "v2.0.0" ]
}

@test "E3: --boot prints the exact D5 line for moca-agent-web" {
  boot_vendored 3
  seed_edges
  run $CLI_BIN project relations --project moca-agent-web --boot
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -r .line)" = "Connected: uses moca-agent-flutter-client (v2.0.0) → calls moca-ai-agent · more: igris project relations" ]
  [ "$(printf '%s' "$output" | jq -r .degraded)" = "false" ]
}

@test "E4: a registered project with no edges prints \"line\":null" {
  boot_vendored 3
  register igris-ai
  run $CLI_BIN project relations --project igris-ai --boot
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '[.degraded, .registered, .line, .neighbours]')" = '[false,true,null,0]' ]
}

@test "E5: a bundle WITHOUT projects:3 — degraded, line null, exit 0" {
  boot_vendored 2
  run $CLI_BIN project relations --project moca-agent-web --boot
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '[.degraded, .line]')" = '[true,null]' ]
  [[ "$(printf '%s' "$output" | jq -r .reason)" == *'projects:3'* ]] || { echo "$output"; false; }
}

@test "E6: no brain DB — degraded, exit 0, and no DB file is created" {
  [ ! -e "$DB" ]
  run $CLI_BIN project relations --project anything --boot
  [ "$status" -eq 0 ]
  [ "$(printf '%s' "$output" | jq -c '[.degraded, .line, .reason]')" = '[true,null,"brain db absent"]' ]
  [ ! -e "$DB" ]
}

@test "E7: the digest is exactly one line on stdout and nothing on stderr" {
  boot_vendored 3
  seed_edges
  $CLI_BIN project relations --project moca-agent-flutter-client > "$BATS_TEST_TMPDIR/out" 2> "$BATS_TEST_TMPDIR/err"
  [ "$(wc -l < "$BATS_TEST_TMPDIR/out" | tr -d ' ')" = "1" ]
  jq -e '.degraded == false and .relations.ok == true' "$BATS_TEST_TMPDIR/out" >/dev/null
  [ ! -s "$BATS_TEST_TMPDIR/err" ]
}

@test "E8: kinds list — the CLI .result equals the MCP tool under jq -S" {
  boot_vendored 3
  a="$(mcp igris_project_relation_kinds '{"action":"list"}' | jq -S .)"
  [ "$(printf '%s' "$a" | jq -r '.data.kinds | length')" = "5" ] || { echo "$a"; false; }
  b="$($CLI_BIN project kinds list | jq -S .result)"
  [ "$a" = "$b" ] || { diff <(echo "$a") <(echo "$b"); false; }
}

@test "E9 (warden M9): 'project' is listed in igris --help, and its help names the write verbs" {
  run $CLI_BIN --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"project [options] <action> [args...]"* ]] || { echo "$output"; false; }
  run $CLI_BIN project --help
  [ "$status" -eq 0 ]
  for verb in "relate <from> <kind> <to>" "unrelate <from> <kind> <to>" "kinds add <name>" "kinds merge <retired> <survivor>" "watermark"; do
    [[ "$output" == *"$verb"* ]] || { echo "missing: $verb"; echo "$output"; false; }
  done
}
