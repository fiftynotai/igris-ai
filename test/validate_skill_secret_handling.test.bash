#!/usr/bin/env bats
source "${BATS_TEST_DIRNAME:-$(dirname "${BASH_SOURCE[0]}")}/require_bats.bash" || exit 2
# validate_skill_secret_handling.test.bash - Tests for
#   scripts/validate_skill_secret_handling.py (TD-492).
#
# The recurrence net for skill text that puts a secret into the transcript:
# a secret named as a tool argument or CLI flag (rule S), or config.json named
# outside a recognised form (rule C, fail-closed).
#
#   real_tree_passes   the validator over the real skills exits 0.
#   R1-R3              red-first on REAL past text, quoted verbatim from git:
#                      /boot's pre-TD-492 lines (HEAD before this brief),
#                      /rest's pre-TD-489 drain step (eb6c9b8^) and its
#                      pre-TD-350 push step (d4e6a97^).
#   C1-C16             rule C: planted reads fail, the real forbid and
#                      cli-self lines pass, near-misses fail, the ledger
#                      subtracts and counts, headings and table rows count,
#                      a negation or cli-self must govern EACH mention, other
#                      files (`tsconfig.json`) are not the config, conditions
#                      and exceptions void a forbid, emphasis and the wider
#                      negations are read, a key path counts, an
#                      `allowed-tools:` grant counts, a condition opening the
#                      next clause voids a forbid, negated open/cat verbs are
#                      forbids, and a second subject breaks cli-self.
#   S1-S10             rule S: strong forms on any line (blank lines,
#                      headings and sibling steps hide nothing), weak forms
#                      at a tool site, quoted and kebab keys, flags, the
#                      wider vocabulary, bold names, handing-over verbs, brace
#                      lists, an HTTP auth header, and the negatives
#                      (`input_tokens`, `cache_key`, token counts, sample
#                      results, forbids, glossary labels, type annotations).
#   B1                 /boot reads remote-brain presence from detect and
#                      records the no-drain decision.
#   E1 / E2            setup errors exit 2.
#   M1-M11             mutation controls: each named line of the validator,
#                      broken, turns a test above the other colour.
#
# Fixtures go under a scratch skills root through SKILL_SECRETS_SCAN_ROOT;
# the real tree is never written.

load test_helper

setup() {
  VALIDATOR="$IGRIS_ROOT/scripts/validate_skill_secret_handling.py"
  [ -x "$VALIDATOR" ] || skip "validator missing or not executable at $VALIDATOR"
  SCRATCH="$TEST_TEMP_DIR/skill_secrets_$BATS_TEST_NUMBER"
  ROOT="$SCRATCH/core/skills"
  mkdir -p "$ROOT"
}

teardown() {
  [ -d "${SCRATCH:-}" ] && rm -rf "${SCRATCH:?}"
  cleanup_test_temp_dir
}

# plant <skill> — write stdin to <ROOT>/<skill>/SKILL.md
plant() {
  mkdir -p "$ROOT/$1"
  cat > "$ROOT/$1/SKILL.md"
}

# scan [validator] — run a validator over the fixture root
scan() {
  run env SKILL_SECRETS_SCAN_ROOT="$ROOT" python3 "${1:-$VALIDATOR}"
}

# mutant <old> <new> — a copy of the validator with ONE literal replaced,
# beside a copy of the helper module it imports. Fails if the anchor is not
# found exactly once, so a mutation that did not land cannot pass silently.
mutant() {
  mkdir -p "$SCRATCH/mut"
  cp "$IGRIS_ROOT/scripts/validate_skill_required_args.py" "$SCRATCH/mut/"
  python3 - "$VALIDATOR" "$SCRATCH/mut/validate_skill_secret_handling.py" "$1" "$2" <<'PY'
import sys
src, dst, old, new = sys.argv[1:]
text = open(src).read()
n = text.count(old)
if n != 1:
    sys.exit(f"mutation anchor found {n} times, expected 1: {old!r}")
open(dst, "w").write(text.replace(old, new))
PY
  MUTANT="$SCRATCH/mut/validate_skill_secret_handling.py"
}

