---
name: promote
description: "Graduate a hardened learning into a project-context doc - operator-approved merge of a proven standard into the right doc, with a derived_from lineage breadcrumb (one-fact-one-source)."
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Bash
  - mcp__igris-brain__igris_memory_recall         # P1 candidate surface
  - mcp__igris-brain__igris_memory_search         # P1 candidate surface (FTS)
  - mcp__igris-brain__igris_memory_get            # P1 inspect a candidate's full content / already-promoted check
  - mcp__igris-brain__igris_memory_dashboard      # P1 candidate sizing (by_review_status)
  - mcp__igris-brain__igris_edge_create           # P5 derived_from lineage breadcrumb
  - mcp__igris-brain__igris_memory_mark_promoted  # P6 mark the source learning promoted
triggers:
  - "PROMOTE"
  - "promote"
  - "graduate standard"
  - "promote learning"
---

# PROMOTE — Memory→Doc Promotion Skill

`/promote` — the memory→doc **promotion** pass (FR-196 one-fact-one-source).

A learning earns promotion once it has **proven itself** — it is recalled often,
high-confidence, and a stable standard rather than a fresh observation. Promotion
moves that standard out of the recall stream and into the project's authored
**context doc**, which then *owns* it. The learning row is **never deleted**: it
becomes a lineage stub (`promoted_to_doc` points readers at the doc), and recall
stops double-surfacing the raw content. The operator approves **every** promotion
— the model proposes, never silently writes a doc.

> **Degradation — promote CANNOT run with the brain absent.** Unlike capture,
> this pass *requires* the brain: it queries candidates, records a
> `derived_from` lineage edge, and marks the source learning promoted — none of
> which has a local fallback. If the `igris-brain` MCP is unavailable, **warn
> and exit cleanly without touching any doc**:
> `Note: /promote needs the brain MCP (to query candidates, record lineage, and mark the learning promoted) and it is unavailable — exiting without changes. Re-run when the brain is reachable.`
> **Never half-merge:** do not write a standard into a doc if you cannot
> immediately record the lineage edge AND mark the learning promoted — a merge
> without the marking re-introduces the exact double-surfacing this pass exists
> to prevent (the doc owns it AND recall keeps surfacing the raw learning).

