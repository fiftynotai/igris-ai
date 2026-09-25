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
| `wedged` | its schedule cannot fire: an earlier run is still open, and the daemon skips every slot while it is. Since TD-361 a run whose owner process is dead is reaped at the next sweep, so an open run belongs to a live owner, or to one the daemon cannot prove dead — see [how a wedge is released](#how-a-wedge-is-released-td-361) |
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
  `last_run_any_host`. "This machine" is the **machine identity**, not the
  hostname (BR-100): every writer stamps `config.json` `machine.id` — a uuid
  minted once by the first writer — into `event_log.machine_id` beside the
  volatile `machine_hostname` label, and the reader keys on the id first. A
  row whose `machine_id` is NULL (written before the mint, by a bash hook, or
  pulled from another brain — the column deliberately never replicates, so an
  inbound row is "not mine" by construction) is attributed through
  `config.json` `machine.aliases`: the hostnames this machine has been observed
  under — writers append the newest `ALIAS_CAP = 16` and evict the oldest on
  the 17th distinct name (TD-453; a hand-written oversize list is left alone,
  only an append evicts), and the operator edits. So a `no_signal`
  under a name the machine used before the mint (a laptop that wrote as
  `MacBookAir` on one network and `…-Air-2.local` on another) is the
  operator-adds-alias case: `igris doctor` lists the unattributed names with
  counts under its informational `machine-identity` class; add only names this
  machine has actually used.
- **Duplicate schedule rows** show up in `warnings[]`. NAME is a schedule's
  identity: the bootstraps de-duplicate by it, and since TD-361
  `schedules.name` is UNIQUE (schedules migration v3). Before that the table
  replicated by a per-machine random id, so two brains each kept their own
  row under one name. The warning now only fires on a brain that has not run v3.

### how a wedge is released (TD-361)

The daemon used to refuse to fire while ANY run of a schedule was `running`,
with no age bound and no owner check. A run whose process exited mid-run (a
session closed while the handler was awaited, or a crash) never received its
terminal update, so it blocked its schedule forever — 94 days once, 12.4 and 11.8 days on
2026-09-24, both born on the machine that wedged. Three things changed:

- **Every run row records its owner.** `schedule_runs` gained `machine_id`,
  `machine_hostname`, `owner_pid` and `owner_started_at` (the `ps -p <pid> -o
  lstart=` string, byte-identical to the CLI's instance-liveness reader). The
  one writer is `run-liveness.ts#insertRunningRow`, which also registers the
  run as in flight in its process.
- **A sweep releases a run only when its owner provably cannot finish it** —
  at daemon start and at every tick. The row is marked `failed` with an error
  starting `abandoned:` and naming the reason: `owner_foreign_machine`,
  `self_not_in_flight`, `owner_dead`, `owner_pid_reused`, or
  `legacy_predates_live_processes`. Every state it cannot prove is ALIVE
  (`pid_only_unverified`, `legacy_unprovable`), and a live owner is never
  reaped however old its run — **there is no age bound**, on purpose: a
  healthy janitor run took 74.7 minutes, and age cannot tell a suspended laptop
  from a dead process.
- **A live run skips the slot.** When a run is genuinely still going, the
  daemon advances `next_run_at` to the next cron slot instead of leaving the
  schedule due (which had re-armed a zero-delay timer: 180 to 200 re-arms per
  250 ms, three runs of `daemon-wedge.test.ts` W10b at HEAD on one machine,
  2026-09-24; the count is load-sensitive, the test asserts only `<= 1` after).

A graceful shutdown marks the process's own in-flight runs `failed` with an
error starting `interrupted:`; the liveness sweep is the backstop for a kill,
a crash or power loss. If the owner later finishes a run that was wrongly
marked, its own terminal write wins.

**Rows with no owner (legacy).** Rows written before schedules v3, or by a
session brain still running an older build, carry no owner. Such a row is
released only if it STARTED before every brain process that could own it —
this process and every live pidfile-registry process on the same DB file. It
is the operator's own manual argument, mechanised: no process that could
still own the row is alive.

**Schedules are machine-local.** `schedules` and `schedule_runs` are no longer
replicated (they left `SYNC_TABLES`). A replicated schedule was executed by
every receiving brain, and a replicated `running` row could never be
terminated. Cognition runs stay visible across machines through `event_log`
(`last_run_any_host`).

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
distinct values** across 360 rows as of 2026-09-01 — reports as ONE instance
rather than 196 tiny detectors. Register an eighth instance that claims a literal
`source_module` tomorrow and the complement shrinks on its own.

TD-440 added a **direct** answer to the same question, alongside this derived one:
`suggestions.source_instance` names the writing component, so the queue can be
grouped by producer without inferring a complement. The `produced` predicates are
deliberately NOT re-pointed at it yet — that would break comparability with the
clean-room baseline TD-440 is measured against. Once `source_instance` is fully
populated, moving them is the same grammar with no reader change, and it removes
the standing hazard that a free-text label could collide with a sibling's declared
literal and mis-attribute the row.

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
| **output** | `suggestions` rows with an LLM-chosen `source_module`, `type_inferred=1` and `source_instance='subconscious'` (TD-440) |
| **produced** | `suggestions[type_inferred=1, source_module=OTHER]` — the complement of every literal sibling, which is what makes it ONE instance and not 196. Unchanged by TD-440 ON PURPOSE: re-pointing it at `source_instance` mid-measurement would break the baseline comparison AC-6 depends on |
| **dedup** | TD-440 — a re-emission of a finding already pending BUMPS `seen_count` on that row instead of inserting. Queue depth tracks open findings, not elapsed runs. See `docs/architecture/subconscious_engine.md` §The finding key |

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

## a `parse_error` that was never one (TD-447)

The second `parse_error` the health surface ever showed was also not a parse
error. On 2026-09-03 `synapse` read `run_failed reason=parse_error
response_bytes=147`, and the 147 bytes were the claude CLI's own words:
`API Error: 529 Overloaded. This is a server-side issue, usually temporary —
try again in a moment. If it persists, check https://status.claude.com.`

`claude -p --output-format json` reports an API or auth failure INSIDE its
result envelope — `{"type":"result","is_error":true,"api_error_status":529,
"terminal_reason":"api_error","result":"API Error: 529 …"}` — and exits 1.
The backend classified `non_zero_exit` only when stdout was EMPTY, so the
envelope fell through to text extraction, the error string was lifted as the
model's answer, the instance parser found no JSON array in it, and the engine
filed the run as a malformed reply. Every consumer downstream was then told
the truth about the wrong thing.

Decoding a row written before the fix — `event_log` keeps 30 days, so some
of these are still readable:

| `response_bytes` | what the "response" actually was |
|---|---|
| 147 | `API Error: 529 Overloaded. …` — the upstream was overloaded; nothing to fix here |
| 72 | `Failed to authenticate: OAuth session expired and could not be refreshed` — `claude login` on this host restores it only until the token next expires if the extractor child inherited the desktop app's host-auth variables (TD-471 strips them; the root cause is pending the TD-471 watcher's verdict) |
| 54–64 | the brief's other recorded sizes for this class — a short CLI error message; the exact text was not captured, so read `payload` on the row |

Since TD-447 the backend inspects a claude stdout for a `{type:"result",
is_error:true}` line BEFORE extracting text. When it finds one the run fails as
`api_error` — or `auth_error` when the status is 401/403 or the
`terminal_reason`/message names authentication — with `detail` set to the
CLI's message (first 200 chars) plus ` (http N)` when a status was reported.
The instance parser is never called, so `response_bytes` is never written for
this class. Perception's legacy path carries both classes at two scopes, and
each was closed separately: the extractor's `backendFailReasonToPerception`
maps them onto `perception.run_failed`'s `reason` (round 1), and the runner's
`mapFailureReasonToLlmStatus` maps that reason onto `llm_status` —
`failed:api_error` and `failed:auth_error` (round 2). Between the two rounds the
event's `reason` was already right while the MCP tool result and the
`perception_extract_cli.ts` summary line still printed `llm_status=failed:unknown`
for the same run (L-1246). BR-109 extends the inspection to every other harness,
each on its own failure channel (next section).

`igris cognition health` reads the row's `reason` and `detail` and leads the
`failing` sentence with them — `api_error: API Error: 529 Overloaded. latest
terminal event on this host is cognition.synapse.run_failed at …, with no later
success` — so `/boot`'s "first sentence of reason" render prints
`synapse: FAILING — api_error: API Error: 529 Overloaded`. No digest field was
added: the render rules already print `reason`, and a new field is a five-place
wire sweep for a string the skills already show. A row with no `reason` in its
payload renders the sentence it always did.

## why an extractor call failed — named reasons per harness (BR-109)

Every CLI reports a failed call on a different channel, and before BR-109 only
claude's was read. The live shapes, and what the backend made of them at HEAD:

- **codex 0.135.0** (exit 1): four JSONL events on stdout — `thread.started`,
  `turn.started`, `error`, `turn.failed` — whose `message` is itself JSON:
  `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The
  'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade …"}}`.
  The stdout was non-empty, so `extractText` lifted all four lines as the answer
  and the run was filed `parse_error` — the TD-447 class, on codex.
- **opencode 1.14.22** (exit 0): stdout empty, stderr `> build · <model>` then
  `Error: Token refresh failed: 401`. It was filed `empty_response`, which
  perception treats as "no candidates", so a perception run on opencode failed
  silently.
- **gemini-cli 0.45.0**: the extractor's `--print` / `--print-timeout` are not
  options of 0.45.0 (`Unknown arguments: print-timeout, printTimeout, print`,
  exit 1), filed `non_zero_exit` with the help text's head as its detail.
- **gemini-cli 0.45.0, live under the BR-109 argv** (2026-09-25, this machine;
  `br109-evidence/gemini-diagnosis.json`): exit 55, stdout empty. stderr carries
  TWO refusals. First, the account's tier: gemini's first auth pass logs an
  `IneligibleTierError` whose `ineligibleTiers[0]` is `reasonCode:
  'UNSUPPORTED_CLIENT'`, `reasonMessage: 'This client is no longer supported for
  Gemini Code Assist for individuals. To continue using Gemini, please migrate to
  the Antigravity suite of products: https://antigravity.google'`, tier
  `free-tier`. That pass logs the error and carries on. Second, the fatal one:
  `Gemini CLI is not running in a trusted directory. To proceed, either use
  --skip-trust, …` (`FatalUntrustedWorkspaceError`, exit 55). The token refreshed
  in the allow arm, so the login is valid. Filed `non_zero_exit`.

Since BR-109 `runBackend` classifies an exec result in this order, BEFORE text
extraction (`classifyExecResult` in `cognition/backend/index.ts`; the detectors
in `parse-output.ts`):

1. `timeout`.
2. **The harness's own failure channel**, at any exit code:

   | harness | failure iff | read from |
   |---|---|---|
   | claude | a `{type:"result", is_error:true}` line (TD-447) | `api_error_status`, `terminal_reason`, `result` |
   | codex | a `turn.failed` event, or an `error` event with NO `agent_message` item (a retried stream that then answers is not a failure) | the event's `message`; when it is JSON, `status` and `error.{code or type, message}` |
   | opencode | stdout is empty AND stderr has an `Error:` line (the last one, ANSI stripped) | that line only — never the `> build · <model>` header |
   | gemini | only when the run gave no answer (exit ≠ 0 or empty stdout); first match wins: (1) the tier refusal (`IneligibleTierError` / `ineligibleTiers:` on stderr, any exit) → `account_unsupported`; (2) exit 55 or the `not running in a trusted directory` line → `cli_incompatible`; (3) exit 41 → `auth_error`; exit 42 or 52 → `cli_incompatible` (an input or config gemini rejects) | (1) the first `reasonMessage`, else the `IneligibleTierError:` message; (2) the trust line; (3) the last non-empty stderr line |
   | antigravity | — (no measured failure shape; step 3 still applies) | — |

3. **Any harness:** a non-zero exit, empty stdout and a stderr line matching
   `unknown argument/option`, `unexpected argument` or `unrecognized argument/option`
   → `cli_incompatible`, detail = that line.
4. `non_zero_exit` and `empty_response`, as before.

One classifier names every detected error: **`auth_error`** on status 401/403, an
authentication phrase (TD-447's, plus `token refresh`, `refresh token`,
`expired token`), or a bare `401`/`403` in a one-line message with no status;
otherwise **`model_unsupported`** when the error code names a model or the
message says a model "requires a newer version", is "not supported",
"unsupported", "does not exist", "not found", "not available" or "is unknown"
(within one sentence); otherwise **`api_error`**. The false-positive rows it must
not match are pinned beside the positive ones (`backend-harness-failures.test.ts`
H14). `detectClaudeErrorEnvelope` keeps TD-447's two classes for the probe and
the TD-471 watcher; `runBackend` names a claude model error `model_unsupported`.

**`account_unsupported`** is gemini's own class: the vendor refuses this
account's tier for this CLI. It is not `auth_error`, because the login is valid
(the token refreshed) and re-authenticating changes nothing. It is not
`api_error` either: that reads as transient, and this refusal is permanent until
the operator switches product. When the tier refusal and the trust refusal
appear together (the measured run), the tier refusal wins. It is the root cause
the operator can act on. The trust refusal is an Igris invocation defect, fixed
by `--skip-trust` below, and after that fix gemini is expected to fail on the
tier alone. That is source-read, not measured: the second `refreshAuth`
(`gemini-ORQHD633.js:16282`) rethrows the non-fatal error, and the top-level
catch prints `An unexpected critical error occurred:` and exits 1. H17 pins that
shape. An answered run is never classified, even when its stderr carries these
words (H18).

**codex answer text.** A codex run's text is now only its `agent_message` texts,
any claude-shaped `result` text and non-JSON lines. Every other codex JSON event
(`thread.*`, `turn.*`, reasoning items) is stream metadata and is dropped; before
BR-109 it rode along beside the answer. The success event sequence is recalled,
not measured, until the operator-run codex PASS records it.

**What `detail` keeps, and where it goes.** The CLI's own error message only —
codex's event message (never its ~212 KB verbose stderr), opencode's single
`Error:` line, gemini's `reasonMessage` or fatal line — ANSI stripped, first 200 chars, with
` (http N)` when a status is known: TD-447's format, so `igris cognition health`
renders it unchanged. `run_failed.detail` lands in `event_log` and replicates to
the remote brain. So `runBackend` scrubs EVERY `detail`, claude's included, of
credential shapes — `sk-…`, JWTs (`eyJ…`), `Bearer …`, Google `ya29.…`, refresh
`1//…` and `AIza…` keys — replacing each with its prefix + `…`. The measured
messages are static strings plus a status or a model id; the scrubber defends
unmeasured provider text, it does not prove it.

**The gemini invocation.** gemini now runs `--allowed-mcp-server-names
__igris_extractor_no_mcp__ --skip-trust --prompt ''` with the prompt on STDIN (agy keeps
`--print-timeout <n>s --print` and the argv tail). A bare `--prompt` token makes
the run headless whatever the TTY (`isHeadlessMode`, `chunk-6T7N6JF2.js:275161`),
and its empty value leaves `input` = the stdin body (`gemini-ORQHD633.js:16235-16237`).
The prompt never sits in argv, so no Linux 128 KB single-argument limit, no
misparse of a body starting with `-`, and no prompt text in `ps`. Measured
offline in an empty scratch HOME: the argv parses and the run is
non-interactive — it exits 41 because gemini validates auth
(`validateNonInteractiveAuth`, `:16043`) BEFORE it reads stdin, not the 42 of an
empty input. `execHarness` owns the deadline.

**Why `--skip-trust` is safe.** Headless gemini refuses an untrusted cwd with
exit 55 (`folderTrustCheck`, `gemini-ORQHD633.js:9863-9881`). `--skip-trust`
(a boolean, `:8064`) sets `GEMINI_CLI_TRUST_WORKSPACE=true` in gemini's own
process (`:8218-8219`), which `checkPathTrust` honours first
(`chunk-6T7N6JF2.js:392185`). The cwd is the isolated home, and after BR-108 that
holds only owned sanitized files and the named auth links. The gemini-cli 0.45.0
features trust unlocks are read below (static, installed bundle; names only):

| unlocked by trust | where | what it reaches in the isolated home |
|---|---|---|
| workspace `settings.json` merged | `mergeSettings`, `chunk-EUYIPFPA.js:16181` | nothing: cwd = `homedir()`, so `isWorkspaceHomeDir()` skips the workspace load (`:16578`) |
| `.env`: `<dir>/.gemini/.env` checked first, ALL keys loaded (untrusted: 4 auth keys, sanitized) | `findEnvFile` / `loadEnvironment`, `:16388-16498` | the owned EMPTY `<iso>/.gemini/.env` (the "trusted" rows of the `.env` table below; F6 pins them) |
| MCP servers started | `startConfiguredMcpServers` / discovery, `chunk-6T7N6JF2.js:365569`, `:365647`; stdio transport `:365215` | the owned settings carry no `mcpServers`, `.gemini/extensions` is never forwarded, and `isBlockedBySettings` (`:365441`) applies `--allowed-mcp-server-names` BEFORE the trust gate, so the sentinel blocks every name. P3 pins the sentinel |
| project `GEMINI.md` memory | `getEnvironmentMemoryPaths`, `:357559` | walks up from the cwd to the nearest `.git` ancestor, else the cwd alone. None of the scratch path's ancestors holds `.git` or `GEMINI.md` on this machine (existence check). A future `.git` above the scratch root would let an ancestor `GEMINI.md` into the prompt. That is a text channel, not MCP or credentials |
| project agents, skills, hooks, policies, commands | `:336477`, `:374172`, `:358614-358745`, `:337524` | `<cwd>/.gemini/{agents,skills,policies,commands}` and `<cwd>/.agents/`: absent (the operator's real ones sit under the REAL home, not the isolated one). The owned settings carry no `hooks` |
| non-default approval modes, extension registry URI | `gemini-ORQHD633.js:8383`, `:8320` | neither is requested: no argv flag, no owned settings key |

So trust opens no MCP or credential channel beyond what BR-108's owned files
already carry. The env var also reaches gemini's own children (git, seen by the
census), which read nothing from it.

**Refusing a harness at selection (the preflight).** `resolveBackend` in the
engine walks the harnesses through `preflightHarness`
(`cognition/backend/preflight.ts`), which makes no subscription call:

| check, in order | refused as | notes |
|---|---|---|
| `<bin> --version` exits 0 | `cli_missing` | the existing probe |
| every flag the REAL builder passes appears in the CLI's own help (`claude --help`, `codex exec --help`, `gemini --help`, `agy --help`, `opencode run --help`), run with the builder's env in an isolated home, 10 s | `cli_incompatible` | FAIL-OPEN: a help that exits non-zero, prints nothing or times out counts as usable, so a misread help can never refuse claude |
| opencode only: `~/.local/share/opencode/auth.json` exists | `not_logged_in` | existence only, never opened. It is opencode's sole subscription channel; claude (Keychain), codex (can be a keyring) and the gemini family are not listed, because a missing file there does not prove logged-out |

A refused harness is skipped like a missing one. A run on a fallback harness
carries `refused: [{harness, reason, detail}]` on `run_started`; when nothing is
usable the skip is `run_skipped reason=cli_missing` if every refusal is a missing
CLI, else `run_skipped reason=harness_refused` with the `refused` array. Neither
skip consumes budget. The verdict is cached per brain process, like the
`--version` probe: **restart the brain after upgrading an extractor CLI.**
Limits, stated: a `run_skipped` renders `ok` in `igris cognition health` (true of
`cli_missing` before BR-109; a follow-up TD owns rendering refusals as failing),
and perception's session-end `selectLlmExtractor` is not preflighted (no
fallback, and a `--help` spawn at init would add boot latency) — its runtime
failures are named by the detectors above.