# --- fixtures quoted from real past text -------------------------------------

plant_boot_pre_td492() {
  plant boot <<'MD'
# boot

**Always-needed files** (boot mechanics, not context modules):
- `<detect.brain_root>/config.json` - Remote brain URL and API key

**Degradation:** if `<detect.brain_root>/core/os/INDEX.md` is absent, fall back to reading `<detect.brain_root>/core/SOUL.md` + `<detect.brain_root>/USER.md` + `<detect.brain_root>/config.json`, display one short degraded-context notice, and continue — never block session start.

If `auto_approve_enabled=true` is set in `<detect.brain_root>/config.json`'s `perception`
section, the background extractor inserts new rows as `approved` directly
and they bypass this surface — they appear in `recall`/`search` immediately
without operator review. Default is opt-in (off).
MD
}

plant_rest_pre_td350_push() {
  plant rest <<'MD'
# rest

If the `igris-brain` MCP server is available AND a remote brain URL is configured:
- Read `~/.igris/config.json` to check for `remote_brain.url` and `remote_brain.api_key`
- If both are present, call `igris_brain_push` with:
  - remote_url = the configured URL
  - api_key = the configured API key
- Display sync result summary (e.g., "Pushed 3 learnings, 1 error, 2 sessions to remote brain")
MD
}

plant_rest_pre_td489_drain() {
  plant rest <<'MD'
# rest

In that case, if a remote brain URL is configured:
- Read `~/.igris/config.json` to check for `remote_brain.url` and `remote_brain.api_key`
- If both are present, call `igris_sync_queue_drain` with:
  - remote_url = the configured URL
  - api_key = the configured API key
- Display the count of drained operations if any were processed
MD
}

# The same drain step with its config.json line removed: rule S alone.
plant_drain_args_only() {
  plant rest <<'MD'
# rest

In that case, if a remote brain URL is configured:
- If both are present, call `igris_sync_queue_drain` with:
  - remote_url = the configured URL
  - api_key = the configured API key
MD
}

# =============================================================================

@test "real_tree_passes: the validator over the real skills exits 0" {
  run python3 "$VALIDATOR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"OK: no secret argument and no unclassified config.json mention"* ]]
}

@test "R1 red-first: /boot's pre-TD-492 lines fail, all three" {
  plant_boot_pre_td492
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 3 secret-handling problem(s)"* ]]
  [[ "$output" == *"boot/SKILL.md:4  config.json named outside a recognised form"* ]]
  [[ "$output" == *"boot/SKILL.md:6  config.json named outside a recognised form"* ]]
  [[ "$output" == *"boot/SKILL.md:8  config.json named outside a recognised form"* ]]
}

@test "R2 red-first: /rest's pre-TD-489 drain step fails on both rules" {
  plant_rest_pre_td489_drain
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 2 secret-handling problem(s)"* ]]
  [[ "$output" == *"rest/SKILL.md:7  secret argument \`api_key\` (name: / name=)"* ]]
  [[ "$output" == *"rest/SKILL.md:4  config.json named outside a recognised form"* ]]
}

@test "R3 red-first: /rest's pre-TD-350 push step fails on both rules" {
  plant_rest_pre_td350_push
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 2 secret-handling problem(s)"* ]]
  [[ "$output" == *"rest/SKILL.md:7  secret argument \`api_key\` (name: / name=)"* ]]
  [[ "$output" == *"rest/SKILL.md:4  config.json named outside a recognised form"* ]]
}

@test "C1 planted: a prose read and a fenced read of config.json both fail" {
  plant prose <<'MD'
Read `~/.igris/config.json` for the remote brain URL.
MD
  plant fenced <<'MD'
```bash
cat ~/.igris/config.json | jq .remote_brain
```
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 2 secret-handling problem(s)"* ]]
  [[ "$output" == *"prose/SKILL.md:1"* ]]
  [[ "$output" == *"fenced/SKILL.md:2"* ]]
}

