#!/usr/bin/env bats

# context_doc_workflow_prompt.test.bash — FR-213 context-doc workflow guards.
#
# These are prompt/protocol regression checks. The behavior is intentionally
# LLM-driven: `applies_when` is supplied by the deterministic inventory digest,
# while `consult_when` and `maintain_when` route model judgment through the
# catalog.

load test_helper

assert_file_contains_fixed() {
  local file="$1"
  local text="$2"

  assert_file_exists "$file" || return 1
  if ! grep -Fq "$text" "$file"; then
    echo "Expected file '$file' to contain: $text" >&2
    echo "File contents:" >&2
    cat "$file" >&2
    return 1
  fi
}

@test "hunt passes context-doc inventory as applies_when source of truth" {
  local hunt="$IGRIS_ROOT/core/skills/hunt/SKILL.md"

  assert_file_contains_fixed "$hunt" "igris context-docs inventory --project {project} --json"
  assert_file_contains_fixed "$hunt" "Context-doc inventory (applies_when source of truth)"
  assert_file_contains_fixed "$hunt" "recreates the predicate logic."
}

@test "hunt routes consult_when and maintain_when through the catalog" {
  local hunt="$IGRIS_ROOT/core/skills/hunt/SKILL.md"

  assert_file_contains_fixed "$hunt" 'The plan'\''s `Context Docs` section MUST include:'
  assert_file_contains_fixed "$hunt" '`Consult before build`'
  assert_file_contains_fixed "$hunt" '`Potential maintenance after build`'
  assert_file_contains_fixed "$hunt" "maintain_when to decide whether existing docs"
}

@test "warden rejects context-doc violations and ignored maintenance triggers" {
  local hunt="$IGRIS_ROOT/core/skills/hunt/SKILL.md"
  local warden="$IGRIS_ROOT/core/agents/warden.md"

  assert_file_contains_fixed "$hunt" "REJECT if the implementation violates any consulted project context doc."
  assert_file_contains_fixed "$hunt" "REJECT if an obvious maintain_when trigger was ignored"
  assert_file_contains_fixed "$hunt" "Phase 6 context-doc maintenance must"
  assert_file_contains_fixed "$hunt" "DOCUMENTING phase to resolve it."
  assert_file_contains_fixed "$warden" "standards, not advisory prose."
}

@test "core agent template teaches catalog-driven context doc loading" {
  local template="$IGRIS_ROOT/core/templates/agent.md"

  assert_file_contains_fixed "$template" "~/.igris/core/context-doc-types/INDEX.md"
  assert_file_contains_fixed "$template" 'according to the catalog'\''s `consult_when` fields'
}

@test "enforcement registry includes the FR-213 context-doc compliance gate" {
  local definition="$IGRIS_ROOT/core/enforcement/context-doc-compliance.md"
  local index="$IGRIS_ROOT/core/enforcement/INDEX.md"

  assert_file_contains_fixed "$definition" "Relevant context docs must be consulted, obeyed, and maintained when triggered"
  assert_file_contains_fixed "$definition" "mechanism: gate"
  assert_file_contains_fixed "$definition" "FR-213 makes /hunt route consult_when and maintain_when"
  assert_file_contains_fixed "$index" "Relevant context docs must be consulted, obeyed, and maintained when triggered"
  assert_file_contains_fixed "$index" "Warden rejects context-doc violations and ignored maintenance triggers"
}
