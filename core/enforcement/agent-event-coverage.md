---
obligation: "A brief must not be closed while a role its Agent Log names has no recorded agent event"
mechanism: gate
status: shipped
lives_in: "scripts/git-hooks/commit-msg"
summary: "FR-267 agent-event coverage gate, §3 of the commit-msg hook. One parser (core/scripts/brief_agent_log_roles.sh) reads the roles a brief's Agent Log names; the hook HARD-FAILS a closes-footer commit when any of them has zero agent_events rows for that brief — predicate: brief_id = the id AND agent = the role AND event_type IN (start, stop, error) AND (project = basename(repo) OR project IS NULL). A role with a start but no stop/error is a WARN unpaired line, not a refusal. One-shot escape via IGRIS_BYPASS_EVENT_GATE, independent of IGRIS_BYPASS_AC_GATE (a bypass of one gate never silences the other). Does NOT cover: a close with no commit, --no-verify, a checkout without hooks, a brain older than the FR-267 schema (no agent_events table, skipped), a bullet-list Agent Log (parses to no roles, nothing demanded), and roles the log does not name."
---

# Agent-event coverage (FR-267)

`igris_agent_event` is the carrier of the hunt-cost record: one `start`/`stop`
pair per agent invocation, brain-timed, brief-keyed. While emission was prose
("you MUST emit"), it was measured at **35 of 112** real invocations since
2026-08-14 and **8 of 18 hunts with zero events** (L-1402). Prose is not a
control (L-1314). This gate is the control: a brief cannot be closed while its
own Agent Log names a role that never emitted.

## The two layers, and what each does not cover

| # | layer | surface | posture | does NOT cover |
|---|---|---|---|---|
| L1 | authoring | `core/skills/hunt/SKILL.md` (every call site, the `## Agent Event Emission` rules, Phase 7 step 0) + `scripts/validate_hunt_agent_event_sites.sh` (the derivation guard over those sites, HARD-fail in `pre-commit`) | stop-and-emit | an orchestrator that names a role in the log and never calls the tool |
| L2 | mechanical | `scripts/git-hooks/commit-msg` §3 | **HARD-FAIL** | a close with NO commit; `--no-verify`; a checkout without hooks; a brain older than the FR-267 schema; a bullet-list Agent Log; roles the log does not name |

There is deliberately **no L3 observer** in this brief: the record it protects
starts at ship time, and the OS-wide roll-up that would read it is FR-268's.
The gap is stated rather than hidden.

## What the gate reads

The Agent Log is the brief's own statement of who worked on it, so the gate
demands nothing the brief did not claim: a phase legitimately skipped (no
architect on an S brief) is not demanded, and a role the log names but no
agent emits for (`fresh-context`, a harness name in the Agent column) is
refused **by name**, so the fix is at the log. `orchestrator`, `user`,
`operator`, `system`, `none`, the dash placeholders and the header cell are
never gated — the orchestrator IS the emitter.

The grammar and its normalization live in ONE file,
`core/scripts/brief_agent_log_roles.sh`, measured over every stored brief
(1,865 on 2026-08-26: 56 parse to roles, 50 are v4 bullet-list logs that
parse to nothing, 1,759 have no log). The hook, the bats suite and any future
audit read that file; a second reader would give the gate and the audit
different populations — the defect TD-325 removed once already.

## The SQL predicate (verbatim from the hook)

```sql
SELECT COUNT(*) FROM agent_events
 WHERE brief_id = '<id>' AND agent = '<role>'
   AND event_type IN ('start','stop','error')
   AND (project = '<basename(repo)>' OR project IS NULL);
```

`0` → the role is MISSING → `EVENT-GATE <id>: VERDICT=FAIL roles=<all>
missing=<m1,m2>` and exit 1. The `project` predicate is applied only when the
column exists (schema v3); NULL-project rows predate the column and count. A
role with a start but no `stop`/`error` prints `WARN unpaired: <role>` — a
crashed agent still ran; its round's duration is NULL, which the record says.

## Red-first

The gate was shown refusing a REAL omission before it was trusted: `FR-256`
(igris-ai, Done 2026-08-14) names architect, forger and sentinel in its Agent
Log and holds zero `agent_events` rows. Its stored content is snapshotted
byte-for-byte at `test/fixtures/event-gate/FR-256.md`; the live refusal is
quoted in `test/fixtures/event-gate/README.md` and pinned by
`test/agent_event_gate.test.bash` (G1), whose G10 control deletes §3 from a
copy of the hook and shows G1 turning green — proof the test exercises the
gate and not something beside it.

## Escape hatch

`IGRIS_BYPASS_EVENT_GATE=1 git commit ...` — one-shot, never `export`ed, same
posture as `IGRIS_BYPASS_AC_GATE`, `IGRIS_BYPASS_PHASE_GUARD` and
`IGRIS_BYPASS_BRIEF_GATE`. It is **independent** of the AC gate's bypass: the
hook's two closing-commit gates share a prelude but each has its own section
skip, so bypassing one never silences the other (before FR-267 the AC bypass
was a bare `exit 0`). It is not the way past a missing event — the healthy
path is to emit the `start`/`stop` pair the role is owed, because that row is
the hunt-cost record.
