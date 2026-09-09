# event-gate fixtures (FR-267)

`FR-256.md` is a byte-for-byte snapshot of `brief_files.content` for the
igris-ai brief FR-256 (status Done, 2026-08-14), taken 2026-08-26 with the
same procedure as `test/fixtures/ac-gate/` (TD-325):

```bash
sqlite3 -readonly ~/.igris/memory/knowledge.db \
  "SELECT content FROM brief_files WHERE project='igris-ai' AND brief_id='FR-256'" \
  > test/fixtures/event-gate/FR-256.md
```

It is the RED-FIRST fixture: its Agent Log names **architect, forger and
sentinel** (plus orchestrator rows, which are never gated) and the brain holds
**zero** `agent_events` rows for it — a real omitted emission, not one written
for the test. The stored brief was NOT edited. The fixture is kept byte-exact
(no header comment inside it) so `cmp` against the brain reproduces it; this
README is the header.

## Live refusal, 2026-08-26 (the first run of the shipped hook, read-only)

```
$ printf 'chore: gate demo\n\ncloses #FR-256\n' > "$SCRATCH/msg"
$ bash scripts/git-hooks/commit-msg "$SCRATCH/msg"; echo "exit=$?"

[commit-msg] FR-267 event gate: refusing to close a brief whose Agent Log names a role with no recorded agent event

EVENT-GATE FR-256: VERDICT=FAIL roles=architect,forger,sentinel missing=architect,forger,sentinel
  every role the Agent Log names must have at least one igris_agent_event
  row (start, stop or error) for this brief — that row IS the hunt-cost
  record. Emit the missing event, or correct the log if it names
  something that is not an agent.

  One-shot bypass (leaves a trail in this terminal, never export it):
    IGRIS_BYPASS_EVENT_GATE=1 git commit ...

exit=1
```

The AC gate (§2) was silent because FR-256's eight criteria are ticked; the
refusal is §3's alone, which is why the bypass hint names only
`IGRIS_BYPASS_EVENT_GATE`. `test/agent_event_gate.test.bash` pins this as G1
in a sandboxed brain, and its G10 control shows the same fixture turning green
when §3 is deleted from a copy of the hook.
