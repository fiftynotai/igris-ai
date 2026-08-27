---
obligation: "Every ceremony (/boot, /rest, /register, /hunt INIT) is bracketed by brain-timed start/stop stamps written by a verb, never by prose"
mechanism: gate
status: shipped
lives_in: "scripts/validate_ceremony_sites.sh + cli/src/lib/kpi-read.ts (the unpaired observer: ceremony_coverage + buildAlarm; rendered by cli/src/verbs/kpi.ts)"
summary: "FR-268 ceremony-stamp coverage. Two layers. L1 authoring — scripts/validate_ceremony_sites.sh HARD-FAILS in pre-commit when any of core/skills/{boot,rest,register,hunt}/SKILL.md loses its `igris ceremony start|stop --name <n>` pair, names the wrong ceremony, moves the start below the skill's first executable step or the stop above its last (heading-anchored), or lets a site land inside an igris_agent_event window. L2 runtime — `igris kpi` reports ceremony starts without a stop as `unpaired` per project-week, and /scan renders that count on its one KPI line; there is no commit to refuse at a ceremony, so this layer is an OBSERVER, not a refusal. Does NOT cover: an orchestrator that skips the stamp lines at runtime (surfaces only as unpaired / missing counts a week later), --no-verify, a checkout without hooks, and a brain older than instances v4 (the verb degrades with the cause named; the record has a gap)."
---

# Ceremony-stamp coverage (FR-268)

`igris ceremony start|stop --name <boot|rest|register|hunt-init>` is the
carrier of the ceremony record (`ceremony_events`, instances migration v4):
one brain-timed `start`/`stop` pair per ceremony run, keyed to the project
and the host. Per-skill invocation telemetry was dropped in June 2026
(FR-202 M7) because it was prose the orchestrator was asked to emit, and
prose is not a control (L-1314; FR-267 measured prose emission at 31 %).
This obligation replaces the prose with a verb the skill CALLS as its first
and last executable step, and a control that fails when the call is lost.

## The two layers, and what each does not cover

| # | layer | surface | posture | does NOT cover |
|---|---|---|---|---|
| L1 | authoring | `core/skills/{boot,rest,register,hunt}/SKILL.md` (one start + one stop site each) + `scripts/validate_ceremony_sites.sh` (HARD-fail in `pre-commit` when any of the four is staged; bats twin `test/validate_ceremony_sites.test.bash`) | stop-and-fix | an orchestrator that does not run the line at runtime; `--no-verify`; a checkout without hooks |
| L2 | runtime observer | `igris kpi` — KPI 7's coverage rows (`starts`, `stops`, `unpaired`, `unpaired_stops` per project-week) and the `/scan` line's `unpaired N` | **OBSERVER** — reports, never refuses | anything before the next reading; a brain older than instances v4 (the verb degrades, the record has a gap — the cause is named in the verb's `skipped[]`) |

There is deliberately no refusal at runtime: a ceremony has no commit to
refuse, and a stamp that could block `/boot` would be a worse defect than a
gap in the series. The gap is made visible instead.

## What the validator reads

The rule table in `scripts/validate_ceremony_sites.sh` (one row per skill:
directory, ceremony name, heading anchors). Anchors are headings and marker
lines, never line numbers — renaming an anchored heading reds the gate,
which is intended: a renamed anchor IS a moved contract, and the fix is the
rule table in the same commit.

## Red-first

Run on the un-edited skills before the stamps landed (2026-08-27 UTC):
`FAIL: 4 skills, 0 sites, 8 violation(s)` — every skill named with
`no start site` and `no stop site`. After the edits: `OK: 4 skills, 8 sites`.
The bats twin mutates a scratch copy of the real tree per case and asserts
the mutation landed before asserting red.

## Escape hatch

None. Unlike the closing-commit gates there is no `IGRIS_BYPASS_*` for this
validator: the only way past it is to fix the skill, because there is no
legitimate commit that ships a ceremony skill without its pair. `--no-verify`
remains the generic hatch and is listed above as uncovered.

## Consumers

`core/os/conduct.md` (the obligations point to this registry) ·
`docs/reference/os-kpis.md` (the record, the KPIs, the residuals) ·
`cli/src/verbs/ceremony.ts` (the allowlist — adding a ceremony is a verb
edit + one skill pair + one validator row, never a migration).
