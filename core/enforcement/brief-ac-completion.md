---
obligation: "A brief must not be closed with an acceptance criterion left unmet and unrecorded"
mechanism: gate
status: shipped
lives_in: "scripts/git-hooks/commit-msg"
summary: "TD-325 three-layer AC gate. One shared parser (core/scripts/brief_ac_check.sh) is read by /hunt (authoring), the commit-msg hook (HARD-FAIL on a closes-footer commit whose brief still has an open criterion) and a WARN validator plus a brain sync-note (the accumulation net). Deferral is explicit: a [~] box carrying DEFERRED and a follow-up brief id. One-shot escape via IGRIS_BYPASS_AC_GATE."
---

# Acceptance-criteria completion (TD-325)

A brief could reach `status=Done` / `phase=COMPLETE` with every acceptance
criterion still `- [ ]`. Nothing read them: not the phase guard, not the commit
gate, not `/hunt`'s COMMITTING step. The cognition `gap` detector reported it
faithfully from 2026-04-29 and was read as noise for twelve weeks, by which
point 388 terminal `igris-ai` briefs FAIL the parser — 386 carrying an open criterion, plus 2 whose `- [~]` deferral is malformed (no reason or no follow-up), which is a different defect.

## The three layers, and what each does not cover

| # | layer | surface | posture | does NOT cover |
|---|---|---|---|---|
| L1 | authoring | `core/skills/hunt/SKILL.md` (Phase 5 step 0, warden prompt, Phase 7 step 0) | stop-and-resolve | a close outside `/hunt`; a direct MCP sync; `/archive` |
| L2 | mechanical | `scripts/git-hooks/commit-msg` | **HARD-FAIL** | a close with NO commit; `--no-verify`; a checkout without hooks; **the `NO_ITEMS` / `NO_AC` class** (see below) |
| L3 | observer | `acGateNote` in `brain-mcp-server/src/tools/briefs.ts` + `scripts/validate_brief_ac_completion.sh` | informs, never rejects | nothing — it is the net |

**THE `NO_ITEMS` / `NO_AC` CLASS EXITS 0 AND IS THEREFORE UNGATED — stated here
because this table is the canonical answer to "what does the gate not cover".**
A brief whose AC block holds no parseable checkbox (`NO_ITEMS`) or which has no
AC heading at all (`NO_AC`) passes L2, and is excluded from L3's `--list`.
Measured on `igris-ai`: **26 of 447** terminal briefs, criteria written as prose
(FR-120 is the archetype — a plain numbered list with no boxes).

This is deliberate, not an oversight: their remedy is rewriting the criteria as
`- [ ]` items so they come under the gate at all, which is a different job from
ticking a box. TD-075 owns that sub-population and dispositions it separately.
The verdict labels exist precisely so the class is COUNTABLE rather than
silently folded into PASS — `NO_ITEMS` was added after a hyphen-only parser
draft turned 32 briefs into a `total=0` verdict earned by parsing nothing.

The residual hole is stated rather than hidden: a brief closed by a direct
`igris_brief_sync(status='Done')` with no commit is refused by nothing. It is
*reported* by L3 at the moment of the sync and again by the validator on the
next brief-state commit.

## Why the refusal is not in the brain

Both of `/hunt`'s terminal syncs run **after** the commit has landed (Phase 7:
COMMITTING → `git commit` → status=Done → sync; Phase 8: sync phase=COMPLETE).
A rejecting brain-level gate cannot un-close anything — it can only refuse to
record something already true. Keyed on `status` it leaves a landed commit with
the store saying open (contradiction C3); keyed on `phase='COMPLETE'` it
manufactures C1, the contradiction TD-257 shipped that second sync to eliminate,
and TD-311 then forbids resolving C1 by editing brief data. Either key makes the
store less truthful. So the brain gets the observer role — the shipped
`nonCanonical*Note` pattern — and the refusal moves upstream of the commit.

`commit-msg` is the only hook that sees the message, and the closing commit is
**defined** by its `closes #<ID>` footer, so the gate needs no phase heuristic:
a WIP commit has no footer and is untouched. It is also free of
`IGRIS_BYPASS_PHASE_GUARD`, which `/hunt` sets on the exact commit that must be
gated — a check inside the pre-commit phase guard would be bypassed by
construction on every close.

## The three box states

```
- [ ]   open      — neither met nor consciously deferred
- [x]   ticked    — met, and VERIFIED
- [~]   deferred  — knowingly unmet, WITH a DEFERRED reason and a follow-up brief
```

`[ ]`→`[x]` and `[ ]`→`[~]` are both a one-character edit. That symmetry is
load-bearing: if deferring cost more keystrokes than ticking, the gate would
breed false ticks and be worse than no gate. The refusal message prints the
paste-ready deferral form first for the same reason.

The syntax is not invented — `FR-241` shipped with its eighth criterion
deliberately unmet, recorded as `- [~]`, and that line is the source of the
convention.

## The part no gate can enforce

**A tick asserts verified evidence. A deferral asserts the absence of it.** Both
are new information; neither rewrites a recorded state, which is why ticking a
box on genuinely-complete work is a record correction rather than the state edit
TD-311 forbids. But a tick made *without* per-criterion verification invents the
evidence, and that IS the forbidden move. No regex can detect one, so
tick-evidence is a review-layer obligation: a warden review item and a §17
checklist row. The retroactive sweep (TD-075) must be per-brief, per-criterion,
evidence-cited — never a bulk UPDATE, never a `sed`.

## Escape hatch

`IGRIS_BYPASS_AC_GATE=1 git commit ...` — one-shot, never `export`ed, same
posture as `IGRIS_BYPASS_PHASE_GUARD` and `IGRIS_BYPASS_BRIEF_GATE`.
