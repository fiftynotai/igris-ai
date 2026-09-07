#!/usr/bin/env bats

# init.bats — integration tests for `igris init`. Hermetic via
# IGRIS_BRAIN_DIR + --from-source. Each test stages its own source
# repo + fresh empty brain dir.

load _helpers.bash

setup() {
  # Each test gets its own brain root + source repo + temp HOME.
  # HOME override gives cli-detect a clean tree; we DON'T override
  # PATH because bats itself needs basic shell utilities (mkdir, tar,
  # etc.) on PATH. The empty-bin trick the unit tests use isn't
  # needed here — at the bats layer cli-detect won't find any of the
  # 4 supported CLIs in our HOME-overriden config dir, so the
  # detection set is empty regardless.
  export IGRIS_BRAIN_DIR="$BATS_TEST_TMPDIR/igris-brain"
  fence_home  # TD-456: HOME=$BATS_TEST_TMPDIR/home, asserted (init writes every harness config under $HOME)
  SOURCE_REPO="$BATS_TEST_TMPDIR/source-repo"
  stage_source_repo "$SOURCE_REPO"
}

stage_source_repo() {
  local root="$1"
  mkdir -p "$root/core/agents" "$root/core/skills/demo" \
           "$root/core/prompts" "$root/core/hooks" "$root/core/scripts"
  printf '# soul (bats)\n' > "$root/core/SOUL.md"
  printf '{ "version": "fixture" }\n' > "$root/core/igris_tree.json"
  printf 'agents: []\n' > "$root/core/agents/manifest.yaml"
  printf '# demo skill\n' > "$root/core/skills/demo/SKILL.md"
  printf '{"hooks":{}}\n' > "$root/core/hooks/canonical-settings.json"
  printf '#!/bin/sh\necho noop\n' > "$root/core/scripts/verify_mirror.sh"
  chmod +x "$root/core/scripts/verify_mirror.sh"
  printf '# igris_os\n' > "$root/core/prompts/igris_os.md"
}

@test "init --from-source creates the brain dir tree and core/ contents" {
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]
  [ -d "$IGRIS_BRAIN_DIR/memory" ]
  [ -d "$IGRIS_BRAIN_DIR/projects" ]
  [ -d "$IGRIS_BRAIN_DIR/logs" ]
  [ -d "$IGRIS_BRAIN_DIR/.cache" ]
  [ -f "$IGRIS_BRAIN_DIR/core/SOUL.md" ]
  [ -f "$IGRIS_BRAIN_DIR/core/skills/demo/SKILL.md" ]
  [ -f "$IGRIS_BRAIN_DIR/USER.md" ]
  [ -f "$IGRIS_BRAIN_DIR/config.json" ]
  [ -f "$IGRIS_BRAIN_DIR/.install-source.json" ]
}

@test "init refuses to overwrite existing v7 install without --upgrade" {
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 1 ]
  [[ "$output" == *"--upgrade"* ]]
}

@test "init --upgrade preserves USER.md byte-for-byte and config.json user-data (additive onboarding stamp only)" {
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]

  # User mutates state files.
  printf 'my custom user notes\n' > "$IGRIS_BRAIN_DIR/USER.md"
  USER_BEFORE_SHA=$(shasum -a 256 "$IGRIS_BRAIN_DIR/USER.md" | awk '{print $1}')

  # config.json user-data fingerprint = the config's semantic VALUES with the
  # FR-235 onboarding lifecycle key removed. This isolates "did any user-authored
  # config value change" from (a) the intentional additive onboarding stamp and
  # (b) the value-preserving reserialization the stamp's rewrite performs (e.g.
  # JS JSON.stringify collapsing 1.0 -> 1). Numbers are coerced to float and keys
  # sorted so only a real value change moves the hash.
  cfg_userdata_sha() {
    python3 - "$IGRIS_BRAIN_DIR/config.json" <<'PY'
import json, hashlib, sys
def norm(x):
    if isinstance(x, bool): return x           # bool before int (bool is-a int)
    if isinstance(x, (int, float)): return float(x)
    if isinstance(x, dict): return {k: norm(v) for k, v in x.items()}
    if isinstance(x, list): return [norm(v) for v in x]
    return x
d = json.load(open(sys.argv[1]))
d.pop("onboarding", None)
print(hashlib.sha256(json.dumps(norm(d), sort_keys=True).encode()).hexdigest())
PY
  }
  CFG_USERDATA_BEFORE=$(cfg_userdata_sha)

  # Mutate the source between init and upgrade.
  printf '# soul (bats v2)\n' > "$SOURCE_REPO/core/SOUL.md"

  run $CLI_BIN init --from-source "$SOURCE_REPO" --upgrade
  [ "$status" -eq 0 ]

  # USER.md stays byte-for-byte — the upgrade never writes it.
  USER_AFTER_SHA=$(shasum -a 256 "$IGRIS_BRAIN_DIR/USER.md" | awk '{print $1}')
  [ "$USER_BEFORE_SHA" = "$USER_AFTER_SHA" ]

  # config.json: no user-authored value changed (fingerprint minus onboarding
  # is identical) — the ONLY permitted delta is the additive onboarding stamp.
  CFG_USERDATA_AFTER=$(cfg_userdata_sha)
  [ "$CFG_USERDATA_BEFORE" = "$CFG_USERDATA_AFTER" ]

  # And that additive stamp landed: a returning (--upgrade) user is marked
  # onboarded so /boot's Welcome + /setup's teach path never fire (BR-077).
  run python3 -c "import json; print(json.load(open('$IGRIS_BRAIN_DIR/config.json')).get('onboarding', {}).get('completed'))"
  [ "$status" -eq 0 ]
  [ "$output" = "True" ]

  # And core itself was upgraded.
  run cat "$IGRIS_BRAIN_DIR/core/SOUL.md"
  [ "$output" = "# soul (bats v2)" ]
}

