---
obligation: "A stated rationale is a claim, and a claim ships only at the scope it was measured at"
mechanism: gate
status: "shipped on the CLAUDE harness only (review-time gate); NOT reaching codex, gemini or opencode — TD-385; build-time authoring is honor-system on every harness"
lives_in: "core/agents/warden.md (REVIEWING gate — claude harness only until TD-385) + core/os/standards.md (build-time baseline, honor-system)"
summary: "FR-251 / TD-382. The only REVIEW-TIME gate is warden, which REJECTs a finding stated at a scope it was not measured at, and a verification word applied to a set whose members do not all carry that status; Group B (the mutation rules) is discharged by whoever runs the mutation battery, usually sentinel at TESTING. HARNESS SCOPE, measured 2026-08-13: that gate reaches CLAUDE only — the codex, gemini and opencode warden loadout copies carry 0 occurrences of its heading, and validate_harness_drift.sh calls all three MATCH regardless, because it compares projection against loadout and never canonical against loadout (TD-385 closes the gap and removes this caveat). Nothing blocks, warns or lints on ANY harness while the sentence is being WRITTEN — no static validator exists and none is proposed, because 'this sentence was never measured' is not statically detectable, so the build-time half (the Claims and Evidence section of core/os/standards.md) is trusted, not gated."
---

# A stated rationale is a claim

The **authoritative** rules are the **Claims and Evidence** section of
`core/os/standards.md`; it wins on any divergence. This file carries the
provenance, the worked instances, and the honest statement of what is and is not
enforced.

## How many places the rule text actually lives — counted, not assumed

An earlier draft of this file made two claims — that the rules had a single
home, and that this file restated none of them. Both were false; the second was
falsified by this file's own frontmatter a few lines above it. (Those claims are
described rather than quoted here on purpose: a grep sweeping for the retracted
wording cannot tell a quotation from an assertion, so reproducing them verbatim
would plant a false positive for the next sweeper.) Measured 2026-08-13, by
grepping each rule's distinctive phrases across every surface this brief
touches:

| # | Site | Carries | Mood |
|---|---|---|---|
| 1 | `core/os/standards.md` §Claims and Evidence | all seven rules | **authoritative** |
| 2 | `core/agents/warden.md` items 1-5 | clauses 1-4 | review-action |
| 3 | `coding_guidelines.md` §17 checklist row | clauses 1-4 | reviewer checklist |
| 4 | this file's frontmatter `summary` → generated verbatim into `core/enforcement/INDEX.md` | clauses 1-2 | registry row |
| 5 | `coding_guidelines.md` §13 | rule 4's illustration only | cross-reference to L-518 |
| 6 | this file's body, "The two authoring clauses, illustrated" | clauses 1-2 leads, VERBATIM | worked illustration |

**Six live sites.** `INDEX.md` is a generated projection of site 4, not a
seventh authored site. Site 6 is authored prose in this file's body: the
generator never touches it, so regenerating the registry does not maintain it.

**They did not derive from the authority.** The phrases
`"a scope it was not measured at"`, `"whose members do not all carry that
status"`, `"Ask the set/member question explicitly"` and `"may be TRUE and still
be a rejection"` each appear at site 2 and at site 3 and/or 4 — and **zero times
in `core/os/standards.md`**. Those rewordings are kept deliberately: each site
addresses a different actor in a different mood, and collapsing them to one
wording was considered and rejected.

`standards.md` is therefore authoritative **by policy, not by derivation** — and
in the other direction too: its clauses 1-2 were copied IN from the briefs this
rule came from (`BR-091`, `TD-382`, both verbatim), so it is not the origin of
its own wording either.

## Which rule text a grep CAN pair, and the command

An earlier draft of this file said no byte-grep could pair the copies. That is
true **only of the clause-1/2 rewordings** at sites 2 and 3. It is false for the
rest, and the truth is more useful than the claim was: three strings are
verbatim-shared across sites, so a rule-text edit to any of them has a real
mechanical finding aid.

