#!/usr/bin/env bats

# git_hooks_consumer.test.bash — FR-243. The git-level gates as a CONSUMER
# project receives them: a fresh `git init` repo with NO `.gitleaks.toml`, whose
# `.git/hooks/<name>` is a symlink to the runtime mirror
# (`$HOME/.igris/core/git-hooks/<name>`) — the shape `igris install` writes.
#
# The subject is driven the way git drives it: a REAL `git commit` through the
# installed symlink (L-1123 — running the tool is not running the gate; the
# sibling `secrets_scan.test.bash` tests the CONFIG via `gitleaks detect`, this
# file tests the HOOK).
#
# Shown RED first (2026-09-07, develop f55abc8, the hook copied from
# `scripts/git-hooks/pre-commit` so the fixture shares the OLD code's root —
# test_standards §"RED-first fixture must share the OLD code's root"):
#   R1  a staged AKIA-shaped key was ACCEPTED, exit 0, with NO output at all —
#       the brief's failure (the scan sat behind `[ -f .gitleaks.toml ]`);
#   R2  no `[pre-commit] layers:` line;
#   R3  gitleaks off PATH → no `secret-scan=DISARMED` token (a 2-line WARN
#       behind the same config condition, so in a consumer repo: silence);
#   R4  a consumer file at `core/skills/x/SKILL.md` invoked the igris-ai-only
#       `scripts/validate_skill_frontmatter_yaml.py` → "No such file" → blocked.
#
# Sandbox: HOME is fenced to `$FAKEHOME` (the hook reads `$HOME/.igris/...`
# for the phase guard, and git reads `$HOME/.gitconfig` — the operator's
# global config must not reach the fixture); `IGRIS_BRAIN_DIR` is set to the
# same root. No brain DB is seeded, so the phase guard reports
# `phase-guard=off (no brain db)` — the consumer-without-/hunt case.
#
# Runs in the ROOT bats matrix (`.github/workflows/test.yml` "Run test suite",
# ubuntu + macos, which installs gitleaks) — NOT in the `cli-bats` job, which
# has no gitleaks and would skip the secret-scan case silently (L-552).

load test_helper

# Through the tracked symlink `scripts/git-hooks/* -> ../../core/git-hooks/*`
# (FR-243) — `cp` follows it, so the fixture copies the canonical bytes.
HOOK_SRC_DIR="$IGRIS_ROOT/scripts/git-hooks"

# The layers-line grammar (MAINTAINING row "git-level gate projection contract"):
#   [pre-commit] layers: phase-guard=<v> secret-scan=<v> repo-validators=<v>
# Keys fixed and ordered; a value is one token optionally followed by ONE
# parenthetical.
LAYERS_RE='\[pre-commit\] layers: phase-guard=[a-zA-Z]+( \([^)]*\))? secret-scan=[a-zA-Z]+( \([^)]*\))? repo-validators=[a-zA-Z/]+( \([^)]*\))?$'

setup() {
  command -v git >/dev/null 2>&1 || skip "git not available"
  [ -f "$HOOK_SRC_DIR/pre-commit" ] || { echo "hook not found at $HOOK_SRC_DIR/pre-commit"; return 1; }
  [ -f "$HOOK_SRC_DIR/commit-msg" ] || { echo "hook not found at $HOOK_SRC_DIR/commit-msg"; return 1; }

  SANDBOX="$TEST_TEMP_DIR/ghc_$BATS_TEST_NUMBER"
  FAKEHOME="$SANDBOX/fakehome"
  MIRROR="$FAKEHOME/.igris/core/git-hooks"
  mkdir -p "$MIRROR"
  cp "$HOOK_SRC_DIR/pre-commit" "$MIRROR/pre-commit"
  cp "$HOOK_SRC_DIR/commit-msg" "$MIRROR/commit-msg"
  chmod +x "$MIRROR/pre-commit" "$MIRROR/commit-msg"

  REPO="$SANDBOX/cproj"
  mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@t.t
  git -C "$REPO" config user.name t
  git -C "$REPO" config commit.gpgsign false
  # What `igris install` writes: .git/hooks/<name> -> $(brainDir())/core/git-hooks/<name>
  ln -s "$MIRROR/pre-commit" "$REPO/.git/hooks/pre-commit"
  ln -s "$MIRROR/commit-msg" "$REPO/.git/hooks/commit-msg"

  # A baseline commit (hooks bypassed) so every test commit is an ordinary one.
  printf 'hello\n' > "$REPO/README.md"
  git -C "$REPO" add README.md
  git -C "$REPO" commit -q --no-verify -m "chore: init" >/dev/null 2>&1

  # A PATH with every directory that carries a gitleaks binary removed, plus a
  # stub dir at the front that keeps the tools the hook needs resolvable
  # (git/python3/sqlite3 may share a dir with gitleaks on some installs).
  STUB_BIN="$SANDBOX/stub-bin"
  mkdir -p "$STUB_BIN"
  for tool in git python3 sqlite3 mktemp hostname; do
    p="$(command -v "$tool" 2>/dev/null || true)"
    [ -n "$p" ] && ln -s "$p" "$STUB_BIN/$tool"
  done
  NO_GITLEAKS_PATH="$STUB_BIN"
  OLD_IFS="$IFS"; IFS=':'
  for d in $PATH; do
    [ -x "$d/gitleaks" ] && continue
    NO_GITLEAKS_PATH="$NO_GITLEAKS_PATH:$d"
  done
  IFS="$OLD_IFS"
}