@test "init --upgrade on empty brain errors with actionable message" {
  run $CLI_BIN init --from-source "$SOURCE_REPO" --upgrade
  [ "$status" -eq 1 ]
  [[ "$output" == *"no existing install"* ]]
}

@test "init --cli-bridge=none keeps cli_targets empty" {
  run $CLI_BIN init --from-source "$SOURCE_REPO" --cli-bridge none
  [ "$status" -eq 0 ]
  run python3 -c "import json; d=json.load(open('$IGRIS_BRAIN_DIR/config.json')); print(len(d['cli_targets']))"
  [ "$status" -eq 0 ]
  [ "$output" = "0" ]
}

@test "init --skip-remote sets remote_brain to null in config.json" {
  run $CLI_BIN init --from-source "$SOURCE_REPO" --skip-remote
  [ "$status" -eq 0 ]
  run python3 -c "import json; d=json.load(open('$IGRIS_BRAIN_DIR/config.json')); print(d['remote_brain'])"
  [ "$status" -eq 0 ]
  [ "$output" = "None" ]
}

@test "init --dry-run prints plan and writes nothing" {
  run $CLI_BIN init --from-source "$SOURCE_REPO" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"Dry-run plan:"* ]]
  [[ "$output" == *"No filesystem writes"* ]]
  # Brain dir should NOT have core/ or templates.
  [ ! -f "$IGRIS_BRAIN_DIR/core/SOUL.md" ]
  [ ! -f "$IGRIS_BRAIN_DIR/USER.md" ]
}

@test "init writes .install-source.json with source=from-source" {
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]
  run python3 -c "import json; d=json.load(open('$IGRIS_BRAIN_DIR/.install-source.json')); print(d['source'])"
  [ "$status" -eq 0 ]
  [ "$output" = "from-source" ]
}

@test "init registers igris-brain MCP in ~/.claude.json (TD-168)" {
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]
  # HOME is overridden to $BATS_TEST_TMPDIR/home in setup(), so
  # ~/.claude.json lands there.
  [ -f "$HOME/.claude.json" ]
  run python3 -c "import json; d=json.load(open('$HOME/.claude.json')); e=d['mcpServers']['igris-brain']; print(e['type'], e['command'])"
  [ "$status" -eq 0 ]
  [ "$output" = "stdio node" ]
}

@test "init does NOT corrupt a malformed ~/.claude.json (non-fatal)" {
  # Pre-write a malformed ~/.claude.json. init must complete (exit 0,
  # non-fatal MCP registration) and leave the broken file byte-unchanged.
  printf '{ broken json,,, ' > "$HOME/.claude.json"
  BEFORE_SHA=$(shasum -a 256 "$HOME/.claude.json" | awk '{print $1}')

  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]

  AFTER_SHA=$(shasum -a 256 "$HOME/.claude.json" | awk '{print $1}')
  [ "$BEFORE_SHA" = "$AFTER_SHA" ]
  # No backup or tmp litter from the refused write.
  [ ! -f "$HOME/.claude.json.igris.bak" ]
}

# --- BR-103: `init --upgrade` refuses a real interruption, honours the record,
# and preserves the runtime-only extras. `stage_source_repo` above is the
# fixture core; I4 uses the REAL checkout so the mirror sweep is over the
# repo's own `git ls-files core`.

