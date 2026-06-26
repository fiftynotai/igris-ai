#!/usr/bin/env bats

# add_surfaces.test.bash — FR-180 `igris add` end-to-end (Phase 1: skill,
# Phase 2: agent, Phase 3: mcp, Phase 5: hook + the R2 refresh-no-clobber merge
# gate). FR-202 M4 retired the identity arm (the os_identity surface is gone).
#
# Exercises the one-step `igris add skill`/`igris add agent` verbs against a
# sandbox brain:
#   - PERSONAL round-trip: materialize (vendor + overlay) → project → verify,
#     asserting the projection symlink actually lands on disk (not just an
#     overlay write).
#   - The mode line is PRINTED (D1, never silent).
#   - FORCED OWNERSHIP-SKIP: a raw `compile --surface skills --expect-core` in a
#     non-owning project FAILS LOUDLY (exit != 0 + actionable message) — the
#     TD-235 no-silent-no-op proof at the adapter layer.
#   - Incidental personal compile (no --expect-core) emits the visible SKIPPED
#     line and stays exit-0.
#
# Setup mirrors harness_mcp.test.bash: sandbox HOME + isolated brain, with the
# repo adapters + verify_mirror copied into the sandbox brain so `igris add`'s
# brainDir()-relative adapter resolution finds them.

load test_helper

setup() {
  ADAPTERS="$IGRIS_ROOT/core/scripts/cli-adapters"
  COMPILE="$ADAPTERS/compile_harnesses.sh"
  GUARD="$ADAPTERS/check_harness_drift.sh"

  [ -f "$COMPILE" ] || skip "compile_harnesses.sh missing at $COMPILE"
  [ -f "$GUARD" ] || skip "check_harness_drift.sh missing at $GUARD"
  require_python3

  CLI_ENTRY="$IGRIS_ROOT/cli/dist/index.js"
  [ -f "$CLI_ENTRY" ] || skip "cli/dist/index.js missing — run 'npm run build' in cli/ first (L-552)"
  command -v node >/dev/null 2>&1 || skip "node not available"
  IGRIS_BIN=(node "$CLI_ENTRY")
  # The MCP compile pass shells out to `igris registry project-mcp`; point it at
  # the freshly-built CLI (Phase 3 mcp arm).
  export IGRIS_CLI="node $CLI_ENTRY"

  # Sandbox HOME so projection symlinks land in temp, not the live machine.
  SANDBOX_HOME="$TEST_TEMP_DIR/home_$BATS_TEST_NUMBER"
  mkdir -p "$SANDBOX_HOME/.claude/skills" "$SANDBOX_HOME/.agents/skills"
  export HOME="$SANDBOX_HOME"

  # Isolated brain dir WITH the repo adapters copied in (igris add resolves the
  # adapter dir as brainDir()/core/scripts/cli-adapters).
  ISOLATED_BRAIN="$TEST_TEMP_DIR/brain_$BATS_TEST_NUMBER"
  mkdir -p "$ISOLATED_BRAIN/registry" "$ISOLATED_BRAIN/core/scripts"
  cp -R "$ADAPTERS" "$ISOLATED_BRAIN/core/scripts/cli-adapters"
  cp "$IGRIS_ROOT/core/scripts/verify_mirror.sh" "$ISOLATED_BRAIN/core/scripts/verify_mirror.sh"
  export IGRIS_BRAIN_DIR="$ISOLATED_BRAIN"

  # A consumer project that is NOT the igris-ai checkout (personal mode).
  PROJ="$TEST_TEMP_DIR/proj_$BATS_TEST_NUMBER"
  mkdir -p "$PROJ"
  cat > "$PROJ/harness-manifest.json" <<'EOF'
{ "version": 1, "agents": [] }
EOF

  # A source SKILL dir (single-skill shape: <src>/SKILL.md). `--from` points at
  # the skill dir itself so the recorded origin == the vendored tree's content
  # root (registry/skills/mytool/mytool/SKILL.md) — TD-201 tree-drift MATCH.
  SKILL_SRC="$TEST_TEMP_DIR/skillsrc_$BATS_TEST_NUMBER/mytool"
  mkdir -p "$SKILL_SRC"
  cat > "$SKILL_SRC/SKILL.md" <<'EOF'
---
name: mytool
description: "A test skill - usage: /mytool"
---
body
EOF

  # A source AGENT body file (unversioned `--from <file>`). The α-assembly emits
  # the per-harness outputs at vendor time; the opencode target projects a
  # registry-anchored symlink into the sandbox HOME.
  AGENT_SRC_DIR="$TEST_TEMP_DIR/agentsrc_$BATS_TEST_NUMBER"
  mkdir -p "$AGENT_SRC_DIR" "$SANDBOX_HOME/.config/opencode/agent"
  AGENT_SRC="$AGENT_SRC_DIR/mybot.md"
  cat > "$AGENT_SRC" <<'EOF'
---
name: mybot
description: "A test agent"
tools: Read, Grep
---
You are MYBOT, a test agent.
EOF
}