@test "C2 controls: the real forbid and cli-self sentences pass, wrapped ones included" {
  plant rest <<'MD'
- the BRAIN-SIDE `sync_queue` TABLE on the remote host — rows from previously failed pushes — drained by the `igris_sync_queue_drain` call the CLI makes for you (phase 2), reading `remote_brain.url` and `remote_brain.api_key` out of `~/.igris/config.json` itself.

When `remote_brain` is configured, run the CLI verb. It reads `remote_brain.url` and `remote_brain.api_key` from `~/.igris/config.json` itself and takes no key argument — so never read, pass or print the key in this step (TD-489):

You MUST push when remote brain is configured. This is NOT optional — the VPS brain depends on receiving data. Run the CLI verb, which reads `remote_brain.url` and `remote_brain.api_key` from `~/.igris/config.json` itself and takes no key argument — so never read, pass or print the key in this step (TD-350):
MD
  plant boot <<'MD'
Run the deterministic verb and render its output. Do NOT read `config.json` and
do NOT run SQL here: the digest already resolves each instance's declared gate.

the resolution of the instance's own declared `gate_keys`, which is
`cognition.subconscious.enabled` — read it from the digest rather than
re-reading `config.json`, so a gate that moves brain-side sweeps itself.) When
the digest is `degraded`, treat as `false`.
MD
  scan
  [ "$status" -eq 0 ]
  [[ "$output" == *"(5 config sentence(s) classified"* ]]
}

@test "C3 near-misses: words before the verb, a bare not, and 'itself' with no CLI all fail" {
  plant forget <<'MD'
Do not forget to read `config.json` before syncing.
MD
  plant barenot <<'MD'
It is not read here; read `~/.igris/config.json` instead.
MD
  plant itself <<'MD'
Read `~/.igris/config.json` itself.
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 3 secret-handling problem(s)"* ]]
}

@test "C4 ledger: a ledgered sentence is subtracted, and a second copy fails the count" {
  plant igris-doctor <<'MD'
- `bridge-missing` — records the named harness in `config.json#cli_targets` and
  backfills the brain MCP; never `init`, never a core replace (BR-103)
MD
  scan
  [ "$status" -eq 0 ]

  cat >> "$ROOT/igris-doctor/SKILL.md" <<'MD'

- `bridge-missing` — records the named harness in `config.json#cli_targets` and
  backfills the brain MCP.
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"[ledger count exceeded]"* ]]
}

@test "C5 a ledger needle in ANOTHER skill is not subtracted" {
  plant elsewhere <<'MD'
- `bridge-missing` — records the named harness in `config.json#cli_targets` and
  backfills the brain MCP.
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"elsewhere/SKILL.md:1"* ]]
}

@test "C6 a heading and a table row naming config.json each count" {
  plant shapes <<'MD'
## Reading config.json

| file | holds |
|---|---|
| `~/.igris/config.json` | the remote brain URL and key |
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 2 secret-handling problem(s)"* ]]
  [[ "$output" == *"shapes/SKILL.md:1"* ]]
  [[ "$output" == *"shapes/SKILL.md:5"* ]]
}

@test "C7 a negation must govern the mention: a later read in the sentence fails" {
  plant andcat <<'MD'
Do not read logs and cat `config.json`.
MD
  plant thenread <<'MD'
Do not read the log, then read `config.json`.
MD
  plant semicolon <<'MD'
Never read the digest; read `config.json` instead.
MD
  plant governed <<'MD'
Never read or edit `config.json` yourself (it holds the remote brain's API key).
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 3 secret-handling problem(s)"* ]]
  [[ "$output" != *"governed/SKILL.md"* ]]
}

@test "C8 cli-self must cover EACH mention: a second, plain read fails" {
  plant twice <<'MD'
The CLI reads `config.json` itself, then you read `config.json`.
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"twice/SKILL.md:1"* ]]
}

@test "C9 other files are not the config: tsconfig.json, my-config.json, config.jsonc" {
  plant others <<'MD'
Read `tsconfig.json`, `my-config.json` and `config.jsonc` before building.
MD
  scan
  [ "$status" -eq 0 ]
  [[ "$output" == *"(0 config sentence(s) classified"* ]]
}