**What the operator does, per reason:**

| harness | reason | action |
|---|---|---|
| opencode | `auth_error` (`Token refresh failed: 401`) or `not_logged_in` | `opencode auth login` in your own shell, then restart the brain |
| codex | `model_unsupported` (`… requires a newer version of Codex`) | upgrade codex, OR set `model` in `~/.codex/config.toml` to one the installed CLI serves (the isolated home carries that key verbatim) |
| gemini | `auth_error` (exit 41) | re-authenticate gemini-cli (`gemini`, then `/auth`) |
| gemini | `account_unsupported` (`This client is no longer supported for Gemini Code Assist for individuals…`) | nothing Igris can fix: the vendor retired the gemini-cli personal tier for this account. Use the `antigravity` harness (`llm_extractor.harness`, or put it first in `fallback_order`) |
| any | `cli_incompatible` | the installed CLI rejects the extractor's argv: check its version against the builder (`cognition/backend/spawn-map.ts`) |

**Proof.** `backend-harness-failures.test.ts` replays each CLI's measured bytes
(`fixtures/br109-cli-failures.ts`) from a stub binary through the real
`runBackend` (H1-H18, H12 through `runExtractor` into `event_log`; H15 is gemini's
live exit-55 stderr, H18 the false-positive rows);
`preflight.test.ts` pins the preflight (R1-R3, R7), `env.test.ts` and
`engine.test.ts` its wiring, and `isolation-file-channels.test.ts` P4 pins the
gemini argv against 0.45.0's declared options. The live PASS lines are recorded
in the proof tables below as each runs: gemini after BR-109's review; opencode
after `opencode auth login`; codex after the CLI is upgraded.

