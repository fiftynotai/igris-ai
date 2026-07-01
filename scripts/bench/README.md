# Igris benchmark harnesses (FR-215)

Two re-runnable benchmarks that turn the FR-185 "vibes → numbers" rows into reproducible
proof. **Framework-dev tooling** — they ship to no consumer install (TD-225/226 altitude rule),
which is why they live here / in `brain-mcp-server/scripts/` and NOT in `cli/src`.

Results artifacts (the numbers + caveats) live in the feature-map:
`~/.igris/projects/igris-ai/plans/feature-map/evidence/b3-recall-results.md` and
`b4-ceremony-results.md`.

---

## B3 — recall quality  (`brain-mcp-server/scripts/recall_bench.ts`)

Scores the **shipped** hybrid-recall path (BM25 composite + sqlite-vec KNN + RRF fusion +
boosts — the exact `memory.ts` `handleMemoryRecall` logic) against a frozen labeled query set.
Emits recall@{1,3,5,10}, precision@{1,5}, MRR, and a lexical-overlap band breakdown. The
**headline is recall@5 on the LOW-overlap band** — the adversarial, distinctive-tokens-stripped
queries that isolate genuine semantic recall (recall #163).

```bash
# tsx is vendored under brain-mcp-server/node_modules/.bin
./brain-mcp-server/node_modules/.bin/tsx brain-mcp-server/scripts/recall_bench.ts \
  --queryset brain-mcp-server/scripts/fixtures/recall_bench_queryset.jsonl \
  --db ~/.igris/memory/knowledge.db \
  --k 10 --project igris-ai \
  --out /tmp/b3_results.json
```

**Args:** `--queryset` (frozen JSONL), `--db` (default `~/.igris/memory/knowledge.db`),
`--k` (default 10), `--project` (default `igris-ai`), `--out` (optional JSON dump).

### Query set — `scripts/fixtures/recall_bench_queryset.jsonl`

One JSON object per line: `{ qid, query, target_ids[], sibling_ids[], author, notes }`.
Frozen (N=30) so a re-run is deterministic. Two tiers:

- **Tier A (`author:"self"`, 23 rows):** stratified sample of approved `igris-ai` learnings
  (every 11th id — no cherry-pick), each paraphrased into a vague NL question with the learning's
  distinctive tokens stripped. Anti-circularity guard = the strip + the low-overlap banding.
- **Tier B (`author:"claude-headless"`, 7 rows):** authored by a fresh headless `claude -p`
  session from the learning content only (no knowledge of the test) — independent of both the
  test author and the MiniLM embedder. (`gemini` was intended for cross-vendor independence but
  is currently unavailable — IneligibleTierError.)
- `sibling_ids` = accepted near-dup positives (cosine ≥0.90), so a correct sibling hit isn't
  penalized. `A20` is the force-included calibration canary (L-817/L-878 near-dup).

To regenerate: re-stratify + re-paraphrase, then freeze. Keep the file committed — the number is
only reproducible against a frozen set.

---

## B4 — ceremony overhead  (`ceremony_bench.sh`)

Measures a cold `/boot`'s token cost in three components: (1) **static** context — the boot-tier
module set parsed from `os/INDEX.md` + config + `igris_tree.json` + SOUL + boot/rest `SKILL.md`;
(2) **verb-digest** — stdout bytes of each boot verb's JSON digest (the new FR-195 overhead);
(3) **wall-clock** — median of N runs per verb. Token model: `chars ÷ 4`, cross-checked
`words × 1.33`.

```bash
bash scripts/bench/ceremony_bench.sh --project igris-ai --runs 5
# faster (skip timing):
bash scripts/bench/ceremony_bench.sh --no-wallclock
```

**Args:** `--project` (default `igris-ai`), `--runs` (wall-clock N, default 5), `--no-wallclock`.
**Env:** `IGRIS_BRAIN_ROOT` (default `~/.igris`).

---

## Determinism & reproducibility

- **B3:** embeddings + RRF are deterministic and the DB snapshot pins the corpus → two runs
  yield **identical** metrics. This is the reproducibility acceptance test.
- **B4 static:** `wc -c` byte counts are deterministic → the static-token total is identical
  across runs on the same `core/` tree.
- **B4 wall-clock:** machine- and network-dependent (boot-sync hits the VPS). Reported as median
  + min/max, never as a fixed value.

## Safety notes (hard requirements)

- **B3 never opens the live DB writable.** It takes a consistent online-backup **snapshot** into a
  temp dir, opens the *copy*, and deletes it on exit. The live brain is opened read-only.
- **B4 never runs a mutating verb against the real brain.** Read-only verbs (detect, session
  gather, assess, context-docs inventory, doctor) run against the real slug — their own contracts
  guarantee they mutate nothing. The one mutating verb (`boot-sync`, which drains the queue +
  merges a VPS pull) runs with `IGRIS_DB_PATH` pointed at a throwaway DB under a `mktemp` scratch
  dir and a scratch slug; the real `knowledge.db` is left byte-identical (verified: mtime+size
  unchanged across a run).
- **Neither harness writes under `~/.igris/core`.** B3 writes only its temp snapshot (+ optional
  `--out`); B4 writes only inside its scratch dir, torn down on exit.