@test "C10 a condition or exception voids a forbid" {
  plant unless <<'MD'
Do not read `config.json` unless the CLI fails.
MD
  plant except <<'MD'
Do not read anything under ~/.igris except `config.json`.
MD
  plant ifyou <<'MD'
If you do not read `~/.igris/config.json` first, you will not know the URL.
MD
  plant ratherthan <<'MD'
Rather than reading the brain DB, take the URL from `config.json`.
MD
  plant ifdown <<'MD'
If the brain is down, do not read `config.json`.
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 4 secret-handling problem(s)"* ]]
  [[ "$output" != *"ifdown/SKILL.md"* ]]
}

@test "C11 emphasis, 'avoid reading', 'never reads', 'ever' and a chained mention are forbids" {
  plant bold <<'MD'
- **NEVER** read `config.json`: it holds the key.
MD
  plant avoid <<'MD'
Avoid reading `config.json`.
MD
  plant reads <<'MD'
The agent never reads `config.json`.
MD
  plant ever <<'MD'
Don't ever read `config.json`.
MD
  plant chained <<'MD'
Never read `config.json` (`~/.igris/config.json`).
MD
  scan
  [ "$status" -eq 0 ]
  [[ "$output" == *"(5 config sentence(s) classified"* ]]
}

@test "C12 a key path read by name fails; inside a cli-self sentence it passes" {
  plant keypath <<'MD'
Read the `remote_brain.url` and `remote_brain.api_key` values to connect.
MD
  plant clikey <<'MD'
Run the CLI verb. It reads `remote_brain.url` and `remote_brain.api_key` from `~/.igris/config.json` itself.
MD
  plant jq <<'MD'
```bash
jq -r '.remote_brain.api_key' "$cfg"
```
MD
  plant designtoken <<'MD'
Set `theme.token` in the design JSON.
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 2 secret-handling problem(s)"* ]]
  [[ "$output" == *"keypath/SKILL.md:1"* ]]
  [[ "$output" == *"jq/SKILL.md:2"* ]]
}

@test "C13 an allowed-tools grant and an escaped dot count; config.json.example does not" {
  plant grant <<'MD'
---
name: grant
description: x
allowed-tools:
  - Read(~/.igris/config.json)
---
# grant
MD
  plant escaped <<'MD'
Open ~/.igris/config\.json and look.
MD
  plant example <<'MD'
Copy `config.json.example` when onboarding a teammate.
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 2 secret-handling problem(s)"* ]]
  [[ "$output" == *"grant/SKILL.md:5"* ]]
  [[ "$output" == *"escaped/SKILL.md:1"* ]]
}

@test "C14 a condition opening the next clause voids a forbid; an alternative does not" {
  plant comma <<'MD'
Do not read `config.json`, unless the CLI fails.
MD
  plant paren <<'MD'
Never read `config.json` (unless the CLI is down).
MD
  plant dash <<'MD'
Never read `config.json` - except when the doctor asks.
MD
  plant butuse <<'MD'
Do not read `config.json`, but use `igris detect` for the remote flag.
MD
  plant instead <<'MD'
Never read `config.json`; instead run `igris detect`.
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 3 secret-handling problem(s)"* ]]
  [[ "$output" != *"butuse/SKILL.md"* ]]
  [[ "$output" != *"instead/SKILL.md"* ]]
}

@test "C15 negated open, cat, print and parsing verbs are forbids" {
  plant open <<'MD'
Do not open `config.json`.
MD
  plant cat <<'MD'
Never `cat` `~/.igris/config.json`.
MD
  plant print <<'MD'
Never print `config.json` into the chat.
MD
  plant parsing <<'MD'
Avoid parsing `config.json`.
MD
  scan
  [ "$status" -eq 0 ]
  [[ "$output" == *"(4 config sentence(s) classified"* ]]
}

@test "C16 a second subject breaks cli-self" {
  plant joined <<'MD'
It reads the digest, and you read `config.json` itself.
MD
  plant you <<'MD'
`igris x` reads the url and you read `config.json` itself.
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 2 secret-handling problem(s)"* ]]
}

@test "S1 planted: an api_key argument under a call fails (no config.json line needed)" {
  plant_drain_args_only
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 1 secret-handling problem(s)"* ]]
  [[ "$output" == *"rest/SKILL.md:6  secret argument \`api_key\` (name: / name=)"* ]]
}