| Verbatim-shared string | Sites carrying it |
|---|---|
| rule 4's illustration (`rather than Y because Y would Z`) | `standards.md`, `warden.md`, `coding_guidelines.md` §13 **and** §17 — 3 files, 4 occurrences |
| clause 1's lead (`Quote the measurement and name its scope`) | `standards.md`, this file's body |
| clause 2's lead (`A verification word applied to a SET is a claim about every member`) | `standards.md`, this file's body |

```
perl -0777 -ne 'BEGIN{$p=qr/rather\s+than\s+Y\s+because\s+Y\s+would\s+Z|Quote\s+the\s+measurement\s+and\s+name\s+its\s+scope|A\s+verification\s+word\s+applied\s+to\s+a\s+SET\s+is\s+a\s+claim\s+about\s+every\s+member/i} my $n=()=/$p/g; print "$n\t$ARGV\n" if $n' \
  core/os/standards.md core/agents/warden.md \
  core/enforcement/rationale-is-a-claim.md \
  ~/.igris/projects/igris-ai/context/coding_guidelines.md
```

**It must be `perl -0777`, not `grep`.** The prose is hard-wrapped, and rule 4's
illustration breaks across the two lines of `warden.md`'s review item 3 — a line-oriented `grep` scores
that file **0** and returns a clean, wrong answer. That failure was measured
three times during this brief, by three different actors, before the
whitespace-collapsing form was adopted. Output measured after this section
landed: `3` standards, `2` warden, `5` this file, `2` coding_guidelines — and
the walk from an earlier `3 / 1 / 2 / 2` is the caveat below made concrete, since
every added hit is this section and warden's pairing note *quoting* the strings
in order to document them, not a new rule statement.

**What it does NOT do.** It finds candidate sites; it cannot tell a rule
statement from a quotation *of* a rule — this section quotes those strings as
evidence, and the paragraph above quotes the reworded phrases as evidence too.
Adjudicate each hit. It also cannot pair the clause-1/2 rewordings at sites 2
and 3, which remain a hand sweep.

**The authoritative sweep list is `MAINTAINING.md`'s claim-to-evidence row.**
The table above is an inventory for reading, not the sweep order. Two lists of
this set have already disagreed: an earlier draft here named sites 2, 3 and 5
while `MAINTAINING.md` named 2, 3 and 4, and site 5 was ordered swept by
neither. The `perl -0777` command above is the only mechanism that detects that
disagreement for the strings it covers; for the rest, nothing does.

## What this obligation does NOT do

**Nothing fails while you are writing.** There is no validator, no lint rule and
no grep gate for this obligation, and none is proposed. "This sentence was never
measured" is not statically detectable — a grep-based gate for it would itself
be a mechanism whose claim outruns its evidence, which is the defect this
obligation exists to name (FR-251 Scope).

So the honest reading of the registry row is:

- **At build time** — writing a brief, a plan, a docstring, a comment, a commit
  message, a review, a summary — this is **honor-system**. Nothing observes you.
- **At REVIEWING** — warden REJECTs on this dimension. That is the only
  review-time *gate*, and it is the most expensive place to catch a sentence the
  author could have checked when writing it.
- **Group B is not warden's alone.** Rules 4–7 are discharged by whoever runs
  the mutation battery — usually sentinel at TESTING. Calling warden the sole
  mechanism would therefore be wrong, and this hunt is the counter-example: a
  stated rationale was falsified by mutation *before* REVIEWING. (Phrased
  descriptively so a sweep for the retracted wording does not match here.)
- **And that review-time half currently reaches ONE harness of four.** See
  "Harness scope" below. On codex, gemini and opencode this obligation is, as
  shipped today, honor-system end to end.

The `gate` in the registry row refers to the review-time half only. Read the row
cold and ask two questions:

1. *"What fails if I violate this while writing?"* — **Nothing, until
   REVIEWING.**
2. *"Which harnesses does the gate reach?"* — **claude only, until TD-385.**

Any future edit that makes a reader answer either question differently has
overstated this obligation.

## Harness scope — measured, not assumed (TD-385)

