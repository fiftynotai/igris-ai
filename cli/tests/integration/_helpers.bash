#!/usr/bin/env bash
# Bats helper: setup/teardown of sandboxed brain dir + fixture project trees.
#
# Every test sets IGRIS_BRAIN_DIR=$BATS_TEST_TMPDIR/igris-brain so the CLI's
# DB / canonical hooks file / installed_features.json land in tmp space.
# We seed:
#   - $IGRIS_BRAIN_DIR/core/hooks/canonical-settings.json (stub)
#   - $IGRIS_BRAIN_DIR/memory/ (empty — registry.ts creates table on demand)
#
# Tests invoke the CLI via `node $CLI_DIST/index.js ...` to avoid any global
# install dependency.

set -euo pipefail

# CLI_DIST resolved at first include — falls back to the workspace dist dir
# if not preset.
if [ -z "${CLI_DIST:-}" ]; then
  CLI_DIST="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../dist" && pwd)"
fi
export CLI_DIST

# CLI_BIN — the actual node command tests should run.
CLI_BIN="node $CLI_DIST/index.js"
export CLI_BIN

# Stub canonical hooks (matches the shape of core/hooks/canonical-settings.json)
read -r -d '' STUB_CANONICAL_HOOKS <<'JSON' || true
{
  "hooks": {
    "SessionStart": [{"hooks":[{"type":"command","command":"$HOME/.igris/core/hooks/shared/session_start.sh"}]}],
    "SessionEnd":   [{"hooks":[{"type":"command","command":"$HOME/.igris/core/hooks/shared/session_end.sh"}]}],
    "PreCompact":   [{"hooks":[{"type":"command","command":"$HOME/.igris/core/hooks/shared/pre_compact.sh"}]}],
    "PostCompact":  [{"hooks":[{"type":"command","command":"$HOME/.igris/core/hooks/shared/post_compact.sh"}]}],
    "PreToolUse":   [{"matcher":"Write|Edit","hooks":[{"type":"command","command":"$HOME/.igris/core/hooks/shared/pre_tool_use.sh"}]}],
    "PostToolUse":  [{"matcher":"Write|Edit","hooks":[{"type":"command","command":"$HOME/.igris/core/hooks/shared/post_tool_use.sh","timeout":20}]}]
  }
}
JSON
export STUB_CANONICAL_HOOKS

# stage_brain — populates $BATS_TEST_TMPDIR/igris-brain with the canonical hooks
# fixture and creates the memory/ dir. Sets IGRIS_BRAIN_DIR for the test.
stage_brain() {
  export IGRIS_BRAIN_DIR="$BATS_TEST_TMPDIR/igris-brain"
  mkdir -p "$IGRIS_BRAIN_DIR/core/hooks"
  mkdir -p "$IGRIS_BRAIN_DIR/memory"
  printf '%s\n' "$STUB_CANONICAL_HOOKS" > "$IGRIS_BRAIN_DIR/core/hooks/canonical-settings.json"
}

# stage_project <subdir-name> — creates a fresh project tree at
# $BATS_TEST_TMPDIR/<subdir> with .claude/ pre-created. Echoes the path.
stage_project() {
  local name="${1:-proj}"
  local dir="$BATS_TEST_TMPDIR/$name"
  mkdir -p "$dir/.claude"
  echo "$dir"
}

# stage_home — an isolated HOME with a CLEAN doctor baseline, so ONLY the drift a
# test deliberately injects fires (never the ambient real ~/.claude state).
# Writes:
#   - $HOME/.claude.json          — valid igris-brain MCP entry (600) so
#                                    mcp-unregistered + secret-perms stay silent.
#   - $HOME/.claude/settings.json — the canonical global Igris hooks (a
#                                    hooks-missing/stale test OVERWRITES this).
#   - $IGRIS_BRAIN_DIR/config.json — opt-out `cli_targets:{}` (600) so
#                                    bridge-missing never fires from a real CLI
#                                    on the runner's PATH.
# Echoes the HOME path. Run the CLI under it with `HOME="$h" run $CLI_BIN ...`.
#
# TD-299: the FR-212d global-hooks detector reads $HOME/.claude/settings.json via
# homedir(); without this isolation `doctor` reads the runner's REAL ~/.claude
# (which carries canonical hooks) and misses the injected drift → exit 0. Call
# AFTER stage_brain (needs $IGRIS_BRAIN_DIR + its canonical-settings.json).
stage_home() {
  local home="$BATS_TEST_TMPDIR/home"
  mkdir -p "$home/.claude"
  local mcpfile="$IGRIS_BRAIN_DIR/fake-bundled-mcp.js"
  printf '// fake bundled mcp\n' > "$mcpfile"
  cat > "$home/.claude.json" <<EOF
{ "mcpServers": { "igris-brain": { "type": "stdio", "command": "node", "args": ["$mcpfile"], "env": {} } } }
EOF
  chmod 600 "$home/.claude.json"
  cp "$IGRIS_BRAIN_DIR/core/hooks/canonical-settings.json" "$home/.claude/settings.json"
  printf '{ "version": "7.0.0", "cli_targets": {} }\n' > "$IGRIS_BRAIN_DIR/config.json"
  chmod 600 "$IGRIS_BRAIN_DIR/config.json"
  echo "$home"
}