teardown() {
  [ -d "$PROJ" ] && rm -rf "$PROJ"
}

@test "add skill (personal): vendors + projects the symlink + verifies, exit 0" {
  run "${IGRIS_BIN[@]}" add skill mytool \
    --no-core \
    --from "$SKILL_SRC" \
    --target "claude:symlink:$HOME/.claude/skills" \
    --project-root "$PROJ"
  echo "status=$status output=$output" >&2
  [ "$status" -eq 0 ]

  # The mode line is printed (D1, never silent).
  [[ "$output" == *"PERSONAL mode"* ]]

  # The projection symlink actually landed (real on-disk effect, not just the
  # overlay write).
  [ -L "$HOME/.claude/skills/mytool" ]
  [ -f "$HOME/.claude/skills/mytool/SKILL.md" ]

  # The overlay block was written.
  [ -f "$ISOLATED_BRAIN/registry/harness-manifest.personal.json" ]
  grep -q "mytool" "$ISOLATED_BRAIN/registry/harness-manifest.personal.json"
}

@test "add skill (personal): re-add is idempotent (second run still exit 0)" {
  "${IGRIS_BIN[@]}" add skill mytool --no-core --from "$SKILL_SRC" \
    --target "claude:symlink:$HOME/.claude/skills" --project-root "$PROJ"
  run "${IGRIS_BIN[@]}" add skill mytool --no-core --from "$SKILL_SRC" \
    --target "claude:symlink:$HOME/.claude/skills" --project-root "$PROJ"
  echo "status=$status output=$output" >&2
  [ "$status" -eq 0 ]
  [ -L "$HOME/.claude/skills/mytool" ]
}

@test "add agent (personal): vendors + projects the opencode symlink + verifies, exit 0" {
  run "${IGRIS_BIN[@]}" add agent mybot \
    --no-core \
    --from "$AGENT_SRC" \
    --target "opencode:$HOME/.config/opencode/agent/mybot.md" \
    --project-root "$PROJ"
  echo "status=$status output=$output" >&2
  [ "$status" -eq 0 ]

  # The mode line is printed (D1, never silent).
  [[ "$output" == *"PERSONAL mode"* ]]

  # The opencode projection symlink actually landed (real on-disk effect).
  [ -L "$HOME/.config/opencode/agent/mybot.md" ]

  # The overlay block was written.
  [ -f "$ISOLATED_BRAIN/registry/harness-manifest.personal.json" ]
  grep -q "mybot" "$ISOLATED_BRAIN/registry/harness-manifest.personal.json"
}

