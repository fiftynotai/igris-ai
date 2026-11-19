# Session attention (FR-276)

The brain graph is the durable map. Each chat gets an independent activity
record that highlights resources delivered and capabilities invoked during that
chat. Boot establishes the recording before its first instrumented read; rest
closes it without deleting its history.

This is an operational view of attention. It cannot measure model-internal
attention or prove that previously delivered content remains in context.

## Identity and storage

An attention session has its own UUID. Project, live instance, native harness
chat, machine, and parent session are separate optional bindings. A missing
native chat ID remains unknown. Neither project equality, recency, nor process
identity merges recordings. Early events survive a later instance binding and
removal of the live instance.

The attention component owns three machine-local tables: `attention_sessions`,
`attention_events`, and `attention_tool_inventory`. They are excluded from
replication and portable project export. An HTTP-served brain (`--http` or
`BRAIN_HTTP`, as the VPS runs) does not boot the component at all
(`LOCAL_ONLY_COMPONENTS` in `engine/index.ts`): no attention tables and no
`igris_attention_*` tools. Events store references and delivery
metadata, never document bodies, tool arguments, credentials, or transcripts.
Database transactions allocate per-session sequence numbers. Timestamps are
brain-owned. An operation ID plus event key makes each event retry idempotent;
a repeated tracked tool operation is refused before it can repeat a side effect.
External reports accept an optional `event_key`. The default identifies the
individual kind, node, outcome, and extent, so one operation can report multiple
nodes or start and finish. Exact retries deduplicate; reusing a key for changed
evidence is refused. Session IDs use RFC UUID version/variant validation.

Resource identity uses the existing structured triple `(type, project, id)` and
escaped graph key. Revision hashes are metadata, never part of identity. A
learning shared across projects keeps its original owner when highlighted.

## Evidence vocabulary

| Evidence | Meaning |
|---|---|
| Available | Discovered in an inventory; delivery or invocation is not implied |
| Preview | Only part of a resource was delivered |
| Full | The resource was delivered in full at the recorded time |
| Invoked | An observed capability call; outcome is recorded separately |
| Failed | A recorded attempt failed; any earlier success remains inspectable |
| Self-reported | A caller asserted the activity through the public event API |
| Historical | Evidence from an earlier explicitly observed context epoch |
| Unknown | Observation cannot establish the extent, binding, or coverage |

The inspector exposes actor, sequence, epoch, time, origin, outcome, extent,
revision, and byte count where known. Missing values remain unknown. A summary
or document pointer is never upgraded into full document delivery. Reconciliation
of project context files and discovery of a tool roster do not count as loading
those files or invoking those tools.

An explicit `epoch` action records context reassembly or an observed compaction.
Without a verified adapter signal, compaction coverage remains unknown. Ending a
recording preserves its evidence; interrupted recordings use a distinct status.

## Selection explanations

Selection is separate from delivery evidence. Each new receipt can carry nullable
`selection` metadata: `category` (`boot`, `task`, `retrieval`, `user_request`),
`provenance` (`caller_declared`, `observed`), and an optional `reference`.
References are 1–128 identifier characters (letters, digits, colon, underscore,
hyphen), starting with a letter or digit. They are not task prose or queries.
The existing `reason` field continues to hold failure, epoch or coverage notes.

Public input accepts only category/reference and always records caller-declared
selection. A trusted loader delivery does not upgrade its caller's rationale.
Declared tool selection propagates to its invocation and delivery receipts.
Without a declaration, successful formatter-owned deliveries at known retrieval
boundaries can record observed retrieval with the tool identifier. A tool
invocation alone establishes no selection cause for other resources.

Migration v2 adds a nullable event field. Readers accept the v1 schema without
migrating it, and old events display **Not recorded**. Existing local write paths
upgrade the ledger before recording new events. No historical backfill is made.
Selection participates in retry comparison, and invalid input is rejected before
resource delivery or target execution. Caller input cannot claim observed
selection provenance.

## Capture boundaries