Determine the current project slug + absolute path up front (promotion targets
that project's `~/.igris/projects/{slug}/context/` docs).

## P1 — Surface hardened candidates

Find learnings that have earned a doc home. Use `igris_memory_recall` (or
`igris_memory_search` for an FTS pass) scoped to the project, and prefer rows
exhibiting the "this lesson has proven itself" signals:

- **high `confidence`** (battle-tested, near 1.0),
- **high `access_count`** (recalled frequently — the recall composite already
  surfaces these higher),
- **`category` IN (`decision`, `pattern`)** — the kinds that become standards
  (a one-off `discovery` or a `mistake` usually is not a doc-worthy standard),
- **`scope = 'global'`** — already cross-project-proven (the brain's internal
  scope-promotion lifted it because it recurred across projects); a strong
  doc-promotion candidate.

`igris_memory_dashboard` (`project` = slug, `summary_only: true`) gives a quick
sizing of the memory footprint (`by_review_status`, `by_category`) to frame how
many candidates exist.

**Two hard filters on the candidate set:**
1. **`review_status = 'approved'` only** — never promote a `pending_review` row
   (a perception-channel candidate a human has not yet vetted). The default
   recall/search filter already hides pending rows, so a candidate surfaced via
   `igris_memory_recall`/`_search` is already approved — but state it and do not
   reach around the filter.
2. **Exclude rows already promoted** — `igris_memory_get` a candidate and skip
   it if its recall output shows a `Promoted: → <doc>` pointer (it already lives
   in a doc; re-promoting would duplicate it).

Present the shortlist to the operator with, for each: title, category,
confidence, access_count, scope, and the proposed target doc (next step).

## P2 — Propose a target doc per candidate

Map each candidate to the right authored doc under
`~/.igris/projects/{slug}/context/` by **reading the doc-type catalog** — the
self-describing source of truth for which doc-type owns which kind of standard
(do NOT hardcode the mapping):

1. **Glob** `~/.igris/core/context-doc-types/*.md` and **Read** each definition.
   Each declares its `target` (the on-disk doc name), its `applies_when`, and a
   `kind_affinity` (the candidate kinds it owns — e.g. `decision, pattern` →
   `coding_guidelines.md`; `structural` → `architecture_map.md`; `UI, design` →
   `design_system.md`; `API` → `api_pattern.md`; `test` → `test_standards.md`).
2. **Match** the candidate's `category`/topic to the best-fit definition's
   `kind_affinity`, and propose that definition's `target` as the doc.

Read whatever target docs already exist (Glob the context dir). If the matched
doc-type is **absent** on disk, offer the operator to **create it** — hand off to
`/standardize <type>`, which authors a new, well-headed doc from that type's
catalog skeleton — or to **skip** this candidate. Do not force a standard into a
mismatched doc.

## P3 — Operator approves each promotion

For **each** candidate, present the proposal and get an explicit decision —
approve / skip / change-target. **Never promote silently.** A "no" leaves the
learning exactly as-is (still in memory, still surfaced by recall).

## P4 — Merge the standard into the doc (read → dedup → merge → write)

For each **approved** candidate:

1. **Read** the target doc fully (`Read`).
2. **Dedup against existing content** — if the doc already documents this
   standard (a heading or paragraph covering the same rule), do **not** append a
   second copy. Offer to **refine the existing section** (fold in any new detail
   from the learning) instead, or skip the merge if the doc already says it
   well. Appending a standard the doc already carries is the exact duplication
   this pass must avoid.
3. **Merge** the learning's standard under a **stable heading** — either an
   existing topical section it belongs under, or a clear new `## <heading>` (a
   `## Promoted Standards` section is a reasonable home when there is no
   topical fit). Write the *standard* (the rule + the why + when-to-apply),
   distilled from the learning's content — not a verbatim dump of the row.
4. **Write** the doc back (`Edit` for a surgical section insert, or `Write` for
   a doc you are creating). **Never overwrite the whole file** with unrelated
   content — a context doc is operator-authored; merge into it, do not clobber
   it. Note the heading anchor you merged under (you need it for P5/P6).

## P5 — Record the lineage breadcrumb (a `derived_from` edge)

Lineage is a **graph edge, not a copy** of the content (FR-196: lineage is "a
different kind, not a duplicate"). After the merge, record where the standard
came from:

```
igris_edge_create({
  from_type:  "learning",
  from_id:    "<learning id>",
  to_type:    "concept",
  to_id:      "<slug>:context/<doc>#<anchor>",   # e.g. "igris-ai:context/coding_guidelines.md#error-handling"
  edge_type:  "derived_from",
  provenance: "user",                             # operator-approved, not observed/inferred
  metadata:   { "promoted_at": "<ISO timestamp>", "target_doc": "<doc>", "target_anchor": "<anchor>", "approved_by": "operator" }
})
```

(`to_type: "concept"` is the free-standing-node type for "a doc section" — it is
not itself a DB entity. The edge is idempotent on its tuple, so a re-run is
safe.)

## P6 — Mark the source learning promoted

Set the recall pointer so the doc becomes the single source going forward:

```
igris_memory_mark_promoted({
  id:         <learning id>,
  doc_path:   "<slug>:context/<doc>",     # same path used in the edge's to_id (without the #anchor)
  doc_anchor: "<anchor>"                   # the heading slug you merged under; a leading '#' is stripped
})
```

After this, `igris_memory_recall` surfaces `Promoted: → <doc>#<anchor>` for that
learning instead of its raw content — the standard now lives in exactly one
place (the doc), with a recall breadcrumb pointing there.

## P7 — Promote summary

Report what was promoted:

```
## Promote complete — <slug>

- Candidates reviewed: <N>
- Promoted: <P>
  - <title> [<category>, conf <x>] → <doc>#<anchor>
  - ...
- Skipped: <k> (already-promoted / operator-declined / dedup — doc already covered it)
- Lineage edges recorded: <P> (derived_from: learning → concept)
```

---

## Constraints

1. **GUIDED, never automatic** — the operator approves every promotion. The
   model proposes; it never silently writes a standard into a doc.
2. **DEDUP before writing** — read the target doc and dedup the standard against
   existing content before merging (offer refine-existing/skip). This is the
   load-bearing guard against duplicate-knowledge drift.
3. **Curate, don't dump** — promote moves only *hardened* standards (approved,
   high-confidence/recall, decision|pattern).
4. **Graceful degradation** — brain absent → warn and **exit without touching
   any doc** (no local fallback; never half-merge a standard you cannot mark +
   lineage).
5. **One-fact-one-source** — after a promotion the *doc owns the standard*; mark
   the learning promoted so recall points to the doc. Never merge a standard
   into a doc without then recording lineage AND marking the learning promoted.
6. **NEVER clobber an authored doc** — read-then-merge under a stable heading;
   never overwrite a whole context doc.
7. **NEVER modify source code** — promote merges standards into context docs; it
   does not edit the project's application code.