@test "S2 a fenced call body (camelCase) and an mcp__ tool (compound name) both fail" {
  plant store <<'MD'
Store it — call:

```
igris_memory_store({ project: "x", apiKey: "<key>" })
```

Then call `mcp__github__auth` with access_token=<token>.
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"store/SKILL.md:4  secret argument \`apiKey\`"* ]]
  [[ "$output" == *"store/SKILL.md:7  secret argument \`access_token\`"* ]]
}

@test "S3 a secret-carrying CLI flag fails, in a fence or in prose" {
  plant flags <<'MD'
```bash
igris sync push --api-key "$KEY"
```

Or pass `--access-token` to the helper.
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 2 secret-handling problem(s)"* ]]
  [[ "$output" == *"secret-carrying flag \`--api-key\`"* ]]
  [[ "$output" == *"secret-carrying flag \`--access-token\`"* ]]
}

@test "S4 negatives: token counts, a dotted config key and plain flags pass" {
  plant hunt <<'MD'
- Call `igris_agent_event` with event_type="stop"; add `model_resolved` and the four token counts (`input_tokens`, `output_tokens`) when the harness reports them.
- The CLI reads `remote_brain.api_key` from `~/.igris/config.json` itself; `igris_sync_queue_drain` never gets it from you.
- Run `igris sync push --dry-run` and `igris sync push --project x`.
MD
  scan
  [ "$status" -eq 0 ]
  [[ "$output" == *"0 secret site(s)"* ]]
}

@test "S5 a quoted JSON key and a kebab-case key at a call site both fail" {
  plant json <<'MD'
```json
{"tool": "igris_sync_push", "arguments": {"remote_url": "u", "password": "x"}}
```

Call `igris_brain_push` with:
  api-key: the configured key
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"json/SKILL.md:2  secret argument \`password\` (quoted key)"* ]]
  [[ "$output" == *"json/SKILL.md:6  secret argument \`api-key\` (name: / name=)"* ]]
}

@test "S6 the wider secret vocabulary fails; other *_key names pass" {
  plant vocab <<'MD'
- Call `igris_a` with `passphrase`.
- Call `igris_b` with `credentials`.
- Call `igris_c` with `private_key`.
- Call `igris_d` with `secret_key`.
- Call `igris_e` with `authorization`.
MD
  plant keys <<'MD'
- Call `igris_f` with `cache_key`, `sort_key` and `primary_key`.
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 5 secret-handling problem(s)"* ]]
  [[ "$output" != *"keys/SKILL.md"* ]]
}

@test "S7 strong forms on any line: blank lines, headings and sibling steps hide nothing" {
  plant blank <<'MD'
Call `igris_brain_push` with:

- project: foo
- api_key: abc
MD
  plant heading <<'MD'
## `igris_brain_push`

- `project`
- `api_key`
MD
  plant sibling <<'MD'
1. Call `igris_brain_push`.
2. Pass `api_key`: the remote key.
MD
  plant nextpara <<'MD'
Call `igris_brain_push`.

Pass `api_key` from the environment.
MD
  plant signature <<'MD'
Use `igris_brain_push(project, api_key)` to publish.
MD
  plant label <<'MD'
Call `igris_brain_push` with:
- API key: abc
MD
  plant envvar <<'MD'
```bash
REMOTE_API_KEY=abc igris sync
```
MD
  plant table <<'MD'
Call `igris_brain_push` with these arguments:

| arg | value |
|---|---|
| api_key | abc |
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 8 secret-handling problem(s)"* ]]
  for s in blank heading sibling nextpara signature label envvar table; do
    [[ "$output" == *"$s/SKILL.md:"* ]]
  done
}

