#!/usr/bin/env bats

# validate_ceremony_sites.test.bash — FR-268. Tests for the authoring control
# scripts/validate_ceremony_sites.sh over the four ceremony skills'
# `igris ceremony start|stop --name <n>` call sites.
#
# Why a guard and not prose: a ceremony's cost is a brain-timed pair written
# by a VERB the skill calls first and last. A skill edit that drops a site,
# moves the start below the first executable step, or misnames the ceremony
# would ship green and the record would silently gain a gap (`igris kpi`
# reports it as `unpaired` a week later — an observer, not a refusal). This
# file is what turns the authoring defect into a red at commit time.
#
# Every RED case MUTATES a scratch copy of the real skill tree and first
# asserts the mutation LANDED (a `sed` that matched nothing proves nothing).
# Every `[[ ]]` carries `|| return 1` (TD-341). Run with `bats`, never `bash`.

load test_helper

GUARD="$IGRIS_ROOT/scripts/validate_ceremony_sites.sh"
SKILLS="$IGRIS_ROOT/core/skills"

setup() {
  [ -f "$GUARD" ] || { echo "guard not found at $GUARD"; return 1; }
  SCRATCH="$(mktemp -d "${BATS_TMPDIR:-/tmp}/ces.XXXXXX")"
  # A verbatim copy of the four skills, the shape the guard reads.
  for s in boot rest register hunt; do
    mkdir -p "$SCRATCH/skills/$s"
    cp "$SKILLS/$s/SKILL.md" "$SCRATCH/skills/$s/SKILL.md"
  done
}

teardown() {
  [ -n "${SCRATCH:-}" ] && rm -rf "$SCRATCH"
}

@test "(G) the real skill tree passes with 4 skills and 8 sites" {
  run /bin/bash "$GUARD"
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "OK: 4 skills, 8 sites" ] || return 1
}

@test "(G2) an explicit skills-dir argument is honoured (same verdict on a verbatim copy)" {
  run /bin/bash "$GUARD" "$SCRATCH/skills"
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "OK: 4 skills, 8 sites" ] || return 1
}