# --- FR-243: git-level gates helpers ------------------------------------------

# IGRIS_REPO_ROOT — the monorepo checkout (cli/tests/integration/../../..).
# PHYSICAL path (`pwd -P`): under a symlinked scratch layout the logical path
# resolves to a tree of symlinks INTO the real checkout, and a helper that
# copies-then-deletes through it deletes the real files (BR-103 forger run,
# 2026-09-07: `core/git-hooks/*` were removed from the checkout that way).
IGRIS_REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
export IGRIS_REPO_ROOT

# stage_git_hooks_mirror — seeds $IGRIS_BRAIN_DIR/core/git-hooks/{pre-commit,
# commit-msg} by COPYING the repo's canonical core/git-hooks/* (what `igris
# refresh` lands). Call AFTER stage_brain. Echoes the mirror dir.
stage_git_hooks_mirror() {
  local dir="$IGRIS_BRAIN_DIR/core/git-hooks"
  mkdir -p "$dir"
  cp "$IGRIS_REPO_ROOT/core/git-hooks/pre-commit" "$dir/pre-commit"
  cp "$IGRIS_REPO_ROOT/core/git-hooks/commit-msg" "$dir/commit-msg"
  chmod +x "$dir/pre-commit" "$dir/commit-msg"
  echo "$dir"
}

# stage_git_project <name> — a registered-project tree that IS a git repo
# (`git init`, empty .git/hooks apart from samples). Echoes the path.
stage_git_project() {
  local name="${1:-gproj}"
  local dir="$BATS_TEST_TMPDIR/$name"
  mkdir -p "$dir"
  git -C "$dir" init -q
  echo "$dir"
}

# register_project_row <slug> <path> — one registry row (schema as registry.ts).
register_project_row() {
  sqlite3 "$IGRIS_BRAIN_DIR/memory/knowledge.db" "
    CREATE TABLE IF NOT EXISTS projects (
      slug TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      tech_stack TEXT, igris_version TEXT, status TEXT DEFAULT 'active',
      registered_at TEXT, last_session_at TEXT, metadata TEXT
    );
    INSERT INTO projects (slug, name, path, igris_version) VALUES ('$1','$1','$2','7.0.0');
  "
}

# path_with_stub_gitleaks — echoes a PATH whose FIRST dir holds an executable
# stub named `gitleaks` (secret-scan-disarmed detection is PATH presence, so a
# stub is enough — the cli-bats CI job has no real gitleaks).
path_with_stub_gitleaks() {
  local bin="$BATS_TEST_TMPDIR/stub-gitleaks-bin"
  mkdir -p "$bin"
  printf '#!/bin/sh\necho stub\n' > "$bin/gitleaks"
  chmod +x "$bin/gitleaks"
  echo "$bin:$PATH"
}

# path_without_gitleaks — echoes $PATH with every dir carrying a gitleaks
# binary removed, and a stub dir in front that keeps `node` + `git` resolvable.
path_without_gitleaks() {
  local bin="$BATS_TEST_TMPDIR/no-gitleaks-bin"
  mkdir -p "$bin"
  local tool p
  for tool in node git sqlite3; do
    p="$(command -v "$tool" 2>/dev/null || true)"
    [ -n "$p" ] && [ ! -e "$bin/$tool" ] && ln -s "$p" "$bin/$tool"
  done
  local out="$bin" d
  local old_ifs="$IFS"; IFS=':'
  for d in $PATH; do
    [ -x "$d/gitleaks" ] && continue
    out="$out:$d"
  done
  IFS="$old_ifs"
  echo "$out"
}

# Portable stat/md5 (TD-434) — byte-identical in spirit to test/test_helper.bash:
# GNU stat has no `-f FORMAT`; `md5 -q` is darwin-only. Never call either raw.
if stat -c %i / >/dev/null 2>&1; then _IGRIS_STAT_DIALECT=gnu; else _IGRIS_STAT_DIALECT=bsd; fi