## what an extractor child inherits (TD-471, TD-472)

Every LLM child an instance spawns, whichever of the five harnesses runs it,
gets its env from one function, `subscriptionOnlyEnv` in
`cognition/backend/env.ts`. The perception session-end hook's detached parent
goes through the same function via `runBackend`. The function does three
things, in this order:

1. **Inherit only an allowlist** (TD-472). Every other inherited name is
   dropped, including names nobody has seen yet.
2. **Apply the builder's explicit injections.** These survive step 1. Today the
   only injection is `HOME`, set to the per-run isolated home.
3. **Drop every name ending `_API_KEY`**, even an injected one. FR-201: an
   extractor never spends metered credits.

| class | names kept | why |
|---|---|---|
| identity / filesystem | `HOME`, `USER`, `LOGNAME`, `PATH`, `SHELL`, `TMPDIR` | `HOME` is overridden by every builder. The claude Keychain entry is keyed by the account, and a token refresh WRITES it. `gemini` is `#!/usr/bin/env node`. codex exec runs shell commands. |
| locale / time | `LANG`, `TZ`, any `LC_*` (anchored: `MY_LC_X` is dropped) | output encoding |
| network | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` and their lowercase forms | without them no CLI reaches its API behind a proxy. A proxy URL can carry an operator credential; that is accepted. |
| CA | `NODE_EXTRA_CA_CERTS`, `NODE_USE_SYSTEM_CA`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CODEX_CA_CERTIFICATE` | `NODE_USE_SYSTEM_CA` is set on every live brain measured (4 processes, 2026-09-24, one machine). `CODEX_CA_CERTIFICATE` is in the codex 0.135.0 binary (a static read of names). |
| platform | `__CF_USER_TEXT_ENCODING` (macOS), `XDG_RUNTIME_DIR` + `DBUS_SESSION_BUS_ADDRESS` (Linux) | the Linux pair is for keyring auth through the session bus. That is code-read only; no Linux desktop has run it. |

