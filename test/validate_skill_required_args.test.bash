#!/usr/bin/env bats

# validate_skill_required_args.test.bash - Tests for
#   scripts/validate_skill_required_args.py (TD-324).
#
# The recurrence guard for SKILL CALL SITES that omit a brain tool's declared
# `inputSchema.required` argument. BR-080 made those a gateway REJECTION rather
# than a silent NULL bind, and skill prose is the largest caller population
# with no compiler, no type checker and no test watching it.
#
# The two controls that matter most are T1/T2 — the known-positive and
# known-negative corpora. An instrument that cannot rediscover a corpus of
# KNOWN defects is not evidence (warden, TD-323 r1), so the seven sites TD-323
# fixed are checked in VERBATIM in both their pre-fix and post-fix form:
#   test/fixtures/skill_required_args/known_positive/  (from BR-080's commit)
#   test/fixtures/skill_required_args/known_negative/  (from TD-323's commit)
# They are checked in rather than derived with `git show` so the armed test
# survives a shallow clone and cannot silently degrade to a skip.
#
# Coverage (every verdict class, L-29 — not just the happy path):
#   real_tree_passes    - the real tree, ledger ON, exits 0 (clean-tree output
#                         must be ZERO; a standing WARN trains --no-verify).
#   T1  known_positive  - all 11 pre-fix flags re-found.
#   T1b known_positive_named_sites - each of the 7 TD-323 sites BY NAME.
#   T2  known_negative  - none of the 7 flagged after TD-323's fix.
#   T3  count_sentinel  - the real map has exactly 75 tools.
#   T4  nested_required - the outer list wins over the edges[] item schema.
#   T5  empty_required  - `required: []` drops the tool from the map.
#   T6  multiline_required - a wrapped array does not parse as empty.
#   T7  block_bounding  - a required list never binds to the PREVIOUS tool.
#   T8  path_false_negative - `{project}` inside a path is NOT a named arg.
#   T8b path_strip_armed - `project=` inside a URL-shaped token is not either;
#                         this, not T8, is what arms the path strip.
#   T9  named_args_pass - the same call with the keys named is clean.
#   T10 arg_prefix_survives_path_strip - `filename=instances/<id>.md` counts.
#   T11 allowed_tools_excluded - 6 tools in frontmatter, 0 in body -> 0 sites.
#                         (the fixture uses a BARE entry alongside the
#                         mcp-prefixed ones, or it would test the tool-mention
#                         lookbehind instead of the exclusion).
#   T12 ledger_subtraction - a classified shape is not reported.
#   T13 ledger_accumulation - the SAME shape twice exceeds its count -> exit 1.
#   T14 setup_error     - an empty scan root exits 2, not 0.

load test_helper

setup() {
  VALIDATOR="$IGRIS_ROOT/scripts/validate_skill_required_args.py"
  [ -f "$VALIDATOR" ] || skip "validator missing at $VALIDATOR"
  FIX="$IGRIS_ROOT/test/fixtures/skill_required_args"
  [ -d "$FIX" ] || skip "fixtures missing at $FIX"
}

@test "real_tree_passes: real tree with the ledger ON exits 0 (clean-tree output is zero)" {
  run python3 "$VALIDATOR"

  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"OK:"* ]] || return 1
  [[ "$output" == *"no unclassified call site"* ]] || return 1
}

@test "T1 known_positive: the pre-fix corpus re-flags all 11 sites" {
  # 11 = archive(1) + hunt:79(1) + reclaim release/claim(2) + Phase7 sync(1)
  #      + Phase8 sync(1) + agent-event items(4) + workflow-template(1).
  # The 12th flag is the agent-event SECTION TOPIC SENTENCE, an un-fixed prose
  # carryover that is ledgered on the real tree. Its presence here is what
  # proves the fixture is a faithful slice and not a scrubbed corpus.
  run env SKILL_ARGS_SCAN_ROOT="$FIX/known_positive" python3 "$VALIDATOR" --no-ledger

  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"Residual sites (12)"* ]] || return 1
}

