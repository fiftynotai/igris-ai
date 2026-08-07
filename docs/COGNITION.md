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

### synapse

**Job.** Reads pairs of related learnings and proposes the RELATIONSHIP between
them — this one derives from that one, these two duplicate each other, this one
contradicts that one. It is how the brain becomes a graph rather than a list.

| | |
|---|---|
| **gate** | `cognition.synapse.enabled` |
| **driver** | the `synapse_engine` schedule (daily, 03:00 UTC) |
| **output** | `suggestions` rows with `source_module='edge_inference'` |

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

### arbiter

**Job.** Finds learnings that CONTRADICT each other — semantically close but
opposed — and proposes which one wins and why. The loser is superseded rather
than deleted, so the lineage survives.

| | |
|---|---|
| **gate** | `cognition.janitor.enabled` — **it has no switch of its own** |
| **driver** | co-driven by the `janitor` instance |
| **output** | `suggestions` rows with `source_module='arbiter'` |

### curator

**Job.** Finds learnings that have gone STALE — old, never accessed, tagged
deprecated — and proposes pruning them. Every prune is logged with its
pre-state, so it can be undone by run.

| | |
|---|---|
| **gate** | `cognition.janitor.enabled` — **it has no switch of its own** |
| **driver** | co-driven by the `janitor` instance |
| **output** | `suggestions` rows with `source_module='curator'` |

### cartographer

**Job.** Detects CLUSTERS of related learnings in the edge graph and proposes a
single meta-learning that summarises each one — turning twelve scattered notes
into one thing you can actually recall.

| | |
|---|---|
| **gate** | `cognition.janitor.enabled` **AND** `cognition.janitor.cluster.enabled` |
| **driver** | co-driven by the `janitor` instance, additionally throttled to once per `cluster.cadence_days` (7) |
| **output** | `suggestions` rows with `source_module='cartographer'` |

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
