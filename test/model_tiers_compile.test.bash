#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# model_tiers_compile.test.bash — FR-277 (AC1-AC4, AC7). The tier map in
# harness-manifest.json compiles to the Claude projection (the canonical
# core/agents/<name>.md frontmatter: `model:` and `effort:`) and to the Codex
# TOML (`model`, `model_reasoning_effort`); Gemini and OpenCode drop both keys.
#
# Every compile runs on a TEMP COPY of the real harness-manifest.json and
# core/agents under a fenced HOME and IGRIS_BRAIN_DIR inside this test's mktemp
# root, `--surface agents` only. The copy is a git work tree (the stamp writes
# canonicals only there, S7) except in MT8.
#
#   MT0  (AC2/AC3) --target all: 36 targets — 36 ok; role keys = agents[].name
#        = core/agents stems; canonical model/effort = the claude column (read
#        by this test's own python); 9 TOMLs carry the codex column; 18
#        Gemini/OpenCode files carry no ^model / ^effort
#   MT0M mutation M3: the resolver ignores the role effort -> MT0 goes red
#   MT1  (AC4, Claude) tiers.fast.claude.model=probe-c moves exactly
#        sentinel.md and warden.md, their model line only
#   MT1M mutation M1: stamping every role with warden's tier -> 9 files move
#   MT2  (AC4, Codex) tiers.fast.codex.model=probe-x moves only those two
#        harness.codex.toml, their `model =` line only; canonicals unchanged
#   MT2M mutation M2: the Codex lookup dropped -> MT2 goes red
#   MT3  control: changing every tiers.deep value moves 0 files (no role
#        defaults to deep; size steps are per-run, never compiled)
#   MT4  a recompile changes nothing: canonical inode + mtime, loadout bytes
#        (GNU `stat -c` first: on Linux `stat -f` is filesystem status, whose
#        free-block counts change between runs — CI 45417354889)
#   MT5  (AC3) check_harness_drift.sh --surface agents: 9 [x/model-tier]
#        MATCH, exit 0; a hand-edited warden model: line is DRIFTED, exit 1
#   MT6  --target codex leaves canonicals alone; --target claude only stamps
#        (the fenced loadout stays absent)
#   MT7  a tier-less inline canonical compiles to fr159-codex-golden.toml
#        (minus the marker line, a pin); adding a role gives
#        fr277-codex-tier-golden.toml (captured from bash)
#   MT8  (S7) PROJECT_ROOT outside a git work tree: a mismatched canonical is
#        a FAIL row and the file's sha is unchanged
#   MT9  a role `ghost`, or a by_size step lighter than the role default,
#        fails validation naming the field; the clean twin passes

load test_helper

ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
FIXTURES="$IGRIS_ROOT/cli/src/__tests__/fixtures"
CORE_AGENTS="aegis architect forger mender sage scribe seeker sentinel warden"