**Why an allowlist and not a longer denylist.** A denylist has to name every
dangerous variable in advance, and it falls behind:

- TD-471's prefix rule (`CLAUDE*`, `ANTHROPIC_*`) was one day old when two
  claude-auth routing names it misses were found: `USE_LOCAL_OAUTH` and
  `USE_STAGING_OAUTH`. The live brains carry both, and the claude 2.1.281
  binary reads both.
- The opencode 1.14.22 binary names 92 distinct `*_API_KEY` providers (a static
  read of names).
- Igris defines credential names of its own that no harness prefix would ever
  cover: `IGRIS_BRAIN_API_KEY` and `BRAIN_API_KEY`.

What the children actually need is short and does not change much: the table
above.

**What is dropped, with the reason:**

- **Credential channels no CLI uses for its own auth:** `SSH_AUTH_SOCK`. It is a
  signing channel, and codex runs commands.
- **Claude-auth routing:** the whole `CLAUDE*` / `ANTHROPIC_*` namespace,
  including the desktop host-auth gate (TD-471), and `USE_LOCAL_OAUTH` /
  `USE_STAGING_OAUTH`.
- **Igris's own names:** every `IGRIS_*` name and `BRAIN_API_KEY`.
- **Metered credentials:** every `*_API_KEY`, plus metered or auth-routing
  names such as `CODEX_ACCESS_TOKEN`, `GOOGLE_CLOUD_ACCESS_TOKEN`,
  `GOOGLE_GENAI_USE_VERTEXAI`, `AWS_*` and `GITHUB_TOKEN`.