`engine/components/attention/capture.ts` wraps the existing strict gateway in a
request-scoped collector. The target receives its original argument object.
Response formatters report structured observations for the content they actually
emit. Pure read modules contain no telemetry writes. Native uncorrelated calls
retain their existing behavior and are outside this coverage.

The facade preserves the target's `content` and `isError`, adding
`_meta.igris_attention`. Recording failure does not replace a successful target
result. Invalid or unknown sessions, nested attention calls, and duplicate
explicit operation IDs are rejected before dispatch.

A collection exceeding the per-call bound records a durable coverage gap, so
reloading the dashboard cannot hide incomplete observation.

The resource loader accepts discovered resource identities rather than arbitrary
paths. The OS loader and inventory both honor `IGRIS_BRAIN_DIR`. It returns content to its caller but records only metadata. Reads default
to 256 KiB and cap at 2 MiB; truncation is UTF-8 safe and produces preview evidence.

Existing memory access-count behavior belongs to the underlying native call.
Attention adds no learning score, confidence update, or semantic-edge update.
Dashboard inspection uses pure readers and causes no access-count increment.

## Inventory

The inventory discovers OS modules, identity documents, project context files,
skills, agents, and published brain tools. Canonical IDs distinguish core,
registry, and brain ownership. Symlink aliases do not create extra capabilities.
Source availability and gaps accompany the result.

Installed capabilities and published brain tools do not prove exposure to a
particular chat. `availability_scope` distinguishes installed, published, and
verified chat exposure. Unknown harness or connector inventories stay unknown.
The inventory never reads secret-bearing connector configuration to infer tools.

The dashboard merges this inventory with the knowledge graph. It does not add
synthetic semantic edges. An edge joining two highlighted nodes remains a
semantic relationship, never an inferred retrieval path.

## CLI and MCP

The local CLI records against its resolved local brain database. It never sends
a local session token through a remotely configured MCP connection. The MCP
facade is usable only against the brain that owns the recording.

```bash
# Retain the returned session.id explicitly between commands.
igris attention begin --project igris-ai --harness codex
igris attention inventory --project igris-ai
igris attention read --session "$SESSION_ID" --type os_module --id igris-core:INDEX --selection boot --selection-ref boot:index
igris attention show --session "$SESSION_ID"
igris attention epoch --session "$SESSION_ID" --operation resume-1 --reason 'Context reassembled'
igris attention end --session "$SESSION_ID"
```

Use an ID returned by `inventory` for each resource read. Use `call --tool …
--args-file …` to correlate an ordinary brain operation; the arguments file must
contain a JSON object of at most 2 MiB. Those arguments can carry query text, so
the instructions (`/boot` §4.3, `core/os/conduct.md`) create the file with
`umask 077; f=$(mktemp)` (mode 0600), pass it as `--args-file "$f"`, and delete
it with `rm -f "$f"` as soon as the call returns, whether it succeeded or failed,
all in one shell command (a `trap 'rm -f "$f"' EXIT` in a subshell). The ledger
never stores the arguments. `event` records explicitly labeled self-reports. `bind`
attaches a verified native chat ID or the newly registered live instance; an
instance ID outside `^[a-zA-Z0-9_-]{1,256}$` is a usage error (exit 2).
`sessions` lists recordings, including completed ones. `--event-key` names an
individual external receipt when several belong to one operation.

The MCP component publishes `igris_attention_session`,
`igris_attention_event`, and `igris_attention_call`. Public event submissions
cannot claim the trusted loader or tool-boundary origin. Strict tool schemas
continue to reject undeclared top-level arguments.

Only explicit begin initializes the attention schema through the CLI write door.
It never creates a missing brain database. Correlated calls boot the local
vendored engine with schedules disabled and dispose it on exit.

## Dashboard

`#/graph?session=<uuid>` selects one recording and preserves an existing focus
parameter. Session selection is independent of graph selection. A parent or
child link follows explicit recorded identity, never a project-based guess.