setup() {
  require_python3
  command -v git >/dev/null 2>&1 || skip "git not available"
  unset IGRIS_ADAPTER_COMMON_SOURCED
  FENCE="$TEST_TEMP_DIR/fence"
  export HOME="$FENCE/home"
  export IGRIS_BRAIN_DIR="$FENCE/brain"
  PROJ="$FENCE/proj"
  mkdir -p "$HOME" "$IGRIS_BRAIN_DIR" "$PROJ/core"
  case "$HOME" in "$TEST_TEMP_DIR"/*) ;; *) echo "HOME not fenced: $HOME" >&2; return 1 ;; esac
  case "$IGRIS_BRAIN_DIR" in "$TEST_TEMP_DIR"/*) ;; *) echo "brain not fenced" >&2; return 1 ;; esac
  cp "$IGRIS_ROOT/harness-manifest.json" "$PROJ/harness-manifest.json"
  cp -R "$IGRIS_ROOT/core/agents" "$PROJ/core/agents"
  git -C "${PROJ:?}" init -q
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  GUARD="$ADAPTERS/check_harness_drift.sh"
}

# compile [--target X] — the fenced agents-only compile of $PROJ.
compile() {
  bash "$COMPILE" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json" \
                  --surface agents "$@"
}

# set_map <python-statement over m["model_tiers"] as t> — edit the fenced map.
set_map() {
  python3 - "$PROJ/harness-manifest.json" "$1" <<'PY'
import json, sys
p, stmt = sys.argv[1], sys.argv[2]
m = json.load(open(p, encoding="utf-8"))
t = m["model_tiers"]
exec(stmt)
json.dump(m, open(p, "w", encoding="utf-8"), indent=2)
PY
}

# snapshot <file> — sha256 of every canonical and every loadout harness file.
snapshot() {
  ( cd "$FENCE" && find proj/core/agents brain/loadout -type f 2>/dev/null | LC_ALL=C sort \
      | while IFS= read -r f; do shasum -a 256 "$f"; done ) > "$1"
}

# changed <before> <after> — the paths whose sha differs, one per line.
changed() {
  python3 - "$1" "$2" <<'PY'
import sys
def rd(p):
    d = {}
    for ln in open(p, encoding="utf-8"):
        sha, path = ln.rstrip("\n").split("  ", 1)
        d[path] = sha
    return d
a, b = rd(sys.argv[1]), rd(sys.argv[2])
for k in sorted(set(a) | set(b)):
    if a.get(k) != b.get(k):
        print(k)
PY
}

# mt0_check <adapters-dir> — MT0's assertions against a compile by that dir.
mt0_check() {
  local out
  out="$(bash "$1/compile_harnesses.sh" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json" \
           --surface agents --target all 2>&1)" || { echo "$out"; return 1; }
  [[ "$out" == *"36 targets — 36 ok, 0 failed"* ]] || { echo "$out"; return 1; }
  python3 - "$PROJ" "$IGRIS_BRAIN_DIR" "$HOME" <<'PY'
import json, os, re, sys
proj, brain, home = sys.argv[1:4]
m = json.load(open(os.path.join(proj, "harness-manifest.json"), encoding="utf-8"))
mt = m["model_tiers"]
names = sorted(a["name"] for a in m["agents"])
stems = sorted(f[:-3] for f in os.listdir(os.path.join(proj, "core/agents")) if f.endswith(".md"))
assert sorted(mt["roles"]) == names == stems and len(names) == 9, (sorted(mt["roles"]), names, stems)
def want(name, col):
    role = mt["roles"][name]
    t = mt["tiers"][role["tier"]][col]
    return t["model"], role.get("effort") or t["effort"]
def fm(path):
    lines = open(path, encoding="utf-8").read().split("\n")
    assert lines[0] == "---", path
    end = lines.index("---", 1)
    return lines[1:end]
try:
    import tomllib
except ImportError:
    tomllib = None
bad = []
for name in names:
    model, effort = want(name, "claude")
    f = fm(os.path.join(proj, "core/agents", name + ".md"))
    mi = [i for i, l in enumerate(f) if l.startswith("model:")]
    ei = [i for i, l in enumerate(f) if l.startswith("effort:")]
    if f[mi[0]] != "model: " + model or len(ei) != 1 or f[ei[0]] != "effort: " + effort or ei[0] != mi[0] + 1:
        bad.append("claude %s: %s" % (name, f))
    cmodel, ceffort = want(name, "codex")
    toml_path = os.path.join(brain, "loadout/agents", name, "harness.codex.toml")
    text = open(toml_path, encoding="utf-8").read()
    if tomllib is not None:
        d = tomllib.loads(text)
        got = (d.get("model"), d.get("model_reasoning_effort"))
    else:
        g = lambda k: (re.search(r'^%s = "([^"]*)"$' % k, text, re.M) or [None, None])[1]
        got = (g("model"), g("model_reasoning_effort"))
    if got != (cmodel, ceffort):
        bad.append("codex %s: %s" % (name, got))
    for h, p in (("gemini", "harness.gemini.md"), ("opencode", "harness.opencode.md")):
        t = open(os.path.join(brain, "loadout/agents", name, p), encoding="utf-8").read()
        if re.search(r"^(model|effort)\s*:", t, re.M):
            bad.append("%s %s carries model/effort" % (h, name))
print("\n".join(bad))
sys.exit(1 if bad else 0)
PY
}

@test "MT0 (AC2/AC3): 36 targets — 36 ok; canonical = claude column, TOML = codex column, Gemini/OpenCode drop both" {
  run mt0_check "$ADAPTERS"
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  # The 18 Gemini/OpenCode targets resolve into the fence (count guard).
  local n
  n="$(find "$IGRIS_BRAIN_DIR/loadout/agents" -name 'harness.gemini.md' -o -name 'harness.opencode.md' | grep -c .)"
  [ "$n" -eq 18 ] || { echo "gemini+opencode files: $n"; return 1; }
}

@test "MT0M: mutation M3 — a resolver that ignores the role effort turns MT0 red (architect reads medium)" {
  local root="$TEST_TEMP_DIR/mut"
  mkdir -p "$root/core/scripts"
  cp -R "$ADAPTERS" "$root/core/scripts/cli-adapters"
  cp "$IGRIS_ROOT/harness-manifest.json" "$root/harness-manifest.json"
  local site='    base_tier, base_eff = role["tier"], role.get("effort")'
  [ "$(grep -cF -- "$site" "$root/core/scripts/cli-adapters/_common.sh")" -eq 1 ] || return 1
  sed -i.bak -e 's/    base_tier, base_eff = role\["tier"\], role.get("effort")/    base_tier, base_eff = role["tier"], None/' \
    "$root/core/scripts/cli-adapters/_common.sh"
  [ "$(grep -cF -- "$site" "$root/core/scripts/cli-adapters/_common.sh")" -eq 0 ] || return 1
  run mt0_check "$root/core/scripts/cli-adapters"
  [ "$status" -ne 0 ] || { echo "mutant survived"; return 1; }
  [[ "$output" == *"claude architect"* ]] || { echo "$output"; return 1; }
}

@test "MT1 (AC4, Claude): fast.claude.model moves exactly sentinel.md and warden.md, the model line only" {
  run compile --target all
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  cp "$PROJ/core/agents/warden.md" "$TEST_TEMP_DIR/warden.before"
  snapshot "$TEST_TEMP_DIR/a"
  set_map 't["tiers"]["fast"]["claude"]["model"] = "probe-c"'
  run compile --target all
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  snapshot "$TEST_TEMP_DIR/b"
  run changed "$TEST_TEMP_DIR/a" "$TEST_TEMP_DIR/b"
  [ "$output" = "$(printf 'proj/core/agents/sentinel.md\nproj/core/agents/warden.md')" ] || { echo "$output"; return 1; }
  run diff "$TEST_TEMP_DIR/warden.before" "$PROJ/core/agents/warden.md"
  [ "$(printf '%s\n' "$output" | grep -c '^[<>]')" -eq 2 ] || { echo "$output"; return 1; }
  [[ "$output" == *"> model: probe-c"* ]] || { echo "$output"; return 1; }
}

@test "MT1M: mutation M1 — stamping every role with one role's tier moves all 9 canonicals" {
  local root="$TEST_TEMP_DIR/mut"
  mkdir -p "$root/core/scripts"
  cp -R "$ADAPTERS" "$root/core/scripts/cli-adapters"
  cp "$IGRIS_ROOT/harness-manifest.json" "$root/harness-manifest.json"
  local site='        _, _, cols = resolve(mt, name)  # stamp'
  [ "$(grep -cF -- "$site" "$root/core/scripts/cli-adapters/_common.sh")" -eq 1 ] || return 1
  sed -i.bak -e 's/        _, _, cols = resolve(mt, name)  # stamp/        _, _, cols = resolve(mt, "warden")/' \
    "$root/core/scripts/cli-adapters/_common.sh"
  [ "$(grep -cF -- "$site" "$root/core/scripts/cli-adapters/_common.sh")" -eq 0 ] || return 1
  run compile --target all
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  snapshot "$TEST_TEMP_DIR/a"
  set_map 't["tiers"]["fast"]["claude"]["model"] = "probe-c"'
  run bash "$root/core/scripts/cli-adapters/compile_harnesses.sh" --project-root "$PROJ" \
    --manifest "$PROJ/harness-manifest.json" --surface agents --target all
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  snapshot "$TEST_TEMP_DIR/b"
  run changed "$TEST_TEMP_DIR/a" "$TEST_TEMP_DIR/b"
  [ "$(printf '%s\n' "$output" | grep -c '^proj/core/agents/')" -eq 9 ] || { echo "$output"; return 1; }
}

@test "MT2 (AC4, Codex): fast.codex.model moves only sentinel's and warden's harness.codex.toml, the model line only" {
  run compile --target all
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  cp "$IGRIS_BRAIN_DIR/loadout/agents/warden/harness.codex.toml" "$TEST_TEMP_DIR/w.before"
  snapshot "$TEST_TEMP_DIR/a"
  set_map 't["tiers"]["fast"]["codex"]["model"] = "probe-x"'
  run compile --target all
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  snapshot "$TEST_TEMP_DIR/b"
  run changed "$TEST_TEMP_DIR/a" "$TEST_TEMP_DIR/b"
  [ "$output" = "$(printf 'brain/loadout/agents/sentinel/harness.codex.toml\nbrain/loadout/agents/warden/harness.codex.toml')" ] \
    || { echo "$output"; return 1; }
  run diff "$TEST_TEMP_DIR/w.before" "$IGRIS_BRAIN_DIR/loadout/agents/warden/harness.codex.toml"
  [ "$(printf '%s\n' "$output" | grep -c '^[<>]')" -eq 2 ] || { echo "$output"; return 1; }
  [[ "$output" == *'> model = "probe-x"'* ]] || { echo "$output"; return 1; }
}

@test "MT2M: mutation M2 — dropping the Codex lookup leaves the TOMLs without the model keys" {
  local root="$TEST_TEMP_DIR/mut"
  mkdir -p "$root/core/scripts"
  cp -R "$ADAPTERS" "$root/core/scripts/cli-adapters"
  cp "$IGRIS_ROOT/harness-manifest.json" "$root/harness-manifest.json"
  local site='MODEL_TIER_CODEX_ROWS="$(igris_model_tier rows "$MANIFEST" codex)"'
  [ "$(grep -cF -- "$site" "$root/core/scripts/cli-adapters/compile_harnesses.sh")" -eq 1 ] || return 1
  sed -i.bak -e 's/^\( *\)MODEL_TIER_CODEX_ROWS="\$(igris_model_tier rows "\$MANIFEST" codex)"/\1MODEL_TIER_CODEX_ROWS=""/' \
    "$root/core/scripts/cli-adapters/compile_harnesses.sh"
  [ "$(grep -cF -- "$site" "$root/core/scripts/cli-adapters/compile_harnesses.sh")" -eq 0 ] || return 1
  run bash "$root/core/scripts/cli-adapters/compile_harnesses.sh" --project-root "$PROJ" \
    --manifest "$PROJ/harness-manifest.json" --surface agents --target codex
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  ! grep -q '^model = ' "$IGRIS_BRAIN_DIR/loadout/agents/warden/harness.codex.toml" || return 1
}

@test "MT3 (control): changing every tiers.deep value moves 0 files" {
  run compile --target all
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  snapshot "$TEST_TEMP_DIR/a"
  set_map 'for c in ("claude", "codex"):
    t["tiers"]["deep"][c]["model"] = "probe-deep-" + c
    t["tiers"]["deep"][c]["effort"] = "low" if False else "high"
t["tiers"]["deep"]["claude"]["model"] = "probe-deep"'
  run compile --target all
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  snapshot "$TEST_TEMP_DIR/b"
  run changed "$TEST_TEMP_DIR/a" "$TEST_TEMP_DIR/b"
  [ -z "$output" ] || { echo "moved: $output"; return 1; }
}

@test "MT4: a recompile changes nothing — canonical inode and mtime, loadout bytes" {
  run compile --target all
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  local before after
  before="$(cd "$PROJ/core/agents" && for f in *.md; do stat -c '%n %i %Y' "$f" 2>/dev/null || stat -f '%N %i %m' "$f"; done)"
  snapshot "$TEST_TEMP_DIR/a"
  sleep 1
  run compile --target all
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  after="$(cd "$PROJ/core/agents" && for f in *.md; do stat -c '%n %i %Y' "$f" 2>/dev/null || stat -f '%N %i %m' "$f"; done)"
  [ "$before" = "$after" ] || { echo "before: $before"; echo "after: $after"; return 1; }
  snapshot "$TEST_TEMP_DIR/b"
  cmp "$TEST_TEMP_DIR/a" "$TEST_TEMP_DIR/b" || return 1
}

@test "MT5 (AC3): the drift guard reads 9 [x/model-tier] MATCH; a hand-edited warden model: line is DRIFTED" {
  run compile --target all
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  run bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json" --surface agents
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$(printf '%s\n' "$output" | grep -cE '^  \[[a-z]+/model-tier\] MATCH$')" -eq 9 ] || { echo "$output"; return 1; }
  [[ "$output" == *"36 targets — 36 in sync, 0 drifted/missing"* ]] || { echo "$output"; return 1; }
  # Planted: a hand edit of a stamped line.
  sed -i.bak -e 's/^model: sonnet$/model: opus/' "$PROJ/core/agents/warden.md"
  grep -qx 'model: opus' "$PROJ/core/agents/warden.md" || return 1
  run bash "$GUARD" --project-root "$PROJ" --manifest "$PROJ/harness-manifest.json" --surface agents
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"[warden/model-tier] DRIFTED"* ]] || { echo "$output"; return 1; }
  [[ "$output" == *"igris harness compile --surface agents --target claude"* ]] || { echo "$output"; return 1; }
}

@test "MT6: --target codex leaves canonicals alone; --target claude only stamps and creates no loadout" {
  set_map 't["tiers"]["fast"]["claude"]["model"] = "probe-c"'
  local sum
  sum="$(cat "$PROJ"/core/agents/*.md | shasum -a 256)"
  run compile --target codex
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [ "$sum" = "$(cat "$PROJ"/core/agents/*.md | shasum -a 256)" ] || { echo "codex compile moved a canonical"; return 1; }
  rm -rf "$IGRIS_BRAIN_DIR"; mkdir -p "$IGRIS_BRAIN_DIR"
  run compile --target claude
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  [[ "$output" == *"9 targets — 9 ok, 0 failed"* ]] || { echo "$output"; return 1; }
  grep -qx 'model: probe-c' "$PROJ/core/agents/warden.md" || return 1
  [ ! -e "$IGRIS_BRAIN_DIR/loadout" ] || { ls -R "$IGRIS_BRAIN_DIR"; return 1; }
}

# mt7_project <with-role:0|1> — the fr159 golden inputs laid out as an inline
# canonical, plus (optionally) a tier map that gives fixture-agent a role.
mt7_project() {
  local p="$FENCE/mt7"
  mkdir -p "$p/canon"
  git -C "${p:?}" init -q
  { cat "$FIXTURES/fr159-codex-golden-frontmatter.md"
    awk 'NR==1&&/^---$/{f=1;next} f&&/^---$/{f=0;next} !f' "$FIXTURES/fr159-codex-golden-body.md"
  } > "$p/canon/fixture-agent.md"
  python3 - "$p/harness-manifest.json" "$IGRIS_ROOT/harness-manifest.json" "$1" <<'PY'
import json, sys
out, real, with_role = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
m = {"version": 1, "agents": [{"name": "fixture-agent",
     "canonical": {"dir": "canon", "file": "fixture-agent.md", "versioned": False},
     "targets": [{"type": "codex", "path": ".codex/agents/fixture-agent.toml"}]}]}
if with_role:
    m["model_tiers"] = {"tiers": json.load(open(real, encoding="utf-8"))["model_tiers"]["tiers"],
                        "roles": {"fixture-agent": {"tier": "fast"}}}
json.dump(m, open(out, "w", encoding="utf-8"), indent=2)
PY
  echo "$p"
}

@test "MT7: tier-less inline canonical = fr159 golden (pin); with a role = fr277-codex-tier-golden.toml" {
  local p
  p="$(mt7_project 0)"
  run bash "$COMPILE" --project-root "$p" --surface agents --target codex
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  diff <(tail -n +2 "$IGRIS_BRAIN_DIR/loadout/agents/fixture-agent/harness.codex.toml") \
       <(tail -n +2 "$FIXTURES/fr159-codex-golden.toml") || return 1
  rm -rf "$p"
  p="$(mt7_project 1)"
  run bash "$COMPILE" --project-root "$p" --surface agents --target codex
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
  cmp "$IGRIS_BRAIN_DIR/loadout/agents/fixture-agent/harness.codex.toml" \
      "$FIXTURES/fr277-codex-tier-golden.toml" || return 1
}

@test "MT8 (S7): outside a git work tree a mismatched canonical is a FAIL row and stays byte-identical" {
  local p="$FENCE/nogit"
  mkdir -p "$p/core"
  cp "$IGRIS_ROOT/harness-manifest.json" "$p/harness-manifest.json"
  cp -R "$IGRIS_ROOT/core/agents" "$p/core/agents"
  ! git -C "${p:?}" rev-parse --is-inside-work-tree >/dev/null 2>&1 || skip "TMPDIR is inside a git work tree"
  sed -i.bak -e 's/^model: sonnet$/model: opus/' "$p/core/agents/warden.md"
  rm -f "$p/core/agents/warden.md.bak"
  local sha
  sha="$(shasum -a 256 < "$p/core/agents/warden.md")"
  run bash "$COMPILE" --project-root "$p" --surface agents --target claude
  [ "$status" -eq 1 ] || { echo "$output"; return 1; }
  [[ "$output" == *"FAIL  warden/model-tier — canonical outside a git checkout; edit the map in the source repo and deploy"* ]] \
    || { echo "$output"; return 1; }
  [[ "$output" == *"OK    sentinel/model-tier -> core/agents/sentinel.md"* ]] || { echo "$output"; return 1; }
  [ "$sha" = "$(shasum -a 256 < "$p/core/agents/warden.md")" ] || return 1
}

@test "MT9: a role with no agent, or a size step lighter than its role, fails naming the field; the clean twin passes" {
  run bash -c "source '$ADAPTERS/_common.sh' && validate_manifest '$PROJ/harness-manifest.json' '$ADAPTERS/manifest.schema.json'"
  [ "$status" -eq 0 ] || { echo "clean twin: $output"; return 1; }
  set_map 't["roles"]["ghost"] = {"tier": "fast"}'
  run bash -c "source '$ADAPTERS/_common.sh' && validate_manifest '$PROJ/harness-manifest.json' '$ADAPTERS/manifest.schema.json'"
  [ "$status" -ne 0 ] || { echo "$output"; return 1; }
  [[ "$output" == *"model_tiers/roles/ghost"* ]] || { echo "$output"; return 1; }
  set_map 'del t["roles"]["ghost"]; t["roles"]["forger"]["by_size"]["L"] = {"tier": "fast"}'
  run bash -c "source '$ADAPTERS/_common.sh' && validate_manifest '$PROJ/harness-manifest.json' '$ADAPTERS/manifest.schema.json'"
  [ "$status" -ne 0 ] || { echo "$output"; return 1; }
  [[ "$output" == *"model_tiers/roles/forger/by_size/L"* ]] || { echo "$output"; return 1; }
}