`grep -c` for the gate's heading `CLAIM↔EVIDENCE REVIEW GATE`, run 2026-08-13
against the file each harness's declared target resolves to:

| Harness | Declared target (`harness-manifest.json:241-254`) | File measured | Heading hits |
|---|---|---|---|
| claude | `.claude/agents/warden.md` (not manifest-declared) | `~/.igris/core/agents/warden.md` | **1** |
| codex | `.codex/agents/warden.toml` | `~/.igris/loadout/agents/warden/harness.codex.toml` | **0** |
| gemini | `~/.gemini/agents/warden.md` | same inode as `~/.igris/loadout/agents/warden/harness.gemini.md` | **0** |
| opencode | `~/.config/opencode/agent/warden.md` | `~/.igris/loadout/agents/warden/harness.opencode.md` | **0** |

**The link topology, shown rather than asserted** — it is what makes the cause
below true. Claude: `.claude/agents/warden.md` and `~/.claude/agents/warden.md`
are **symlinks** to `~/.igris/core/agents/warden.md`, and
`verify_mirror.sh core/agents/warden.md .claude/agents/warden.md` resolves
realpath B to that file and returns MATCH — so claude reads the canonical body
itself. Codex and opencode: their declared targets are **symlinks into the
loadout**. Gemini: its declared target is a **hard link** — `stat` gives inode
`226944859 nlink=2` for both `~/.gemini/agents/warden.md` and the loadout file.

So the other three are **compiled copies in the loadout**, reached by link, and
nothing recompiled them. A full loadout recompile does reach all three — but
**not simply "because they are links"**, and an earlier draft of this paragraph
asserted that mechanism without checking it. Measured:
`core/scripts/cli-adapters/compile_harnesses.sh` writes the loadout with
`mv "$tmp" "$out_path"` (`:517`, `:651`), which assigns a **new inode and breaks
the gemini hard link** — the script says so itself at `:143-147`. Propagation to
gemini survives only because `emit_md_hardlink` (`:154-159`, `rm -f` then `ln`)
re-establishes the link at `:761-766`. The symlinked codex and opencode targets
are indifferent to the inode change. The conclusion holds and TD-385 stays
scoped to the loadout; the mechanism is the compiler's explicit re-link step,
not the durability of a hard link.

**A separate, smaller finding: an orphaned home-anchored codex copy.**
`~/.codex/agents/warden.toml` also exists. Unlike the declared project-relative
target it is a **regular file**, shares no inode with the loadout, and is a
generation older: **0** occurrences of `CONTEXT-DOC REVIEW GATE` (FR-213, which
the loadout copy has), and its CONTEXT PROTOCOL still says to read
`~/.igris/core/igris_tree.json` and that you do not need `igris_os.md` — a file
FR-187 deleted. A loadout recompile will not reach it. **Whether anything reads
it is UNMEASURED**: `harness-manifest.json` declares the project-relative path,
so this may be a stale artefact of an older layout rather than a live read
target. Recorded, not resolved.

**This section was itself challenged, and the challenge is the illustration.**
Review reported that the codex and opencode declared targets did not exist,
which would have moved the cause off the loadout and re-scoped TD-385. Both
accounts were stated at the scope of the instrument that produced them — a glob
that does not resolve symlinks on one side, a grep of loadout files on the
other. It was settled by following the links, not by preferring either account,
which is clause 1 applied to a reviewer.

**And no gate reported this.** `validate_harness_drift.sh` returns
`[warden/codex] [warden/gemini] [warden/opencode]` all **MATCH**, exit 0,
because it compares *projection against loadout* — and per the link topology
above the projection resolves to the loadout file itself (the gate's own output
labels these `[loadout-anchored]`), so that comparison is satisfied by
construction. The comparison it never makes is *canonical body against loadout
body*. Corroborating measurement: diffing
`git show HEAD:core/agents/warden.md` against the gemini and opencode loadouts
gives 5 and 9 changed lines, **all frontmatter** — those bodies were faithful
copies before this brief's 32-line edit, and the gate could not see the
transition.