@test "S8 negatives: prose about tokens and secrets, sample results, forbids, headers" {
  plant prose <<'MD'
Call `igris_session_sync` with token usage summarised.

Call `igris_memory_store` with credentials redacted from `content`.

Call `igris_memory_store` and tag it `password`.

Call `igris_memory_search` to find prior art. Never paste the token: use the CLI verb instead.

Call `igris_catalog_add` with `name`: `color-token`.
MD
  plant sample <<'MD'
Call `igris_brief_list`; each row looks like:

```json
{"id":"BR-1","token_estimate":120,"secret":false}
```
MD
  plant forbid <<'MD'
Do not use the `--token` flag; use `igris login` instead.

| flag | meaning |
|---|---|
| `--no-token` | skip auth |
MD
  plant header <<'MD'
| Token | Hex | Usage |
|---|---|---|
| `color.primary` | #000 | text |
MD
  scan
  [ "$status" -eq 0 ]
  [[ "$output" == *"0 secret site(s)"* ]]
}

@test "S9 bold names, hand-over verbs, brace lists, auth headers, ungoverned negations and label-shaped calls fail" {
  plant bold <<'MD'
Call `igris_brain_push` with:
- **api_key**: the remote key
MD
  plant quotedpass <<'MD'
Pass "api_key" to `igris_sync_push`.
MD
  plant supply <<'MD'
Supply `api_key` when you call `igris_sync_push`.
MD
  plant brace <<'MD'
Call `igris_sync_push` with { url, api_key }.
MD
  plant header <<'MD'
```bash
curl -H "Authorization: Bearer $K" https://brain.example.invalid/sync
```
MD
  plant rawheader <<'MD'
```http
Authorization: Bearer $KEY
```
MD
  plant notgoverned <<'MD'
When it is not set pass `api_key` to `igris_x`.
MD
  plant notgovernedbare <<'MD'
When it is not set pass api_key to `igris_x`.
MD
  plant labelcall <<'MD'
- Token (pass to igris_x)
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"FAIL: 9 secret-handling problem(s)"* ]]
  for s in bold quotedpass supply brace header rawheader notgoverned notgovernedbare labelcall; do
    [[ "$output" == *"$s/SKILL.md:"* ]]
  done
}

@test "S10 negatives: forbidden hand-overs and flags, glossary labels, type annotations, pwd" {
  plant forbids <<'MD'
Avoid passing `api_key` to a tool.

Do not ever pass `api_key` to a tool.

Don't use the `--token` flag.

Don't pass the token.

Never write `api_key=...` in a command.
MD
  plant glossary <<'MD'
Token: a unit of text the model reads.

- **Password:** the field label on the login screen.

Auth methods:

- Password
- Token
MD
  plant code <<'MD'
```ts
interface Auth { token: string; }
```

```bash
pwd=$(pwd -P)
```
MD
  scan
  [ "$status" -eq 0 ]
  [[ "$output" == *"0 secret site(s)"* ]]
}

@test "B1 /boot reads remote-brain presence from detect and records the no-drain decision" {
  local boot="$IGRIS_ROOT/core/skills/boot/SKILL.md"
  run grep -c "Always-needed files" "$boot"
  [ "$output" = "0" ]
  grep -qF '`detect.remote_brain` is the remote brain'"'"'s presence' "$boot"
  grep -qF "What boot does not drain (TD-492 decision)" "$boot"
  # The degradation fallback no longer names config.json.
  run grep -n "fall back to reading" "$boot"
  [ "$status" -eq 0 ]
  [[ "$output" != *"config.json"* ]]
}

@test "E1 a missing skills root exits 2" {
  run env SKILL_SECRETS_SCAN_ROOT="$SCRATCH/nope" python3 "$VALIDATOR"
  [ "$status" -eq 2 ]
  [[ "$output" == *"skills root not found"* ]]
}

@test "E2 a skills root with no markdown exits 2" {
  scan
  [ "$status" -eq 2 ]
  [[ "$output" == *"no markdown found"* ]]
}

@test "M1 mutation: classify() passing every mention turns R1 green" {
  plant_boot_pre_td492
  mutant '        else:
            return None' '        else:
            verdicts.append("forbid")'
  scan "$MUTANT"
  [ "$status" -eq 0 ]
}

@test "M2 mutation: a bare 'not' as a forbid turns a 'Not reading' sentence green" {
  plant barenot <<'MD'
Not reading `config.json` first is the usual mistake.
MD
  scan
  [ "$status" -eq 1 ]
  mutant 'NEG = (r"(?:(?:do|does|must|should)\s+not|' 'NEG = (r"(?:not|(?:do|does|must|should)\s+not|'
  scan "$MUTANT"
  [ "$status" -eq 0 ]
}