@test "T1b known_positive_named_sites: each of the 7 TD-323 sites is re-found by tool and residual" {
  run env SKILL_ARGS_SCAN_ROOT="$FIX/known_positive" python3 "$VALIDATOR" --no-ledger

  [ "$status" -eq 1 ] || return 1
  # /archive step 3 — the sharpest: a rejection there half-archives a brief.
  [[ "$output" == *"archive/SKILL.md:4: igris_brief_update -> missing: brief_id, project"* ]] || return 1
  # /hunt Phase 1 step 1 — the false negative an earlier sweep produced.
  [[ "$output" == *"hunt/SKILL.md:3: igris_brief_get -> missing: brief_id, project"* ]] || return 1
  # /hunt 6.5 reclaim branch — two tools, two lines.
  [[ "$output" == *"igris_brief_release -> missing: brief_id, project"* ]] || return 1
  [[ "$output" == *"igris_brief_claim -> missing: brief_id, project"* ]] || return 1
  # /hunt Phase 7 step 5 and Phase 8 step 2 — the upsert pair.
  [[ "$output" == *"igris_brief_sync -> missing: brief_id, project, title"* ]] || return 1
  # /hunt agent-event list items.
  [[ "$output" == *"igris_agent_event -> missing: agent, instance_id"* ]] || return 1
  # hunt/workflow-template.md — the file that stayed invisible while sweeps
  # looked only at SKILL.md.
  [[ "$output" == *"hunt/workflow-template.md:3: igris_brief_get -> missing: brief_id, project"* ]] || return 1
}

@test "T2 known_negative: TD-323's fix clears all 7; only the ledgered prose carryover remains" {
  run env SKILL_ARGS_SCAN_ROOT="$FIX/known_negative" python3 "$VALIDATOR" --no-ledger

  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"Residual sites (1)"* ]] || return 1
  # The single remaining flag is the section topic sentence, NOT a fixed site.
  [[ "$output" == *"igris_agent_event -> missing: agent, event_type, instance_id"* ]] || return 1
  # None of the seven fixed sites may reappear.
  [[ "$output" != *"igris_brief_update"* ]] || return 1
  [[ "$output" != *"igris_brief_get"* ]] || return 1
  [[ "$output" != *"igris_brief_release"* ]] || return 1
  [[ "$output" != *"igris_brief_claim"* ]] || return 1
  [[ "$output" != *"igris_brief_sync"* ]] || return 1
}

@test "T3 count_sentinel: the real components tree yields exactly 75 tools" {
  # 80 `required: [` literals - 4 empty - 1 nested item schema = 75.
  # In-family with gateway-tool-count.test.ts pinning 112 registered tools.
  run python3 "$VALIDATOR" --dump-tool-map

  [ "$status" -eq 0 ] || return 1
  [ "$(printf '%s\n' "$output" | grep -c '^igris_')" -eq 75 ] || return 1
}

@test "T4 nested_required: the edges[] item schema does NOT shadow the real list" {
  run env SKILL_ARGS_COMPONENTS_ROOT="$FIX/components" python3 "$VALIDATOR" --dump-tool-map

  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"igris_memory_store: project,category,title,content"* ]] || return 1
  # The nested list must never become the tool's map entry.
  [[ "$output" != *"igris_memory_store: to_type"* ]] || return 1
}

@test "T5 empty_required: a tool declaring required: [] is dropped from the map" {
  run env SKILL_ARGS_COMPONENTS_ROOT="$FIX/components" python3 "$VALIDATOR" --dump-tool-map

  [ "$status" -eq 0 ] || return 1
  [[ "$output" != *"igris_empty_required"* ]] || return 1
}

@test "T6 multiline_required: a wrapped array parses as its keys, not as empty" {
  run env SKILL_ARGS_COMPONENTS_ROOT="$FIX/components" python3 "$VALIDATOR" --dump-tool-map

  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"igris_multiline_required: first_key,second_key"* ]] || return 1
}