- **Code injection:** `NODE_OPTIONS`, `DYLD_*`.
- **Terminal bookkeeping:** `TERM`, `PWD`, `SHLVL`, `XPC_*` and
  `SECURITYSESSIONID`.

**Config pointers.** These are variables that could send a child to the
operator's REAL harness config instead of the isolated home:

| variable | harness | disposition |
|---|---|---|
| `HOME` | all | REPLACED with the isolated home, through the explicit injection |
| `PATH`, `TMPDIR` | all | KEPT. `PATH` decides which binary IS the CLI, and `TMPDIR` is scratch only. |
| `XDG_RUNTIME_DIR` | Linux keyring | KEPT. It is a socket directory, not a config directory. |
| `CLAUDE_CONFIG_DIR` | claude | STRIPPED (since TD-471) |
| `CODEX_HOME` | codex | STRIPPED |
| `GEMINI_CLI_HOME`, `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`, `GEMINI_CLI_TRUSTED_FOLDERS_PATH`, `GEMINI_SYSTEM_MD` | gemini, antigravity | STRIPPED |
| `ANTIGRAVITY_EXECUTABLE_DATA_DIR` | antigravity | STRIPPED |
| `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_CONFIG` | gemini, antigravity, opencode | STRIPPED |
| `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_AUTH_CONTENT`, `OPENCODE_DB`, `OPENCODE_TEST_HOME` | opencode | STRIPPED. `_CONTENT` is inline config, MCP included. |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | opencode and any XDG-aware CLI | STRIPPED. An operator whose opencode auth lives under a custom `XDG_DATA_HOME` loses it in the isolated home, because only `~/.local/share/opencode/auth.json` is forwarded (BR-109; the whole directory before it). That was already true before TD-472. |
| `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_PROFILE` | claude (Bedrock), opencode | STRIPPED |
| `NODE_OPTIONS` | gemini (node) | STRIPPED. `--require` loads operator code into the child. |

