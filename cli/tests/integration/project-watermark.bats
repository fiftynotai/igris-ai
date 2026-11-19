#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/../../../test/require_bats.bash" || exit 2
# project-watermark.bats — `igris project watermark` end to end through the
# BUILT cli (FR-274).
#
# The #1533 cross-package parity guard: the brain DB schema here is created by
# the VENDORED engine (`cli/dist/brain-mcp-server/dist/` — `migrateSchema`,
# then `createProjectsComponent().schema()` through the real `runMigrations`),
# never by hand-written DDL. So if the brain's projects:2 column names and the
# CLI writer's ever disagree — or `cli/dist` is stale and lacks projects:2 —
# P1 reds instead of passing.
#
#   P1  the vendored engine's schema: the verb records, `sqlite3` reads it back;
#   P2  a bundle WITHOUT projects:2 (only projects:1 applied): exit 0, degraded,
#       the cause named, the row unchanged;
#   P3  the digest is exactly one line of valid JSON on stdout, nothing else.
#
# Every test runs under stage_brain (HOME + IGRIS_BRAIN_DIR fenced, TD-456).

load _helpers.bash

setup() {
  stage_brain
  VENDORED="$CLI_DIST/brain-mcp-server/dist"
  [ -f "$VENDORED/engine/components/projects/index.js" ] || skip "vendored brain missing — run 'npm run build' in cli/ first"
  command -v sqlite3 >/dev/null 2>&1 || skip "sqlite3 not available"
  DB="$IGRIS_BRAIN_DIR/memory/knowledge.db"
  export GIT_CONFIG_GLOBAL="$BATS_TEST_TMPDIR/gitconfig"
  export GIT_CONFIG_NOSYSTEM=1
  printf '[user]\n\tname = fr274\n\temail = fr274@igris.invalid\n[init]\n\tdefaultBranch = main\n' > "$GIT_CONFIG_GLOBAL"
  REPO="$(cd "$(stage_project wmrepo)" && pwd -P)"
  git -C "${REPO:?}" init -q
  echo one > "$REPO/one.txt"
  git -C "${REPO:?}" add -A
  git -C "${REPO:?}" commit -q -m one
  git -C "${REPO:?}" checkout -q -b feature/wm
}

# boot_vendored <max-projects-version> — the vendored legacy chain + the
# projects component chain up to <max> (2 = current, 1 = a pre-FR-274 bundle).
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
  ')
}

register_repo() {
  sqlite3 "$DB" "INSERT INTO projects (slug, name, path) VALUES ('wmrepo', 'wmrepo', '$REPO');"
}

@test "P1: on the VENDORED engine's schema, the verb records and sqlite3 reads it back" {
  boot_vendored 2
  [ "$(sqlite3 "$DB" "SELECT group_concat(version) FROM engine_migrations WHERE component='projects'")" = "1,2" ]
  register_repo
  run $CLI_BIN project watermark --project wmrepo
  [ "$status" -eq 0 ]
  [[ "$output" == *'"recorded":true'* ]] || { echo "$output"; false; }
  [[ "$output" == *'"degraded":false'* ]] || { echo "$output"; false; }
  sha="$(git -C "${REPO:?}" rev-parse HEAD)"
  [ "$(sqlite3 "$DB" "SELECT knowledge_sha FROM projects WHERE slug='wmrepo'")" = "$sha" ]
  [ "$(sqlite3 "$DB" "SELECT knowledge_branch FROM projects WHERE slug='wmrepo'")" = "feature/wm" ]
  [ -n "$(sqlite3 "$DB" "SELECT knowledge_recorded_at FROM projects WHERE slug='wmrepo'")" ]
}

@test "P2: a bundle without projects:2 — exit 0, degraded with the cause named, the row unchanged" {
  boot_vendored 1
  [ "$(sqlite3 "$DB" "SELECT group_concat(version) FROM engine_migrations WHERE component='projects'")" = "1" ]
  register_repo
  before="$(sqlite3 "$DB" "SELECT * FROM projects")"
  run $CLI_BIN project watermark --project wmrepo
  [ "$status" -eq 0 ]
  [[ "$output" == *'"degraded":true'* ]] || { echo "$output"; false; }
  [[ "$output" == *'projects:2 not applied'* ]] || { echo "$output"; false; }
  [ "$(sqlite3 "$DB" "SELECT * FROM projects")" = "$before" ]
}

@test "P3: the digest is exactly one line of valid JSON on stdout" {
  boot_vendored 2
  register_repo
  $CLI_BIN project watermark --project wmrepo > "$BATS_TEST_TMPDIR/out" 2> "$BATS_TEST_TMPDIR/err"
  [ "$(wc -l < "$BATS_TEST_TMPDIR/out" | tr -d ' ')" = "1" ]
  node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (j.project !== "wmrepo" || j.recorded !== true) process.exit(1);' "$BATS_TEST_TMPDIR/out"
  [ ! -s "$BATS_TEST_TMPDIR/err" ]
}