# DIVERGENCE FROM SKILLS (flagged): the agent writer (`runAdd`) hard-REJECTS a
# re-add of an existing same-name overlay agent ("already exists; remove it
# first"), whereas `runAddSkill` treats a same-source re-add as an idempotent
# no-op. `igris add agent` faithfully reuses that pre-existing write-path
# behavior (R7 — no logic moved). So a personal-agent re-add is a LOUD reject
# (exit != 0), not a silent success. The materialize reject short-circuits
# BEFORE projection, so the prior symlink is left intact.
@test "add agent (personal): re-add rejects the duplicate overlay name (exit != 0)" {
  "${IGRIS_BIN[@]}" add agent mybot --no-core --from "$AGENT_SRC" \
    --target "opencode:$HOME/.config/opencode/agent/mybot.md" --project-root "$PROJ"
  run "${IGRIS_BIN[@]}" add agent mybot --no-core --from "$AGENT_SRC" \
    --target "opencode:$HOME/.config/opencode/agent/mybot.md" --project-root "$PROJ"
  echo "status=$status output=$output" >&2
  [ "$status" -ne 0 ]
  [[ "$output" == *"already exists"* ]]
  # The first add's projection symlink is left intact (reject short-circuits).
  [ -L "$HOME/.config/opencode/agent/mybot.md" ]
}

@test "S1: scoped verify ignores a pre-existing UNRELATED skill's drift" {
  skip "FR-212d: skills/MCP add now delegate (skills CLI / add-mcp); round-trip covered by fr212-smoke + remove.test.ts"
  # Add mytool, then add a SECOND skill (distinct target dir), then DRIFT
  # mytool's registry copy. Adding a third skill must still succeed because the
  # verify (harness check) is scoped via --filter to the just-added skill —
  # pre-existing unrelated drift does NOT false-fail a clean add (S1).
  "${IGRIS_BIN[@]}" add skill mytool --no-core --from "$SKILL_SRC" \
    --target "claude:symlink:$HOME/.claude/skills" --project-root "$PROJ"

  # A second source skill projected to a DISTINCT target dir (so the materialize
  # cross-block path-dedupe doesn't reject it).
  local src2="$TEST_TEMP_DIR/skillsrc2_$BATS_TEST_NUMBER/other"
  mkdir -p "$src2" "$HOME/.claude/skills2"
  cat > "$src2/SKILL.md" <<'EOF'
---
name: other
description: "Another skill - usage: /other"
---
body2
EOF

  # Now CORRUPT mytool's registry copy → unrelated tree drift.
  echo "MUTATED-UNRELATED" >> "$ISOLATED_BRAIN/registry/skills/mytool/mytool/SKILL.md"

  # Adding `other` must succeed: its scoped verify (--filter other) never looks
  # at mytool's drift.
  run "${IGRIS_BIN[@]}" add skill other --no-core --from "$src2" \
    --target "claude:symlink:$HOME/.claude/skills2" --project-root "$PROJ"
  echo "status=$status output=$output" >&2
  [ "$status" -eq 0 ]
  [[ "$output" == *"Added personal skill 'other'"* ]]
  [ -L "$HOME/.claude/skills2/other" ]
}

@test "TD-235: forced ownership-skip FAILS loudly under --expect-core (exit != 0)" {
  # A raw compile of the core skills surface in a non-owning project, with
  # --expect-core, must FAIL loudly — never a silent exit-0 no-op.
  run env IGRIS_BRAIN_DIR="$ISOLATED_BRAIN" bash "$COMPILE" \
    --project-root "$PROJ" --surface skills --expect-core
  echo "status=$status output=$output" >&2
  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL  core skills"* ]]
  [[ "$output" == *"not owned by --project-root"* ]]
}

@test "TD-235: incidental compile (no --expect-core) emits visible SKIPPED, exit 0" {
  run env IGRIS_BRAIN_DIR="$ISOLATED_BRAIN" bash "$COMPILE" \
    --project-root "$PROJ" --surface skills
  echo "status=$status output=$output" >&2
  [ "$status" -eq 0 ]
  [[ "$output" == *"SKIPPED core surfaces (personal-project compile)"* ]]
}

@test "TD-235 drift mirror: forced ownership-skip FAILS loudly in check under --expect-core" {
  run env IGRIS_BRAIN_DIR="$ISOLATED_BRAIN" bash "$GUARD" \
    --project-root "$PROJ" --expect-core
  echo "status=$status output=$output" >&2
  [ "$status" -ne 0 ]
  [[ "$output" == *"FAIL  core skills"* ]]
}

