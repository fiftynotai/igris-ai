#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# agent_memory_export.test.bash — TD-496 Part 1, the agent-memory export script.
#
# core/scripts/agent_memory_export.sh reads agent-memory files, renders each
# lesson verbatim as `igris_memory_store` arguments, applies mechanical
# defaults, and keeps a decision ledger in a run dir. It never writes, moves or
# deletes a source file (AC3): the read-only cases run every action against a
# `chmod -R a-w` corpus and compare a byte+mode+mtime manifest before and after.
#
# FENCES. Every path lives under this test's mktemp -d root (never under
# ~/.igris). HOME and IGRIS_BRAIN_DIR point into it. IGRIS_CLI is a python stub
# that records each call and its --in file, and answers from control.json; the
# live brain is never opened.
#
# The script runs under /bin/bash (3.2 on macOS) in every case, so a green run
# on a developer Mac is also the bash-3.2 portability check.
#
# Secret-shaped fixture strings are built by concatenation so gitleaks never
# sees a literal.

load test_helper

# AMX_SCRIPT_UNDER_TEST points the suite at a mutated copy (mutation checks).
SCRIPT="${AMX_SCRIPT_UNDER_TEST:-$IGRIS_ROOT/core/scripts/agent_memory_export.sh}"
SCHEMA_FILE="$IGRIS_ROOT/brain-mcp-server/src/engine/components/memory/index.ts"
ORIG_HOME="$HOME"