| Read route | Result |
|---|---|
| `/api/attention/sessions?project=&before=&limit=` | Recording list and pagination cursor |
| `/api/attention/session?session=&through=&before=&limit=` | Reproducible snapshot and bounded event history |
| `/api/attention/inventory?project=` | Discovered nodes, source coverage, and revision |

Limits are 1–100. Malformed parameters return 400; an unknown session returns
404. Missing schema, brain, or compatible runtime returns explicit degraded
coverage. These GET routes use read-only connections and retain the dashboard's
loopback, same-origin, and no-store fences. They add no write endpoint.

Topology and activity have separate lifetimes. Graph and inventory load together
on scope change or explicit refresh. Visible activity polls every five seconds;
a hidden tab pauses and refreshes on return. Switching chat discards stale
responses. Replay selects a sequence cutoff; returning to live resumes updates.
Activity changes repaint existing nodes without restarting layout, moving the
camera, replaying entrance motion, or fetching topology again.

A selected recording defaults to **This chat**, a visibility lens over the loaded
topology. **Whole brain** restores the broader map. **Show related nodes** adds
one semantic hop from recorded nodes; those neighbours do not gain activity
markers without their own evidence. The related-node explanation explicitly
separates a knowledge relationship from loading.

The lens hides excluded glyphs, labels, pointer targets, and links, while keeping
settled positions and topology intact. Visible counts and density follow the
lens. Explicit lens/session entry and Fit can frame its visible nodes; live polls
repaint membership without moving the camera. New references absent from loaded
topology remain in the evidence list until a topology refresh.

The inspector presents **Why selected** for each receipt, separating observed
retrieval from caller-declared boot/task/user-request reasons. History and replay
use the metadata of the recorded event, never a guess based on today's policy.

Shape continues to encode role: OS modules and context documents use STORE,
skills use SERVICE, agents use AGENT, and tools use TOOL. Evidence has text labels
and an independent visual treatment. Hover and selection never create recorded
activity. Unresolved references remain visible in the evidence list.

## Retention and storage growth

There is no automatic expiry or deletion of attention recordings. Ending a
session preserves all events; bounded history pages and bounded inspector
contributors limit response size, not stored history. Storage grows with recorded
operations. The snapshot exposes `latest_sequence` and `through_sequence`; the
history uses them to show the recording's event count and replay position.

A snapshot is bounded. It reduces the newest 2,000 events at its cutoff into at
most 100 node states, keeping the most recently active, and each node carries at
most 2 supporting events: the decisive one and the latest. `truncated` and
`counts` report the bound, and a truncated snapshot also says so in
`degraded.reason` (a `Snapshot bounded: …` sentence). Older evidence stays
reachable through history paging. `igris attention show` exits 0 for a
snapshot whose only degradation is this bound: it still carries
`truncated: true`, `counts` and that sentence. It exits 3 only when attention is
unavailable or the snapshot is degraded for another reason.

For a machine-wide count, inspect the local database read-only:

```sql
SELECT status, COUNT(*) AS sessions FROM attention_sessions GROUP BY status;
SELECT COUNT(*) AS events FROM attention_events;
SELECT session_id, COUNT(*) AS events FROM attention_events GROUP BY session_id;
```

No cleanup command ships in this change. A future retention action must preserve
explicit user control and must not silently remove histories from ended chats.

## Deployment and verification

Build the brain before the CLI so the CLI vendors the matching runtime. Install
the compatible CLI before mirroring boot instructions that use these commands.
Older runtimes must keep boot usable and report missing observation coverage.
A dashboard service that cannot start must not block boot or invent a usable URL.

Validation covers real component migrations, concurrent sibling recordings,
retry ordering, strict-gateway response parity, truncated and failed delivery,
epoch replay, rest persistence, local-only storage, query-only dashboard reads,
and browser behavior across session switches and activity updates. The detailed
implementation plan is in
`~/.igris/projects/igris-ai/plans/FR-276/implementation-plan.md`.
