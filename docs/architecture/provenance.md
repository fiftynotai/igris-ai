# Provenance — Learnings

**Brief:** FR-107 — Provenance Tags on Learnings
**Status:** Phase 1 (tagging) shipped. Phase 2 (re-ranking) deferred.
**Schema:** `learnings.provenance` (DB v14, see `brain-mcp-server/src/db.ts`).

## Vocabulary

The `learnings.provenance` column records *how* a learning was acquired — its
origin and trust level. The five accepted values are:

| Value            | Meaning                                                                                  |
|------------------|------------------------------------------------------------------------------------------|
| `observed`       | Directly captured from a concrete event, log, file, or user-pasted artifact. Default.    |
| `inferred`       | Derived by reasoning over other learnings or evidence; not directly seen.                |
| `synthesized`    | Fused from multiple sources (e.g., recall + research + edges) into a new artifact.       |
| `ambiguous`      | Source provenance is unclear or contested; treat with caution.                           |
| `human_asserted` | A human explicitly told us this fact and asserted it as ground truth.                    |

The vocabulary is enforced at three layers:

1. **MCP JSON Schema** — `igris_memory_store` tool's `provenance` parameter is an `enum`.
2. **Handler** — `validateMemoryInput` rejects unknown values with a clear error.
3. **Database** — `CHECK (provenance IN (...))` rejects direct INSERT/UPDATE attempts that bypass the handler.

## Default

`provenance` defaults to `'observed'`. The DB schema declares
`DEFAULT 'observed'`, so existing rows backfill in O(1) when the migration runs
and any handler call that omits `provenance` lands on the same default.

## Surfaces

Provenance is **input** on `igris_memory_store` (optional) and **output** on:

- `igris_memory_store` — confirmation message includes `Provenance: <value>`
- `igris_memory_search` — every result row
- `igris_memory_recall` — every result row
- `igris_memory_get` — single result
- `igris_memory_hybrid_search` — every result row (both BM25-only fallback and hybrid paths)

Phase 1 surfaces the tag only. Phase 2 will weight ranking by provenance — that
work is **out of scope for this brief**.

## Divergence with `entity_edges.provenance`

Edges and memory both have a column called `provenance`, but the vocabularies
are different and intentionally so:

| Component  | Values                                              | Source          |
|------------|-----------------------------------------------------|-----------------|
| edges      | `observed`, `backfill`, `inferred`, `user`          | FR-105          |
| learnings  | `observed`, `inferred`, `synthesized`, `ambiguous`, `human_asserted` | FR-107          |

The two columns describe different domains:

- **Edges** describe graph relationships between entities — a graph edge is
  either *seen in the data* (`observed`), *inserted by a backfill job*
  (`backfill`), *deduced from other edges* (`inferred`), or *manually drawn by
  a user* (`user`).
- **Learnings** describe **knowledge artifacts** — declarative facts captured
  by the system. The relevant axis is the trust/origin spectrum from direct
  observation through reasoning, fusion, ambiguity, and explicit human
  assertion.

Do **not** extract a shared `VALID_PROVENANCE` constant. The two vocabularies
will continue to diverge as each domain matures, and a shared constant would
force them to converge artificially.

## Usage Examples

```ts
// Default — direct capture from a concrete artifact
await igris_memory_store({
  project: 'my-app',
  category: 'pattern',
  title: 'Use WAL mode for SQLite under concurrent reads',
  content: '...',
});
// → provenance: 'observed'

// Reasoning-derived: seeker concluded this from other learnings
await igris_memory_store({
  project: 'my-app',
  category: 'decision',
  title: 'This codebase will benefit from connection pooling',
  content: '...',
  provenance: 'inferred',
});

// Cross-source fusion: distilled from recall + edges + brief context
await igris_memory_store({
  project: 'my-app',
  category: 'pattern',
  title: 'Standard MVVM+GetX layering for Flutter modules',
  content: '...',
  provenance: 'synthesized',
});

// Source unclear — record but flag for later verification
await igris_memory_store({
  project: 'my-app',
  category: 'discovery',
  title: 'Possibly the cause of the intermittent 500s',
  content: '...',
  provenance: 'ambiguous',
});

// User explicitly asserted this as ground truth
await igris_memory_store({
  project: 'my-app',
  category: 'decision',
  title: 'We will not adopt server components in this app',
  content: '...',
  provenance: 'human_asserted',
});
```

## Agent Conventions

The following conventions describe **how agents should choose a provenance
value**. These are conventions, not enforced rules — code does not check them.

- **architect**, **forger**, **sentinel**, **warden** — capturing what they
  directly read in the codebase or test output: `observed` (the default).
- **seeker** — when storing reasoning-derived learnings (e.g., "this looks
  like the same pattern we saw in project X"): `inferred`.
- **mender** — when bundling root-cause hypotheses across multiple errors:
  `synthesized`.
- Any agent — when capturing user-confirmed ground truth (e.g., "user said the
  feature must support offline mode"): `human_asserted`.
- Any agent — when the source of a fact cannot be reliably determined:
  `ambiguous`.

> **Note (deferred work):** Updating the seeker agent definition (and other
> agent prompts) to explicitly set `provenance` is a follow-up brief. Phase 1
> ships the surface and the conventions; agent prompts will be updated in a
> later pass.

## Phase 2 (deferred)

Re-ranking by provenance is **not** in scope for FR-107. When Phase 2 lands,
the expected behavior is roughly:

- `human_asserted` ranks highest (≈ 1.4× boost)
- `observed` ranks at baseline (1.0×)
- `synthesized` slightly below baseline (≈ 0.9×)
- `inferred` lower (≈ 0.8×)
- `ambiguous` lowest (≈ 0.6×)

The exact weights and where they apply (recall composite score? hybrid RRF?
both?) will be decided based on production retrieval quality data once Phase 1
has been live for long enough to observe usage patterns.