**When a harness needs something the list drops.** For example, a gemini
Workspace Code Assist account needs `GOOGLE_CLOUD_PROJECT`. The remedy is an
explicit injection in that harness's builder (`backend/spawn-map.ts`), named in
the MAINTAINING.md row. It is never a widening of what children inherit, and a
`*_API_KEY` never passes even that way.

**What the env rule cannot close.** An env rule cannot filter a file. The
files a child can read are the next section's rule (BR-108).

**Proof, per harness (AC-3).** Each harness is proved by one live headless call
under the allowlist. It runs beside a control call with TD-471's env on the
same argv and the same isolated home, so env is the only variable. The runs use
`brain-mcp-server/scripts/td472_child_env_probe.ts`, are operator-run, and
record the result envelope, booleans and env names only:

| harness | verdict | refresh witness | date / machine |
|---|---|---|---|
| claude | pending: runs after the TD-471 watcher's verdict | — | — |
| codex | `PRE_EXISTING` under BR-108's isolation: both arms exit 1 identically — the request authenticates and the server answers 400 "the 'gpt-5.6-sol' model requires a newer version of Codex" (the operator config's model outruns codex 0.135.0; BR-109) | no | 2026-09-24, codex 0.135.0, this machine |
| gemini | `PRE_EXISTING` — vendor-side (2026-09-25, gemini-cli 0.45.0, this machine): after BR-109's argv (`--prompt ''` + stdin, `--skip-trust`) both arms exit 1 with `account_unsupported` (the vendor retired gemini-cli's Code Assist for individuals tier; the login is valid — the token refreshed on the first pair). Nothing regressed; the harness decision is TD-474 | first pair yes, re-run no | 2026-09-25, gemini-cli 0.45.0, this machine |
| antigravity | `PASS` under BR-108's isolation: both arms answered (allow 12.7 s, base 10.1 s) | n/a (agy keeps no refresh witness) | 2026-09-24, agy 1.0.16, this machine |
| opencode | `PRE_EXISTING` (2026-09-24, opencode 1.14.22, this machine): both arms fail auth identically — the allowlist and the TD-471 env; nothing regressed; the isolated-HOME auth defect is BR-109 | — | — |

The unit and stub tiers already pin the rule for all five harnesses. They cover
metered names, pointers, the names TD-471 missed, and the real ambient env
reduced to the allowlist. `env.test.ts` and
`backend-child-env-allowlist.test.ts` hold these checks.

## what an extractor child can READ (BR-108)

The isolated home is an ALLOWLIST of files, the file-side twin of the env
allowlist above. Before BR-108 it forwarded each harness's state directory
minus a few excluded names, so every operator file nobody had named reached the
child: gemini's `settings.json` declaring `igris-brain`, codex's `config.toml`
with every MCP server, its plugin `.mcp.json` files, `.gemini/.env`, and the
operator's history and memory stores. Now `makeIsolatedHome`
(`cognition/backend/isolation.ts`) does three things:

1. **Symlinks forward only named auth stores** (`FORWARD`). A token refresh must
   reach the operator's file, so these are links, never copies.
2. **Writes every config file a child reads as an OWNED copy** (mode 0600) with
   MCP, hook and exec keys removed. An owned write refuses a linked ancestor, so
   it can never land in an operator directory.
3. **Adds each CLI's MCP switch** wherever the installed version is verified to
   honour it.

A file nobody named is never forwarded, so a new MCP server, config file or
plugin directory cannot reach a child. It fails closed.

