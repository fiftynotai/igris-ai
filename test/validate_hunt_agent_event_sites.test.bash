#!/usr/bin/env bats

# validate_hunt_agent_event_sites.test.bash — FR-267. Tests for the derivation
# guard scripts/validate_hunt_agent_event_sites.sh over the hunt skill's
# `igris_agent_event` call sites.
#
# Why a guard and not prose: the gateway REQUIRES model_requested on every
# call (a site without it is rejected at dispatch, and the emission is
# fire-and-forget, so the loss is silent) and the brain OWNS duration_ms and
# round. A skill edit that drops the argument or re-adds a caller-supplied
# duration would ship green. This file is what turns that into a red.
#
# Every RED case below MUTATES a scratch copy of the real skill and first
# asserts the mutation LANDED (a `sed` that matched nothing would prove nothing
# — forger memory: prove the mutation landed). Every `[[ ]]` carries
# `|| return 1` (TD-341: a bare non-final `[[ ]]` cannot fail a bats test).

load test_helper

GUARD="$IGRIS_ROOT/scripts/validate_hunt_agent_event_sites.sh"
SKILL="$IGRIS_ROOT/core/skills/hunt/SKILL.md"

setup() {
  [ -f "$GUARD" ] || { echo "guard not found at $GUARD"; return 1; }
  [ -f "$SKILL" ] || { echo "skill not found at $SKILL"; return 1; }
  SCRATCH="$(mktemp -d "${BATS_TMPDIR:-/tmp}/aes.XXXXXX")"
}

teardown() {
  [ -n "${SCRATCH:-}" ] && rm -rf "$SCRATCH"
}

@test "(G) the real hunt skill passes with at least 13 sites" {
  run bash "$GUARD"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" =~ ^OK:\ ([0-9]+)\ sites$ ]] || return 1
  [ "${BASH_REMATCH[1]}" -ge 13 ] || return 1
}

@test "(G2) an explicit path argument is honoured (same verdict on a verbatim copy)" {
  cp "$SKILL" "$SCRATCH/copy.md"
  run bash "$GUARD" "$SCRATCH/copy.md"
  [ "$status" -eq 0 ] || return 1
  [[ "$output" == OK:* ]] || return 1
}

# -----------------------------------------------------------------------------
# (R1) SELF-NEGATIVE CONTROL for rule (a): delete ONE model_requested line.
# -----------------------------------------------------------------------------
@test "(R1) one model_requested line deleted -> FAIL naming that site and the key" {
  before="$(grep -c 'model_requested:' "$SKILL")"
  # Delete the FIRST `- model_requested:` line only.
  awk 'BEGIN{done=0} /^[[:space:]]*- model_requested:/ && !done {done=1; next} {print}' \
    "$SKILL" > "$SCRATCH/m.md"
  after="$(grep -c 'model_requested:' "$SCRATCH/m.md")"
  [ "$after" -eq $((before - 1)) ] || return 1

  run bash "$GUARD" "$SCRATCH/m.md"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"does not name 'model_requested'"* ]] || return 1
  [[ "$output" == *"FAIL:"* ]] || return 1
  # Exactly one site is broken.
  [ "$(printf '%s\n' "$output" | grep -c "does not name 'model_requested'")" -eq 1 ] || return 1
}

# -----------------------------------------------------------------------------
# (R2) SELF-NEGATIVE CONTROL for rule (b): a caller-supplied duration_ms.
# -----------------------------------------------------------------------------
@test "(R2) a '- duration_ms: 5' line added to a window -> FAIL naming duration_ms" {
  awk 'BEGIN{done=0} {print} /^[[:space:]]*- event_type: "start"/ && !done {done=1; print "   - duration_ms: 5"}' \
    "$SKILL" > "$SCRATCH/d.md"
  grep -q '^   - duration_ms: 5$' "$SCRATCH/d.md" || return 1

  run bash "$GUARD" "$SCRATCH/d.md"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"passes 'duration_ms'"* ]] || return 1
}

@test "(R2b) a '- round: 2' line added to a window -> FAIL naming round" {
  awk 'BEGIN{done=0} {print} /^[[:space:]]*- event_type: "stop"$/ && !done {done=1; print "     - round: 2"}' \
    "$SKILL" > "$SCRATCH/r.md"
  grep -q '^     - round: 2$' "$SCRATCH/r.md" || return 1

  run bash "$GUARD" "$SCRATCH/r.md"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"passes 'round'"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (R3) rule (c): the mender start site is what makes mender a covered role.
# -----------------------------------------------------------------------------
@test "(R3) the mender start agent misspelled -> FAIL naming mender" {
  sed 's/^     - agent: "mender"$/     - agent: "mendr"/' "$SKILL" > "$SCRATCH/a.md"
  ! grep -q '^     - agent: "mender"$' "$SCRATCH/a.md" || return 1
  grep -q '^     - agent: "mendr"$' "$SCRATCH/a.md" || return 1

  run bash "$GUARD" "$SCRATCH/a.md"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *'no start site names agent "mender"'* ]] || return 1
}

# -----------------------------------------------------------------------------
# (R4) rule (d): the site floor. Everything before Phase 3 holds 2 sites.
# -----------------------------------------------------------------------------
@test "(R4) a copy truncated before Phase 3 -> FAIL on the site floor" {
  awk '/^### Phase 3: BUILDING/ {exit} {print}' "$SKILL" > "$SCRATCH/t.md"
  [ "$(grep -c '`igris_agent_event` with:' "$SCRATCH/t.md")" -lt 13 ] || return 1

  run bash "$GUARD" "$SCRATCH/t.md"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"fewer than the 13 floor"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (A) the argument form is what counts: a bare word in a placeholder is not
#     `agent:`. Replace `- agent: "architect"` with prose naming the agent.
# -----------------------------------------------------------------------------
@test "(A) 'agent' as a bare word in the window is not the argument -> FAIL" {
  sed 's/^   - agent: "architect"$/   - the agent here is architect/' "$SKILL" > "$SCRATCH/w.md"
  grep -q '^   - the agent here is architect$' "$SCRATCH/w.md" || return 1

  run bash "$GUARD" "$SCRATCH/w.md"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"does not name 'agent'"* ]] || return 1
}

@test "(E) unreadable path -> exit 2" {
  run bash "$GUARD" "$SCRATCH/does-not-exist.md"
  [ "$status" -eq 2 ] || return 1
}
