# Perception Dedup Tuning (TD-087)

**Status:** Implemented
**Ship date:** 2026-05-04
**Predecessor:** TD-086 (cheap-dedup pre-filter, threshold 0.85)

## Problem

After TD-086 shipped, re-running perception on the same transcript still
inserted ~9 candidates. The dedup pre-filter at threshold 0.85 was missing
LLM paraphrases of insights it had already stored.

The motivating example surfaced in the live corpus:

| id | title |
|----|-------|
| 143 | Three-engine brain architecture: perception + subconscious + janitor with shared LLM-extractor primitive |
| 152 | Three-engine brain framing: perception, subconscious, janitor — one shared LLM-extractor primitive |

Same insight, different phrasing. Stored cosine: **0.8134** — below the
TD-086 threshold of 0.85, so the dedup missed it.

The hypothesis: the LLM rephrases the **body** more aggressively than the
title. Em-dashes vs colons, "+" vs commas, "architecture" vs "framing" —
all swing the embedding out of the dedup neighbourhood.

## Solution shipped (Option A+C combined)

**Two layered changes** in `brain-mcp-server/src/engine/components/perception/`:

1. **Pre-normalise embedding inputs** (`dedup.ts::normalizeForDedup`) — collapse
   phrasing entropy before the model sees the text. Rules in order:
    1. lowercase
    2. strip leading bullet markers (`-`, `*`, `•`) per line
    3. replace ALL dash variants (`-`, `–`, `—`, `−`, hyphen) with space
    4. drop structural punctuation (`. ! ? : ; , " ' ( ) [ ] { } | < > + = * ~ ^ @ # $ % &`)
    5. collapse whitespace runs (incl. tabs, newlines) to single space
    6. trim
   The same normalisation is mirrored in the perception persist path
   (`cognition/extractors/perception.ts::persistCandidate`) so perception-channel
   stored embeddings live in the same space as dedup queries. Note this
   consistency holds **only for the perception channel** — the manual
   `igris_memory_store` channel embeds RAW `${title} ${content}` regardless of
   date, so its stored geometry stays un-normalised until backfilled (see
   [Backfill decision](#backfill-decision) — the TD-286 channel-aware backfill).

2. **Lower the default threshold** from 0.85 → 0.80 (`types.ts`
   `DEFAULT_PERCEPTION_CONFIG.dedup_cosine_threshold`). Operator overrides
   via `~/.igris/config.json` `perception.dedup_cosine_threshold` and
   `IGRIS_PERCEPTION_DEDUP_THRESHOLD` continue to work exactly as before.

The motivating L-143/L-152 pair: **post-normalisation cosine = 0.8878**
(vs raw 0.8134), well above the new 0.80 threshold.

## Empirical justification

### Corpus snapshot

- DB: `~/.igris/memory/knowledge.db` at 2026-05-04
- Rows analysed: 143 with non-null embeddings (project: igris-ai)
- Pair distribution by `cosine_full` (over stored embeddings):

| Band | Pair count |
|------|-----------:|
| ≥ 0.95 | 1 |
| [0.90, 0.95) | 80 |
| [0.85, 0.90) | 181 |
| [0.80, 0.85) | 150 |
| [0.75, 0.80) | 86 |
| < 0.75 | 9655 |

### Methodology

- Read-only corpus dump via `scripts/dedup_corpus_eval.ts` (raw Float32Array
  cosine over `learnings.embedding` BLOB — L-67 pattern; vec0 is for K-NN
  search not pair-wise cosines).
- For each pair, computed three modalities:
    - `cosine_full` — over the stored embedding (the TD-086 baseline).
    - `cosine_title_only` — re-embedding `title` only.
    - `cosine_normalized` — re-embedding `${normalize(title)} ${normalize(content)}`.
- Stratified sample of 201 pairs across bands, force-including the
  L-143/L-152 reformulation pair for calibration.
- Hand-labelled (cluster-pattern heuristic + manual review of borderline
  pairs): **102 TRUE_DUP, 99 DISTINCT, 0 blank**.
- Cluster patterns identified (each cluster has 2-7 paraphrase rows):
  sqlite-vec mutex teardown, mock-at-I/O-boundary, BR-062 verify_mirror,
  SYNC_TABLES filter, set +e/set -e bracket, three-engine brain.

### F1 across options

| Option | TP | FP | FN | Precision | Recall | F1 |
|--------|---:|---:|---:|----------:|-------:|---:|
| A only — full @ 0.85 *(TD-086 baseline)* | 100 | 0 | 2 | 1.000 | 0.980 | 0.990 |
| A only — full @ 0.80 | 101 | 0 | 1 | 1.000 | 0.990 | 0.995 |
| A only — full @ 0.75 | 102 | 0 | 0 | 1.000 | 1.000 | 1.000 |
| B only — title @ 0.85 | 51 | 0 | 51 | 1.000 | 0.500 | 0.667 |
| B only — title @ 0.80 | 64 | 0 | 38 | 1.000 | 0.627 | 0.771 |
| C only — norm @ 0.85 | 98 | 0 | 4 | 1.000 | 0.961 | 0.980 |
| **C+A — norm @ 0.80** *(SHIPPED)* | **101** | **0** | **1** | **1.000** | **0.990** | **0.995** |
| C only — norm @ 0.75 | 102 | 0 | 0 | 1.000 | 1.000 | 1.000 |

**Precision saturated at 1.000 across all options on this corpus** — the
labelled clusters are tight enough that no genuine DISTINCT pair surfaced
above 0.75 cosine in any modality. This is a precision floor finding, not
a guarantee future LLM behaviour shifts will preserve it (see Risks).

**Why C+A and not A@0.75 or A@0.80 alone?** Two reasons:

- A alone tightens a knob without addressing the root cause (LLM phrasing
  entropy in body). Future LLM upgrades that rephrase more aggressively
  would need yet another threshold drop. Normalisation reduces the entropy
  source itself.
- A@0.75 ties the F1 ceiling (1.000) but is more aggressive than the data
  warrants — the FN at 0.80 is a single borderline pair, and going to 0.75
  would invite future false positives once the corpus grows.

The combined ship trades a 5pp threshold drop for a structurally smaller
neighbourhood-of-similarity, giving the dedup margin against future LLM
output shifts.

## Live e2e results (Phase 4)

Two harnesses:

### Deterministic e2e (controlled — proves the dedup pipeline works)

`scripts/td087_e2e_deterministic.ts` — stub LLM extractor returning 8
candidates with mild paraphrasing across 5 sequential runs.

| Run | extracted | inserted | deduped |
|----:|----------:|---------:|--------:|
| 1 | 8 | 8 | 0 |
| 2 | 8 | 2 | 6 |
| 3 | 8 | 0 | 8 |
| 4 | 8 | 1 | 7 |
| 5 | 8 | 2 | 6 |

**Pass.** Run 3 onward: inserted ≤ 2 (plan acceptance). Stretch goal of
inserted=0 hit on run 3.

Sampled 5 deduped IDs — all TRUE-positive merges. Anchor row
`seen_again_count` = 4 across the steady-state cluster anchors (rows 1, 2,
3, 5 in the scratch DB). No false-positive merges identified.

### Real-LLM live e2e (claude-CLI driven)

Fixture: `test/fixtures/td087/transcript_steady_state.jsonl` (6KB,
synthesised TD-087 work session).

| Run | extracted | inserted | deduped |
|----:|----------:|---------:|--------:|
| 1 | 6 | 6 | 0 |
| 2 | 4 | 1 | 3 |
| 3 | 6 | 3 | 3 |
| 4 | 5 | 3 | 2 |
| 5 | 5 | 4 | 1 |

**Partial pass.** The dedup IS working — 9 dedups across runs 2-5, all
TRUE-positive merges. But **inserted ≥ 3** on runs 3–5, above the
plan's "≤ 2" criterion.

Diagnosis: the real LLM produces SEMANTIC paraphrases that diverge enough
from prior-run text to land in the **0.69-0.78 cosine band** — well below
the 0.80 threshold and well below ANY safe cheap-dedup threshold. Examples
from the e2e DB (`/tmp/td087_e2e.db`):

| id_a | id_b | cosine | shared insight |
|-----:|-----:|-------:|----------------|
| 9 | 12 | 0.7387 | "deterministic e2e using stub LLM" |
| 4 | 13 | 0.7508 | "dedup query embedding must use same transform" |
| 13 | 16 | 0.6899 | "embed-time/dedup-time normalisation must match" |
| 8 | 15 | 0.7370 | "combine normalization + threshold drop" |

These are semantic paraphrases beyond the reach of TD-087's cheap-dedup.
Per the plan's "Out of Scope" section, semantic merge is FR-119 / FR-116
janitor territory — a follow-up, not a TD-087 regression.

### Decision

Ship A+C @ 0.80 as the new defaults. The deterministic e2e proves the
pipeline change works as intended. The real-LLM result documents the
boundary where cheap-dedup ends and the FR-119 semantic-merge job begins.

## Operator monitoring guidance

### `seen_again_count` distribution

The cleanest signal that dedup is misbehaving: `seen_again_count`
distribution shifts unexpectedly between releases.

```bash
# Per-row: how many times each learning has been re-discovered
sqlite3 ~/.igris/memory/knowledge.db "
  SELECT id, project, substr(title, 1, 80) AS title, seen_again_count, last_seen_at
  FROM learnings
  WHERE seen_again_count > 0
  ORDER BY seen_again_count DESC LIMIT 50;"

# Histogram: how many rows fall into each rediscovery-count bucket
sqlite3 ~/.igris/memory/knowledge.db "
  SELECT seen_again_count, COUNT(*)
  FROM learnings
  GROUP BY seen_again_count
  ORDER BY seen_again_count;"
```

Healthy distribution: long tail, most rows at `seen_again_count=0`, a few
at 1-3. **Anomaly: a row with `seen_again_count > 10`** may indicate the
LLM keeps re-extracting the same insight across many sessions (good — the
dedup is doing its job) **OR** that the dedup is over-merging
genuinely-distinct insights into one anchor (bad — false positive).

To audit suspect anchors:

```bash
# Pull rows with high rediscovery counts and inspect their content vs the
# perception.rediscovery events to see what got merged.
sqlite3 ~/.igris/memory/knowledge.db "
  SELECT json_extract(payload, '$.existing_learning_id') AS anchor,
         json_extract(payload, '$.similarity_score') AS sim,
         datetime(created_at) AS at
  FROM event_log
  WHERE event_name = 'perception.rediscovery'
  ORDER BY at DESC LIMIT 30;"
```

### Surfacing via `/scan`

`/scan` reads `event_log` for perception lifecycle events. Surfacing
`seen_again_count` distribution as a derived metric requires a `/scan`
code change — that is **out of scope for TD-087** and tracked as a
follow-up. The raw queries above are the operator's manual workaround
in the interim.

## Rollback

Three tiers, matched to the severity of the failure:

### Tier 1 — Operator hot rollback (no code change, < 1 minute)

Disables dedup entirely. Acceptable if false-positive merges are
identified and immediate revert is needed.

```bash
echo 'export IGRIS_PERCEPTION_DEDUP_ENABLED=0' >> ~/.zshrc
source ~/.zshrc
```

Effect: perception reverts to TD-066 LLM-only ingestion. Inserted count
returns to ~9 per run on the same transcript. No false-positive risk.

### Tier 2 — Threshold-only rollback (config edit, no rebuild)

Restores TD-086's 0.85 threshold while keeping Option C normalisation in
effect. Useful if the **threshold drop** caused the regression but
normalisation is fine.

```jsonc
// ~/.igris/config.json
{
  "perception": {
    "dedup_cosine_threshold": 0.85
  }
}
```

### Tier 3 — Full revert (code rollback)

Reverts dedup.ts, runner.ts, types.ts edits. Restores TD-086 defaults
exactly. Use ONLY if a catastrophic false-positive rate appears that
neither Tier 1 nor Tier 2 contains.

```bash
git revert <td-087-commit-sha>
cd brain-mcp-server && npm run build
```

## Verification after any rollback

```bash
# Re-run perception against the TD-087 fixture and confirm pre-TD-087
# behaviour returns (~9 inserts on a re-run).
IGRIS_DB_PATH=/tmp/td087_rollback_check.db \
  npx tsx brain-mcp-server/scripts/perception_extract_cli.ts \
  --project rollback-check \
  --transcript-path brain-mcp-server/test/fixtures/td087/transcript_steady_state.jsonl \
  --source rollback_check --no-log

# Confirm no errors in event_log
sqlite3 /tmp/td087_rollback_check.db "
  SELECT event_name, COUNT(*) FROM event_log
  WHERE event_name LIKE 'perception.%'
  GROUP BY event_name;"
```

## Backfill decision

**Channel-aware backfill — shipped as TD-286.** (This section originally
declined a backfill on a *temporal* premise — "pre-TD-087 rows have
non-normalised embeddings." TD-285 showed that premise was wrong: the
depressed cosine is **channel-based, not date-based**.)

The root cause is asymmetric embedding geometry across ingestion channels,
independent of `created_at`:

- **Perception channel** (`cognition/extractors/perception.ts:265`) embeds the
  normalised fingerprint `${normalizeForDedup(title)} ${normalizeForDedup(
  content)}` — so its stored geometry already lives in the space the 0.80
  threshold was F1-tuned for.
- **Manual channel** (`igris_memory_store`, `src/tools/memory.ts:283`) embeds
  RAW `${title} ${content}` — **regardless of date**. Every manually-stored
  learning holds un-normalised geometry, whether written before or after
  TD-087.

The live dedup query is always normalised (`dedup.ts:245`), so it measures a
normalised query vector against a RAW-stored vector for every manual row —
artificially depressing cosine for genuine paraphrase pairs. TD-285's acid
test quantified the effect (Path A caught 0/258 vs Path B's 3/258 on the
pending proxy corpus); the residual duplicates were a pre-normalisation
artifact, not a live recall gap.

**TD-286 performs the backfill this section previously declined.**
`brain-mcp-server/scripts/td286_renormalize_backfill.ts` detects RAW-stored
rows using the TD-285 `svr > svn` classifier (not a date filter — self-limiting
and re-run-safe), re-embeds them on the normalised fingerprint, and rewrites
`learnings.embedding` (BLOB + `embedding_model`) **and** `learnings_vec` in a
single per-row transaction (lockstep). It is idempotent (`norm`-classified rows
are skipped) and resumable (each row commits independently). Dry-run is the
default; `--apply` is the explicit opt-in. A dry-run over the live corpus at
build time found 447 RAW-stored rows (all approved) out of 711 embedded, with
264 already norm-stored (the perception channel + a handful of approved rows).

**Guardrail — unchanged.** The backfill realigns *stored geometry* only; it
does **not** touch the dedup threshold. The `0.80` default (and the
`dedup_cosine_threshold` config/env overrides) are untouched, and the
complementary-facet band around `~0.71–0.79` (the real-LLM `0.69–0.78`
paraphrases documented above) remains FR-119 / FR-116 semantic-merge
territory — out of scope for cheap-dedup. Because the backfill moves stored
vectors uniformly *into* the space the threshold was tuned for, the F1 numbers
in this doc continue to describe the live system.

## Future work

- **FR-119 / FR-116 brain janitor** — semantic merge for paraphrases
  that fall below the cheap-dedup threshold. The real-LLM e2e in this
  document quantifies the demand: ~9 paraphrases over 5 runs landed in
  the 0.69-0.78 cosine band, above what cheap-dedup can safely catch but
  below what an LLM-judge could merge confidently.
- **`/scan` rediscovery-rate metric** — surface
  `seen_again_count` distribution and `perception.rediscovery` event
  rate as a first-class metric. Currently requires manual SQL.
- **Re-run the corpus eval after the next prompt update** — the F1
  numbers in this doc are tied to the LLM extractor's current prompt.
  Significant prompt changes warrant a fresh tuning pass.

## Reproducibility

To rerun the Phase 1 analysis:

```bash
cd brain-mcp-server

# 1. Generate pair CSV from the live corpus
npx tsx scripts/dedup_corpus_eval.ts --out /tmp/pairs.csv --project igris-ai

# 2. Hand-label the label_blank column (TRUE_DUP / DISTINCT / SKIP)
#    or use the heuristic auto-labeler:
python3 /Users/m.elamin/StudioProjects/igris-ai/brain-mcp-server/scripts/td087_label_pairs.py \
  /tmp/pairs.csv /tmp/pairs_labeled.csv

# 3. Compute F1 across options
npx tsx scripts/dedup_corpus_eval.ts --score /tmp/pairs_labeled.csv

# 4. Deterministic e2e
npx tsx scripts/td087_e2e_deterministic.ts

# 5. Real-LLM e2e (requires `claude` CLI on PATH)
for i in 1 2 3 4 5; do
  IGRIS_DB_PATH=/tmp/td087_e2e.db \
    npx tsx scripts/perception_extract_cli.ts --project td087-real \
    --transcript-path test/fixtures/td087/transcript_steady_state.jsonl \
    --source td087_e2e --no-log --db /tmp/td087_e2e.db
done
sqlite3 /tmp/td087_e2e.db "
  SELECT json_extract(payload, '\$.candidates_count') AS inserted,
         json_extract(payload, '\$.deduped') AS deduped
  FROM event_log WHERE event_name = 'perception.run_succeeded' ORDER BY id;"
```