@test "T7 block_bounding: a required list binds to its own tool, never the previous one" {
  run env SKILL_ARGS_COMPONENTS_ROOT="$FIX/components" python3 "$VALIDATOR" --dump-tool-map

  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"igris_after_no_required: beta_key"* ]] || return 1
  # The tool ABOVE it declares no required list and must stay out of the map.
  [[ "$output" != *"igris_no_required:"* ]] || return 1
}

@test "T8 path_false_negative: {project} inside a filesystem path is not a named argument" {
  # The exact shape that hid hunt/SKILL.md:79 through two sweeps.
  run env SKILL_ARGS_SCAN_ROOT="$FIX/window" python3 "$VALIDATOR" --no-ledger

  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"wdemo/SKILL.md:6: igris_brief_get -> missing: brief_id, project"* ]] || return 1
}

@test "T9 named_args_pass: the same call with both keys named is not flagged" {
  run env SKILL_ARGS_SCAN_ROOT="$FIX/window" python3 "$VALIDATOR" --no-ledger

  # The fixture holds exactly two flagged sites (T8's and T8b's). The named
  # form on the following step, and the key=path form, must both be clean.
  [[ "$output" == *"Residual sites (2)"* ]] || return 1
  [[ "$output" != *"wdemo/SKILL.md:12"* ]] || return 1
}

@test "T8b path_strip_armed: project= inside a URL-shaped token is not a named argument" {
  # This is what ARMS the path strip. The bare-word forms in T8 are already
  # refused by the named-argument rule, so removing the strip does not change
  # T8's verdict — only a `key=` living INSIDE a path-shaped token does.
  run env SKILL_ARGS_SCAN_ROOT="$FIX/window" python3 "$VALIDATOR" --no-ledger

  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"igris_memory_recall -> missing: project"* ]] || return 1
}

@test "T10 arg_prefix_survives_path_strip: filename=instances/<id>.md counts as named" {
  # Symmetric to T8: the path strip must not eat a NAMED argument whose VALUE
  # happens to be a path (boot/SKILL.md's session-file update shape).
  run env SKILL_ARGS_SCAN_ROOT="$FIX/window" python3 "$VALIDATOR" --no-ledger

  [[ "$output" != *"igris_session_file_update"* ]] || return 1
}

@test "T11 allowed_tools_excluded: 6 non-empty-required tools in frontmatter score zero" {
  # Warden's specificity control. If allowed-tools lines were counted, this
  # file would score 6 residual sites.
  run env SKILL_ARGS_SCAN_ROOT="$FIX/allowlist" python3 "$VALIDATOR" --no-ledger

  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"OK:"* ]] || return 1
}

@test "T12 ledger_subtraction: a classified shape is not reported" {
  run env SKILL_ARGS_SCAN_ROOT="$FIX/ledger" python3 "$VALIDATOR"

  [ "$status" -eq 0 ] || return 1
  [[ "$output" == *"(1 ledgered)"* ]] || return 1
}

@test "T13 ledger_accumulation: the same shape twice exceeds its count and is reported" {
  # The TD-333 accumulation-observer pattern: keying on shape rather than line
  # number must not let a genuinely NEW site hide behind a classified one.
  run env SKILL_ARGS_SCAN_ROOT="$FIX/ledger_dup" python3 "$VALIDATOR"

  [ "$status" -eq 1 ] || return 1
  [[ "$output" == *"ledger count exceeded (2 > 1)"* ]] || return 1
}

@test "T14 setup_error: a scan root with no markdown exits 2, not 0" {
  mkdir -p "$TEST_TEMP_DIR/empty_skills"

  run env SKILL_ARGS_SCAN_ROOT="$TEST_TEMP_DIR/empty_skills" python3 "$VALIDATOR"

  [ "$status" -eq 2 ] || return 1
  [[ "$output" == *"no skill markdown found"* ]] || return 1
}