@test "M3 mutation: the site line alone as the window turns a weak-form site green" {
  plant weak <<'MD'
- Call `igris_sync_queue_drain`
  with the remote URL and api_key.
MD
  scan
  [ "$status" -eq 1 ]
  [[ "$output" == *"weak/SKILL.md:1  secret argument \`api_key\` at a igris_sync_queue_drain site"* ]]
  mutant 'window = unbold(h.strip_path_tokens(h.site_window(lines, idx, spans)))' 'window = line'
  scan "$MUTANT"
  [ "$status" -eq 0 ]
}

@test "M4 mutation: a substring secret test turns S4's token counts red" {
  plant hunt <<'MD'
- Call `igris_agent_event` with the four token counts (`input_tokens`, `output_tokens`).
MD
  scan
  [ "$status" -eq 0 ]
  mutant '    return _is_secret_parts([p for p in re.split(r"[_\-\s]+", snake) if p])' \
    '    return any(w in snake for w in SECRET_LAST)'
  scan "$MUTANT"
  [ "$status" -eq 1 ]
}

@test "M5 mutation: dropping the governance gap check turns C7's read-after-negation green" {
  plant andcat <<'MD'
Do not read logs and cat `config.json`.
MD
  scan
  [ "$status" -eq 1 ]
  mutant '        if not RE_FORBID_GAP.match(s[f.end():m.start()]):
            continue' '        pass'
  scan "$MUTANT"
  [ "$status" -eq 0 ]
}

@test "M6 mutation: a bare substring match turns C9's tsconfig.json red" {
  plant others <<'MD'
Read `tsconfig.json` before building.
MD
  scan
  [ "$status" -eq 0 ]
  mutant 'RE_CONFIG = re.compile(r"(?<![A-Za-z0-9_.-])config\\?\.json(?!\.?[A-Za-z0-9_])", re.I)' \
    'RE_CONFIG = re.compile(r"config\.json", re.I)'
  scan "$MUTANT"
  [ "$status" -eq 1 ]
}


@test "M7 mutation: no emphasis normalisation turns a bold NEVER red" {
  plant bold <<'MD'
- **NEVER** read `config.json`: it holds the key.
MD
  scan
  [ "$status" -eq 0 ]
  mutant '    s = re.sub(r"\*\*|__", "", sentence)' '    s = sentence'
  scan "$MUTANT"
  [ "$status" -eq 1 ]
}

@test "M8 mutation: no condition-after guard turns 'unless' green" {
  plant unless <<'MD'
Do not read `config.json` unless the CLI fails.
MD
  scan
  [ "$status" -eq 1 ]
  mutant '    if RE_COND_AFTER.search(tail):
        return True' '    if False:
        return True'
  scan "$MUTANT"
  [ "$status" -eq 0 ]
}

@test "M9 mutation: no table-header skip turns a design-token table red" {
  plant header <<'MD'
| Token | Hex | Usage |
|---|---|---|
MD
  scan
  [ "$status" -eq 0 ]
  mutant '            if form == "table cell" and RE_TABLE_SEP.match(next_line):
                continue' '            pass'
  scan "$MUTANT"
  [ "$status" -eq 1 ]
}


@test "M10 mutation: no next-clause condition check turns ', unless' green" {
  plant comma <<'MD'
Do not read `config.json`, unless the CLI fails.
MD
  scan
  [ "$status" -eq 1 ]
  mutant '    return bool(b) and bool(RE_COND_NEXT.match(rest[b.end():]))' '    return False'
  scan "$MUTANT"
  [ "$status" -eq 0 ]
}

@test "M11 mutation: no glossary-label skip turns 'Token:' red" {
  plant glossary <<'MD'
Token: a unit of text the model reads.
MD
  scan
  [ "$status" -eq 0 ]
  mutant '                continue                 # a glossary label: "Token: a unit of text"' '                pass'
  scan "$MUTANT"
  [ "$status" -eq 1 ]
}