| harness | symlinked forward (a missing source is skipped) | owned files | argv switch |
|---|---|---|---|
| claude | `Library/Keychains`, `.claude/.credentials.json` | `.claude.json`: the operator's copy minus `mcpServers`, `projects` (per-project MCP) and `primaryApiKey` (a metered Console key); every other key kept | `--strict-mcp-config`, no `--mcp-config` |
| codex | `Library/Keychains`, `.codex/auth.json` | `.codex/config.toml`: root-section lines for `model`, `model_reasoning_effort`, `cli_auth_credentials_store`, `forced_login_method`, `forced_chatgpt_workspace_id`, `preferred_auth_method` with a one-line scalar value, copied verbatim; then an owned `[features]` block setting `apps`, `in_app_browser`, `plugin_sharing`, `plugins`, `skill_mcp_dependency_install`, `tool_call_mcp_elicitation` to false | none (see the residuals) |
| gemini | `Library/Keychains`, `.gemini/oauth_creds.json`, `.gemini/google_accounts.json`, `.gemini/installation_id` | `.gemini/settings.json` with only `security.auth`, `selectedAuthType`, `model`; `.gemini/config/mcp_config.json` = `{"mcpServers": {}}`; empty `.env` and `.gemini/.env` | `--allowed-mcp-server-names __igris_extractor_no_mcp__`, then `--skip-trust` and `--prompt ''` with the prompt on stdin (BR-109) |
| antigravity | the gemini stores + `.gemini/antigravity-cli/antigravity-oauth-token`, `installation_id`, `cache/onboarding.json` | as gemini, plus `.gemini/antigravity-cli/settings.json` with only `model` | none (agy has no such flag) |
| opencode | `Library/Keychains`, `.local/share/opencode/auth.json` (the provider store only, BR-109; the whole directory before it) | none | none |

**Why each owned copy is shaped the way it is:**

- **gemini, antigravity and codex keep an allowlist of keys.** A new exec
  surface in a known file is dropped without anyone naming it: gemini `hooks`,
  `mcp.serverCommand`, `tools.discoveryCommand`, `advanced`; codex `notify`,
  `[plugins.*]`, `[hooks.*]`, `[projects.*]`.
- **claude keeps a key denylist.** claude is the production harness, and its
  `.claude.json` has many keys it may read at startup. `--strict-mcp-config` is
  the fail-closed MCP layer; the copy exists so no MCP-declaring file is linked
  and the metered key does not travel.
- **The codex TOML copy needs no parser dependency.** It only has to recognise
  what it KEEPS, so anything it cannot classify is dropped: tables, dotted keys,
  inline tables, arrays, multi-line strings. A line inside a multi-line string
  is never copied and never ends the root section. A parser gap can only drop
  more. A codex table header can carry arbitrary text (a project path), so no
  instrument prints one.
- **An unparseable source yields an owned file carrying nothing** (`{}` for
  JSON, the `[features]` block alone for codex). Auth then fails loudly
  (`auth_error`) instead of a partial copy passing.
- **The codex `-c` belt was measured, not assumed.** Against a
  fixture home that declares a server, `codex -c 'mcp_servers={}' mcp list
  --json` still lists that server, so the override does not replace the table.
  It is not passed. The old `-c mcp_servers.igris-brain.command=…` override is
  removed too: against an EMPTY config it CREATES an `igris-brain` entry (codex
  0.135.0, fixture homes, 2026-09-25).
- **The gemini allow list needs a name.** `--allowed-mcp-server-names` REPLACES
  the settings allow list and clears the block list, and a non-empty allow list
  blocks every other name. An EMPTY list blocks nothing, so the flag carries one
  name no server has (gemini-cli 0.45.0, `gemini-ORQHD633.js:8112`, `:8552-8553`;
  `chunk-6T7N6JF2.js:365440-365450`).

**No longer forwarded, by class:**

- **MCP / exec declarations:** codex `config.toml` (whole) and `plugins/`;
  gemini `settings.json`, `extensions/` and `config/hooks.json`; the whole of
  `.config/opencode/` (`opencode.json`, any `opencode.jsonc` or `config.json`,
  the plugin `package.json` / `node_modules`, `command/`); opencode's
  `mcp-auth.json` (MCP OAuth tokens, BR-109).
- **Igris OS context:** `.gemini/agents/`, `.config/opencode/command/`,
  `.codex/AGENTS.md`.
- **Metered-key files:** `.gemini/.env`, `.codex/.env`.
- **Operator memory and history:** codex `memories_1.sqlite`, `history.jsonl`,
  `state_5.sqlite` and sessions; gemini `tmp/` and `history/`; agy
  `conversation_summaries.db`, `history.jsonl` and `jetski_state.pbtxt`; opencode
  `opencode.db*`, `storage/`, `snapshot/` (git object stores of operator projects)
  `log/` and `tool-output/` (BR-109). Before these fixes a gemini, codex or opencode child wrote
  its session of untrusted text into those directories through the links. It now
  writes into the reaped scratch home.

**`.env` files (gemini family).** gemini-cli 0.45.0's `findEnvFile`
(`chunk-EUYIPFPA.js:16388-16419`) returns the FIRST hit, walking up from the
workspace directory, which is the child's cwd (the isolated home). At each
directory it checks `<dir>/.gemini/.env` (trusted folders only), then
`<dir>/.env` (unless `ignoreLocalEnv`, except at `homedir()`). At `/` it falls
back to `homedir()/.gemini/.env` (trusted), then `homedir()/.env`. In an
untrusted folder it still loads the keys on its auth-variable whitelist, and
folder trust is on by default (`:14057`). The scratch root sits under the real
HOME, so every ancestor of the isolated home is the operator's. Since BR-109 the
gemini argv passes `--skip-trust`, so a gemini child walks the "trusted / off"
row; agy is untrusted.

