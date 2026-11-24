#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# model_tier_resolver.test.bash — FR-277 (AC2, AC5). `model_tier.sh resolve`
# over the real harness-manifest.json `model_tiers` map, plus fenced copies for
# the no-map and runtime-layout cases. Nothing here opens a brain.
#
#   R1   warden default                         tier=fast, source=default
#   R2   forger --size L                        effort high
#   R2b  forger --size XL                       tier=deep
#   R2c  forger --size M-Medium                 the default (M has no step)
#   R2d  forger --size bogus                    the default plus a stderr NOTE
#   R3   warden --tier strong --effort high     exit 0, source=override
#   R4   architect --tier fast                  exit 1 (lighter than the default)
#   R4b  warden --effort low                    exit 1 (same tier, lower effort)
#   R5   an override equal to the default       exit 0
#   R6   unknown agent / tier / harness         exit 2
#   R7   no map                                 exit 3
#   R8   runtime layout (core/harness-manifest.json beside core/scripts)
#   R9   warden --tier strong --differ-from claude-opus-5-5   tier=deep
#   R9b  warden --differ-from inherit:claude-sonnet-5-5       tier=strong
#   R10  sentinel --size XL (control: no step)  unchanged
#   RM5  mutation: `<` -> `<=` in the override floor breaks R5
#   RM4b mutation: dropping the effort comparison lets R4b through
# Each mutation first proves it landed (grep -c of the mutated line is 1).

load test_helper

ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
MT="$ADAPTERS/model_tier.sh"

setup() {
  require_python3
  export HOME="$TEST_TEMP_DIR/home"
  export IGRIS_BRAIN_DIR="$TEST_TEMP_DIR/brain"
  mkdir -p "$HOME" "$IGRIS_BRAIN_DIR"
  unset IGRIS_ADAPTER_COMMON_SOURCED
}

# kv <key> — the value of `key=` in $output.
kv() { printf '%s\n' "$output" | sed -n "s/^$1=//p" | head -1; }

# mutant_adapters <sed-expr> <needle> — a copy of the adapter dir plus the
# real manifest at the repo-layout position, with one python line mutated.
mutant_adapters() {
  local root="$TEST_TEMP_DIR/mut"
  mkdir -p "$root/core/scripts"
  cp -R "$ADAPTERS" "$root/core/scripts/cli-adapters"
  cp "$IGRIS_ROOT/harness-manifest.json" "$root/harness-manifest.json"
  [ "$(grep -cF -- "$2" "$root/core/scripts/cli-adapters/_common.sh")" -eq 1 ] \
    || { echo "mutation site '$2' is not unique" >&2; return 1; }
  sed -i.bak -e "$1" "$root/core/scripts/cli-adapters/_common.sh"
  [ "$(grep -cF -- "$2" "$root/core/scripts/cli-adapters/_common.sh")" -eq 0 ] \
    || { echo "mutation did not land" >&2; return 1; }
  echo "$root/core/scripts/cli-adapters/model_tier.sh"
}

@test "R1: warden's default is the fast tier" {
  run bash "$MT" resolve --agent warden
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(kv tier)" = fast ] || { echo "$output"; return 1; }
  [ "$(kv source)" = default ] || { echo "$output"; return 1; }
  [ "$(kv claude.model)" = sonnet ] || { echo "$output"; return 1; }
  [ "$(kv codex.model)" = gpt-6.2-sol ] || { echo "$output"; return 1; }
}

@test "R2: forger --size L steps effort to high on its tier" {
  run bash "$MT" resolve --agent forger --size L
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(kv tier)" = strong ] && [ "$(kv effort)" = high ] && [ "$(kv source)" = size:L ] \
    || { echo "$output"; return 1; }
}

@test "R2b: forger --size XL steps to the deep tier" {
  run bash "$MT" resolve --agent forger --size XL
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(kv tier)" = deep ] && [ "$(kv claude.model)" = fable ] || { echo "$output"; return 1; }
}

@test "R2c: forger --size M-Medium reads as M, which has no step: the default" {
  run bash "$MT" resolve --agent forger --size M-Medium
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(kv tier)" = strong ] && [ "$(kv effort)" = medium ] && [ "$(kv source)" = default ] \
    || { echo "$output"; return 1; }
}

@test "R2d: an unknown size gives the default and a stderr NOTE" {
  run bash -c "bash '$MT' resolve --agent forger --size bogus 2>'$TEST_TEMP_DIR/err'"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(kv tier)" = strong ] && [ "$(kv source)" = default ] || { echo "$output"; return 1; }
  grep -qF "NOTE: unknown size 'bogus'" "$TEST_TEMP_DIR/err" || { cat "$TEST_TEMP_DIR/err"; return 1; }
}