# --- Phase 3: igris add mcp -------------------------------------------------

@test "add mcp (personal): registers + projects the claude config entry + verifies, exit 0" {
  skip "FR-212d: skills/MCP add now delegate (skills CLI / add-mcp); round-trip covered by fr212-smoke + remove.test.ts"
  run "${IGRIS_BIN[@]}" add mcp myserver \
    --no-core \
    --command node \
    --arg /srv/x.js \
    --env "API=\${API_TOKEN}" \
    --target claude:merge \
    --project-root "$PROJ"
  echo "status=$status output=$output" >&2
  [ "$status" -eq 0 ]

  # The mode line is printed (D1, never silent).
  [[ "$output" == *"PERSONAL mode"* ]]

  # The overlay block was written.
  [ -f "$ISOLATED_BRAIN/registry/harness-manifest.personal.json" ]
  grep -q "myserver" "$ISOLATED_BRAIN/registry/harness-manifest.personal.json"

  # The projection MERGED the entry into the live claude config (real effect).
  [ -f "$HOME/.claude.json" ]
  python3 -c "import json; d=json.load(open('$HOME/.claude.json')); assert 'myserver' in d['mcpServers']; assert d['mcpServers']['myserver']['command']=='node'"
  # §14: the ${VAR} indirection ref is stored, NOT a resolved secret.
  python3 -c "import json; d=json.load(open('$HOME/.claude.json')); assert d['mcpServers']['myserver']['env']['API']=='\${API_TOKEN}'"
}

@test "add mcp (personal): inline secret in --env is REJECTED (§14), no projection" {
  run "${IGRIS_BIN[@]}" add mcp myserver \
    --no-core \
    --command node \
    --env "API=sk-live-do-not-leak" \
    --target claude:merge \
    --project-root "$PROJ"
  echo "status=$status output=$output" >&2
  [ "$status" -ne 0 ]
  [[ "$output" == *"must be a single"* ]]
  # No entry projected — the reject short-circuits before projection.
  if [ -f "$HOME/.claude.json" ]; then
    run python3 -c "import json; d=json.load(open('$HOME/.claude.json')); print('myserver' in d.get('mcpServers', {}))"
    [ "$output" = "False" ]
  fi
}

@test "S1: MCP scoped verify ignores a pre-existing UNRELATED MCP's drift" {
  skip "FR-212d: skills/MCP add now delegate (skills CLI / add-mcp); round-trip covered by fr212-smoke + remove.test.ts"
  # Add `myserver`, then DRIFT its projected claude entry. Adding a SECOND MCP
  # (`other`) must still succeed because the verify (harness check) is scoped via
  # --filter to the just-added MCP — a pre-existing unrelated MCP drift does NOT
  # false-fail a clean add (S1; Phase 3 wired --filter into the MCP passes).
  "${IGRIS_BIN[@]}" add mcp myserver --no-core --command node \
    --target claude:merge --project-root "$PROJ"

  # CORRUPT myserver's projected claude entry → unrelated MCP drift.
  python3 -c "import json; p='$HOME/.claude.json'; d=json.load(open(p)); d['mcpServers']['myserver']['args']=['/tampered.js']; json.dump(d, open(p,'w'))"

  run "${IGRIS_BIN[@]}" add mcp other --no-core --command python \
    --target claude:merge --project-root "$PROJ"
  echo "status=$status output=$output" >&2
  [ "$status" -eq 0 ]
  [[ "$output" == *"Added personal MCP 'other'"* ]]
}

# --- FR-180 Phase 5: igris add hook (D7 — the net-new first-class surface) ----