@test "I1 (BR-103): init --upgrade REFUSES on core.new.* staging residue — exit 1, nothing written; --wipe-orphans is the door" {
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]
  mkdir "$IGRIS_BRAIN_DIR/core.new.99999"
  printf 'half-written\n' > "$IGRIS_BRAIN_DIR/core.new.99999/partial"
  W_TREE="$(core_tree_sha)"
  W_IS="$(shasum -a 256 "$IGRIS_BRAIN_DIR/.install-source.json" | awk '{print $1}')"
  W_CFG="$(shasum -a 256 "$IGRIS_BRAIN_DIR/config.json" | awk '{print $1}')"
  # a proceed would be visible: the source moved
  printf '# soul (bats v2)\n' > "$SOURCE_REPO/core/SOUL.md"

  run $CLI_BIN init --from-source "$SOURCE_REPO" --upgrade
  echo "$output"
  [ "$status" -ne 0 ]
  grep -q 'interrupted' <<<"$output"
  grep -q 'core.new.99999' <<<"$output"
  grep -q -- '--wipe-orphans' <<<"$output"
  # nothing written: tree, record, config (so no onboarding stamp), residue kept, no bak
  [ "$(core_tree_sha)" = "$W_TREE" ]
  [ "$(shasum -a 256 "$IGRIS_BRAIN_DIR/.install-source.json" | awk '{print $1}')" = "$W_IS" ]
  [ "$(shasum -a 256 "$IGRIS_BRAIN_DIR/config.json" | awk '{print $1}')" = "$W_CFG" ]
  [ -f "$IGRIS_BRAIN_DIR/core.new.99999/partial" ]
  [ "$(bak_count)" = "0" ]
  run cat "$IGRIS_BRAIN_DIR/core/SOUL.md"
  [ "$output" = "# soul (bats)" ]

  # the door: staging residue is removed, the upgrade proceeds
  run $CLI_BIN init --from-source "$SOURCE_REPO" --upgrade --wipe-orphans
  echo "$output"
  [ "$status" -eq 0 ]
  [ ! -d "$IGRIS_BRAIN_DIR/core.new.99999" ]
  run cat "$IGRIS_BRAIN_DIR/core/SOUL.md"
  [ "$output" = "# soul (bats v2)" ]
}

@test "I2 (BR-103): control — a retained core.bak.* beside a healthy core/ is NOT an interruption: --upgrade proceeds with no error line" {
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]
  run $CLI_BIN init --from-source "$SOURCE_REPO" --upgrade
  [ "$status" -eq 0 ]
  [ "$(bak_count)" = "1" ]
  printf '# soul (bats v3)\n' > "$SOURCE_REPO/core/SOUL.md"
  run $CLI_BIN init --from-source "$SOURCE_REPO" --upgrade
  echo "$output"
  [ "$status" -eq 0 ]
  [ "$(grep -c 'Detected interrupted state' <<<"$output")" = "0" ]
  [ "$(grep -c 'error:' <<<"$output")" = "0" ]
  run cat "$IGRIS_BRAIN_DIR/core/SOUL.md"
  [ "$output" = "# soul (bats v3)" ]
  # one retained bak: the older one was pruned, the newest kept
  [ "$(bak_count)" = "1" ]
}

@test "I3 (BR-103): init --upgrade REFUSES a mid-swap shape (core.bak.* present, core/ absent) with a restore hint; never auto-restores, never wipes the bak" {
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]
  BAK="$IGRIS_BRAIN_DIR/core.bak.2026-01-01T00-00-00-000Z"
  mv "$IGRIS_BRAIN_DIR/core" "$BAK"
  W_BAK="$(core_tree_sha "$BAK")"
  W_IS="$(shasum -a 256 "$IGRIS_BRAIN_DIR/.install-source.json" | awk '{print $1}')"
  run $CLI_BIN init --from-source "$SOURCE_REPO" --upgrade
  echo "$output"
  [ "$status" -ne 0 ]
  grep -q 'interrupted' <<<"$output"
  grep -q "mv $BAK $IGRIS_BRAIN_DIR/core" <<<"$output"
  [ ! -e "$IGRIS_BRAIN_DIR/core" ]
  [ -d "$BAK" ]
  [ "$(core_tree_sha "$BAK")" = "$W_BAK" ]
  [ "$(shasum -a 256 "$IGRIS_BRAIN_DIR/.install-source.json" | awk '{print $1}')" = "$W_IS" ]
  # the operator's move is the recovery; after it the upgrade proceeds
  mv "$BAK" "$IGRIS_BRAIN_DIR/core"
  run $CLI_BIN init --from-source "$SOURCE_REPO" --upgrade
  [ "$status" -eq 0 ]
}

