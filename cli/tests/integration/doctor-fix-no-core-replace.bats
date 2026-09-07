#!/usr/bin/env bats

# doctor-fix-no-core-replace.bats — BR-103.
#
# On 2026-09-07 `igris doctor --fix` repaired a one-harness `bridge-missing`
# row by calling `init --upgrade`, which resolved the DEFAULT channel (the
# latest release tag), fetched a core OLDER than this checkout and swapped it
# over ~/.igris/core — dropping core/git-hooks/ and dangling every consumer
# hook it was about to install. Three properties are pinned here, each in a
# fenced HOME + IGRIS_BRAIN_DIR sandbox with a fake brain and fake clones:
#
#   D1  `--fix` never replaces core/ (whole-tree byte witness + a from-source
#       record that stays from-source + zero core.bak.*), AND the same run
#       fixes both clones and clears the bridge row (the positive control —
#       "no writes" is trivially true of a run that did nothing).
#   D2  a brain-level fix that THROWS is isolated: the per-project fixes still
#       run, and the outcome table names both with their result.
#   D3  a clean fence under `--fix` writes nothing and prints no fix rows.
#
# Network: the CLI is started with the `node:https` stub preload
# (fixtures/github-stub-preload.cjs). In `stub` mode a run AT HEAD reaches the
# core swap without a live GitHub (the metadata calls are answered locally, the
# tarball body is IGRIS_TARBALL_FILE); the same preload counts every https call,
# so the GREEN arm asserts the number is ZERO rather than inferring it. Both
# arms are hermetic; the RED arm is the same test run against a HEAD dist.

load _helpers.bash

setup() {
  REAL_HOME="$HOME"
  export REAL_HOME
  # Read-only belt over the REAL machine files (absent on CI — then skipped).
  if [ -f "$REAL_HOME/.igris/.install-source.json" ]; then
    REAL_IS_SHA="$(shasum -a 256 "$REAL_HOME/.igris/.install-source.json" | awk '{print $1}')"
    REAL_CORE_SHA="$(core_tree_sha "$REAL_HOME/.igris/core")"
  else
    REAL_IS_SHA=""; REAL_CORE_SHA=""
  fi
  stage_brain
  export IGRIS_KEEP_BAK=0
  HOME="$(stage_home)"
  export HOME
}

teardown() {
  if [ -n "${REAL_IS_SHA:-}" ]; then
    [ "$(shasum -a 256 "$REAL_HOME/.igris/.install-source.json" | awk '{print $1}')" = "$REAL_IS_SHA" ]
    [ "$(core_tree_sha "$REAL_HOME/.igris/core")" = "$REAL_CORE_SHA" ]
  fi
}