@test "add hook (personal): registers + merges the claude settings.json hook + verifies, exit 0" {
  run "${IGRIS_BIN[@]}" add hook my-guard \
    --no-core \
    --event PreToolUse \
    --matcher "Write|Edit" \
    --project-root "$PROJ"
  echo "status=$status output=$output" >&2
  [ "$status" -eq 0 ]

  # The mode line is printed (D1, never silent).
  [[ "$output" == *"PERSONAL mode"* ]]

  # The overlay block + the registry hook SCRIPT were written.
  [ -f "$ISOLATED_BRAIN/registry/harness-manifest.personal.json" ]
  grep -q "my-guard" "$ISOLATED_BRAIN/registry/harness-manifest.personal.json"
  [ -x "$ISOLATED_BRAIN/registry/hooks/my-guard/PreToolUse.sh" ]

  # The projection MERGED the hook GROUP into the project settings.json (real effect).
  [ -f "$PROJ/.claude/settings.json" ]
  python3 -c "import json; d=json.load(open('$PROJ/.claude/settings.json')); cmds=[h['command'] for g in d['hooks']['PreToolUse'] for h in g['hooks']]; assert '\$HOME/.igris/registry/hooks/my-guard/PreToolUse.sh' in cmds, cmds"
  # The success line names the R2 preservation contract.
  [[ "$output" == *"survives"* ]]
}

@test "R2 MERGE GATE: the canonical hooks re-merge PRESERVES a personal-added hook" {
  # Add a personal hook, then run the SAME canonical re-merge install/update/
  # doctor --fix use (mergeCanonicalHooks). The personal hook MUST survive — its
  # registry-prefix command is classified user-owned and is never clobbered.
  "${IGRIS_BIN[@]}" add hook my-guard --no-core --event PreToolUse \
    --matcher "Write|Edit" --project-root "$PROJ"
  [ -f "$PROJ/.claude/settings.json" ]

  # Provide a canonical-settings.json in the sandbox brain to re-merge from.
  mkdir -p "$ISOLATED_BRAIN/core/hooks"
  cp "$IGRIS_ROOT/core/hooks/canonical-settings.json" \
     "$ISOLATED_BRAIN/core/hooks/canonical-settings.json"

  # Run the EXACT canonical re-merge path (the dist libs install/update/doctor use).
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs");
    const { loadCanonicalHooks } = require(process.argv[1] + "/lib/canonical-hooks.js");
    const { mergeCanonicalHooks } = require(process.argv[1] + "/lib/json-merge.js");
    const sp = process.argv[2];
    const merged = mergeCanonicalHooks(JSON.parse(readFileSync(sp, "utf-8")), loadCanonicalHooks());
    writeFileSync(sp, JSON.stringify(merged, null, 2) + "\n");
  ' "$IGRIS_ROOT/cli/dist" "$PROJ/.claude/settings.json" 2>/dev/null \
    || node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    import { loadCanonicalHooks } from "'"$IGRIS_ROOT"'/cli/dist/lib/canonical-hooks.js";
    import { mergeCanonicalHooks } from "'"$IGRIS_ROOT"'/cli/dist/lib/json-merge.js";
    const sp = "'"$PROJ"'/.claude/settings.json";
    const merged = mergeCanonicalHooks(JSON.parse(readFileSync(sp, "utf-8")), loadCanonicalHooks());
    writeFileSync(sp, JSON.stringify(merged, null, 2) + "\n");
  '

  # ASSERT: personal hook SURVIVED + the canonical core hook was (re)applied.
  python3 -c "import json; d=json.load(open('$PROJ/.claude/settings.json')); cmds=[h['command'] for g in d['hooks']['PreToolUse'] for h in g['hooks']]; assert '\$HOME/.igris/registry/hooks/my-guard/PreToolUse.sh' in cmds, ('personal clobbered', cmds); assert any(c.startswith('\$HOME/.igris/core/hooks/') for c in cmds), ('core not applied', cmds)"
}