file_inode() {
  if [ "$_IGRIS_STAT_DIALECT" = gnu ]; then stat -c %i "$1" 2>/dev/null || echo ""
  else stat -f %i "$1" 2>/dev/null || echo ""; fi
}

file_md5() {
  if command -v md5 >/dev/null 2>&1; then md5 -q "$1" 2>/dev/null || echo ""
  else md5sum "$1" 2>/dev/null | awk '{print $1}'; fi
}

# --- BR-103: core-swap witnesses + fixtures --------------------------------

# core_tree_sha [dir] — ONE sha256 over every regular file under <dir>
# (default $IGRIS_BRAIN_DIR/core): sorted path list → per-file sha256 →
# sha256 of that listing. Portable (find + LC_ALL=C sort + shasum). Symlinks
# are not files and are not hashed; an empty tree hashes deterministically.
core_tree_sha() {
  local dir="${1:-$IGRIS_BRAIN_DIR/core}"
  (
    cd "$dir" || exit 1
    find . -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | awk '{print $1}'
  )
}

# bak_count — how many core.bak.* siblings sit beside $IGRIS_BRAIN_DIR/core.
bak_count() {
  find "$IGRIS_BRAIN_DIR" -maxdepth 1 -name 'core.bak.*' | wc -l | tr -d ' '
}

# stage_fixture_tarball — a GitHub-shaped release tarball
# (`igris-ai-fixture/core/**`, so tarball.ts's `strip: 1` applies) built from
# the repo's core/ with core/git-hooks/ DELETED: the incident's population, a
# core OLDER than the checkout. Echoes the .tar.gz path. Built at test time,
# never checked in.
stage_fixture_tarball() {
  local stage="$BATS_TEST_TMPDIR/fixture-tarball"
  local prefix="igris-ai-fixture"
  rm -rf "$stage"
  mkdir -p "$stage/$prefix/core"
  # Copy the CONTENTS into a real dir we created (never `cp -R <dir>`, which
  # copies a symlinked source AS a symlink), and refuse to delete through
  # anything that is not that real dir — the rm below must never follow a
  # link into the checkout.
  cp -R "$IGRIS_REPO_ROOT/core/." "$stage/$prefix/core/"
  if [ -L "$stage/$prefix/core" ] || [ ! -d "$stage/$prefix/core" ] || [ -L "$stage/$prefix/core/git-hooks" ]; then
    echo "stage_fixture_tarball: refusing — staged core is not a real directory" >&2
    return 1
  fi
  rm -rf "$stage/$prefix/core/git-hooks"
  tar -czf "$stage.tar.gz" -C "$stage" "$prefix"
  echo "$stage.tar.gz"
}

# write_install_source_from_source <source-repo> — a from-source
# .install-source.json record (the shape `igris init --from-source` writes).
write_install_source_from_source() {
  printf '{\n  "schema_version": 1,\n  "channel": "main",\n  "ref": "from-source",\n  "fetched_at": "2026-09-07T00:00:00.000Z",\n  "content_sha256": "from-source-fixture",\n  "source": "from-source",\n  "source_path": "%s"\n}\n' "$1" > "$IGRIS_BRAIN_DIR/.install-source.json"
}

# GITHUB_STUB_PRELOAD — pass as NODE_OPTIONS="--require $GITHUB_STUB_PRELOAD"
# with IGRIS_TEST_HTTPS_MODE=stub|block and IGRIS_TEST_HTTPS_COUNT_FILE=<file>.
GITHUB_STUB_PRELOAD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fixtures/github-stub-preload.cjs"
export GITHUB_STUB_PRELOAD

# path_minimal — echoes a PATH holding ONLY node, git, sqlite3 (symlinked into
# a fresh bin dir) and a STUB gitleaks (secret-scan-disarmed is PATH presence;
# without it the informational row fires on every fence that installs a
# hook), so cli-detect sees none of the runner's real harness binaries (this
# machine has all six on PATH). Prepend a stub dir to make one CLI "installed".
path_minimal() {
  local bin="$BATS_TEST_TMPDIR/minimal-bin"
  mkdir -p "$bin"
  local tool p
  for tool in node git sqlite3; do
    p="$(command -v "$tool" 2>/dev/null || true)"
    [ -n "$p" ] && [ ! -e "$bin/$tool" ] && ln -s "$p" "$bin/$tool"
  done
  if [ ! -e "$bin/gitleaks" ]; then
    printf '#!/bin/sh\necho stub\n' > "$bin/gitleaks"
    chmod +x "$bin/gitleaks"
  fi
  echo "$bin"
}