# commit_with_hooks <message> [ENV=VAL ...] — a real `git commit` in the sandbox
# with HOME fenced. Extra env assignments come first (e.g. PATH=...).
commit_with_hooks() {
  local msg="$1"; shift
  run env "$@" HOME="$FAKEHOME" IGRIS_BRAIN_DIR="$FAKEHOME/.igris" \
    git -C "$REPO" commit -q -m "$msg"
}

stage_secret() {
  # The shape secrets_scan.test.bash (d) uses; gitleaks' built-in
  # aws-access-token rule catches it with NO config (probed 2026-09-07,
  # gitleaks 8.30.1: `detect --no-git` on this line, no --config, 1 finding).
  printf 'const awsKey = "AKIA1234567890ABCDEF";\n' > "$REPO/prod.ts"
  git -C "$REPO" add prod.ts
}

stage_benign() {
  printf 'export const answer = 42;\n' > "$REPO/lib.ts"
  git -C "$REPO" add lib.ts
}

# ---------------------------------------------------------------------------
# R1 — the brief's failure: credential-shaped content in a consumer repo with
# no .gitleaks.toml. RED on develop: exit 0, empty output (accepted silently).
# ---------------------------------------------------------------------------
@test "R1: staged AKIA key in a consumer repo (no .gitleaks.toml) is REFUSED by the installed hook" {
  command -v gitleaks >/dev/null 2>&1 || skip "gitleaks not installed"
  stage_secret
  commit_with_hooks "chore: add config"
  echo "exit=$status"; echo "$output"
  [ "$status" -eq 1 ]
  [[ "$output" == *"SECRET-SHAPED CONTENT DETECTED"* ]] || return 1
  # The refusal is the HOOK's (not a git error): the file is still staged, no commit landed.
  [ "$(git -C "$REPO" rev-list --count HEAD)" -eq 1 ]
}

# ---------------------------------------------------------------------------
# R2 — the layers line prints on EVERY run, including a commit with nothing to
# validate (today: silent exit 0).
# ---------------------------------------------------------------------------
@test "R2: a benign commit prints the [pre-commit] layers line in the pinned grammar" {
  stage_benign
  commit_with_hooks "chore: benign"
  echo "$output"
  [ "$status" -eq 0 ]
  line="$(printf '%s\n' "$output" | grep -E '^\[pre-commit\] layers: ' | head -n1)"
  [ -n "$line" ] || return 1
  [[ "$line" =~ $LAYERS_RE ]] || return 1
  # Consumer tokens: no brain DB seeded, no .gitleaks.toml, not the igris-ai checkout.
  [[ "$line" == *"phase-guard=off (no brain db)"* ]] || return 1
  [[ "$line" == *"repo-validators=n/a"* ]] || return 1
  if command -v gitleaks >/dev/null 2>&1; then
    [[ "$line" == *"secret-scan=active (gitleaks defaults)"* ]] || return 1
  fi
}

