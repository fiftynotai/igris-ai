#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/../../../test/require_bats.bash" || exit 2
# project-relations-write.bats — WRITE PARITY for the FR-273 CLI write verbs
# (plan D11, Z-series), through the BUILT cli and the VENDORED engine.
#
# Every case starts from ONE fixture (vendored legacy chain + projects:1-3,
# registered projects incl. a duplicate-path pair and an off-disk slug, a seeded
# edge, a custom kind with an edge) copied to DB-A and DB-B with VACUUM INTO:
#   - DB-A: the MCP tool through the vendored bootEngine + gateway.dispatch;
#   - DB-B: the CLI verb (IGRIS_BRAIN_DIR points at it).
# Asserted per case:
#   1. the CLI digest's `.result` equals the MCP text (jq -S, timestamps dropped
#      and removed_at reduced to "is set", since the two runs happen seconds apart);
#   2. the normalised dumps of both tables are identical (plan §4.2 Z);
#   3. the CLI exit code is 0 when `ok`, 1 when refused.
# Z17 is the mixed-caller case: an MCP declare then a CLI merge on ONE DB must
# dump exactly like the all-MCP run.
#
# stage_brain fences HOME + IGRIS_BRAIN_DIR (TD-456); IGRIS_RELATIONS_SEMANTIC=off
# so neither side can load the embedding model.

load _helpers.bash

setup() {
  stage_brain
  export IGRIS_RELATIONS_SEMANTIC=off
  unset IGRIS_DB_PATH
  VENDORED="$CLI_DIST/brain-mcp-server/dist"
  [ -f "$VENDORED/engine/components/projects/relations/actions.js" ] || skip "vendored brain missing — run 'npm run build' in cli/ first"
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  command -v jq >/dev/null 2>&1 || skip "jq not available"
  ROOT="$BATS_TEST_TMPDIR/repos"
  BASE="$BATS_TEST_TMPDIR/base.db"
  DBA="$BATS_TEST_TMPDIR/a.db"
  DBB="$IGRIS_BRAIN_DIR/memory/knowledge.db"
  build_fixture
  sqlite3 "$BASE" "VACUUM INTO '$DBA'"
  sqlite3 "$BASE" "VACUUM INTO '$DBB'"
}