| folder trust / `ignoreLocalEnv` | first file found before BR-108 | first file found now |
|---|---|---|
| untrusted (the default) / off (the default) | the first ancestor `.env`, including `~/.igris/.env` and `~/.env` | `<iso>/.env` (empty) |
| trusted / off | `<iso>/.gemini/.env`: the FORWARDED operator file | `<iso>/.gemini/.env` (empty) |
| trusted / on | an ancestor `.gemini/.env`, the real one included | `<iso>/.gemini/.env` (empty) |
| untrusted / on | `homedir()/.env` | `<iso>/.env` (empty) |

Every row ends at an owned empty file. The owned `settings.json` does not carry
`advanced`, and the builder never passes `--ignore-env`: that switch skips
`<iso>/.env` whenever `homedir()` is not byte-equal to the cwd, which weakens
the stop. codex's `$CODEX_HOME/.env` and opencode's cwd `.env` are moot, since
neither home contains one.

**Linux claude.** claude on Linux keeps its credentials in
`~/.claude/.credentials.json`. It is forwarded as a link (skipped when absent,
the normal macOS case), so `.claude/` in the isolated home holds that one link
and nothing else. This is code-read only; no Linux machine has run it.

**Residuals — MCP config OUTSIDE the home we own:**

- gemini system settings: covered by the argv switch, which applies to every
  settings layer.
- codex `/etc/codex/*` and managed config: NOT covered. The replace-semantics
  belt measured false, so no argv closes them.
- claude managed MCP: `--strict-mcp-config`, as documented upstream.
- agy system-level config: unknown.
- Remote connectors (codex `apps`, claude.ai connectors) spawn no local
  process, so a process census cannot see them. codex's are denied by the owned
  `[features]` block. codex `computer_use`, `browser_use` and
  `browser_use_external` stay on; they are not MCP by name, and the measured
  `computer-use` MCP server is plugin-provided, with `plugins/` not forwarded
  and `plugins` denied.
- A CLI that refreshes a linked token by write-temp-then-rename replaces the
  link in the scratch home, and the rotated token is reaped. That was already
  true of codex and gemini before BR-108. The probe's refresh witness observes
  it, and since BR-109 each arm also records `forward_links_intact`. opencode
  1.14.22 writes `auth.json` IN PLACE (`Auth.set` → `writeJson` → `fs.writeFile`,
  a static read of the binary), so its file link survives a refresh; before
  BR-109 the whole directory was linked, which was rename-safe.

**Versions read.** gemini-cli 0.45.0 (static read of the installed bundle),
codex-cli 0.135.0 (offline commands against fixture homes), agy 1.0.16 (a
`strings` read of names). A newer version re-runs those reads before this
section moves (the MAINTAINING.md row).

**Proof (BR-108 AC-2).** `isolation-file-channels.test.ts` pins the rule for
every harness against a fixture operator home: no MCP name is reachable,
symlinks followed (F1); the home's manifest equals a second spelling
(`fixtures/br108-isolated-home.ts`) by exact membership (F2); the `.env` stop
is checked against a verbatim replica of `findEnvFile` with a positive control
(F6). The live calls use `brain-mcp-server/scripts/td472_child_env_probe.ts`,
which adds a process census to each arm (local processes only, with a canary
self-test that must fire), a `--preflight-only` mode and a `BLOCKED_ARGV`
verdict:

| harness | BR-108 live verdict | date / machine |
|---|---|---|
| claude | pending: after the TD-471 watcher's verdict, with `--mcp-inventory`; a pre-deploy gate for the owned `.claude.json` | — |
| codex | no MCP process spawned in either arm (census `cli_seen` true, `mcp_spawned` false); `codex login status` reads logged-in inside the isolated HOME; the call itself fails on the model-version 400 above (not auth; BR-109) | 2026-09-24, codex 0.135.0, this machine |
| gemini | no MCP process spawned in either arm of either live pair (census `cli_seen` true, `mcp_spawned` false; forward links intact); the call itself is refused by the vendor (`account_unsupported`, 2026-09-25 re-run) — a PASS is not reachable for this account, the harness decision is TD-474. Structural proof: F1 / F6 / P3 / P4 green | 2026-09-25, gemini-cli 0.45.0, this machine |
| antigravity | `PASS`: both arms answered, no MCP process spawned (census `cli_seen` true, `mcp_spawned` false) | 2026-09-24, agy 1.0.16, this machine |
| opencode | not in BR-108's live AC. On this machine only `opencode.json` existed, and it was already excluded; an `opencode.jsonc` or `config.json` DID reach the child before BR-108 (F1 at HEAD) | — |

## the layer is open

A new instance is a new self-describing extractor file plus one barrel line; the
host does not change. The one thing an instance MUST declare beyond its four
slots is its `health` block — its event namespace literals, its gate keys, its
driver and its output destination. That field is REQUIRED, not optional, because
an instance that cannot say how an operator sees it stop can ship invisible, and
that is exactly what happened to five of these seven.