setup() {
  require_python3
  W="$TEST_TEMP_DIR/w"
  mkdir -p "$W"
  case "$W" in
    "$ORIG_HOME"/.igris|"$ORIG_HOME"/.igris/*)
      echo "refusing: fixture root $W is under ~/.igris" >&2
      return 1 ;;
  esac
  export HOME="$W/home"
  export IGRIS_BRAIN_DIR="$W/brain"
  mkdir -p "$HOME" "$IGRIS_BRAIN_DIR"
  P="$W/proj"
  U="$W/userroot"
  R="$W/run"
  export STUB_DIR="$W/stub"
  make_stub
  export IGRIS_CLI="$STUB_DIR/igris"
}

teardown() {
  # The read-only cases chmod the corpus a-w; restore write so the root can go.
  if [ -n "${W:-}" ] && [ -d "$W" ]; then
    chmod -R u+w "$W" 2>/dev/null || true
  fi
  cleanup_test_temp_dir
}

# amx <action> [args] — the script under /bin/bash (3.2 on macOS).
amx() {
  /bin/bash "$SCRIPT" "$@"
}

scan_corpus() {
  amx scan --run-dir "$R" \
    --root "main=$P/.claude/agent-memory:proj" \
    --root "nested:cli=$P/cli/.claude/agent-memory:proj" \
    --root "user=$U:proj" "$@"
}

# cid_of <label> <role/relpath> — the documented derivation, recomputed here.
cid_of() {
  python3 -c 'import hashlib,sys; print(hashlib.sha256((sys.argv[1]+"\0"+sys.argv[2]).encode()).hexdigest()[:12])' "$1" "$2"
}

# control <json> — what the stub answers.
control() {
  printf '%s\n' "$1" > "$STUB_DIR/control.json"
}

# manifest <dir> — every entry's relpath, kind, mode, mtime_ns, size and sha256.
manifest() {
  python3 - "$1" <<'PY'
import hashlib, os, sys
root = sys.argv[1]
for dp, dns, fns in os.walk(root):
    dns.sort()
    for n in sorted(dns + fns):
        p = os.path.join(dp, n)
        st = os.lstat(p)
        kind = 'd' if os.path.isdir(p) else 'f'
        h = ''
        if kind == 'f' and os.access(p, os.R_OK):
            with open(p, 'rb') as f:
                h = hashlib.sha256(f.read()).hexdigest()
        print(os.path.relpath(p, root), kind, oct(st.st_mode), st.st_mtime_ns, st.st_size, h)
PY
}

make_stub() {
  mkdir -p "$STUB_DIR/calls"
  printf '{"vector": true}\n' > "$STUB_DIR/control.json"
  cat > "$STUB_DIR/igris" <<'PY'
#!/usr/bin/env python3
# Stub `igris lessons ingest`. Records argv and a byte copy of --in, then
# answers from control.json: present{title:id}, nearest{title:{...}},
# collide{title:id}, unregistered[project], vector, exit, commit_error{title:msg}.
# Result rows follow cli/src/types.ts IngestResult: `results[]`, `status`
# would-store|stored|tagged|already-present|title-collision|error,
# `collision:{id,key}`, per-row `vector_available`, `nearest.advisory`.
import hashlib, json, os, sys
d = os.environ["STUB_DIR"]
argv = sys.argv[1:]
with open(os.path.join(d, "control.json")) as f:
    ctl = json.load(f)
calls = os.path.join(d, "calls")
n = len([x for x in os.listdir(calls) if x.endswith(".argv.json")]) + 1
with open(os.path.join(calls, "%03d.argv.json" % n), "w") as f:
    json.dump(argv, f)
if argv[:2] != ["lessons", "ingest"]:
    sys.stderr.write("stub: unexpected argv %r\n" % (argv,))
    sys.exit(2)
def opt(name):
    return argv[argv.index(name) + 1] if name in argv else None
with open(opt("--in"), "rb") as f:
    data = f.read()
with open(os.path.join(calls, "%03d.in.jsonl" % n), "wb") as f:
    f.write(data)
if ctl.get("exit") is not None:
    sys.exit(ctl["exit"])
rows = [json.loads(l) for l in data.decode("utf-8").splitlines() if l.strip()]
items = []
vec = bool(ctl.get("vector", True))
if "--dry-run" in argv:
    for i, r in enumerate(rows):
        a = r.get("args") or {}
        t = a.get("title", "")
        it = {"line": i + 1, "key": r["key"], "op": r.get("op"), "status": "would-store",
              "id": None, "error": None, "key_present": False, "collision": None,
              "project_registered": None, "vector_available": vec,
              "vector_reason": None if vec else "stub: vectors off", "nearest": None}
        if t in ctl.get("present", {}):
            it.update(key_present=True, status="already-present", id=ctl["present"][t])
        elif a.get("project") in ctl.get("unregistered", []):
            it.update(project_registered=False, status="error",
                      error="unregistered-project:" + a["project"])
        elif t in ctl.get("collide", {}):
            cid = ctl["collide"][t]
            it.update(project_registered=True, status="title-collision",
                      collision={"id": cid, "key": None}, error="title-collision:%s" % cid)
        else:
            it["project_registered"] = True
            n_ = ctl.get("nearest", {}).get(t)
            if vec and n_ is not None:
                it["nearest"] = dict({"scope": "local", "advisory": False}, **n_)
        items.append(it)
    print(json.dumps({"ok": True, "dry_run": True, "results": items}))
    sys.exit(0)
ledger = opt("--ledger")
have = {}
if ledger and os.path.exists(ledger):
    with open(ledger) as f:
        for l in f:
            if l.strip():
                row = json.loads(l)
                have[(row["key"], row["op"])] = row["id"]
nid = int(ctl.get("next_id", 5000)) + len(have)
errors = 0
out = open(ledger, "a") if ledger else None
for r in rows:
    if r["op"] == "store":
        a = r["args"]
        t = a["title"]
        if t in ctl.get("commit_error", {}):
            items.append({"key": r["key"], "op": "store", "status": "error", "error": ctl["commit_error"][t]})
            errors += 1
            continue
        if (r["key"], "store") in have:
            items.append({"key": r["key"], "op": "store", "status": "already-present", "id": have[(r["key"], "store")]})
            continue
        status, rid = "stored", nid
        if t in ctl.get("present", {}):
            status, rid = "already-present", ctl["present"][t]
        else:
            nid += 1
        out.write(json.dumps({"key": r["key"], "id": rid, "op": "store",
                              "sha256": hashlib.sha256(a["content"].encode()).hexdigest()}) + "\n")
        items.append({"key": r["key"], "op": "store", "status": status, "id": rid})
    elif r["op"] == "add_tags":
        out.write(json.dumps({"key": r["key"], "id": r["id"], "op": "add_tags",
                              "sha256": hashlib.sha256(b"").hexdigest()}) + "\n")
        items.append({"key": r["key"], "op": "add_tags", "status": "tagged", "id": r["id"]})
if out:
    out.close()
print(json.dumps({"ok": True, "dry_run": False, "results": items}))
sys.exit(1 if errors else 0)
PY
  chmod +x "$STUB_DIR/igris"
}

# make_corpus — the main root (warden/sentinel/seeker), one nested root, a user
# root, and three agent-memory dirs the root walk must prune.
make_corpus() {
  local A="$P/.claude/agent-memory"
  mkdir -p "$A/warden" "$A/sentinel" "$A/seeker" \
    "$P/cli/.claude/agent-memory/sentinel" \
    "$P/node_modules/pkg/.claude/agent-memory/forger" \
    "$P/dist/.claude/agent-memory/forger" \
    "$P/.git/x/.claude/agent-memory/forger" \
    "$U/forger"

  cat > "$A/warden/MEMORY.md" <<'EOF'
# Warden Memory

## Lessons
- [A split invalidates attribution](feedback_split.md) — sweep for sentences that attribute the defect
- [Dashboard lives here](reference_dash.md) — where the dashboard code lives
- [Gone lesson](feedback_gone.md) — this file does not exist
Always quote the primitive output verbatim.
EOF
  cat > "$A/warden/feedback_split.md" <<'EOF'
---
name: a-split-invalidates-attribution
description: When a brief is split, sweep attribution sentences
metadata:
  type: feedback
---

When work is re-partitioned between briefs, sweep for sentences that
ATTRIBUTE the defect to the old brief.
EOF
  cat > "$A/warden/reference_dash.md" <<'EOF'
---
name: dashboard-location
description: Where the dashboard lives
type: reference
---
The dashboard source lives under cli/dashboard.
EOF
  cat > "$A/warden/project_snapshot.md" <<'EOF'
---
name: td-445-headroom
description: TD-445 headroom figures
metadata:
  type: project
---
Headroom was 14,973 B on 2026-09-04.
EOF
  cat > "$A/warden/user_profile.md" <<'EOF'
---
name: operator-profile
description: who the operator is
type: user
---
The operator prefers terse reports.
EOF
  printf 'Plain notes without any frontmatter.\n' > "$A/warden/notes.md"
  cat > "$A/warden/feedback_same_a.md" <<'EOF'
---
name: shared-name
description: first body
metadata:
  type: feedback
---
Body A is about quoting.
EOF
  cat > "$A/warden/feedback_same_b.md" <<'EOF'
---
name: shared-name
description: second body
metadata:
  type: feedback
---
Body B is about escaping.
EOF
  cat > "$A/warden/feedback_dup.md" <<'EOF'
---
name: dup-one
description: the warden copy
metadata:
  type: feedback
---
The duplicated   lesson
body text.
EOF
  : > "$A/warden/empty.md"
  printf -- '---\ntype: feedback\n---\nhidden lesson\n' > "$A/warden/.hidden.md"
  printf '\377\376 not utf-8\n' > "$A/warden/binary.md"

  cat > "$A/sentinel/MEMORY.md" <<'EOF'
# Sentinel Memory
- [Dup lesson](feedback_dup.md) — the same lesson
EOF
  cat > "$A/sentinel/feedback_dup.md" <<'EOF'
---
name: dup-two
description: the sentinel copy
metadata:
  type: feedback
---

The duplicated lesson body text.

EOF
  cat > "$A/seeker/reference_tools.md" <<'EOF'
---
name: tool-notes
description: which tool reads what
metadata:
  type: reference
---
The digest reads tags, not recall.
EOF
  cat > "$P/cli/.claude/agent-memory/sentinel/feedback_nested.md" <<'EOF'
---
name: nested-lesson
description: a nested-root lesson
metadata:
  type: feedback
---
Nested roots carry their own lessons.
EOF
  for d in node_modules/pkg dist .git/x; do
    printf -- '---\ntype: feedback\n---\npruned\n' > "$P/$d/.claude/agent-memory/forger/feedback_pruned.md"
  done
  cat > "$U/forger/feedback_user_root.md" <<'EOF'
---
name: user-root-lesson
description: a user-root lesson
metadata:
  type: feedback
---
User-root lessons fall back to the default project.
EOF
}

# --- roots -------------------------------------------------------------------

@test "roots: main and nested roots found, node_modules/.git/dist pruned, user and extra labelled" {
  make_corpus
  local X="$W/extra"
  mkdir -p "$X/.claude/agent-memory/forger"
  printf -- '---\ntype: feedback\n---\nextra\n' > "$X/.claude/agent-memory/forger/feedback_x.md"

  run amx roots --project-root "$P" --user-root "$U" --extra-root "$X" --json
  [ "$status" -eq 0 ]
  printf '%s' "$output" > "$W/roots.json"
  python3 - "$W/roots.json" "$P" "$U" "$X" <<'PY'
import json, os, sys
rows = json.load(open(sys.argv[1]))
P, U, X = (os.path.realpath(a) for a in sys.argv[2:5])
by = {r["label"]: r for r in rows}
assert set(by) == {"main", "nested:cli", "user", "extra:" + X + "/.claude/agent-memory"}, sorted(by)
assert by["main"]["path"] == P + "/.claude/agent-memory", by["main"]
assert by["main"]["set"] == "main" and by["nested:cli"]["set"] == "nested"
assert by["user"]["set"] == "user" and by["user"]["path"] == U
assert by["extra:" + X + "/.claude/agent-memory"]["set"] == "extra"
for r in rows:
    assert "node_modules" not in r["path"] and "/dist/" not in r["path"] and "/.git/" not in r["path"], r
assert by["nested:cli"]["files"] == 1 and by["user"]["files"] == 1
assert by["main"]["roles"] == {"seeker": 1, "sentinel": 2, "warden": 12}, by["main"]["roles"]
# the three sets get a scan spec; an extra root is reported, not processed
assert by["main"]["spec"] == "main=" + P + "/.claude/agent-memory:proj", by["main"]["spec"]
assert by["user"]["spec"] == "user=" + U + ":proj"
assert by["extra:" + X + "/.claude/agent-memory"]["spec"] is None
PY
}

@test "roots: --include-worktrees reports a linked worktree's agent-memory as extra" {
  require_git
  make_corpus
  local WT="$W/wt"
  git -C "${P:?}" init -q
  git -C "${P:?}" -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m init
  git -C "${P:?}" worktree add -q "${WT:?}" -b wt-branch
  mkdir -p "$WT/.claude/agent-memory/forger"
  printf -- '---\ntype: feedback\n---\nworktree lesson\n' > "$WT/.claude/agent-memory/forger/feedback_wt.md"

  run amx roots --project-root "$P" --include-worktrees --json
  [ "$status" -eq 0 ]
  printf '%s' "$output" > "$W/roots.json"
  python3 - "$W/roots.json" "$WT" <<'PY'
import json, os, sys
rows = json.load(open(sys.argv[1]))
wt = os.path.realpath(sys.argv[2]) + "/.claude/agent-memory"
extra = [r for r in rows if r["set"] == "extra"]
assert [r["label"] for r in extra] == ["extra:" + wt], rows
PY

  run amx roots --project-root "$P" --json
  [ "$status" -eq 0 ]
  [[ "$output" != *'"extra'* ]] || { echo "worktree reported without --include-worktrees"; return 1; }
}

# --- read-only (AC3) ----------------------------------------------------------

@test "read-only: every action leaves an a-w corpus byte-, mode- and mtime-identical" {
  make_corpus
  chmod -R a-w "$P" "$U"
  local before
  before="$(manifest "$W/proj"; manifest "$U")"

  run amx roots --project-root "$P" --user-root "$U" --json
  [ "$status" -eq 0 ]
  run scan_corpus --only-role warden
  [ "$status" -eq 0 ]
  run amx next --run-dir "$R" --size 50
  [ "$status" -eq 0 ]
  run amx propose --run-dir "$R" --batch 1 --keep 1 --drop "7:dated headroom snapshot"
  [ "$status" -eq 0 ]
  run amx sheet --run-dir "$R" --batch 1
  [ "$status" -eq 0 ]
  run amx show --run-dir "$R" --batch 1 --row 1
  [ "$status" -eq 0 ]
  run amx decide --run-dir "$R" --batch 1 --accept
  [ "$status" -eq 0 ]
  run amx decide --run-dir "$R" --batch 1 --accept --commit
  [ "$status" -eq 0 ]
  run amx report --run-dir "$R" --md --verify-sources
  [ "$status" -eq 0 ]
  run scan_corpus --rescan
  [ "$status" -eq 0 ]

  local after
  after="$(manifest "$W/proj"; manifest "$U")"
  [ "$before" = "$after" ] || { diff <(printf '%s\n' "$before") <(printf '%s\n' "$after"); return 1; }
}

@test "read-only: static check — no rm, mv, unlink, rename or shutil; one guarded os.replace" {
  [ -f "$SCRIPT" ]
  # No delete or move primitive anywhere in the script, bash or python.
  run grep -nE '(^|[^A-Za-z_])(rm|mv|unlink|rmdir)([[:space:]]|$)|os\.(remove|unlink|rmdir|removedirs|rename|truncate|chmod|utime)\(|\.unlink\(|shutil' "$SCRIPT"
  [ "$status" -eq 1 ] || { echo "forbidden primitive: $output"; return 1; }
  # Exactly one os.replace (the atomic write helper) and exactly two
  # write-mode open() calls (that helper and the append helper).
  [ "$(grep -c 'os\.replace(' "$SCRIPT")" -eq 1 ]
  [ "$(grep -cE "open\([^)]*['\"][wax]b?['\"]" "$SCRIPT")" -eq 2 ]
  # Both helpers route through the run-dir guard and open their file through
  # _open_run_file, which never follows a symlink (O_NOFOLLOW).
  run python3 - "$SCRIPT" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
def body(name):
    m = re.search(r"\ndef %s\(.*?(?=\ndef )" % name, src, re.S)
    assert m, name
    return m.group(0)
for name in ("_write_text", "_append_line"):
    assert "_guard_write(" in body(name), name
    assert "_open_run_file(" in body(name), name
assert "os.O_NOFOLLOW" in body("_open_run_file")
# The one truncate is the atomic helper's own .part fd, after the link check.
assert src.count("os.ftruncate(") == 1 and "os.ftruncate(fd, 0)" in body("_write_text")
PY
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

@test "write: a symlinked or hard-linked .part in the run dir is refused; its target is never written" {
  make_corpus
  mkdir -p "$W/outside"
  printf 'ORIGINAL\n' > "$W/outside/victim"
  local part
  # 1. a symlink to an existing file outside the run dir
  mkdir -p "$R"
  for part in run.json manifest.jsonl candidates.jsonl; do
    ln -s "$W/outside/victim" "$R/$part.part"
  done
  run scan_corpus
  [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
  [[ "$output" == *"symlink"* ]] || { echo "$output"; return 1; }
  [ "$(cat "$W/outside/victim")" = "ORIGINAL" ]
  # 2. a dangling symlink: its target is never created
  local R2="$W/run2"
  mkdir -p "$R2"
  for part in run.json manifest.jsonl candidates.jsonl; do
    ln -s "$W/outside/created-$part" "$R2/$part.part"
  done
  run amx scan --run-dir "$R2" --root "main=$P/.claude/agent-memory:proj"
  [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
  run ls "$W/outside"
  [ "$output" = "victim" ] || { echo "outside dir now holds: $output"; return 1; }
  # 3. a hard link to a file outside the run dir is not truncated or written
  local R3="$W/run3"
  mkdir -p "$R3"
  for part in run.json manifest.jsonl candidates.jsonl; do
    ln "$W/outside/victim" "$R3/$part.part"
  done
  run amx scan --run-dir "$R3" --root "main=$P/.claude/agent-memory:proj"
  [ "$status" -eq 1 ] || { echo "status $status: $output"; return 1; }
  [[ "$output" == *"hard-linked"* ]] || { echo "$output"; return 1; }
  [ "$(cat "$W/outside/victim")" = "ORIGINAL" ]
}

@test "read-only: a run dir inside a source root is refused before anything is written" {
  make_corpus
  run amx scan --run-dir "$P/.claude/agent-memory/run" --root "main=$P/.claude/agent-memory:proj"
  [ "$status" -eq 2 ]
  [[ "$output" == *"inside a source root"* ]] || { echo "$output"; return 1; }
  [ ! -e "$P/.claude/agent-memory/run" ]
}

# --- parsing -------------------------------------------------------------------

@test "parse: nested metadata.type, top-level type and no frontmatter classify" {
  make_corpus
  run scan_corpus
  [ "$status" -eq 0 ]
  python3 - "$R" <<'PY'
import json, sys
C = [json.loads(l) for l in open(sys.argv[1] + "/candidates.jsonl")]
def one(rel):
    hit = [c for c in C if any(m["relpath"] == rel for m in c["members"])]
    assert len(hit) == 1, (rel, hit)
    return hit[0]
assert one("feedback_split.md")["class"] == "feedback"
assert one("reference_dash.md")["class"] == "reference"
assert one("project_snapshot.md")["class"] == "project"
assert one("user_profile.md")["class"] == "user"
assert one("notes.md")["class"] == "none"
PY
}

@test "parse: MEMORY.md link text becomes the title, the dash text the hook" {
  make_corpus
  run scan_corpus
  [ "$status" -eq 0 ]
  python3 - "$R" <<'PY'
import json, sys
C = [json.loads(l) for l in open(sys.argv[1] + "/candidates.jsonl")]
c = [c for c in C if c["members"][0]["relpath"] == "feedback_split.md"][0]
assert c["title"] == "A split invalidates attribution", c["title"]
assert c["hook"] == "sweep for sentences that attribute the defect", c["hook"]
r = [c for c in C if c["members"][0]["relpath"] == "reference_dash.md"][0]
assert r["title"] == "Dashboard lives here" and r["hook"] == "where the dashboard code lives", r
PY
}

@test "parse: index non-link lines become one index-inline candidate; a dangling link is flagged" {
  make_corpus
  run scan_corpus
  [ "$status" -eq 0 ]
  [[ "$output" == *"dangling"*"feedback_gone.md"* ]] || { echo "$output"; return 1; }
  python3 - "$R" <<'PY'
import json, sys
R = sys.argv[1]
C = [json.loads(l) for l in open(R + "/candidates.jsonl")]
inl = [c for c in C if c["class"] == "index-inline"]
# warden's index has an inline line; sentinel's is links only.
assert len(inl) == 1, inl
assert inl[0]["role"] == "warden" and inl[0]["label"] == "main"
assert "Always quote the primitive output verbatim." in inl[0]["args"]["content"]
assert "[A split" not in inl[0]["args"]["content"]
run = json.load(open(R + "/run.json"))
d = run["dangling"]
assert [(x["label"], x["role"], x["target"]) for x in d] == [("main", "warden", "feedback_gone.md")], d
PY
}

@test "parse: empty, hidden and non-UTF-8 files are excluded with a reason" {
  make_corpus
  # A valid UTF-8 lesson carrying one literal NUL (a typo for an escape) is
  # content, not excluded: the NUL renders as the visible escape \0.
  printf -- '---\nname: nul-lesson\nmetadata:\n  type: feedback\n---\nthe separator is (\000) here\n' \
    > "$P/.claude/agent-memory/warden/feedback_nul.md"
  run scan_corpus
  [ "$status" -eq 0 ]
  python3 - "$R" <<'PY'
import json, sys
M = [json.loads(l) for l in open(sys.argv[1] + "/manifest.jsonl")]
ex = {m["relpath"]: m["reason"] for m in M if m["status"] == "excluded"}
assert ex == {"empty.md": "empty", ".hidden.md": "hidden", "binary.md": "non-utf8"}, ex
idx = sorted((m["role"], m["relpath"]) for m in M if m["status"] == "index")
assert idx == [("sentinel", "MEMORY.md"), ("warden", "MEMORY.md")], idx
C = [json.loads(l) for l in open(sys.argv[1] + "/candidates.jsonl")]
members = {m["relpath"] for c in C for m in c["members"]}
assert not members & set(ex), members
nul = [c for c in C if c["members"][0]["relpath"] == "feedback_nul.md"]
assert len(nul) == 1 and "nul-escaped" in nul[0]["flags"], nul
assert "\x00" not in nul[0]["args"]["content"]
assert "the separator is (\\0) here" in nul[0]["args"]["content"], nul[0]["args"]["content"]
PY
}

@test "parse: a file symlink is excluded as symlink and never read; a directory symlink is not followed" {
  make_corpus
  mkdir -p "$W/outside"
  printf -- '---\nname: outside\nmetadata:\n  type: feedback\n---\nOUTSIDE-TARGET-BODY\n' > "$W/outside/feedback_out.md"
  ln -s "$W/outside/feedback_out.md" "$P/.claude/agent-memory/warden/feedback_link.md"
  ln -s "$W/outside/feedback_gone.md" "$P/.claude/agent-memory/warden/feedback_dangling.md"
  ln -s "$W/outside" "$P/.claude/agent-memory/warden/linkdir"
  run scan_corpus
  [ "$status" -eq 0 ]
  python3 - "$R" <<'PY'
import json, sys
M = [json.loads(l) for l in open(sys.argv[1] + "/manifest.jsonl")]
link = {m["relpath"]: m for m in M if m["role"] == "warden" and m["relpath"].startswith(("feedback_link", "feedback_dangling", "linkdir"))}
assert sorted(link) == ["feedback_dangling.md", "feedback_link.md"], sorted(link)
for m in link.values():
    assert (m["status"], m["reason"], m["size"], m["sha256"]) == ("excluded", "symlink", 0, ""), m
C = open(sys.argv[1] + "/candidates.jsonl").read()
assert "OUTSIDE-TARGET-BODY" not in C
PY
  run amx report --run-dir "$R" --json
  printf '%s' "$output" > "$W/report.json"
  python3 - "$W/report.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
assert not [f for f in r["failures"] if "files found" in f], r["failures"]
PY
}

# --- duplicates ----------------------------------------------------------------

@test "dups: the same normalised body merges into one candidate with the union of roles" {
  make_corpus
  run scan_corpus
  [ "$status" -eq 0 ]
  python3 - "$R" <<'PY'
import json, sys
C = [json.loads(l) for l in open(sys.argv[1] + "/candidates.jsonl")]
d = [c for c in C if any(m["relpath"] == "feedback_dup.md" for m in c["members"])]
assert len(d) == 1, d
d = d[0]
assert d["roles"] == ["sentinel", "warden"], d["roles"]
assert sorted(m["role"] for m in d["members"]) == ["sentinel", "warden"]
assert "role:sentinel" in d["args"]["tags"].split(",") and "role:warden" in d["args"]["tags"].split(",")
assert d["args"]["content"].count("Source: agent-memory ") == 2, d["args"]["content"]
PY
}

@test "dups: a shared frontmatter name with different bodies is flagged same-name #k, not merged" {
  make_corpus
  run scan_corpus
  [ "$status" -eq 0 ]
  python3 - "$R" <<'PY'
import json, sys
C = [json.loads(l) for l in open(sys.argv[1] + "/candidates.jsonl")]
s = [c for c in C if c["members"][0]["relpath"] in ("feedback_same_a.md", "feedback_same_b.md")]
assert len(s) == 2, s
flags = sorted(f for c in s for f in c["flags"] if f.startswith("same-name"))
assert flags == ["same-name #1", "same-name #2"], flags
PY
}

# --- secrets -------------------------------------------------------------------

make_secret_corpus() {
  local A="$P/.claude/agent-memory/warden"
  mkdir -p "$A"
  local gh="gh"; gh="${gh}p_""abcdefghijklmnopqrstuvwxyz0123456789"
  local pem="-----BEGIN "; pem="${pem}RSA PRIV""ATE KEY-----"
  local asg="api_tok"; asg="${asg}en=Zq8""Xw2Lm9Pa4Rt7Ys1Vb"
  local brr="Bea"; brr="${brr}rer ""abcdefghijklmnopqrstuvwxyz012345"
  local i=0 s
  for s in "$gh" "$pem" "$asg" "$brr"; do
    i=$((i + 1))
    printf -- '---\nname: s%s\nmetadata:\n  type: feedback\n---\nconfig is %s here\n' "$i" "$s" > "$A/feedback_s$i.md"
  done
  printf -- '---\nname: clean\nmetadata:\n  type: feedback\n---\nnothing secret here\n' > "$A/feedback_clean.md"
}

@test "secret: key prefix, PEM header, token= and Bearer default to DROP secret?" {
  make_secret_corpus
  run amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj"
  [ "$status" -eq 0 ]
  run amx next --run-dir "$R" --size 50
  [ "$status" -eq 0 ]
  run amx sheet --run-dir "$R" --batch 1 --json
  [ "$status" -eq 0 ]
  printf '%s' "$output" > "$W/sheet.json"
  python3 - "$W/sheet.json" <<'PY'
import json, sys
S = json.load(open(sys.argv[1]))
got = {r["title"]: (r["disp"], r["reason"]) for r in S["rows"]}
for t in ("S1", "S2", "S3", "S4"):
    assert got[t] == ("DROP", "secret?"), (t, got[t])
assert got["Clean"] == ("KEEP", ""), got["Clean"]
PY
}

@test "secret: keeping a flagged row needs --secret-override K:<reason>" {
  make_secret_corpus
  amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" >/dev/null
  amx next --run-dir "$R" --size 50 >/dev/null
  amx sheet --run-dir "$R" --batch 1 >/dev/null
  local row
  row="$(amx sheet --run-dir "$R" --batch 1 --json | python3 -c 'import json,sys; print([r["row"] for r in json.load(sys.stdin)["rows"] if r["title"]=="S1"][0])')"
  run amx decide --run-dir "$R" --batch 1 --keep "$row"
  [ "$status" -eq 2 ]
  [[ "$output" == *"--secret-override"* ]] || { echo "$output"; return 1; }
  run amx decide --run-dir "$R" --batch 1 --secret-override "$row:fixture value not a credential" --json
  [ "$status" -eq 0 ]
  printf '%s' "$output" > "$W/d.json"
  python3 - "$W/d.json" "$row" <<'PY'
import json, sys
D = json.load(open(sys.argv[1]))
r = [x for x in D["rows"] if x["row"] == int(sys.argv[2])][0]
assert r["disp"] == "KEEP", r
assert D["commit"] is False
PY
}

@test "secret: key: value, a quoted key field, URL credentials and a JWT default to DROP secret?; prose and plain URLs do not" {
  local A="$P/.claude/agent-memory/warden"
  mkdir -p "$A"
  local v="Zq8""Xw2Lm9Pa4Rt7Ys1Vb"
  local col="api_ke"; col="${col}y: $v"
  local qf='{"tok'; qf="${qf}en\": \"$v\"}"
  local url="postgres://adm"; url="${url}in:hunter2""pass@db.internal:5432/app"
  local jwt="ey""J"; jwt="${jwt}hbGciOiJIUzI1NiJ9.ey""JzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXBhcnQ"
  local short='{"tok'; short="${short}en\": \"short\"}"
  local i=0 s
  for s in "$col" "$qf" "$url" "$jwt"; do
    i=$((i + 1))
    printf -- '---\nname: p%s\nmetadata:\n  type: feedback\n---\nconfig is %s here\n' "$i" "$s" > "$A/feedback_p$i.md"
  done
  i=0
  for s in "the token: field is optional" "see https://brain.example.dev:443/api/v1@v2 for it" \
           "clone git@github.com:org/repo.git first" "$short" "the cache key: amx:abc"; do
    i=$((i + 1))
    printf -- '---\nname: n%s\nmetadata:\n  type: feedback\n---\nnote: %s\n' "$i" "$s" > "$A/feedback_n$i.md"
  done
  run amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj"
  [ "$status" -eq 0 ]
  run amx next --run-dir "$R" --size 50
  [ "$status" -eq 0 ]
  run amx sheet --run-dir "$R" --batch 1 --json
  [ "$status" -eq 0 ]
  printf '%s' "$output" > "$W/sheet.json"
  python3 - "$W/sheet.json" "$R" <<'PY'
import json, sys
S = json.load(open(sys.argv[1]))
got = {r["title"]: (r["disp"], r["reason"]) for r in S["rows"]}
C = {c["title"]: c["secret"] for c in map(json.loads, open(sys.argv[2] + "/candidates.jsonl"))}
want = {"P1": ["colon-assignment"], "P2": ["quoted-field"], "P3": ["url-credentials"], "P4": ["jwt"]}
for t, names in want.items():
    assert got[t] == ("DROP", "secret?"), (t, got[t])
    assert C[t] == names, (t, C[t])
for t in ("N1", "N2", "N3", "N4", "N5"):
    assert got[t] == ("KEEP", ""), (t, got[t])
    assert C[t] == [], (t, C[t])
PY
}

# --- rendered store args ---------------------------------------------------------

@test "render: store-arg keys are a subset of the igris_memory_store allowlist (pinned to the schema)" {
  make_corpus
  run scan_corpus
  [ "$status" -eq 0 ]
  # The allowlist, pinned to brain-mcp-server/src/engine/components/memory/index.ts:75-157
  # (the igris_memory_store inputSchema) minus review_status and edges.
  python3 - "$R" "$SCHEMA_FILE" <<'PY'
import json, re, sys
ALLOW = {"project", "category", "title", "content", "tags", "tech_stack",
         "source_brief", "scope", "provenance", "source_extractor"}
src = open(sys.argv[2]).read()
blk = src[src.index("name: 'igris_memory_store'"):]
blk = blk[:blk.index("required: ['project', 'category', 'title', 'content']")]
props = set(re.findall(r"^ {14}([a-z_]+): \{", blk, re.M))
assert len(props) >= 10, props          # vacuity guard on the extraction
assert ALLOW <= props, ALLOW - props     # every allowed key is a real property
assert "confidence" not in props
C = [json.loads(l) for l in open(sys.argv[1] + "/candidates.jsonl")]
assert C
for c in C:
    keys = set(c["args"])
    assert keys <= ALLOW, keys - ALLOW
    assert "confidence" not in keys
    assert {"project", "category", "title", "content"} <= keys
PY
}

@test "render: distill/observed/local defaults and amx, agent-memory and role tags" {
  make_corpus
  run scan_corpus
  [ "$status" -eq 0 ]
  python3 - "$R" <<'PY'
import json, sys
C = [json.loads(l) for l in open(sys.argv[1] + "/candidates.jsonl")]
for c in C:
    a = c["args"]
    assert a["source_extractor"] == "distill" and a["provenance"] == "observed" and a["scope"] == "local", a
    assert a["project"] == "proj", a["project"]
    tags = a["tags"].split(",")
    assert tags[0] == "amx:" + c["cid"] and tags[1] == "agent-memory", tags
    assert tags[2:] == ["role:" + r for r in sorted(c["roles"])], tags
    assert c["key"] == "amx:" + c["cid"]
PY
}

@test "render: title from link text, else humanised name, else file name; <=200 chars; unique by (role)" {
  make_corpus
  local A="$P/.claude/agent-memory"
  # Same frontmatter name in two roles with different bodies -> titles collide.
  printf -- '---\nname: quote-the-output\nmetadata:\n  type: feedback\n---\nwarden body\n' > "$A/warden/feedback_q.md"
  printf -- '---\nname: quote-the-output\nmetadata:\n  type: feedback\n---\nseeker body\n' > "$A/seeker/feedback_q.md"
  local long
  long="$(python3 -c 'print("x" * 300)')"
  printf -- '---\nname: %s\nmetadata:\n  type: feedback\n---\nlong body\n' "$long" > "$A/seeker/feedback_long.md"
  run scan_corpus
  [ "$status" -eq 0 ]
  python3 - "$R" <<'PY'
import json, sys
C = [json.loads(l) for l in open(sys.argv[1] + "/candidates.jsonl")]
def t(role, rel):
    return [c for c in C if c["role"] == role and c["members"][0]["relpath"] == rel][0]["title"]
assert t("warden", "reference_dash.md") == "Dashboard lives here"           # link text
assert t("warden", "project_snapshot.md") == "Td 445 headroom"              # name humanised
assert t("warden", "notes.md") == "Notes"                                   # file name
q = sorted([t("warden", "feedback_q.md"), t("seeker", "feedback_q.md")])
assert q == ["Quote the output", "Quote the output (warden)"] or q == ["Quote the output", "Quote the output (seeker)"], q
assert len(t("seeker", "feedback_long.md")) <= 200
titles = [c["title"] for c in C]
assert len(titles) == len(set(titles)), titles
PY
}

@test "render: content is hook, blank line, body, then the Source line, with no absolute path" {
  make_corpus
  run scan_corpus
  [ "$status" -eq 0 ]
  python3 - "$R" "$W" <<'PY'
import json, sys
R, W = sys.argv[1], sys.argv[2]
C = [json.loads(l) for l in open(R + "/candidates.jsonl")]
c = [c for c in C if c["members"][0]["relpath"] == "feedback_split.md"][0]
body = ("When work is re-partitioned between briefs, sweep for sentences that\n"
        "ATTRIBUTE the defect to the old brief.")
sha = c["members"][0]["sha256"][:12]
want = ("sweep for sentences that attribute the defect\n\n" + body + "\n\n"
        "Source: agent-memory main/warden/feedback_split.md (sha256 " + sha + ")")
assert c["args"]["content"] == want, repr(c["args"]["content"])
for c in C:
    assert W not in c["args"]["content"], c["cid"]
    assert "/Users/" not in c["args"]["content"] and "/tmp/" not in c["args"]["content"]
PY
}

# --- candidate id and rescan -----------------------------------------------------

@test "cid: the first 12 hex of sha256(label NUL role/relpath), stable across a rescan" {
  make_corpus
  run scan_corpus
  [ "$status" -eq 0 ]
  local want
  want="$(cid_of main warden/feedback_split.md)"
  run python3 -c 'import json,sys; print([c["cid"] for c in map(json.loads, open(sys.argv[1])) if c["members"][0]["relpath"]=="feedback_split.md"][0])' "$R/candidates.jsonl"
  [ "$output" = "$want" ]
  local before
  before="$(python3 -c 'import json,sys; print(sorted(c["cid"] for c in map(json.loads, open(sys.argv[1]))))' "$R/candidates.jsonl")"
  run scan_corpus --rescan
  [ "$status" -eq 0 ]
  local after
  after="$(python3 -c 'import json,sys; print(sorted(c["cid"] for c in map(json.loads, open(sys.argv[1]))))' "$R/candidates.jsonl")"
  [ "$before" = "$after" ]
}

@test "rescan: decisions are kept, a new file is added, a changed body is flagged source-changed" {
  make_corpus
  amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --only-role warden >/dev/null
  amx next --run-dir "$R" --size 50 >/dev/null
  amx propose --run-dir "$R" --batch 1 --keep 1 --drop "7:dated headroom snapshot" >/dev/null
  amx sheet --run-dir "$R" --batch 1 >/dev/null
  run amx decide --run-dir "$R" --batch 1 --accept --commit
  [ "$status" -eq 0 ]
  local ndec
  ndec="$(grep -c '"kind":"decision"' "$R/decisions.jsonl")"
  [ "$ndec" -gt 0 ]

  local A="$P/.claude/agent-memory/warden"
  printf -- '---\nname: brand-new\nmetadata:\n  type: feedback\n---\na new lesson\n' > "$A/feedback_new.md"
  printf '\nAn appended paragraph.\n' >> "$A/reference_dash.md"
  run amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --rescan
  [ "$status" -eq 0 ]

  [ "$(grep -c '"kind":"decision"' "$R/decisions.jsonl")" -ge "$ndec" ]
  python3 - "$R" "$(cid_of main warden/reference_dash.md)" <<'PY'
import json, sys
R, old = sys.argv[1], sys.argv[2]
C = [json.loads(l) for l in open(R + "/candidates.jsonl")]
new = [c for c in C if c["members"][0]["relpath"] == "feedback_new.md"]
assert len(new) == 1, new
# the committed candidate keeps its id and decision; the changed body is a new,
# flagged candidate that revises it
assert any(c["cid"] == old for c in C)
rev = [c for c in C if "source-changed" in c["flags"]]
assert len(rev) == 1 and rev[0]["members"][0]["relpath"] == "reference_dash.md", rev
assert rev[0]["cid"] != old
assert "An appended paragraph." in rev[0]["args"]["content"]
PY
}

# --- dry-run defaults -------------------------------------------------------------

@test "defaults: feedback KEEP pattern, reference KEEP discovery, project/index-inline judge, user and no-frontmatter DROP" {
  make_corpus
  amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --only-role warden >/dev/null
  run amx next --run-dir "$R" --size 50
  [ "$status" -eq 0 ]
  run amx sheet --run-dir "$R" --batch 1 --json
  [ "$status" -eq 0 ]
  printf '%s' "$output" > "$W/sheet.json"
  python3 - "$W/sheet.json" <<'PY'
import json, sys
S = json.load(open(sys.argv[1]))
got = {r["title"]: (r["disp"], r["category"], r["reason"]) for r in S["rows"]}
assert got["A split invalidates attribution"] == ("KEEP", "pattern", ""), got
assert got["Dashboard lives here"] == ("KEEP", "discovery", ""), got
assert got["Td 445 headroom"][:2] == ("JUDGE", "discovery"), got
assert got["Operator profile"][0::2] == ("DROP", "user-profile"), got
assert got["Notes"][0::2] == ("DROP", "no-frontmatter"), got
inl = [r for r in S["rows"] if r["class"] == "index-inline"]
assert len(inl) == 1 and inl[0]["disp"] == "JUDGE", inl
assert S["group"] == "warden" and S["dedup"] == "vector", S
PY
}

@test "defaults: dup with role DROP, without role TAG, key_present ALREADY, collision RETITLE, unregistered BLOCK" {
  make_corpus
  control '{"vector": true,
    "nearest": {"A split invalidates attribution": {"id": 1531, "project": "proj", "title": "x", "tags": "agent-memory,role:warden", "similarity": 0.91},
                "Dashboard lives here": {"id": 1532, "project": "proj", "title": "y", "tags": "ops", "similarity": 0.86}},
    "present": {"Shared name": 900},
    "collide": {"Shared name (warden)": 77}}'
  amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --only-role warden >/dev/null
  run amx next --run-dir "$R" --size 50
  [ "$status" -eq 0 ]
  run amx sheet --run-dir "$R" --batch 1 --json
  printf '%s' "$output" > "$W/sheet.json"
  python3 - "$W/sheet.json" <<'PY'
import json, sys
S = json.load(open(sys.argv[1]))
got = {r["title"]: r for r in S["rows"]}
a = got["A split invalidates attribution"]
assert (a["disp"], a["id"]) == ("DROP", 1531) and a["reason"].startswith("dup-in-brain"), a
d = got["Dashboard lives here"]
assert (d["disp"], d["id"]) == ("TAG", 1532), d
s = got["Shared name"]
assert (s["disp"], s["id"]) == ("ALREADY", 900), s
rt = [r for r in S["rows"] if r["disp"] == "RETITLE"]
assert len(rt) == 1 and rt[0]["title"] != "Shared name (warden)" and rt[0]["title"].startswith("Shared name (warden)"), rt
PY

  # an unregistered project blocks every row it owns
  control '{"vector": true, "unregistered": ["ghost"]}'
  local R2="$W/run2"
  amx scan --run-dir "$R2" --root "main=$P/.claude/agent-memory:ghost" --only-role warden >/dev/null
  run amx next --run-dir "$R2" --size 50
  [ "$status" -eq 0 ]
  run amx sheet --run-dir "$R2" --batch 1 --json
  printf '%s' "$output" > "$W/sheet2.json"
  python3 - "$W/sheet2.json" <<'PY'
import json, sys
S = json.load(open(sys.argv[1]))
assert S["rows"] and all(r["disp"] == "BLOCK" for r in S["rows"]), [r["disp"] for r in S["rows"]]
assert all("unregistered" in r["reason"] for r in S["rows"])
PY
}

# --- next -----------------------------------------------------------------------

@test "next: runs IGRIS_CLI lessons ingest --in <batch> --dry-run --json on a one-group batch" {
  make_corpus
  run scan_corpus
  [ "$status" -eq 0 ]
  run amx next --run-dir "$R" --size 25
  [ "$status" -eq 0 ]
  python3 - "$STUB_DIR" "$R" <<'PY'
import json, os, sys
d, R = sys.argv[1], sys.argv[2]
argv = json.load(open(d + "/calls/001.argv.json"))
assert argv == ["lessons", "ingest", "--in", os.path.realpath(R) + "/batches/0001.candidates.jsonl", "--dry-run", "--json"], argv
rows = [json.loads(l) for l in open(d + "/calls/001.in.jsonl")]
assert rows and all(r["op"] == "store" and r["key"].startswith("amx:") for r in rows)
assert all(r["key"] in r["args"]["tags"].split(",") for r in rows)
run = json.load(open(R + "/run.json"))
b = run["batches"]["0001"]
# small roles first: seeker is the first group present in the corpus
assert b["group"] == "seeker", b
C = {c["key"]: c for c in map(json.loads, open(R + "/candidates.jsonl"))}
assert {C[r["key"]]["group"] for r in rows} == {"seeker"}
PY
}

@test "next: vector_available false refuses unless --allow-no-dedup, which run.json records" {
  make_corpus
  control '{"vector": false}'
  amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --only-role warden >/dev/null
  run amx next --run-dir "$R" --size 50
  [ "$status" -eq 1 ]
  [[ "$output" == *"--allow-no-dedup"* ]] || { echo "$output"; return 1; }
  run python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(r.get("allow_no_dedup"))' "$R/run.json"
  [ "$output" = "[]" ] || [ "$output" = "None" ]

  run amx next --run-dir "$R" --size 50 --allow-no-dedup
  [ "$status" -eq 0 ]
  python3 - "$R" <<'PY'
import json, sys
r = json.load(open(sys.argv[1] + "/run.json"))
a = r["allow_no_dedup"]
assert len(a) == 1 and a[0]["batch"] == "0001", a
PY
  run amx sheet --run-dir "$R" --batch 1
  [[ "$output" == *"dedup: none"* ]] || { echo "$output"; return 1; }
}

# --- propose / decide -------------------------------------------------------------

@test "propose: a drop reason longer than six words is refused; decide --accept needs every judge row proposed" {
  make_corpus
  amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --only-role warden >/dev/null
  amx next --run-dir "$R" --size 50 >/dev/null
  amx sheet --run-dir "$R" --batch 1 >/dev/null
  run amx propose --run-dir "$R" --batch 1 --drop "7:this reason is far too long to accept"
  [ "$status" -eq 2 ]
  [[ "$output" == *"six words"* ]] || { echo "$output"; return 1; }
  run amx decide --run-dir "$R" --batch 1 --accept
  [ "$status" -eq 1 ]
  [[ "$output" == *"no proposal"* ]] || { echo "$output"; return 1; }
}

@test "decide: without --commit it writes nothing and prints the resolved dispositions" {
  make_corpus
  amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --only-role warden >/dev/null
  amx next --run-dir "$R" --size 50 >/dev/null
  amx propose --run-dir "$R" --batch 1 --keep 1 --drop "7:dated headroom snapshot" >/dev/null
  amx sheet --run-dir "$R" --batch 1 >/dev/null
  local before
  before="$(manifest "$R")"
  run amx decide --run-dir "$R" --batch 1 --accept
  [ "$status" -eq 0 ]
  [[ "$output" == *"KEEP"* && "$output" == *"DROP"* ]] || { echo "$output"; return 1; }
  [ "$before" = "$(manifest "$R")" ]
  [ ! -e "$R/batches/0001.approved.jsonl" ]
  [ -e "$STUB_DIR/calls/001.argv.json" ] && [ ! -e "$STUB_DIR/calls/002.argv.json" ]
}

@test "decide --commit sends exactly NNNN.approved.jsonl with --ledger <run>/stored.jsonl and records results" {
  make_corpus
  control '{"vector": true, "nearest": {"Dashboard lives here": {"id": 1532, "project": "proj", "title": "y", "tags": "ops", "similarity": 0.86}}}'
  amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --only-role warden >/dev/null
  amx next --run-dir "$R" --size 50 >/dev/null
  amx propose --run-dir "$R" --batch 1 --keep 1 --drop "7:dated headroom snapshot" >/dev/null
  amx sheet --run-dir "$R" --batch 1 >/dev/null
  run amx decide --run-dir "$R" --batch 1 --accept --commit
  [ "$status" -eq 0 ]
  [[ "$output" == *"stored "*"tagged 1"*"dropped "*"already-present 0"*"errors 0"* ]] || { echo "$output"; return 1; }
  cmp "$STUB_DIR/calls/002.in.jsonl" "$R/batches/0001.approved.jsonl"
  python3 - "$STUB_DIR" "$R" <<'PY'
import json, os, sys
d, R = sys.argv[1], sys.argv[2]
rr = os.path.realpath(R)
argv = json.load(open(d + "/calls/002.argv.json"))
assert argv == ["lessons", "ingest", "--in", rr + "/batches/0001.approved.jsonl",
                "--ledger", rr + "/stored.jsonl", "--json"], argv
ops = [json.loads(l) for l in open(R + "/batches/0001.approved.jsonl")]
tag = [o for o in ops if o["op"] == "add_tags"]
assert len(tag) == 1 and tag[0]["id"] == 1532 and "role:warden" in tag[0]["tags"].split(","), tag
for o in ops:
    if o["op"] == "store":
        assert set(o) == {"key", "op", "args"} and o["key"] in o["args"]["tags"].split(",")
dec = [json.loads(l) for l in open(R + "/decisions.jsonl")]
com = [x for x in dec if x["kind"] == "decision" and x["committed"]]
assert {x["result"]["status"] for x in com if x["disp"] in ("KEEP", "TAG")} <= {"stored", "tagged"}
led = [json.loads(l) for l in open(R + "/stored.jsonl")]
assert len([x for x in com if x["result"]["status"] == "stored"]) == len([l for l in led if l["op"] == "store"])
PY
}

@test "decide --accept refuses when the resolution no longer matches the sheet shown" {
  make_corpus
  amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --only-role warden >/dev/null
  amx next --run-dir "$R" --size 50 >/dev/null
  amx propose --run-dir "$R" --batch 1 --keep 1 --drop "7:dated headroom snapshot" >/dev/null
  amx sheet --run-dir "$R" --batch 1 >/dev/null
  amx propose --run-dir "$R" --batch 1 --drop "1:changed after the sheet" >/dev/null
  run amx decide --run-dir "$R" --batch 1 --accept --commit
  [ "$status" -eq 1 ]
  [[ "$output" == *"sheet"* ]] || { echo "$output"; return 1; }
  [ ! -e "$R/stored.jsonl" ]
}

# --- report -----------------------------------------------------------------------

commit_warden_batch() {
  amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" \
    --root "nested:cli=$P/cli/.claude/agent-memory:proj" --root "user=$U:proj" >/dev/null
  local b=1
  while amx next --run-dir "$R" --size 50 >"$W/next.out" 2>&1; do
    grep -q 'nothing pending' "$W/next.out" && break
    local judge
    judge="$(amx sheet --run-dir "$R" --batch "$b" --json | python3 -c 'import json,sys; print(",".join(str(r["row"]) for r in json.load(sys.stdin)["rows"] if r["disp"]=="JUDGE"))')"
    if [ -n "$judge" ]; then
      amx propose --run-dir "$R" --batch "$b" --keep "$judge" >/dev/null
    fi
    amx sheet --run-dir "$R" --batch "$b" >/dev/null
    amx decide --run-dir "$R" --batch "$b" --accept --commit >/dev/null
    b=$((b + 1))
    [ "$b" -lt 20 ] || return 1
  done
}

@test "report: --json closes the arithmetic per root and source set; --md states units" {
  make_corpus
  commit_warden_batch
  run amx report --run-dir "$R" --json
  [ "$status" -eq 0 ]
  printf '%s' "$output" > "$W/rep.json"
  python3 - "$W/rep.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
assert r["ok"] is True, r["failures"]
labels = {x["label"] for x in r["roots"]}
assert labels == {"main", "nested:cli", "user"}, labels
assert {x["set"] for x in r["sets"]} == {"main", "nested", "user"}
for x in r["roots"] + r["sets"] + [r["total"]]:
    f, l = x["files"], x["learnings"]
    assert f["found"] == f["index"] + f["excluded"] + f["read"], x
    assert f["read"] == f["in_candidates"] + f["unscanned"], x
    disc = sum(l["discarded"].values())
    assert l["proposed"] == l["approved_new"] + l["approved_tag"] + disc + l["pending"], x
    assert l["approved_new"] == l["stored"] + l["already"], x
assert r["total"]["learnings"]["pending"] == 0
assert r["total"]["learnings"]["stored"] > 0
assert r["total"]["files"]["unscanned"] == 0
PY
  run amx report --run-dir "$R" --md
  [ "$status" -eq 0 ]
  [[ "$output" == *"(unit: files)"* && "$output" == *"(unit: learnings)"* ]] || { echo "$output"; return 1; }
  [[ "$output" == *"nested:cli"* && "$output" == *"user"* ]] || { echo "$output"; return 1; }

  # A file written after the scan is counted as read, unscanned and pending —
  # the tables still close, and only a rescan brings it into the candidates.
  printf -- '---\nname: late\nmetadata:\n  type: feedback\n---\nwritten after the scan\n' \
    > "$P/.claude/agent-memory/warden/feedback_late.md"
  run amx report --run-dir "$R" --json
  [ "$status" -eq 0 ]
  printf '%s' "$output" > "$W/rep2.json"
  python3 - "$W/rep2.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
assert r["ok"] is True, r["failures"]
main = [x for x in r["roots"] if x["label"] == "main"][0]["files"]
assert main["unscanned"] == 1 and main["pending"] == 1, main
assert main["read"] == main["in_candidates"] + 1, main
PY
}

@test "report: a hand-corrupted ledger fails the arithmetic (exit 1)" {
  make_corpus
  commit_warden_batch
  run amx report --run-dir "$R" --json
  [ "$status" -eq 0 ]
  # Drop the first ledger row: a stored lesson now has no ledger evidence, and
  # the report names that key (not only the aggregate count).
  local gone
  gone="$(head -1 "$R/stored.jsonl" | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')"
  sed -n '2,$p' "$R/stored.jsonl" > "$W/ledger.tmp"
  cat "$W/ledger.tmp" > "$R/stored.jsonl"
  run amx report --run-dir "$R" --md
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL"* ]] || { echo "$output"; return 1; }
  [[ "$output" == *"$gone is recorded"*"no matching store row"* ]] || { echo "$output"; return 1; }
  # A foreign ledger key is caught too.
  printf '{"key":"amx:ffffffffffff","id":1,"op":"store","sha256":"%064d"}\n' 0 >> "$R/stored.jsonl"
  run amx report --run-dir "$R" --json
  [ "$status" -eq 1 ]
  [[ "$output" == *"amx:ffffffffffff"* ]] || { echo "$output"; return 1; }
}

@test "report --verify-sources reports missing and changed source files" {
  make_corpus
  amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --only-role warden >/dev/null
  run amx report --run-dir "$R" --md --verify-sources
  [ "$status" -eq 0 ]
  local A="$P/.claude/agent-memory/warden"
  # (1) missing alone fails. Simulates an agent removing its own memory file;
  # the script never does.
  cp "$A/reference_dash.md" "$W/keep.md"
  python3 -c 'import os,sys; os.remove(sys.argv[1])' "$A/reference_dash.md"
  run amx report --run-dir "$R" --md --verify-sources
  [ "$status" -eq 1 ]
  [[ "$output" == *"missing  main/warden/reference_dash.md"* ]] || { echo "$output"; return 1; }
  [[ "$output" == *"source missing: main/warden/reference_dash.md"* ]] || { echo "$output"; return 1; }
  # without --verify-sources the same run dir passes: the check is what fails it
  run amx report --run-dir "$R" --md
  [ "$status" -eq 0 ]
  # (2) changed alone fails.
  cp "$W/keep.md" "$A/reference_dash.md"
  printf 'changed\n' >> "$A/notes.md"
  run amx report --run-dir "$R" --md --verify-sources
  [ "$status" -eq 1 ]
  [[ "$output" == *"changed  main/warden/notes.md"* ]] || { echo "$output"; return 1; }
  [[ "$output" != *"missing  "* ]] || { echo "$output"; return 1; }
  # (3) a rescan records the change, and verification is clean again.
  run amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --rescan
  [ "$status" -eq 0 ]
  run amx report --run-dir "$R" --md --verify-sources
  [ "$status" -eq 0 ] || { echo "$output"; return 1; }
}

# --- the reply grammar, project overrides, errors, imported proposals ---------------

@test "decide: flip, new, cat, global and title overrides resolve as the dry echo shows" {
  make_corpus
  control '{"vector": true, "nearest": {"Dashboard lives here": {"id": 1532, "project": "proj", "title": "y", "tags": "ops", "similarity": 0.86}}}'
  amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --only-role warden >/dev/null
  amx next --run-dir "$R" --size 50 >/dev/null
  amx propose --run-dir "$R" --batch 1 --keep 1 --drop "7:dated headroom snapshot" >/dev/null
  # rows: 2 dup KEEP, 5 split KEEP, 6 notes DROP, 8 dash TAG, 9 profile DROP
  run amx decide --run-dir "$R" --batch 1 --flip 2,6 --new 8 --cat 5=mistake --global 5 \
    --title "3=A sharper title" --json
  [ "$status" -eq 0 ]
  printf '%s' "$output" > "$W/d.json"
  python3 - "$W/d.json" <<'PY'
import json, sys
rows = {r["row"]: r for r in json.load(open(sys.argv[1]))["rows"]}
assert rows[2]["disp"] == "DROP" and rows[2]["source"] == "operator", rows[2]
assert rows[6]["disp"] == "KEEP", rows[6]
assert rows[8]["disp"] == "NEW" and rows[8]["id"] is None, rows[8]
assert rows[5]["category"] == "mistake" and rows[5]["scope"] == "global", rows[5]
assert rows[3]["title"] == "A sharper title", rows[3]
assert rows[9]["disp"] == "DROP" and rows[9]["reason"] == "user-profile", rows[9]
PY
  # a flip of the TAG row goes to DROP, and back again restores the TAG
  run amx decide --run-dir "$R" --batch 1 --flip 8 --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"disp": "DROP"'* ]] || { echo "$output"; return 1; }
  # a row outside the batch is a usage error
  run amx decide --run-dir "$R" --batch 1 --flip 99
  [ "$status" -eq 2 ]
}

@test "decide --commit: a project override is verified by a dry run first; an unregistered one commits nothing" {
  make_corpus
  control '{"vector": true, "unregistered": ["ghost"]}'
  amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --only-role warden >/dev/null
  amx next --run-dir "$R" --size 50 >/dev/null
  amx propose --run-dir "$R" --batch 1 --keep 1 --drop "7:dated headroom snapshot" >/dev/null
  amx sheet --run-dir "$R" --batch 1 >/dev/null
  run amx decide --run-dir "$R" --batch 1 --project 5=ghost --accept --commit
  [ "$status" -eq 1 ]
  [[ "$output" == *"project not registered"*"5 (ghost)"* ]] || { echo "$output"; return 1; }
  [ ! -e "$R/stored.jsonl" ]
  [ ! -e "$R/decisions.jsonl" ] || ! grep -q '"kind":"decision"' "$R/decisions.jsonl"
  # call 2 was the verification dry run; no write call followed
  python3 - "$STUB_DIR" <<'PY'
import json, os, sys
d = sys.argv[1] + "/calls"
argvs = [json.load(open(os.path.join(d, f))) for f in sorted(os.listdir(d)) if f.endswith(".argv.json")]
assert len(argvs) == 2 and "--dry-run" in argvs[1], argvs
PY
  run amx decide --run-dir "$R" --batch 1 --project 5=other --accept --commit
  [ "$status" -eq 0 ]
  python3 - "$STUB_DIR" "$R" <<'PY'
import json, os, sys
d, R = sys.argv[1] + "/calls", sys.argv[2]
argvs = [json.load(open(os.path.join(d, f))) for f in sorted(os.listdir(d)) if f.endswith(".argv.json")]
assert "--dry-run" in argvs[2] and "--ledger" in argvs[3], argvs
ops = [json.loads(l) for l in open(R + "/batches/0001.approved.jsonl")]
assert [o["args"]["project"] for o in ops if o["args"]["title"] == "A split invalidates attribution"] == ["other"]
PY
}

@test "decide --commit: an errored row stays pending, exits 1, and the next batch re-offers it" {
  make_corpus
  control '{"vector": true, "commit_error": {"Notes": "title-collision:77"}}'
  amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --only-role warden >/dev/null
  amx next --run-dir "$R" --size 50 >/dev/null
  amx propose --run-dir "$R" --batch 1 --keep 1 --drop "7:dated headroom snapshot" >/dev/null
  amx sheet --run-dir "$R" --batch 1 >/dev/null
  run amx decide --run-dir "$R" --batch 1 --keep 6 --accept --commit
  [ "$status" -eq 1 ]
  [[ "$output" == *"errors 1"* && "$output" == *"title-collision:77 (stays pending)"* ]] || { echo "$output"; return 1; }
  run amx report --run-dir "$R" --json
  [ "$status" -eq 0 ]
  [[ "$output" == *'"pending": 1'* ]] || { echo "$output"; return 1; }
  run amx next --run-dir "$R" --size 50
  [ "$status" -eq 0 ]
  python3 - "$R" <<'PY'
import json, sys
R = sys.argv[1]
b = json.load(open(R + "/run.json"))["batches"]["0002"]
C = dict((c["cid"], c) for c in map(json.loads, open(R + "/candidates.jsonl")))
assert [C[c]["title"] for c in b["cids"]] == ["Notes"], b
PY
}

@test "scan --import-decisions carries a dry run's proposals into the full run" {
  make_corpus
  local D="$W/dryrun"
  amx scan --run-dir "$D" --root "main=$P/.claude/agent-memory:proj" --only-role warden >/dev/null
  amx next --run-dir "$D" --size 50 >/dev/null
  amx propose --run-dir "$D" --batch 1 --keep "1:durable index note" --drop "7:dated headroom snapshot" >/dev/null
  run amx scan --run-dir "$R" --root "main=$P/.claude/agent-memory:proj" --only-role warden --import-decisions "$D"
  [ "$status" -eq 0 ]
  [[ "$output" == *"imported 2 proposal(s)"* ]] || { echo "$output"; return 1; }
  amx next --run-dir "$R" --size 50 >/dev/null
  run amx sheet --run-dir "$R" --batch 1 --json
  printf '%s' "$output" > "$W/s.json"
  python3 - "$W/s.json" <<'PY'
import json, sys
rows = {r["row"]: r for r in json.load(open(sys.argv[1]))["rows"]}
assert (rows[1]["disp"], rows[1]["reason"]) == ("KEEP", "durable index note (model)"), rows[1]
assert (rows[7]["disp"], rows[7]["reason"]) == ("DROP", "dated headroom snapshot (model)"), rows[7]
PY
  # the dry run committed nothing, so nothing was imported as a decision
  run grep -c '"kind":"decision"' "$R/decisions.jsonl"
  [ "$output" = "0" ]
}