# -----------------------------------------------------------------------------
# (R1) rule (a): boot's stop site deleted.
# -----------------------------------------------------------------------------
@test "(R1) boot's stop line deleted -> FAIL naming boot and the missing stop" {
  f="$SCRATCH/skills/boot/SKILL.md"
  before="$(grep -c 'igris ceremony stop --name boot' "$f")"
  [ "$before" -eq 1 ] || return 1
  grep -v 'igris ceremony stop --name boot' "$f" > "$SCRATCH/m.md" && mv "$SCRATCH/m.md" "$f"
  [ "$(grep -c 'igris ceremony stop --name boot' "$f")" -eq 0 ] || return 1

  run /bin/bash "$GUARD" "$SCRATCH/skills"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"boot/SKILL.md:0 -> no stop site"* ]] || return 1
  [[ "$output" == *"FAIL: 4 skills, 7 sites, 1 violation(s)"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (R2) rule (c): boot's start moved BELOW the first `igris detect` line.
# -----------------------------------------------------------------------------
@test "(R2) boot's start moved below igris detect -> FAIL 'start site must be above'" {
  f="$SCRATCH/skills/boot/SKILL.md"
  start_ln="$(grep -n 'igris ceremony start --name boot' "$f" | head -1 | cut -d: -f1)"
  detect_ln="$(grep -n 'igris detect' "$f" | head -1 | cut -d: -f1)"
  [ "$start_ln" -lt "$detect_ln" ] || return 1
  line="$(sed -n "${start_ln}p" "$f")"
  # Delete it where it is and re-insert it after the LAST `igris detect` line.
  last_detect="$(grep -n 'igris detect' "$f" | tail -1 | cut -d: -f1)"
  awk -v del="$start_ln" -v after="$last_detect" -v text="$line" \
    'NR==del {next} {print} NR==after {print text}' "$f" > "$SCRATCH/m.md" && mv "$SCRATCH/m.md" "$f"
  new_start="$(grep -n 'igris ceremony start --name boot' "$f" | head -1 | cut -d: -f1)"
  [ "$new_start" -gt "$(grep -n 'igris detect' "$f" | head -1 | cut -d: -f1)" ] || return 1

  run /bin/bash "$GUARD" "$SCRATCH/skills"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"start site must be above the first 'igris detect' line"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (R3) rule (a): `--name rest` misspelled as `--name rests`.
# -----------------------------------------------------------------------------
@test "(R3) rest's start renamed to --name rests -> FAIL naming the wrong ceremony and the missing start" {
  f="$SCRATCH/skills/rest/SKILL.md"
  sed 's/igris ceremony start --name rest /igris ceremony start --name rests /' "$f" > "$SCRATCH/m.md" && mv "$SCRATCH/m.md" "$f"
  [ "$(grep -c 'igris ceremony start --name rests ' "$f")" -eq 1 ] || return 1

  run /bin/bash "$GUARD" "$SCRATCH/skills"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"site names ceremony 'rests' but this skill's ceremony is 'rest'"* ]] || return 1
  [[ "$output" == *"rest/SKILL.md:0 -> no start site"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (R4) rule (c): hunt's stop moved below `### Phase 2`.
# -----------------------------------------------------------------------------
@test "(R4) hunt's stop moved below ### Phase 2 -> FAIL 'stop site must be above'" {
  f="$SCRATCH/skills/hunt/SKILL.md"
  stop_ln="$(grep -n 'igris ceremony stop --name hunt-init' "$f" | head -1 | cut -d: -f1)"
  phase2_ln="$(grep -n '^### Phase 2' "$f" | head -1 | cut -d: -f1)"
  [ "$stop_ln" -lt "$phase2_ln" ] || return 1
  line="$(sed -n "${stop_ln}p" "$f")"
  awk -v del="$stop_ln" -v after="$phase2_ln" -v text="$line" \
    'NR==del {next} {print} NR==after {print text}' "$f" > "$SCRATCH/m.md" && mv "$SCRATCH/m.md" "$f"
  [ "$(grep -n 'igris ceremony stop --name hunt-init' "$f" | head -1 | cut -d: -f1)" -gt "$(grep -n '^### Phase 2' "$f" | head -1 | cut -d: -f1)" ] || return 1

  run /bin/bash "$GUARD" "$SCRATCH/skills"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"stop site must be above '### Phase 2'"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (R5) rule (d): a ceremony line indented INTO an `igris_agent_event` window.
# -----------------------------------------------------------------------------
@test "(R5) hunt's stop re-homed inside an igris_agent_event window -> FAIL 'inside an igris_agent_event window'" {
  f="$SCRATCH/skills/hunt/SKILL.md"
  stop_ln="$(grep -n 'igris ceremony stop --name hunt-init' "$f" | head -1 | cut -d: -f1)"
  # The first agent-event site in the file and its first continuation line.
  mark_ln="$(grep -n '`igris_agent_event` with:' "$f" | head -1 | cut -d: -f1)"
  [ "$mark_ln" -gt 0 ] || return 1
  mark_indent="$(sed -n "${mark_ln}p" "$f" | sed 's/[^ ].*//' | wc -c)"
  # Insert the stop line right after the mark, indented deeper than the mark.
  pad="$(printf '%*s' "$((mark_indent + 4))" '')"
  awk -v del="$stop_ln" -v after="$mark_ln" -v text="${pad}igris ceremony stop --name hunt-init --project {project}" \
    'NR==del {next} {print} NR==after {print text}' "$f" > "$SCRATCH/m.md" && mv "$SCRATCH/m.md" "$f"
  [ "$(grep -c '^ *igris ceremony stop --name hunt-init --project {project}$' "$f")" -eq 1 ] || return 1

  run /bin/bash "$GUARD" "$SCRATCH/skills"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"sits inside an \`igris_agent_event\` window"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (R6) rule (b): register's stop placed above its start (both sites present).
# -----------------------------------------------------------------------------
@test "(R6) register's start and stop swapped -> FAIL on ordering" {
  f="$SCRATCH/skills/register/SKILL.md"
  start_ln="$(grep -n 'igris ceremony start --name register' "$f" | head -1 | cut -d: -f1)"
  stop_ln="$(grep -n 'igris ceremony stop --name register' "$f" | head -1 | cut -d: -f1)"
  [ "$start_ln" -lt "$stop_ln" ] || return 1
  awk -v a="$start_ln" -v b="$stop_ln" '
    NR==FNR { if (NR==a) sa=$0; if (NR==b) sb=$0; next }
    FNR==a { print sb; next } FNR==b { print sa; next } { print }' "$f" "$f" > "$SCRATCH/m.md" && mv "$SCRATCH/m.md" "$f"
  [ "$(grep -n 'igris ceremony stop --name register' "$f" | head -1 | cut -d: -f1)" -lt "$(grep -n 'igris ceremony start --name register' "$f" | head -1 | cut -d: -f1)" ] || return 1

  run /bin/bash "$GUARD" "$SCRATCH/skills"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"stop site is not below the start site"* ]] || return 1
}

# -----------------------------------------------------------------------------
# (R7) rule (a): a duplicated start site.
# -----------------------------------------------------------------------------
@test "(R7) rest's start line duplicated -> FAIL '2 start sites'" {
  f="$SCRATCH/skills/rest/SKILL.md"
  awk '{print} /igris ceremony start --name rest / && !done {done=1; print}' "$f" > "$SCRATCH/m.md" && mv "$SCRATCH/m.md" "$f"
  [ "$(grep -c 'igris ceremony start --name rest ' "$f")" -eq 2 ] || return 1

  run /bin/bash "$GUARD" "$SCRATCH/skills"
  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"2 start sites (expected exactly one)"* ]] || return 1
}

@test "(C) a comment-only line added to every skill -> still OK: 4 skills, 8 sites" {
  for s in boot rest register hunt; do
    printf '\n<!-- FR-268 control line: no site here -->\n' >> "$SCRATCH/skills/$s/SKILL.md"
  done
  [ "$(grep -c 'FR-268 control line' "$SCRATCH/skills/boot/SKILL.md")" -eq 1 ] || return 1
  run /bin/bash "$GUARD" "$SCRATCH/skills"
  [ "$status" -eq 0 ] || return 1
  [ "$output" = "OK: 4 skills, 8 sites" ] || return 1
}

@test "(E) unreadable skills dir -> exit 2" {
  run /bin/bash "$GUARD" "$SCRATCH/does-not-exist"
  [ "$status" -eq 2 ] || return 1
}

@test "(E2) a skills dir missing one of the four skills -> exit 2" {
  rm "$SCRATCH/skills/register/SKILL.md"
  run /bin/bash "$GUARD" "$SCRATCH/skills"
  [ "$status" -eq 2 ] || return 1
  [[ "$output" == *"cannot read"* ]] || return 1
}