@test "S1: hook scoped verify ignores a pre-existing UNRELATED hook's drift" {
  # Add `my-guard`, then add a SECOND hook on a DIFFERENT event; corrupting the
  # first must not false-fail the second (the verify is --filter-scoped, S1).
  "${IGRIS_BIN[@]}" add hook my-guard --no-core --event PreToolUse \
    --project-root "$PROJ"
  # Corrupt my-guard's projected entry (remove it) → unrelated hook drift.
  python3 -c "import json; p='$PROJ/.claude/settings.json'; d=json.load(open(p)); d['hooks']['PreToolUse']=[]; json.dump(d, open(p,'w'))"

  run "${IGRIS_BIN[@]}" add hook other-guard --no-core --event SessionStart \
    --project-root "$PROJ"
  echo "status=$status output=$output" >&2
  [ "$status" -eq 0 ]
  [[ "$output" == *"Added personal hook 'other-guard'"* ]]
}

# --- FR-180 cross-phase: `add --core` PROJECTS (not just source-writes) -------
#
# Build a sandbox igris-ai "checkout" (a project root that detectCoreRepo
# recognises) AND point IGRIS_BRAIN_DIR at a runtime brain rooted under the
# sandbox HOME, so the surfaces-manifest's `~`-prefixed source/targets
# (~/.igris/core/skills, ~/.claude/skills, …) resolve into the sandbox. The
# CORE projection runs against the BRAIN ROOT (the fix), so the core skill
# materialized into the checkout + mirrored to the runtime brain is actually
# PROJECTED to the harnesses — asserting the symlink lands proves one-step.
build_core_checkout() {
  # Runtime brain UNDER the sandbox HOME so `~/.igris/...` == the brain.
  CORE_BRAIN="$HOME/.igris"
  mkdir -p "$CORE_BRAIN/core/scripts" "$CORE_BRAIN/core/skills" \
           "$CORE_BRAIN/core/agents" "$CORE_BRAIN/registry"
  cp -R "$ADAPTERS" "$CORE_BRAIN/core/scripts/cli-adapters"
  cp "$IGRIS_ROOT/core/scripts/verify_mirror.sh" "$CORE_BRAIN/core/scripts/verify_mirror.sh"
  export IGRIS_BRAIN_DIR="$CORE_BRAIN"

  # A sandbox igris-ai checkout: detectCoreRepo needs BOTH a
  # core/scripts/cli-adapters/surfaces-manifest.json AND a repo-root
  # harness-manifest.json. The checkout's surfaces-manifest is the one the
  # MATERIALIZE half reads (it gets the new block written into it); projection
  # reads the RUNTIME brain's copy (mirrored from the checkout).
  CORE_REPO="$TEST_TEMP_DIR/corerepo_$BATS_TEST_NUMBER"
  mkdir -p "$CORE_REPO/core/scripts/cli-adapters" "$CORE_REPO/core/skills" \
           "$CORE_REPO/core/agents"
  cp "$CORE_BRAIN/core/scripts/cli-adapters/surfaces-manifest.json" \
     "$CORE_REPO/core/scripts/cli-adapters/surfaces-manifest.json"
  # A repo-root harness-manifest with NO agents (skill/mcp arms don't read it;
  # the agent arm appends to it).
  cat > "$CORE_REPO/harness-manifest.json" <<'EOF'
{ "version": 1, "agents": [] }
EOF
}

@test "add --core skill: PROJECTS the symlink against the brain root + verifies, exit 0" {
  skip "FR-212d: skills/MCP add now delegate (skills CLI / add-mcp); round-trip covered by fr212-smoke + remove.test.ts"
  build_core_checkout

  run "${IGRIS_BIN[@]}" add --core skill zzprobeskill --project-root "$CORE_REPO"
  echo "status=$status output=$output" >&2
  [ "$status" -eq 0 ]
  [[ "$output" == *"CORE mode"* ]]

  # MATERIALIZE: source written into the checkout + mirrored to the runtime brain.
  [ -f "$CORE_REPO/core/skills/zzprobeskill/SKILL.md" ]
  [ -f "$CORE_BRAIN/core/skills/zzprobeskill/SKILL.md" ]

  # PROJECTION ACTUALLY LANDS (the fix): the claude skill symlink exists AND
  # resolves to the runtime-brain canonical source (NOT a phantom success).
  [ -L "$HOME/.claude/skills/zzprobeskill" ]
  [ -f "$HOME/.claude/skills/zzprobeskill/SKILL.md" ]
  local resolved
  resolved="$(cd "$HOME/.claude/skills/zzprobeskill" && pwd -P)"
  [ "$resolved" = "$(cd "$CORE_BRAIN/core/skills/zzprobeskill" && pwd -P)" ]

  # The one-step success line is printed and reports a drift-clean projection.
  [[ "$output" == *"Added core skill 'zzprobeskill'"* ]]
  [[ "$output" == *"drift-clean"* ]]
}