@test "I4 (BR-103): init --upgrade with NO flags on a from-source record re-copies from the RECORDED checkout — zero network; every repo core/** file MATCHes; git-hooks executable" {
  run $CLI_BIN init --from-source "$IGRIS_REPO_ROOT"
  [ "$status" -eq 0 ]
  # a from-source record pointing at THIS checkout
  run python3 -c "import json; d=json.load(open('$IGRIS_BRAIN_DIR/.install-source.json')); print(d['source'], d['source_path'])"
  [ "$output" = "from-source $IGRIS_REPO_ROOT" ]
  COUNT_FILE="$BATS_TEST_TMPDIR/https-calls"
  # NO --from-source, NO --channel: the record decides. Any https call errors
  # (block mode) and is counted; IGRIS_BLOCK_NETWORK fences the tarball seam too.
  NODE_OPTIONS="--require $GITHUB_STUB_PRELOAD" IGRIS_TEST_HTTPS_MODE=block \
    IGRIS_TEST_HTTPS_COUNT_FILE="$COUNT_FILE" IGRIS_BLOCK_NETWORK=1 \
    run $CLI_BIN init --upgrade
  echo "$output"
  echo "https calls: $(cat "$COUNT_FILE")"
  [ "$status" -eq 0 ]
  [ "$(cat "$COUNT_FILE")" = "0" ]
  run python3 -c "import json; d=json.load(open('$IGRIS_BRAIN_DIR/.install-source.json')); print(d['source'], d['source_path'], d['channel'], d['ref'])"
  [ "$output" = "from-source $IGRIS_REPO_ROOT main from-source" ]
  # the mirror sweep: every tracked repo core/** file vs the fenced runtime core
  PAIRS=""
  for f in $(git -C "$IGRIS_REPO_ROOT" ls-files core); do
    PAIRS="$PAIRS $IGRIS_REPO_ROOT/$f $IGRIS_BRAIN_DIR/$f"
  done
  N_FILES="$(git -C "$IGRIS_REPO_ROOT" ls-files core | wc -l | tr -d ' ')"
  run bash "$IGRIS_REPO_ROOT/core/scripts/verify_mirror.sh" $PAIRS
  echo "$output" | tail -3
  [ "$status" -eq 0 ]
  # the primitive's own SUMMARY line: every pair MATCH, zero of every other verdict
  grep -q "^SUMMARY: $N_FILES pairs — $N_FILES MATCH, 0 MISMATCH, 0 MISSING, 0 SAME_INODE, 0 TYPE_ERROR, 0 ERROR" <<<"$output"
  [ -x "$IGRIS_BRAIN_DIR/core/git-hooks/pre-commit" ]
  [ -x "$IGRIS_BRAIN_DIR/core/git-hooks/commit-msg" ]
  # the runtime-only extra regenerated from the source ROOT
  cmp "$IGRIS_REPO_ROOT/harness-manifest.json" "$IGRIS_BRAIN_DIR/core/harness-manifest.json"
}

@test "I5 (BR-103): runtime-only extras across an upgrade — harness-manifest.json REGENERATED from the source root, docs/component-manifest.md CARRIED over, an unlisted extra is reported and NOT carried" {
  printf '{ "harnesses": {}, "v": 1 }\n' > "$SOURCE_REPO/harness-manifest.json"
  run $CLI_BIN init --from-source "$SOURCE_REPO"
  [ "$status" -eq 0 ]
  cmp "$SOURCE_REPO/harness-manifest.json" "$IGRIS_BRAIN_DIR/core/harness-manifest.json"
  # prior core carries the two runtime-only files + one stale unlisted extra
  mkdir -p "$IGRIS_BRAIN_DIR/core/docs"
  printf '# component manifest (runtime-only)\n' > "$IGRIS_BRAIN_DIR/core/docs/component-manifest.md"
  printf 'stale\n' > "$IGRIS_BRAIN_DIR/core/stray.md"
  # the source root's manifest moved: REGENERATE must pick the new one up
  printf '{ "harnesses": {}, "v": 2 }\n' > "$SOURCE_REPO/harness-manifest.json"
  run $CLI_BIN init --from-source "$SOURCE_REPO" --upgrade --verbose
  echo "$output"
  [ "$status" -eq 0 ]
  UPGRADE_OUT="$output"
  cmp "$SOURCE_REPO/harness-manifest.json" "$IGRIS_BRAIN_DIR/core/harness-manifest.json"
  [ -f "$IGRIS_BRAIN_DIR/core/docs/component-manifest.md" ]
  run cat "$IGRIS_BRAIN_DIR/core/docs/component-manifest.md"
  [ "$output" = "# component manifest (runtime-only)" ]
  [ ! -e "$IGRIS_BRAIN_DIR/core/stray.md" ]
  # the --verbose lines name each disposition
  grep -q 'not carried: stray.md' <<<"$UPGRADE_OUT"
  grep -q 'carried over: docs/component-manifest.md' <<<"$UPGRADE_OUT"
  grep -q 'regenerated: harness-manifest.json' <<<"$UPGRADE_OUT"
}
