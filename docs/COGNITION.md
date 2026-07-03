# the cognition layer — configuration

IGRIS's inferred-memory subsystem: a host running single-purpose LLM instances
that observe the brain and *propose* candidates for your review. It ships
**disabled by default** — a fresh install observes nothing until you enable it.

## enabling

Config lives in `~/.igris/config.json` under `cognition`. Each instance has a
master switch; absent or `false` = off.

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

## the instances

| instance | job |
|---|---|
| perception | session transcripts → proposed learnings |
| subconscious | brain digest → suggestions (stalled briefs, gaps, patterns) |
| synapse | infers relationship edges between learnings |
| janitor | de-duplicates near-identical learnings |
| arbiter | resolves contradicting learnings |
| curator | prunes stale learnings |
| cartographer | clusters related learnings into one meta-learning |

The layer is open: a new instance is a new self-describing extractor file — the
host doesn't change.
