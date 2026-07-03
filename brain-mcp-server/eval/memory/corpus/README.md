# Sealed synthetic corpus — invariants

`learnings.seed.json` is a COMMITTED, sealed corpus of ~60 synthetic learnings
across four fictional projects. It is deliberately synthetic (not a snapshot of
the live `knowledge.db`) so the eval is a reproducible regression gate: a fixed
corpus + pinned embedding model + deterministic RRF yields identical metrics
across runs.

## Projects

| slug | domain | tech_stack |
|------|--------|-----------|
| `aurora-mobile` | Flutter mobile banking app | dart,flutter,riverpod |
| `nimbus-api` | Node/TypeScript REST backend | typescript,node,fastify,postgres |
| `helio-web` | React marketing site | typescript,react,nextjs |
| `pipeline-etl` | Python data pipeline | python,airflow,spark |

## Invariants (do not break without updating the golden sets)

1. **Stable keys, not ids.** Every entry has a stable string `key`
   (e.g. `AUR-01`). The golden sets reference keys; `seed.ts` returns a
   `key → dbId` map. This decouples golden authoring from insertion order — you
   can reorder entries without breaking the golden sets (but see #4).
2. **Unique titles except promotion pairs.** All base titles are unique so base
   seeding never fires a premature `promoteToGlobal`. The only shared titles are
   the four `PROMO-*` rows.
3. **≥10 `pending_review` rows** (`source_extractor: "llm"`) distributed across
   projects, for the FR-109 gating dimension.
4. **Promotion pairs are LAST.** `PROMO-A1/A2` (true-dup, near-identical content
   → must promote) and `PROMO-B1/B2` (same title, distinct content → must NOT
   promote) are appended after all base rows so promotion fires only on the last
   store. Keep them last.
5. **Blindness.** Learning content is phrased with deliberately different
   vocabulary than the golden questions (`golden/queryset.jsonl`). The runner
   measures per-query lexical-overlap bands; the headline is the LOW-band number.

## Defaults applied by seed.ts (when a field is omitted)

- `scope`: `local`
- `review_status`: `approved`
- `source_extractor`: `manual`
- `tags`: `''`

Global rows set `scope: "global"` explicitly; pending rows set
`review_status`/`source_extractor` explicitly.