# assert_armed — the fence is real: HOME is not the runner's, the brain dir is
# under the test tmpdir. A test that runs unarmed against ~/.igris is the
# incident this file exists to prevent.
assert_armed() {
  [ "$HOME" != "$REAL_HOME" ]
  case "$IGRIS_BRAIN_DIR" in
    "$BATS_TEST_TMPDIR"/*) ;;
    *) echo "IGRIS_BRAIN_DIR not under BATS_TEST_TMPDIR: $IGRIS_BRAIN_DIR"; return 1 ;;
  esac
}

# seed_fence_core — the stub brain plus the git-hooks mirror plus six real repo
# core files, so the tree is non-trivial and a swap is visible in its sha.
seed_fence_core() {
  stage_git_hooks_mirror >/dev/null
  local f
  for f in SOUL.md os/conduct.md skills/igris-doctor/SKILL.md \
           scripts/verify_mirror.sh enforcement/INDEX.md scripts/brief_ac_check.sh; do
    mkdir -p "$IGRIS_BRAIN_DIR/core/$(dirname "$f")"
    cp "$IGRIS_REPO_ROOT/core/$f" "$IGRIS_BRAIN_DIR/core/$f"
  done
}

# plant_bridge_missing — exactly doctor-drift-classes.bats class 8/8: config
# claims only claude; a stub `codex` on PATH + $HOME/.codex make codex
# "installed". Echoes the stub bin dir.
plant_bridge_missing() {
  cat > "$IGRIS_BRAIN_DIR/config.json" <<'CFG'
{
  "version": "7.0.0",
  "cli_targets": { "claude": { "hooks": {} } }
}
CFG
  chmod 600 "$IGRIS_BRAIN_DIR/config.json"
  local stub="$BATS_TEST_TMPDIR/stub-bin"
  mkdir -p "$stub" "$HOME/.codex"
  printf '#!/bin/sh\necho fake\n' > "$stub/codex"
  chmod +x "$stub/codex"
  echo "$stub"
}

# harden_harness_configs — TD-220 R1: the MCP backfill writes harness configs
# at the umask default (644); the read pass would then flag them
# `secret-perms` (harness-owned). Chmod them as `doctor --fix` would on the
# next pass, so the second-pass exit code reads only the classes under test.
harden_harness_configs() {
  local p
  for p in "$HOME/.claude.json" "$HOME/.gemini/settings.json" \
           "$HOME/.codex/config.toml" "$HOME/.config/opencode/opencode.json" \
           "$HOME/.cursor/mcp.json" "$HOME/.gemini/config/mcp_config.json"; do
    [ -f "$p" ] && chmod 600 "$p"
  done
  return 0
}

@test "D1 (BR-103): doctor --fix on bridge-missing never replaces core/ — whole-tree byte witness; both clones fixed; the outcome table names every fix" {
  assert_armed
  seed_fence_core
  write_install_source_from_source "$IGRIS_REPO_ROOT"
  STUB_BIN="$(plant_bridge_missing)"
  RUN_PATH="$STUB_BIN:$(path_minimal)"
  PROJ1="$(stage_git_project gh1)"; register_project_row gh1 "$PROJ1"
  PROJ2="$(stage_git_project gh2)"; register_project_row gh2 "$PROJ2"
  TARBALL="$(stage_fixture_tarball)"
  COUNT_FILE="$BATS_TEST_TMPDIR/https-calls"

  # Witness W0: the whole core tree, the install record, the bak ring.
  W0_TREE="$(core_tree_sha)"
  W0_IS="$(shasum -a 256 "$IGRIS_BRAIN_DIR/.install-source.json" | awk '{print $1}')"
  [ "$(bak_count)" = "0" ]

  PATH="$RUN_PATH" NODE_OPTIONS="--require $GITHUB_STUB_PRELOAD" \
    IGRIS_TEST_HTTPS_MODE=stub IGRIS_TEST_HTTPS_COUNT_FILE="$COUNT_FILE" \
    IGRIS_TARBALL_FILE="$TARBALL" \
    run $CLI_BIN doctor --fix
  echo "$output"
  echo "https calls: $(cat "$COUNT_FILE")"

  # --- the byte witness: nothing under core/ moved, no bak, record intact ----
  [ "$(core_tree_sha)" = "$W0_TREE" ]
  [ "$(shasum -a 256 "$IGRIS_BRAIN_DIR/.install-source.json" | awk '{print $1}')" = "$W0_IS" ]
  [ "$(bak_count)" = "0" ]
  [ -x "$IGRIS_BRAIN_DIR/core/git-hooks/pre-commit" ]
  # line-scoped: the old arm's announcement is gone
  [ "$(grep -c 'invoking partial init' <<<"$output")" = "0" ]
  # zero https calls — counted by the preload, not inferred
  [ "$(cat "$COUNT_FILE")" = "0" ]

  # --- the positive control: the same run did real work -----------------------
  [ -L "$PROJ1/.git/hooks/pre-commit" ] && [ -x "$PROJ1/.git/hooks/pre-commit" ]
  [ -L "$PROJ1/.git/hooks/commit-msg" ] && [ -x "$PROJ1/.git/hooks/commit-msg" ]
  [ -L "$PROJ2/.git/hooks/pre-commit" ] && [ -x "$PROJ2/.git/hooks/pre-commit" ]
  [ -L "$PROJ2/.git/hooks/commit-msg" ] && [ -x "$PROJ2/.git/hooks/commit-msg" ]
  grep -qE '^\| git-hooks-missing \| gh1 \| .* \| applied \| clean \|$' <<<"$output"
  grep -qE '^\| git-hooks-missing \| gh2 \| .* \| applied \| clean \|$' <<<"$output"
  grep -qE '^\| bridge-missing \| codex \| .* \| applied \| clean \|$' <<<"$output"
  run python3 -c "import json; d=json.load(open('$IGRIS_BRAIN_DIR/config.json')); print('codex' in d['cli_targets'], 'claude' in d['cli_targets'])"
  [ "$output" = "True True" ]
  # the record still says from-source at THIS checkout (no silent channel switch)
  run python3 -c "import json; d=json.load(open('$IGRIS_BRAIN_DIR/.install-source.json')); print(d['source'], d['source_path'])"
  [ "$output" = "from-source $IGRIS_REPO_ROOT" ]

  # --- second pass: the fixed classes are gone and the verb exits 0 -----------
  harden_harness_configs
  PATH="$RUN_PATH" NODE_OPTIONS="--require $GITHUB_STUB_PRELOAD" IGRIS_TEST_HTTPS_MODE=block \
    run $CLI_BIN doctor
  echo "$output"
  [ "$status" -eq 0 ]
  [ "$(grep -c 'bridge-missing' <<<"$output")" = "0" ]
  [ "$(grep -c 'git-hooks-missing' <<<"$output")" = "0" ]
}

@test "D2 (BR-103): a brain-level fix that throws is isolated — the per-project fix still runs and the table names both" {
  assert_armed
  stage_git_hooks_mirror >/dev/null
  # brain-core-missing: the load-bearing canonical hooks file is absent...
  rm -f "$IGRIS_BRAIN_DIR/core/hooks/canonical-settings.json"
  # ...and its fix (runRefresh) THROWS on a malformed install record.
  printf '{ not json' > "$IGRIS_BRAIN_DIR/.install-source.json"
  PROJ="$(stage_git_project gh1)"; register_project_row gh1 "$PROJ"
  RUN_PATH="$(path_minimal)"

  PATH="$RUN_PATH" NODE_OPTIONS="--require $GITHUB_STUB_PRELOAD" IGRIS_TEST_HTTPS_MODE=block \
    run $CLI_BIN doctor --fix
  echo "$output"
  # the brain-level failure is reported, not fatal
  [ "$status" -eq 1 ]
  grep -qE '^\| brain-core-missing \| \(brain\) \| .* \| failed \| brain-core-missing \|$' <<<"$output"
  # ...and the per-project fix after it still ran
  [ -L "$PROJ/.git/hooks/pre-commit" ] && [ -x "$PROJ/.git/hooks/pre-commit" ]
  [ -L "$PROJ/.git/hooks/commit-msg" ] && [ -x "$PROJ/.git/hooks/commit-msg" ]
  grep -qE '^\| git-hooks-missing \| gh1 \| .* \| applied \| clean \|$' <<<"$output"
}

@test "D3 (BR-103): control — a clean fence under --fix writes nothing and prints no fix rows" {
  assert_armed
  seed_fence_core
  write_install_source_from_source "$IGRIS_REPO_ROOT"
  PROJ="$(stage_git_project gh1)"; register_project_row gh1 "$PROJ"
  RUN_PATH="$(path_minimal)"
  # one prior pass installs the hooks; from here the fence is clean
  PATH="$RUN_PATH" NODE_OPTIONS="--require $GITHUB_STUB_PRELOAD" IGRIS_TEST_HTTPS_MODE=block \
    run $CLI_BIN doctor --fix
  [ "$status" -eq 0 ]
  W_TREE="$(core_tree_sha)"
  W_IS="$(shasum -a 256 "$IGRIS_BRAIN_DIR/.install-source.json" | awk '{print $1}')"
  PATH="$RUN_PATH" NODE_OPTIONS="--require $GITHUB_STUB_PRELOAD" IGRIS_TEST_HTTPS_MODE=block \
    run $CLI_BIN doctor --fix
  echo "$output"
  [ "$status" -eq 0 ]
  [ "$(core_tree_sha)" = "$W_TREE" ]
  [ "$(shasum -a 256 "$IGRIS_BRAIN_DIR/.install-source.json" | awk '{print $1}')" = "$W_IS" ]
  [ "$(bak_count)" = "0" ]
  grep -q 'No fixes attempted' <<<"$output"
  [ "$(grep -c '| applied |' <<<"$output")" = "0" ]
}