@test "add --core mcp: PROJECTS the entry into the live config against the brain root, exit 0" {
  skip "FR-212d: skills/MCP add now delegate (skills CLI / add-mcp); round-trip covered by fr212-smoke + remove.test.ts"
  build_core_checkout

  run "${IGRIS_BIN[@]}" add --core mcp zzprobemcp \
    --command echo --arg hi --target claude:merge --project-root "$CORE_REPO"
  echo "status=$status output=$output" >&2
  [ "$status" -eq 0 ]
  [[ "$output" == *"CORE mode"* ]]

  # MATERIALIZE: the surfaces.mcp_servers block landed in BOTH the checkout
  # surfaces-manifest and the runtime-brain mirror.
  grep -q "zzprobemcp" "$CORE_REPO/core/scripts/cli-adapters/surfaces-manifest.json"
  grep -q "zzprobemcp" "$CORE_BRAIN/core/scripts/cli-adapters/surfaces-manifest.json"

  # PROJECTION ACTUALLY LANDS (the fix + the projector core-surfaces union): the
  # MCP entry merged into the live claude config.
  [ -f "$HOME/.claude.json" ]
  python3 -c "import json; d=json.load(open('$HOME/.claude.json')); assert 'zzprobemcp' in d['mcpServers']; assert d['mcpServers']['zzprobemcp']['command']=='echo'"

  [[ "$output" == *"Added core MCP 'zzprobemcp'"* ]]
  [[ "$output" == *"drift-clean"* ]]
}

@test "add --core hook: writes the shared script + surfaces block + PROJECTS against the brain root, exit 0" {
  build_core_checkout
  # The core hook needs a core/hooks/shared dir in BOTH the checkout + the brain.
  mkdir -p "$CORE_REPO/core/hooks/shared" "$CORE_BRAIN/core/hooks/shared"

  run "${IGRIS_BIN[@]}" add --core hook zzprobehook \
    --event PostToolUse --project-root "$CORE_REPO"
  echo "status=$status output=$output" >&2
  [ "$status" -eq 0 ]
  [[ "$output" == *"CORE mode"* ]]

  # MATERIALIZE: the shared script + the surfaces.hooks block landed in BOTH the
  # checkout and the runtime-brain mirror.
  [ -x "$CORE_REPO/core/hooks/shared/PostToolUse.sh" ]
  [ -x "$CORE_BRAIN/core/hooks/shared/PostToolUse.sh" ]
  grep -q "zzprobehook" "$CORE_REPO/core/scripts/cli-adapters/surfaces-manifest.json"
  grep -q "zzprobehook" "$CORE_BRAIN/core/scripts/cli-adapters/surfaces-manifest.json"

  # PROJECTION ACTUALLY LANDS: the core hook command merged into the brain
  # project's settings.json (projection runs against the BRAIN ROOT).
  [ -f "$CORE_BRAIN/.claude/settings.json" ]
  python3 -c "import json; d=json.load(open('$CORE_BRAIN/.claude/settings.json')); cmds=[h['command'] for g in d['hooks']['PostToolUse'] for h in g['hooks']]; assert '\$HOME/.igris/core/hooks/shared/PostToolUse.sh' in cmds, cmds"

  [[ "$output" == *"Added core hook 'zzprobehook'"* ]]
  [[ "$output" == *"drift-clean"* ]]
}