**TD-385 owns closing this**, and its AC-6 requires this caveat be removed once
it does. The loadout was deliberately NOT recompiled here: no FR-251 plan step
covers `~/.igris/loadout/`, and no TD-096 mirror pair verifies it.

This section is itself the obligation applied to its own registry row. An
unqualified "shipped" would have been a true finding — warden does REJECT on
this — stated at a scope nobody checked.

## Provenance

### Eleven instances in mbrgea-ai (2026-08-04 → 2026-08-10)

Reported in FR-251's own problem table, which is the source; **not re-derived
in this repo** (they are another project's briefs). Per that table: eleven
instances found during GL-010, of which it records nine as prose rather than
logic, and warden REJECTs on four consecutive briefs — **mbrgea-ai's** BR-083,
BR-085, TD-085 and BR-084 — purely on docstrings, comments, decision records and
brief text, endorsing the implementation every time. (The project qualifier is
load-bearing: BR-083, BR-084 and BR-085 are *also* live igris-ai brief ids, and
igris-ai's BR-083 titles `MAINTAINING.md:125`. A reader of this `core/` doc
would otherwise resolve them locally and land on the wrong briefs.)

The countermeasure was invented under pressure inside that project and lived in
`~/.igris/projects/mbrgea-ai/context/test_standards.md` plus one agent's habit.
mbrgea-ai learnings **1167** and **1201** carry the technique. That a technique
held in one project's doc is fragile is FR-251's thesis, and relocating it into
`core/os/standards.md` is this brief's answer.

**A residual, stated rather than smoothed.** FR-251's scope says "*move* the
countermeasure into the OS". The operation actually performed was a **COPY**:
mbrgea-ai's `test_standards.md` is another project's runtime doc, and FR-251
explicitly scopes out changing how any project's tests are written. mbrgea-ai
therefore still holds a duplicate of the four mutation rules. That duplicate is
a known, accepted state and a candidate for a follow-on brief — it is not a
completed move.

### Nine more in igris-ai, 2026-08-13 — different project, different actors

Re-derived here from the two briefs' own recorded sections, and cited at that
scope: BR-091's Correction section and TD-345's Corrections section. Neither
was re-run against the underlying code by this brief.

**BR-091 — five instances** (`BR-091.md` Correction, 2026-08-12). Every one
occurred in a RESTATEMENT; none in a measurement. The brief's own summary of
the set: *"The measurements in this brief held up throughout … What failed each
time was a sentence written ABOUT a measurement, one step removed from it, by
someone who did not take it."*

**TD-345 — four instances**, and the observation that gives this obligation its
sharpest form. TD-345's table records each as *a TRUE finding stated at a scope
its author had not checked, with the refutation already open or one operation
away*:

| The prose | What refuted it | Distance |
|---|---|---|
| "zero short-circuiting readers remain" | the next clause of the same bullet | 9 words |
| "~10%" as the resolved figure | the same entry's `{122..127}` vs `152` | 3 lines |
| "+3.4% is precision discipline" | `11.69 / 11.30` | one division |
| "editing the title would redden a guard" | the cited file's own comment: *"this test never reads the live brain"* | 2 lines above the cited line |

The distance column is the point. The check was always cheap and always local.

### Instance ten — where clause 3 came from (FR-251's own review loop)

Clause 3 ("a guarantee is a claim about what cannot happen") was not in the
plan. It was derived from this brief's own review record, where the same shape
recurred across four rounds. In each, the disclosure was accurate and the
guarantee attached to it was not:

The middle column quotes the retracted guarantees verbatim so the shape is
legible. They are quotations of withdrawn text, not assertions of this document.

| Round | Disclosed, accurately | Guarantee attached (quoted; every one retracted) | What refuted it |
|---|---|---|---|
| 1 | three prose copies exist | so one authored copy cannot fork | the asserting file was itself a copy |
| 2 | five sites, listed | so no byte-grep can pair them | pairs at four sites, one command |
| 3 | six sites, one list | so the two lists cannot diverge | already diverged, six versus five |
| 4 | the sweep list is authoritative | so this file does not enumerate | its own six-row table, sixty lines above |

The correction protocol is what produces it: told a claim outran its evidence,
the natural repair is to fix the claim AND explain why it cannot recur — and the
second half is a fresh unmeasured claim about a mechanism. Clause 3 exists to
stop that half being written.

## The two authoring clauses, illustrated (TD-382)

TD-382 is delivered by this brief and closes with it. Its two clauses are clauses 1-2 of Group A in the Claims and Evidence section. Each carries one BR-091 instance,
quoted at its true scope, per TD-382's acceptance criterion. Instances are
numbered as TD-382's table numbers them, 1–5.

**Clause 1 — quote the measurement and name its scope.**
BR-091 instance 4: the Correction section previously said *"no such record
exists"*. The v7.2.1 record DOES exist, on `hotfix/7.2.1`, carrying the correct
list. The measurement taken was branch-scoped — no `## [7.2.1]` heading in that
branch's CHANGELOG — and it was glossed into a global claim; the gloss was
canonised instead of the measurement. The true finding was always narrower: the
phantom id never reached any record.

**Clause 2 — a verification word applied to a SET is a claim about every
member.** BR-091 instance 5: a paragraph said five figures were *"all
independently re-derived"*. False for one of them — the 0-of-1966 corpus count
was measured once, by the forger, and review had already stated it could not
re-run it. Every figure was individually correct; the quantifier was not.

**Clause 2 is not redundant.** BR-091 records that clause 1 alone would have
caught instances 1–4, all narrative restatements, and would NOT have caught
instance 5: a rule phrased only as "quote the measurement" reads as *satisfied*
by that sentence.

## The mutation clauses, and the prior art already in this repo

Group B (rules 4–7) applies only when mutation is the chosen verification
method.

**Rule 7 has a working implementation in this repo**, which this brief does not
touch: `cli/scripts/browser-gate.mjs` gives each gate a `--mutate=<name>` that
breaks it on purpose, inverts its own verdict in mutation mode so the run
succeeds only if the named gate reports FAIL, and reports `VACUOUS` with a
non-zero exit when a mutation is not caught (`cli/scripts/browser-gate.mjs:35-43`).
It carries the control that must survive — gate `7c`, described in its own text
as *"its measured control"* (`cli/scripts/browser-gate.mjs:3672`). Named as
prior art, not as a requirement placed on anything else.

**Rule 6 is NOT established by that file, and an earlier draft of this section
claimed it was** — a two-member set claim whose evidence covered one member,
which is clause 2 committed inside the document stating clause 2. What
`browser-gate.mjs` shows is rule 6's *shape*: a per-gate verdict rather than a
count. But rule 6's literal content — an anchor string plus the subprocess
return code — is not what it does. Its mutation verdict is computed from
in-process check results; the `spawn`/`execFileSync` calls it does contain
(8 references, `:71-72, :589, :778, :1092, :1121, :6215, :6591`) launch the
dashboard fixture and evaluate module snippets, and are not the assertion
surface. Rule 6 was written against the `^FAILED`-grepping harness in FR-251's
own problem table (mbrgea-ai instance #4), where a collection abort scored as a
miss.

The anchor-string-plus-return-code form does appear in this brief's own
verification, which is the nearest worked example: the generator arm-checks
required both the exact anchor (`rationale-is-a-claim: missing summary`, then
`missing status`) **and** the return code (RED exit 1, restored exit 0), rather
than either alone.

## What was verified when this obligation shipped, and what was not

- **Verified.** The frontmatter carries all five required fields — the generator
  hard-fails otherwise, so running `core/scripts/gen_enforcement_registry.sh` IS
  the validation gate. That gate was itself checked for stuck-instrument
  behaviour by deleting this file's `summary:` line, requiring the named
  red, restoring it, and requiring the green back.
- **Not verified, and not verifiable by any artifact of this brief.** That
  warden's newly-named dimension changes warden's behaviour. The only evidence
  would be a REJECT on a claim↔evidence finding across subsequent hunts — an
  observation over time, not something this brief can measure. Any sentence
  asserting otherwise would be the next instance.
