# the cognition layer — configuration

IGRIS's inferred-memory subsystem: a host running single-purpose LLM instances
that observe the brain and *propose* candidates for your review.

**The cognition layer ships disabled.** `igris install` writes every instance's
switch OFF, perception included (FR-191's zero-config door). Nothing any of them
produces reaches conscious memory without your approval — see "review-gated by
default" below.

## enabling

Config lives in `~/.igris/config.json` under `cognition`. Each instance has a
master switch, and an explicit `false` always turns it off.

**What an ABSENT key means is per instance, and there is exactly one
exception — but an absent key is NOT what a fresh install gives you.** For
`subconscious`, `synapse` and `janitor` — and therefore for the three the
janitor gates — an absent key means OFF. For `perception` it means ON: the
brain's resolver defaults it to extract.

**That is the resolver's default, not the shipped posture.** A stock install
never has an absent perception key: `igris install` and the config template both
WRITE `enabled: false`. So after `igris install`, perception is OFF like
everything else, and you turn it on deliberately.

The distinction matters for configs the installer never touched — a pre-FR-191
install, a hand-edited `config.json`, or an `IGRIS_BRAIN_DIR` with none at all.
There, perception IS extracting, and a health check that assumed "absent means
off" would report it `disabled` while it runs. Each instance therefore declares
its own default, and `igris cognition health` resolves against the declaration
rather than assuming the majority rule.

```jsonc
{
  "cognition": {
    "perception":   { "enabled": true },   // sessions -> learnings
    "subconscious": { "enabled": true },   // brain digest -> suggestions
    "synapse":      { "enabled": true },   // learning -> learning edges
    "janitor":      { "enabled": true }    // memory hygiene
  }
}
```

- `perception`, `subconscious`, `synapse`, `janitor` each own an `enabled` flag.
- The `janitor` flag also governs its family — `arbiter` (contradictions),
  `curator` (pruning), `cartographer` (clustering) — which derive from
  `cognition.janitor.enabled` rather than carrying their own switch.
- Restart your harness after editing so the brain reloads the config.

## review-gated by default

Every instance *proposes*; nothing is written to conscious memory without
approval. The auto-apply flags all default to `false`:

| flag | when `true` |
|---|---|
| `janitor.auto_merge` | apply near-duplicate merges without review |
| `janitor.contradiction.auto_resolve` | resolve contradictions without review |
| `janitor.pruning.auto_prune` | prune stale learnings without review |
| `synapse.auto_approve` | write inferred edges without review |
| `janitor.cluster.auto_fork` | create cluster meta-learnings without review |

Leave them off to keep every change gated behind your review.

## per-instance knobs

- `llm_timeout_ms` (300000) — per-run LLM timeout.
- `llm_daily_budget` (8) — max runs per day.
- `min_input_bytes` / `min_digest_bytes` — skip a run below this input size.
- `harness` (null) — pin extraction to a harness; null = configured default.
- similarity / cadence: `dupe_cosine_floor` (0.90), `cosine_floor` (0.80),
  `top_k` (5), `max_pairs` (200), `stale_days` (14); the `cluster` / `emergence`
  sub-passes default off (clustering is expensive).

## how you'd know one stopped

```bash
igris cognition health
```

One JSON digest, one row per REGISTERED instance. The roster is **derived** from
the extractor registry — the brain projects `registry.all()` into a
`cognition_instances` table at every boot and the verb reads that projection —
so an instance added tomorrow appears here with no edit to the verb, to `/boot`
or to `/scan`.

That derivation is the whole point of the surface. Before it existed the health
checks were hand-lists: `/boot` named two of seven instances in embedded SQL,
and the five it did not name were silent for four weeks before anyone noticed.
A hand-list over an open registry cannot report on the members nobody
remembered to list.

`/boot` renders only the entries that are not healthy (nothing at all on a
healthy brain). `/scan` renders the full roster table.

**Read the statuses as written:**

| status | means |
|---|---|
| `ok` | the latest terminal event on THIS machine is a success or a skip |
| `disabled` | one of its declared gate keys is not `true` — `disabled_by` names WHICH |
| `wedged` | its schedule cannot fire: an earlier run never reached a terminal status, and the daemon's overlap guard refuses to start a second one |
| `blocked_upstream` | it runs only inside another instance's run, and that driver is wedged/disabled/failing. **Fix the driver, not this instance** |
| `failing` | the latest terminal event on this machine is a failure with no later success |
| `no_signal` | enabled, but no terminal event inside the retained `event_log` window |

**`no_signal` is not "never ran".** The brain purges `event_log` rows older than
30 days on every engine start, so "stopped a while ago" and "never existed" are
indistinguishable from that table alone. The digest reports
`event_log_oldest_at` next to the status for exactly this reason, and the verb
cross-checks `schedules` / `schedule_runs`, which are never purged. Do not
retire an instance on a `no_signal` verdict.

Two more things the digest reports that a naive read would miss:

- **`last_run_at` is scoped to this machine.** `event_log` replicates between
  brains, so a run that succeeded on another host would otherwise render a
  locally-wedged instance green. That reading is reported separately as
  `last_run_any_host`.
- **Duplicate schedule rows** show up in `warnings[]`. The schedule bootstrap
  de-duplicates by NAME while the table replicates by a per-machine random id,
  so two brains can each keep their own row under one name.

## how much is any of it worth

```bash
igris cognition yield
```

The sibling question, and the harder one. `health` answers *is this instance
running?*; `yield` answers *is what it produces worth anything?* — per instance:
rows produced, rows a human judged, rows kept, the share of the pending queue,
and the share that expired unjudged.

The roster is derived the same way — from `cognition_instances` — so an instance
added tomorrow is SCORED here with no edit, not merely listed. What makes that
possible is a second declaration alongside `output`.

### `output` and `produced` are different questions

Every instance declares both, and conflating them is the mistake this verb was
built to stop making.

| | answers | example (perception) |
|---|---|---|
| `output` | *where does an operator look for actionable results?* | `learnings[review_status='pending_review']` — the review INBOX |
| `produced` | *which rows did this instance ever write?* | `learnings[source_extractor='llm']` |

`output` is legitimately a STATE predicate. Perception's selects **zero** rows
the moment its queue is drained — which is exactly what happened on 2026-09-01 —
while perception had in fact authored 569. A yield reading built on `output`
would report the highest-scoring instance in the brain as having produced
nothing.

`produced` uses a grammar with one special token:

```
table[col='literal']
table[col=literal, col2=OTHER]
```

`OTHER` means *the complement of every literal any OTHER instance declares for
this same table and column*, computed from the roster. That is how the
subconscious — whose `source_module` is chosen by the LLM, and which had **196
distinct values** across 360 rows on 2026-09-01 — reports as ONE instance rather
than 196 tiny detectors. Register an eighth instance that claims a literal
`source_module` tomorrow and the complement shrinks on its own.

### expiry is not judgment

The governing defect. `review_status='rejected'` on a learning has two completely
different causes and they were indistinguishable:

| cause | what writes it | how you tell |
|---|---|---|
| **bulk expiry** — the janitor's stale-pending sweep | `review_status='rejected'`, `updated_at`. **`deleted_at` untouched.** No event. | `rejected` **AND** `deleted_at IS NULL` |
| **human judgment** — a reviewer rejected a recurring candidate | `review_status='rejected'` **AND** `deleted_at`, plus a `perception.rejected_pattern_recurring` event | `rejected` **AND** `deleted_at IS NOT NULL` |

The verb counts the first as `expired`, never as a rejection. That is not a
detail: on 2026-08-26 the naive reading scored perception at 23 kept of 69
(**33%**) because it counted 40 expiry-flipped rows as human rejections, while
the only review that had actually happened scored it 23 of 29 (**79%**).

Suggestions behave differently and are handled differently: nothing ever flips a
lapsed suggestion to `dismissed`, so it stays `pending` and is counted as
`pending_expired` — unjudged, and never a rejection either.

**This compensation happens at the READER. No writer changed.** A distinct
`expired` status would have been a new member of a vocabulary that readers
across BOTH packages select on — written as `review_status = 'approved'`, as
`COALESCE(review_status, 'approved') = 'approved'`, and as a bound
`review_status = ?` — and a new status value falls silently outside every one of
those forms. It would also have perturbed the very population being measured.

**No count of those readers is given, and that is deliberate.** Two exactly
re-derivable populations exist, run from the repo root (both measured
2026-09-01):

```bash
# files that NAME the column
grep -rl review_status brain-mcp-server/src cli/src | grep -v __tests__ | wc -l
# -> 35

# files where it sits next to a comparison operator
grep -rlE "review_status[[:space:]]*(=|!=|<>|IS|IN|LIKE)" \
  brain-mcp-server/src cli/src | grep -v __tests__ | wc -l
# -> 21
```

Neither is the answer to "how many filter on it", and nothing in between is
mechanical. The first mixes DDL, writes (`SET review_status = ...`),
TypeScript-level comparisons, the roster's own
`learnings[review_status='pending_review']` predicate string and doc comments in
with the SQL filters. The second admits files that match only inside a docblock
QUOTING a predicate, and it cannot see a `COALESCE(review_status, 'approved')`
filter at all, because the column is followed by a comma there rather than an
operator. That third population has its own re-runnable command —
`grep -rn "COALESCE(review_status" brain-mcp-server/src cli/src | grep -v __tests__`
— which on 2026-09-01 returned eight lines: seven SQL filters spread over five
files, plus one docblock in `cli/src/types.ts`. Three of the five
(`arbiter/candidates.ts`, `cartographer/candidates.ts`, `subconscious/digest.ts`)
match the operator regex nowhere and are missed outright. The other two are
re-admitted for the wrong reason, which is the sharper failure because the file
count then looks right: `janitor/candidates.ts` matches on one docblock line
quoting `review_status='merged'`, and `janitor/hygiene.ts` on
`rejectStalePending`'s `SET review_status = 'rejected' … WHERE review_status =
'pending_review'` — a write and its predicate — plus two more docblock lines.
Neither matches on any `COALESCE` filter it actually contains, so both are
counted for text that is not the filter being counted. Separating the populations
takes a comment-stripping parser and a judgement call per file, which is not a
method a reader can re-run. An earlier draft of this paragraph carried a cardinal
that could not be re-derived from its own stated method, which is precisely the
instrument defect this verb exists to stop.

### three bounds the numbers carry, because without them they lie

- **A `learnings` `produced` count is a SURVIVING-row count, not a lifetime
  one.** The common perception reject path HARD-deletes: the row is gone from
  `learnings` entirely, so it is missing from `produced` as well as from
  `judged`. Measured 2026-09-01: seven rejection events exist and exactly one
  rejected row survives. Not fixable — the rows are gone — so it is named
  instead, on the field itself.
- **The `event_log` judgment counts are a LOWER BOUND.** `event_log` is purged at
  30 days, and these emits went nowhere at all before FR-241 Phase 6b, so the
  record starts when the listener did. They are reported ALONGSIDE the row-state
  counts and never reconciled into one number; a divergence in the informative
  direction becomes a warning that names its cause.
- **The derivation is TOTAL over instances; the judgment model is a CLOSED SET
  over tables.** Adding an instance costs nothing. Adding a new output table
  costs one edit in the reader, and until it is made that instance reports
  `unmeasured` with a named reason — never a number.

### unmeasured is not zero

Every rate is an object, not a number: `{numerator, denominator,
denominator_label, value}`. `value` is `null` — never `0` — whenever the
denominator is empty, and the instance carries `measured: false` with a reason.

A rate cannot be rendered without its denominator because the denominator is
structurally part of the field. An instance nobody has reviewed has not been
scored badly; it has not been scored. The janitor writes no suggestions of its
own, so it reports `unmeasured` rather than `0/10` — absence of verdicts is not a
verdict.

Rows that belong to NO registered instance get their own derived
`(unclaimed:<table>)` entry, found as a complement rather than by naming
anything: that is where the 844 legacy `gap`/`stalled`/`pattern`/`conflict` rows
from the engine FR-118 deleted show up, and where the next orphaned population
will. Every channel reports `claimed + unclaimed === total`, and says so when it
does not.

`/scan --yield` renders the table. Without the token, `/scan` prints one pointer
line.

## the instances

Seven instances, one host. Each block answers what it does, what gates it, what drives it, and where its
output lands.

The brief's fourth question — *how would an operator know it stopped?* — is
deliberately NOT answered per block. A written status decays the moment it is
written, and a doc claiming an instance is healthy is exactly the stale
self-description this layer already suffers from. It is answered once, live, by
`igris cognition health` and the surfaces above.
Status is deliberately absent from this document — a written status decays.
`igris cognition health` is the only place a status belongs.

### perception

**Job.** Reads a session transcript at session end and proposes what was worth
learning from it. The only instance driven by your actual work rather than by a
clock. Output lands in the learning review queue, where nothing enters conscious
memory until you approve it.

| | |
|---|---|
| **gate** | `cognition.perception.enabled` — **absent means ON here**, unlike every other instance |
| **driver** | session hook — spawned detached at session end / pre-compact, not by a cron row |
| **output** | `learnings` rows with `review_status='pending_review'` |
| **produced** | `learnings[source_extractor='llm']` — every row its LLM extractor wrote (SURVIVING rows: the common reject path hard-deletes) |

> **It writes under a LEGACY event namespace.** Every other instance logs to
> `event_log` under `component='cognition.<id>'`. Perception logs under the bare
> `perception`, with `perception.run_*` event names, because its production path
> predates the unification and was never migrated. Any surface that derives
> `cognition.perception` finds zero rows and reports the healthiest instance as
> never having run. The instance therefore DECLARES both literals, and the
> health surface reads the declaration rather than deriving a name.

### subconscious

**Job.** Reads a digest of the whole brain — briefs, goals, learnings, activity
— and proposes what you are not seeing: a brief stalled for weeks, a project
gone quiet, a pattern in how work is going. The suggestion KIND is open: the LLM
names it, so the categories are not a fixed list.

| | |
|---|---|
| **gate** | `cognition.subconscious.enabled` |
| **driver** | the `subconscious_engine` schedule (every 6 hours) |
| **output** | `suggestions` rows with an LLM-chosen `source_module` and `type_inferred=1` |
| **produced** | `suggestions[type_inferred=1, source_module=OTHER]` — the complement of every literal sibling, which is what makes it ONE instance and not 196 |

### synapse

**Job.** Reads pairs of related learnings and proposes the RELATIONSHIP between
them — this one derives from that one, these two duplicate each other, this one
contradicts that one. It is how the brain becomes a graph rather than a list.

| | |
|---|---|
| **gate** | `cognition.synapse.enabled` |
| **driver** | the `synapse_engine` schedule (daily, 03:00 UTC) |
| **output** | `suggestions` rows with `source_module='edge_inference'` |
| **produced** | `suggestions[source_module='edge_inference']` — under-reports while `synapse.auto_approve` is on, because the edge is then written directly instead of queued |

### janitor

**Job.** Memory hygiene: finds near-identical learnings and proposes merging
them. It also runs a deterministic sweep (confidence bumps for re-discovered
learnings, rejection of stale pending rows) that needs no LLM.

**And it drives three other instances.** `runJanitor` co-drives the arbiter, the
curator and the cartographer inside its own run — sequentially, aggregating
every counter into ONE audit row. So the janitor is not one instance among
seven; it is the execution path for FOUR of them. When its schedule stops, four
instances stop together and only one of them has a schedule you can look at.

| | |
|---|---|
| **gate** | `cognition.janitor.enabled` |
| **driver** | the `janitor_engine` schedule (daily, 04:00 UTC — offset from synapse) |
| **output** | `suggestions` rows with `source_module='janitor'`; audit rows in `brain_maintenance_runs` |
| **produced** | `suggestions[source_module='janitor']` — zero rows today, so its yield reports `unmeasured`, not a zero score |

### arbiter

**Job.** Finds learnings that CONTRADICT each other — semantically close but
opposed — and proposes which one wins and why. The loser is superseded rather
than deleted, so the lineage survives.

| | |
|---|---|
| **gate** | `cognition.janitor.enabled` — **it has no switch of its own** |
| **driver** | co-driven by the `janitor` instance |
| **output** | `suggestions` rows with `source_module='arbiter'` |
| **produced** | `suggestions[source_module='arbiter']` |

### curator

**Job.** Finds learnings that have gone STALE — old, never accessed, tagged
deprecated — and proposes pruning them. Every prune is logged with its
pre-state, so it can be undone by run.

| | |
|---|---|
| **gate** | `cognition.janitor.enabled` — **it has no switch of its own** |
| **driver** | co-driven by the `janitor` instance |
| **output** | `suggestions` rows with `source_module='curator'` |
| **produced** | `suggestions[source_module='curator']` |

### cartographer

**Job.** Detects CLUSTERS of related learnings in the edge graph and proposes a
single meta-learning that summarises each one — turning twelve scattered notes
into one thing you can actually recall.

| | |
|---|---|
| **gate** | `cognition.janitor.enabled` **AND** `cognition.janitor.cluster.enabled` |
| **driver** | co-driven by the `janitor` instance, additionally throttled to once per `cluster.cadence_days` (7) |
| **output** | `suggestions` rows with `source_module='cartographer'` |
| **produced** | `suggestions[source_module='cartographer']` |

> **The only double-gated instance.** `cluster.enabled` ships OFF because the
> community-detection pass is expensive. Both keys must be `true`. When the
> health digest reports it `disabled`, read `disabled_by` — the two gates have
> completely different remedies. And a quiet week is expected behaviour, not a
> stall: the cadence throttle skips the pass entirely when the last successful
> run is inside the window.

## four instances have no `cognition.<id>` key — by design

`~/.igris/config.json` has no `cognition.arbiter`, no `cognition.curator` and no
`cognition.cartographer` entry, and it never will. Those three derive `enabled`
from `cognition.janitor.enabled` (the cartographer ANDs in its cluster
sub-toggle) because they are sub-phases of a janitor run, not independently
schedulable engines. Perception is the fourth exception in the other direction:
it has a key, but it has no cron row — a session hook drives it.

So the documented convention *"if the `cognition.<id>` key is absent, treat as
false"* is doubly narrower than it sounds. It is a statement about instances
that HAVE such a key — and among those, perception's absent key means ON, not
off. Expecting a key for the janitor family is the mistake: an absent key there
is not a gate that defaulted to `false`, and their dormancy is always
upstream. That is why the
health digest reports them as `blocked_upstream` rather than `no_signal` — the
difference between "go look at the arbiter" and "go look at the janitor's
schedule" is the difference between a wasted afternoon and a fix.

Each instance declares the key that ACTUALLY gates it, and the health surface
resolves that declaration. Nothing infers a key from an id.

## the arbiter `parse_error`, resolved

The arbiter's last recorded state before it went quiet was
`run_failed reason=parse_error`. It was not broken.

The engine used to CONFLATE two different things: a MALFORMED response and a
well-formed EMPTY one. An arbiter that looked at the brain and correctly
answered "there are no real contradictions here" was told it had failed. TD-292
separated them — an instance now declares its own well-formedness verdict, and a
valid empty array settles to a SUCCESSFUL run with zero candidates.

Re-tested against the current build end-to-end: driving a janitor run with an
arbiter backend that returns a literal empty array yields a **succeeded** run,
zero proposals, and no `parse_error` row. Restoring the old rule on the same
fixture reproduces the original failure exactly. No arbiter fix is warranted.

That verification is hermetic by necessity, and the necessity is itself worth
recording: a live re-run was impossible while the janitor schedule was wedged,
and the original evidence had already aged out of `event_log` under the 30-day
purge. If you find yourself unable to reproduce a cognition failure because the
subsystem that would reproduce it is the thing that is broken — that is the
signal to build the health surface first.

## the layer is open

A new instance is a new self-describing extractor file plus one barrel line; the
host does not change. The one thing an instance MUST declare beyond its four
slots is its `health` block — its event namespace literals, its gate keys, its
driver and its output destination. That field is REQUIRED, not optional, because
an instance that cannot say how an operator sees it stop can ship invisible, and
that is exactly what happened to five of these seven.