build_fixture() {
  mkdir -p "$ROOT"/{app-a,pkg-b,svc-c,cp}
  (cd "$CLI_DIST/.." && V="file://$VENDORED" DB="$BASE" R="$ROOT" node --input-type=module -e '
    const { createSqliteAdapter } = await import(`${process.env.V}/engine/storage/sqlite.js`);
    const { migrateSchema } = await import(`${process.env.V}/db.js`);
    const { createProjectsComponent } = await import(`${process.env.V}/engine/components/projects/index.js`);
    const { relateAction, kindsAction } = await import(`${process.env.V}/engine/components/projects/relations/actions.js`);
    const s = createSqliteAdapter(process.env.DB);
    const db = s.rawConnection;
    migrateSchema(db);
    s.runMigrations("projects", createProjectsComponent().schema());
    const R = process.env.R;
    const reg = db.prepare("INSERT INTO projects (slug, name, path) VALUES (?, ?, ?)");
    for (const x of ["app-a", "pkg-b", "svc-c"]) reg.run(x, x, `${R}/${x}`);
    reg.run("customerpulse-flutter", "cp", `${R}/cp`);
    reg.run("customerpulse_flutter", "cp2", `${R}/cp`);
    reg.run("gone-svc", "gone", `${R}/no-such-dir`);
    const must = (r) => { if (!r.ok) { console.error(JSON.stringify(r)); process.exit(1); } };
    must(await relateAction(db, { action: "declare", from: "svc-c", kind: "calls_service", to: "gone-svc", detail: { role: "backend" } }));
    must(await kindsAction(db, { action: "add", name: "rebrand_of", meaning: "A is B rebranded for a specific customer",
      direction: "A → B", forward_label: "rebrands", inverse_label: "rebranded as", example: "x rebrand_of y" }, { env: { IGRIS_RELATIONS_SEMANTIC: "off" } }));
    must(await relateAction(db, { action: "declare", from: "app-a", kind: "rebrand_of", to: "pkg-b" }));
    db.prepare("UPDATE project_relations SET updated_at = ?, created_at = ?").run("2026-01-01 00:00:00", "2026-01-01 00:00:00");
    s.close();
  ')
}

# mcp <db> <tool> <json-args> — the tool text through the vendored bootEngine +
# gateway.dispatch (sync, schedules and cognition disabled: hermetic).
mcp() {
  (cd "$CLI_DIST/.." && V="file://$VENDORED" DB="$1" TOOL="$2" ARGS="$3" node --input-type=module -e '
    const { bootEngine } = await import(`${process.env.V}/engine/index.js`);
    const e = bootEngine({ dbPath: process.env.DB, components: {
      sync: { enabled: false }, schedules: { enabled: false }, cognition: { enabled: false } } });
    try {
      const r = await e.gateway.dispatch(process.env.TOOL, JSON.parse(process.env.ARGS));
      process.stdout.write(r.content[0].text + "\n");
    } finally { e.shutdown(); }
  ' 2>/dev/null)
}

NORM='walk(if type == "object" then (del(.created_at, .updated_at) | if has("removed_at") then .removed_at = (.removed_at != null) else . end) else . end)'

dump() {
  sqlite3 "$1" "SELECT from_slug,kind,to_slug,detail,provenance,removed_at IS NULL FROM project_relations ORDER BY 1,2,3"
  echo "--"
  sqlite3 "$1" "SELECT name,meaning,direction,forward_label,inverse_label,example,aliases,status,merged_into FROM project_relation_kinds ORDER BY 1"
}

# parity <expected-ok true|false> <tool> <json-args> -- <cli args...>
parity() {
  local want="$1" tool="$2" args="$3"; shift 4
  local a b
  a="$(mcp "$DBA" "$tool" "$args" | jq -S "$NORM")"
  [ -n "$a" ] || { echo "empty MCP result"; return 1; }
  run $CLI_BIN project "$@"
  b="$(printf '%s' "$output" | jq -S ".result | $NORM")"
  [ "$a" = "$b" ] || { echo "RESULT DIFF"; diff <(echo "$a") <(echo "$b"); return 1; }
  [ "$(printf '%s' "$a" | jq -r .ok)" = "$want" ] || { echo "ok != $want: $a"; return 1; }
  if [ "$want" = true ]; then [ "$status" -eq 0 ] || { echo "exit $status"; return 1; }; else [ "$status" -eq 1 ] || { echo "exit $status"; return 1; }; fi
  [ "$(dump "$DBA")" = "$(dump "$DBB")" ] || { echo "DUMP DIFF"; diff <(dump "$DBA") <(dump "$DBB"); return 1; }
}

@test "Z1: declare" {
  parity true igris_project_relate '{"action":"declare","from":"app-a","kind":"uses_package","to":"pkg-b","detail":{"package":"p","ref":"v2"}}' -- relate app-a uses_package pkg-b --detail package=p --detail ref=v2
}

@test "Z2: declare via an alias stores the canonical kind" {
  parity true igris_project_relate '{"action":"declare","from":"app-a","kind":"depends_on_package","to":"pkg-b"}' -- relate app-a depends_on_package pkg-b
  [ "$(sqlite3 "$DBB" "SELECT kind FROM project_relations WHERE from_slug='app-a' AND to_slug='pkg-b' AND kind != 'rebrand_of'")" = "uses_package" ]
}

@test "Z3: declare refused — unknown kind" {
  parity false igris_project_relate '{"action":"declare","from":"app-a","kind":"uses_packages","to":"pkg-b"}' -- relate app-a uses_packages pkg-b
}

@test "Z4: declare refused — duplicate-path endpoint" {
  parity false igris_project_relate '{"action":"declare","from":"customerpulse-flutter","kind":"uses_package","to":"pkg-b"}' -- relate customerpulse-flutter uses_package pkg-b
}

@test "Z5: declare refused — unregistered endpoint" {
  parity false igris_project_relate '{"action":"declare","from":"ghost-app","kind":"uses_package","to":"pkg-b"}' -- relate ghost-app uses_package pkg-b
}

@test "Z6: declare refused — absolute-path detail" {
  parity false igris_project_relate '{"action":"declare","from":"app-a","kind":"uses_package","to":"pkg-b","detail":{"path":"/Users/x/pkg"}}' -- relate app-a uses_package pkg-b --detail path=/Users/x/pkg
}

@test "Z7: re-declare of an identical live edge is a no-op" {
  parity true igris_project_relate '{"action":"declare","from":"svc-c","kind":"calls_service","to":"gone-svc","detail":{"role":"backend"}}' -- relate svc-c calls_service gone-svc --detail role=backend
  [ "$(sqlite3 "$DBB" "SELECT updated_at FROM project_relations WHERE from_slug='svc-c'")" = "2026-01-01 00:00:00" ]
}

@test "Z8: remove tombstones" {
  parity true igris_project_relate '{"action":"remove","from":"svc-c","kind":"calls_service","to":"gone-svc"}' -- unrelate svc-c calls_service gone-svc
}

@test "Z9: remove refused — unknown edge" {
  parity false igris_project_relate '{"action":"remove","from":"app-a","kind":"supersedes","to":"pkg-b"}' -- unrelate app-a supersedes pkg-b
}

@test "Z10: kinds add accepted" {
  parity true igris_project_relation_kinds '{"action":"add","name":"deploys_to","meaning":"A is deployed onto B'"'"'s hosting infrastructure","direction":"A → B","forward_label":"deploys to","inverse_label":"hosts","example":"x deploys_to y","aliases":["hosted_on"]}' -- kinds add deploys_to --meaning "A is deployed onto B's hosting infrastructure" --kind-direction "A → B" --forward-label "deploys to" --inverse-label hosts --example "x deploys_to y" --alias hosted_on
}

@test "Z11: kinds add refused — lexical near-duplicate" {
  parity false igris_project_relation_kinds '{"action":"add","name":"imports_code","meaning":"A imports B'"'"'s code at compile time","direction":"A → B","forward_label":"imports","inverse_label":"imported by","example":"x imports_code y"}' -- kinds add imports_code --meaning "A imports B's code at compile time" --kind-direction "A → B" --forward-label imports --inverse-label "imported by" --example "x imports_code y"
}

@test "Z12: kinds add refused — name collision with an alias" {
  parity false igris_project_relation_kinds '{"action":"add","name":"client_of","meaning":"A is a customer of B","direction":"A → B","forward_label":"buys from","inverse_label":"sells to","example":"x client_of y"}' -- kinds add client_of --meaning "A is a customer of B" --kind-direction "A → B" --forward-label "buys from" --inverse-label "sells to" --example "x client_of y"
}

@test "Z13: kinds alias" {
  parity true igris_project_relation_kinds '{"action":"alias","name":"uses_package","alias":"pulls_in"}' -- kinds alias uses_package pulls_in
}

@test "Z14: kinds alias refused — collision" {
  parity false igris_project_relation_kinds '{"action":"alias","name":"supersedes","alias":"calls"}' -- kinds alias supersedes calls
}

@test "Z15: kinds merge rewrites and tombstones" {
  parity true igris_project_relation_kinds '{"action":"merge","retired":"rebrand_of","survivor":"white_label_of"}' -- kinds merge rebrand_of white_label_of
  [ "$(sqlite3 "$DBB" "SELECT COUNT(*) FROM project_relations WHERE kind='rebrand_of' AND removed_at IS NULL")" = "0" ]
}

@test "Z16: kinds merge is idempotent" {
  # Both DBs start already merged (the same MCP merge on each), then the second merge is compared.
  mcp "$DBA" igris_project_relation_kinds '{"action":"merge","retired":"rebrand_of","survivor":"white_label_of"}' >/dev/null
  mcp "$DBB" igris_project_relation_kinds '{"action":"merge","retired":"rebrand_of","survivor":"white_label_of"}' >/dev/null
  parity true igris_project_relation_kinds '{"action":"merge","retired":"rebrand_of","survivor":"white_label_of"}' -- kinds merge rebrand_of white_label_of
  [ "$(printf '%s' "$output" | jq -r .result.data.changed)" = "false" ]
}

@test "Z17: mixed callers — an MCP declare then a CLI merge on ONE DB dumps like the all-MCP run" {
  mcp "$DBA" igris_project_relate '{"action":"declare","from":"svc-c","kind":"rebrand_of","to":"pkg-b"}' >/dev/null
  mcp "$DBA" igris_project_relation_kinds '{"action":"merge","retired":"rebrand_of","survivor":"white_label_of"}' >/dev/null
  mcp "$DBB" igris_project_relate '{"action":"declare","from":"svc-c","kind":"rebrand_of","to":"pkg-b"}' >/dev/null
  run $CLI_BIN project kinds merge rebrand_of white_label_of
  [ "$status" -eq 0 ] || { echo "$output"; false; }
  [ "$(dump "$DBA")" = "$(dump "$DBB")" ] || { diff <(dump "$DBA") <(dump "$DBB"); false; }
  [ "$(sqlite3 "$DBB" "SELECT COUNT(*) FROM project_relations WHERE kind='white_label_of' AND removed_at IS NULL")" = "2" ]
}

@test "Z18: a write digest is one line with replication 'next brain push'; no brain → exit 3, no DB created" {
  $CLI_BIN project relate app-a supersedes pkg-b > "$BATS_TEST_TMPDIR/out" 2> "$BATS_TEST_TMPDIR/err"
  [ "$(wc -l < "$BATS_TEST_TMPDIR/out" | tr -d ' ')" = "1" ]
  jq -e '.replication == "next brain push" and .ok == true and .action == "relate"' "$BATS_TEST_TMPDIR/out" >/dev/null
  [ ! -s "$BATS_TEST_TMPDIR/err" ]
  rm -f "$DBB" "$DBB-wal" "$DBB-shm"
  run $CLI_BIN project relate app-a supersedes pkg-b
  [ "$status" -eq 3 ]
  [ ! -e "$DBB" ]
}
