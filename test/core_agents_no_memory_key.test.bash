#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# core_agents_no_memory_key.test.bash — TD-496 part 2 (AC4).
#
# No compiled Codex, Gemini or OpenCode target of the nine core agents carries a
# `memory` key. The source edit (no `memory:` line in core/agents/*.md) is what
# clears them: Gemini's translator already drops the key, Codex emits only
# description / developer_instructions / name, and OpenCode copies every source
# key it does not map, so before part 2 the nine OpenCode targets carried
# `memory: project`. The drift gate cannot see this: it compares link paths, not
# file contents, so this suite greps the bytes each target resolves to.
#
# The compile runs on a TEMP COPY of the real harness-manifest.json and
# core/agents, under a fenced HOME and IGRIS_BRAIN_DIR inside this test's
# mktemp root, with `--surface agents` only (no skills, MCP or hook pass). It
# never touches the operator's ~/.gemini, ~/.config/opencode, ~/.igris or this
# checkout's .codex.
#
#   N1  vacuity: the compile projects exactly 27 targets (9 agents x codex,
#       gemini, opencode) and every one resolves to a file in the fenced brain;
#       with FR-277's nine `<name>/model-tier` stamp rows the summary reads 36
#       (the copy is not a git work tree, so the stamp only checks — S7);
#   N2  none of the 27 resolved files has a memory line (TOML `^memory\s*=`,
#       Markdown `^memory\s*:`);
#   N3  negative control: the detector reports a planted key in both formats.

load test_helper

CORE_AGENTS="aegis architect forger mender sage scribe seeker sentinel warden"

setup() {
  COMPILE="$IGRIS_ROOT/core/scripts/cli-adapters/compile_harnesses.sh"
  [ -f "$COMPILE" ] || skip "compile_harnesses.sh missing at $COMPILE"
  require_python3

  FENCE="$TEST_TEMP_DIR/fence"
  export HOME="$FENCE/home"
  export IGRIS_BRAIN_DIR="$FENCE/brain"
  PROJ="$FENCE/proj"
  mkdir -p "$HOME" "$IGRIS_BRAIN_DIR" "$PROJ/core"
  # Belt: both fences sit inside this test's mktemp root.
  case "$HOME" in "$TEST_TEMP_DIR"/*) ;; *) echo "HOME not fenced: $HOME" >&2; return 1 ;; esac
  case "$IGRIS_BRAIN_DIR" in "$TEST_TEMP_DIR"/*) ;; *) echo "brain not fenced" >&2; return 1 ;; esac

  cp "$IGRIS_ROOT/harness-manifest.json" "$PROJ/harness-manifest.json"
  cp -R "$IGRIS_ROOT/core/agents" "$PROJ/core/agents"
}

# Compile the nine agents into the fence. Prints the compile output.
compile_core_agents() {
  bash "$COMPILE" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json" \
                  --surface agents --target all
}

# One line per agent target in the copied manifest: name<TAB>type<TAB>resolved
# file (the path resolved like compile_harnesses.sh does, then realpath'd).
list_targets() {
  python3 - "$PROJ/harness-manifest.json" "$PROJ" "$HOME" <<'PY'
import json, os, sys
manifest, proj, home = sys.argv[1], sys.argv[2], sys.argv[3]
for agent in json.load(open(manifest, encoding="utf-8"))["agents"]:
    for t in agent["targets"]:
        p = t["path"]
        if p.startswith("~/"):
            p = os.path.join(home, p[2:])
        elif not p.startswith("/"):
            p = os.path.join(proj, p)
        print("\t".join([agent["name"], t["type"], os.path.realpath(p)]))
PY
}

# Print every file among the arguments that carries a memory key.
memory_offenders() {
  local f
  for f in "$@"; do
    case "$f" in
      *.toml) grep -qE '^memory[[:space:]]*=' "$f" && echo "$f" ;;
      *)      grep -qE '^memory[[:space:]]*:' "$f" && echo "$f" ;;
    esac
  done
  return 0
}

@test "N1: vacuity — the compile projects 27 targets for the 9 core agents, all resolved into the fence" {
  run compile_core_agents
  echo "$output" >&2
  [ "$status" -eq 0 ]
  [[ "$output" == *"36 targets — 36 ok, 0 failed"* ]] || return 1
  [ "$(printf '%s\n' "$output" | grep -c '/model-tier -> core/agents/')" -eq 9 ] || return 1

  run list_targets
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 27 ]
  local a ty
  for a in $CORE_AGENTS; do
    for ty in codex gemini opencode; do
      printf '%s\n' "${lines[@]}" | grep -qE "^${a}"$'\t'"${ty}"$'\t' \
        || { echo "missing target $a/$ty" >&2; return 1; }
    done
  done
  # Every target exists, is a regular file once resolved, and lives in the fence.
  local name type file
  while IFS=$'\t' read -r name type file; do
    [ -f "$file" ] || { echo "unresolved $name/$type: $file" >&2; return 1; }
    case "$file" in
      "$(cd "$FENCE" && pwd -P)"/*) ;;
      *) echo "outside the fence: $name/$type -> $file" >&2; return 1 ;;
    esac
  done < <(list_targets)
}

@test "N2: no compiled target of the 9 core agents carries a memory key" {
  run compile_core_agents
  [ "$status" -eq 0 ]
  local files=() name type file
  while IFS=$'\t' read -r name type file; do
    files+=("$file")
  done < <(list_targets)
  [ "${#files[@]}" -eq 27 ]
  run memory_offenders "${files[@]}"
  echo "offenders:" >&2
  echo "$output" >&2
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "N3: negative control — the detector reports a planted memory key in TOML and Markdown" {
  local d="$FENCE/planted"
  mkdir -p "$d"
  printf 'description = "x"\nmemory = "project"\nname = "x"\n' > "$d/a.toml"
  printf -- '---\nname: x\nmemory: project\n---\n' > "$d/b.md"
  printf -- '---\nname: x\nmode: subagent\n---\n' > "$d/clean.md"
  printf 'description = "x"\nname = "x"\n' > "$d/clean.toml"
  run memory_offenders "$d/a.toml" "$d/b.md" "$d/clean.md" "$d/clean.toml"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 2 ]
  [[ "$output" == *"a.toml"* ]]
  [[ "$output" == *"b.md"* ]]
}