@test "R3: warden --tier strong --effort high is a heavier per-run override" {
  run bash "$MT" resolve --agent warden --tier strong --effort high
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(kv tier)" = strong ] && [ "$(kv effort)" = high ] && [ "$(kv source)" = override ] \
    || { echo "$output"; return 1; }
  [ "$(kv claude.model)" = opus ] || { echo "$output"; return 1; }
}

@test "R4: architect --tier fast is refused (lighter than the role default)" {
  run bash "$MT" resolve --agent architect --tier fast
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"REFUSED:"*"lighter than architect's default strong/high"* ]] || { echo "$output"; return 1; }
}

@test "R4b: warden --effort low is refused (same tier, lower effort)" {
  run bash "$MT" resolve --agent warden --effort low
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"REFUSED:"* ]] || { echo "$output"; return 1; }
}

@test "R5: an override equal to the role default is allowed" {
  run bash "$MT" resolve --agent warden --tier fast --effort medium
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(kv tier)" = fast ] && [ "$(kv source)" = override ] || { echo "$output"; return 1; }
}

@test "R6: unknown agent, tier, effort or harness is a usage error (exit 2)" {
  run bash "$MT" resolve --agent ghost
  [ "$status" -eq 2 ] || { echo "agent: $status $output"; return 1; }
  run bash "$MT" resolve --agent warden --tier huge
  [ "$status" -eq 2 ] || { echo "tier: $status $output"; return 1; }
  run bash "$MT" resolve --agent warden --effort extreme
  [ "$status" -eq 2 ] || { echo "effort: $status $output"; return 1; }
  # Best-effort harnesses have no tier column (the script header names it).
  run bash "$MT" resolve --agent warden --harness gemini
  [ "$status" -eq 2 ] || { echo "harness: $status $output"; return 1; }
  run bash "$MT" resolve
  [ "$status" -eq 2 ] || { echo "usage: $status $output"; return 1; }
}

@test "R7: a manifest without model_tiers exits 3" {
  python3 - "$IGRIS_ROOT/harness-manifest.json" "$TEST_TEMP_DIR/nomap.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
m.pop("model_tiers", None)
json.dump(m, open(sys.argv[2], "w", encoding="utf-8"))
PY
  run bash "$MT" resolve --agent warden --manifest "$TEST_TEMP_DIR/nomap.json"
  [ "$status" -eq 3 ] || { echo "$status $output"; return 1; }
}

@test "R8: the runtime layout (<x>/core/harness-manifest.json) resolves" {
  local x="$TEST_TEMP_DIR/runtime"
  mkdir -p "$x/core/scripts"
  cp -R "$ADAPTERS" "$x/core/scripts/cli-adapters"
  cp "$IGRIS_ROOT/harness-manifest.json" "$x/core/harness-manifest.json"
  [ ! -e "$x/harness-manifest.json" ] || return 1
  run bash "$x/core/scripts/cli-adapters/model_tier.sh" resolve --agent forger --size XL
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(kv tier)" = deep ] || { echo "$output"; return 1; }
}

@test "R9: warden --tier strong --differ-from claude-opus-5-5 steps to deep" {
  run bash "$MT" resolve --agent warden --tier strong --differ-from claude-opus-5-5
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(kv tier)" = deep ] && [ "$(kv source)" = differ:deep ] || { echo "$output"; return 1; }
  [ "$(kv claude.effort)" = high ] || { echo "$output"; return 1; }
}

@test "R9b: --differ-from inherit:claude-sonnet-5-5 steps warden's default to strong" {
  run bash "$MT" resolve --agent warden --differ-from inherit:claude-sonnet-5-5
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(kv tier)" = strong ] && [ "$(kv claude.model)" = opus ] || { echo "$output"; return 1; }
}

@test "R10: control — sentinel --size XL has no step and stays on its default" {
  run bash "$MT" resolve --agent sentinel --size XL
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(kv tier)" = fast ] && [ "$(kv source)" = default ] || { echo "$output"; return 1; }
}

@test "RM5: mutation — '<' to '<=' in the override floor refuses R5's equal override" {
  local mt
  mt="$(mutant_adapters 's/            if want < floor:/            if want <= floor:/' '            if want < floor:')" || return 1
  run bash "$mt" resolve --agent warden --tier fast --effort medium
  [ "$status" -eq 1 ] || { echo "mutant survived: $status $output"; return 1; }
}

@test "RM4b: mutation — dropping the effort comparison lets R4b's lighter effort through" {
  local mt
  mt="$(mutant_adapters 's/            if want < floor:/            if want[0] < floor[0]:/' '            if want < floor:')" || return 1
  run bash "$mt" resolve --agent warden --effort low
  [ "$status" -eq 0 ] || { echo "mutant killed for the wrong reason: $status $output"; return 1; }
}
