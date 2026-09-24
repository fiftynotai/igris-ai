# signature-gate fixtures (TD-470)

Message files for `test/commit_signature_gate.test.bash`. They are commit
MESSAGE FILES handed to the hook as `$1`, never commit messages of this repo.

## Provenance

Each `igris-ai-<sha7>.msg` is the raw message of an igris-ai commit,
byte-for-byte: everything after the first blank line of `git cat-file commit`
(not `git log --format=%B`, which appends a newline). Taken 2026-09-24:

```bash
python3 - <<'PY'
import subprocess
for sha in ["4aaaf8e", "116346f", "40ff64d", "e6deaee", "b3df736"]:
    raw = subprocess.check_output(["git", "cat-file", "commit", sha])
    open(f"test/fixtures/signature-gate/igris-ai-{sha}.msg", "wb").write(raw.split(b"\n\n", 1)[1])
PY
```

| file | role | what it carries |
|---|---|---|
| `igris-ai-4aaaf8e.msg` | RED (SG1) | the newest of this repo's 16 signed commits (2025-12-03): a `Co-Authored-By: Claude <noreply@anthropic.com>` trailer and a `Generated with [Claude Code](…)` line led by U+1F412 (a monkey), NOT the robot U+1F916 Claude Code 2.1.281 emits. A robot-only S2a would have missed this line, so S2a takes the emoji plane |
| `igris-ai-116346f.msg` | RED (SG1b) | a robot-emoji signed commit (2025-10-14) |
| `igris-ai-40ff64d.msg` | control (SC13a) | quotes the standard mid-line in body prose ("no 'Generated with…', no Co-Authored-By tags") |
| `igris-ai-e6deaee.msg` | control (SC13b) | names `Co-Authored-By` in its SUMMARY; the summary is 81 chars (it predates TD-180), so SC13b runs it through a hook copy with only the length limit lifted |
| `igris-ai-b3df736.msg` | control (SC13c) | a bullet quoting `'Generated with Claude Code'` |

`TD-470.md` is `brief_files.content` for igris-ai TD-470, read-only from the
brain (python `sqlite3`, `mode=ro`), `cmp`-identical to the brief cache
`~/.igris/projects/igris-ai/briefs/TD-470.md` at snapshot time. It is the
SC7 control: a body that discusses both shapes at length must pass.

None of these files is edited. A new case gets a new file.

## Measured before the gate was written (2026-09-24, git 2.50.1)

`git interpret-trailers --parse` on the plan's P4 shapes:

| message tail | co-author trailers git reports |
|---|---|
| `closes #FR-1` then `Co-Authored-By: Claude <noreply@anthropic.com>`, one paragraph | 0 |
| the same two lines in the reverse order | 0 |
| the trailer alone as the last paragraph | 1 |
| `Co-authored-by: Claude` (key only), last paragraph | 1 |
| `Co-authored-by : x <x@y.z>` (space before the colon) | 1 (git normalises the key) |
| a co-author paragraph, then a separate `closes #FR-1` paragraph | 0 |
| a col-0 `Co-Authored-By: tags are …` line in a MIDDLE paragraph | 0 |

The first and sixth rows are why S1b reads the identity form anywhere. SO1
pins "git reports a trailer => the gate refuses" over every case, plus the one
deliberate superset (SG5).

## RED at HEAD (8c95fe3), before the gate existed

`bats test/commit_signature_gate.test.bash` against HEAD's hook: **21 not ok /
12 ok of 33**. The 12 green were the designed controls: SC1-SC13 (9 tests)
plus SB1, SB3 and SB4. Every SG case failed on `expected exit 1, got 0`; SB2,
SB5, SM1 and SO1 failed for the same reason, and SN1-SN5 failed because the
block and anchors they delete did not exist yet.

## First refusal of the gate on a real message (repo copy, empty HOME)

```
$ HOME=<empty> /bin/bash scripts/git-hooks/commit-msg test/fixtures/signature-gate/igris-ai-4aaaf8e.msg; echo "exit=$?"

[commit-msg] TD-470 signature gate: refusing an AI signature in the commit message

SIGNATURE-GATE: co-author: Co-Authored-By: Claude <noreply@anthropic.com>
SIGNATURE-GATE: generated-with: 🐒 Generated with [Claude Code](https://claude.com/claude-code)

  core/os/standards.md: no "Generated with" line, no Co-authored-by trailer.
  Remove the line(s) above; to QUOTE one in a body, indent it.

  One-shot bypass, e.g. for a genuine human pair (leaves a trail in this
  terminal, never export it):
    IGRIS_BYPASS_SIGNATURE_GATE=1 git commit ...

exit=1
```

## False-positive sweep before review (a read-only pre-check, not the A/B)

The working-tree hook with only its length limit lifted, `env -i
HOME=<empty> PATH=/usr/bin:/bin /bin/bash`, over every commit message reachable
by `git rev-list --all`:

| repo | messages | refused | of those, git also parses a co-author trailer |
|---|---|---|---|
| igris-ai | 872 | 16 | 16 (exactly the 16 signed commits) |
| five registered clones, read-only (moca-ai-agent, mbrgea-ai, moca-hadir-app, moca-agent-flutter-client, moca-hr-agent) | 870 | 32 | 31 |

The one refusal git does not see is a real signed paragraph placed above later
paragraphs (the SG6 shape). Not one message that git parses as carrying a
co-author trailer passed the gate. The clone contents are client data and
are not reproduced here.