# ---------------------------------------------------------------------------
# R3 — loud degradation: gitleaks absent from PATH → the token says DISARMED
# and a box is printed. Today the WARN sits behind the config condition, so a
# consumer sees nothing.
# ---------------------------------------------------------------------------
@test "R3: gitleaks off PATH → secret-scan=DISARMED token + the DISARMED box" {
  stage_benign
  commit_with_hooks "chore: benign" PATH="$NO_GITLEAKS_PATH"
  echo "$output"
  [[ "$output" == *"secret-scan=DISARMED (gitleaks not installed)"* ]] || return 1
  [[ "$output" == *"SECRET SCAN DISARMED"* ]] || return 1
  [[ "$output" == *"igris doctor"* ]] || return 1
}

# Self-negative control (test_standards §"Self-negative controls in bats"):
# DISARMED is LOUD, not BLOCKING — the TD-159 posture (a hard block would be
# bypassed with --no-verify and teach the wrong habit). The commit lands.
@test "R3b: DISARMED still accepts the commit (loud, not blocking)" {
  stage_benign
  commit_with_hooks "chore: benign" PATH="$NO_GITLEAKS_PATH"
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"secret-scan=DISARMED"* ]] || return 1
  [ "$(git -C "$REPO" rev-list --count HEAD)" -eq 2 ]
}

# ---------------------------------------------------------------------------
# C1 — the surviving control: a benign commit is accepted before AND after the
# fix, and across every mutation of the battery.
# ---------------------------------------------------------------------------
@test "C1 (control): a benign commit through the installed hook is accepted" {
  stage_benign
  commit_with_hooks "chore: benign"
  echo "$output"
  [ "$status" -eq 0 ]
  [ "$(git -C "$REPO" rev-list --count HEAD)" -eq 2 ]
}

# ---------------------------------------------------------------------------
# R4 — the igris-ai-internal validator region is INERT in a consumer repo and
# SAYS so. A consumer that happens to stage `core/skills/x/SKILL.md` must not
# have `$REPO_ROOT/scripts/validate_*` invoked (today: python3 "No such file"
# → failed=1 → blocked).
# ---------------------------------------------------------------------------
@test "R4: a consumer staging core/skills/x/SKILL.md is not gated by the igris-ai validators" {
  mkdir -p "$REPO/core/skills/x"
  printf -- '---\nname: x\n---\nbody\n' > "$REPO/core/skills/x/SKILL.md"
  git -C "$REPO" add core/skills/x/SKILL.md
  commit_with_hooks "docs: add skill"
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"repo-validators=n/a (not the igris-ai checkout)"* ]] || return 1
  [[ "$output" != *"No such file"* ]] || return 1
  [[ "$output" != *"validate_skill_frontmatter_yaml"* ]] || return 1
}

# ---------------------------------------------------------------------------
# R5 — the discriminator's other arm (plan R9): a repo carrying all three
# discriminator files reports `repo-validators=active` — so the region cannot
# be inert on the igris-ai checkout itself. Nothing that triggers a validator
# is staged, so the run stays green.
# ---------------------------------------------------------------------------
@test "R5: a repo with harness-manifest.json + brain-mcp-server/ + scripts/git-hooks/ reports repo-validators=active" {
  printf '{}\n' > "$REPO/harness-manifest.json"
  mkdir -p "$REPO/brain-mcp-server" "$REPO/scripts/git-hooks"
  stage_benign
  commit_with_hooks "chore: benign"
  echo "$output"
  [ "$status" -eq 0 ]
  [[ "$output" == *"repo-validators=active (igris-ai)"* ]] || return 1
}

# ---------------------------------------------------------------------------
# R6 — a consumer that DOES carry a .gitleaks.toml gets `--config` (the third
# token value), and the scan still refuses.
# ---------------------------------------------------------------------------
@test "R6: with a .gitleaks.toml present the token reads (repo config) and the scan still refuses" {
  command -v gitleaks >/dev/null 2>&1 || skip "gitleaks not installed"
  printf '[extend]\nuseDefault = true\n' > "$REPO/.gitleaks.toml"
  stage_secret
  commit_with_hooks "chore: add config"
  echo "$output"
  [ "$status" -eq 1 ]
  [[ "$output" == *"secret-scan=active (repo config)"* ]] || return 1
  [[ "$output" == *"SECRET-SHAPED CONTENT DETECTED"* ]] || return 1
}
