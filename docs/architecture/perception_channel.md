# Perception Channel

**Brief:** FR-109 — Auto-extract learnings from session transcripts
**Status:** Phase 1 (rule extractors) and Phase 2 (LLM extractor) shipped together.
**Schema:** `learnings.review_status` (DB v15) + `perception_watermarks` (component v1).

## Overview

The perception channel is a passive, post-session pipeline that scans
transcript windows for candidate learnings and queues them for human review
before they enter the conscious channel (i.e., the default `igris_memory_*`
recall surfaces).

```
session_end / pre_compact
   -> hook writes perception_inbox.jsonl
/awaken or /rest
   -> drains inbox via igris_perception_submit
   -> runs rule extractors + (optional) LLM extractor
   -> dedupes + persists pending_review rows
/awaken section 4.9
   -> renders top 5 pending candidates (limit=5)
user
   -> approves (igris_perception_approve) or rejects (igris_perception_reject)
default recall
   -> filters review_status='approved' (pending hidden)
```

This keeps the conscious channel deterministic: only learnings that a human
actively approved (or were directly stored) ever surface in `recall`,
`search`, `hybrid_search`, or `pattern_suggest`.

## Two-Channel Model

The conscious channel (default) and the perception channel share the
`learnings` table but are gated by `review_status`:

| Channel    | review_status   | Visible in recall?  | Source                     |
|------------|-----------------|---------------------|----------------------------|
| Conscious  | `approved`      | Yes                 | `igris_memory_store`       |
| Perception | `pending_review`| No                  | `igris_perception_submit`  |

`review_status='approved'` is the default — every existing call path stays
visible. Perception extractors pass `'pending_review'` so the row is hidden
until a human approves it.

The vocabulary is enforced at the handler layer (validator in
`tools/memory.ts`). The composite index `idx_learnings_review_status(review_status, project)`
keeps the lazy-on-read filter cheap.

## Provenance Interaction

Every perception-generated row is tagged `provenance='inferred'`. Approval
flips `review_status` to `'approved'` but does NOT change `provenance` —
inference is permanent. The forensic trail is preserved across the lifecycle:

- `provenance='inferred'` → derived (rules or LLM), not directly observed.
- `evidence.source_extractor` → which extractor produced it (`rule:learned_marker`,
  `rule:retry_chain`, `rule:blocker_resolution`, `rule:error_fingerprint`, `llm`).

Combined, you can compute precision per source: `approved_count / inferred_count`
broken down by `source_extractor`.

## Run Mode (Mode B)

Rules and LLM both fire on the same transcript window. Dedupe handles overlap:

```
runRuleExtractors(events)
   |
   v
[heuristic-first cost gate]
   - skip:disabled       (extractor_llm_enabled = false)
   - skip:bytes          (transcript_bytes < llm_min_transcript_bytes)
   - skip:rules_sufficient (rule_candidates.length >= llm_skip_threshold)
   - ran                  (otherwise)
   |
   v
runLlmExtractor(events) when ran
   |
   v
dedupeWithRulePriority(rules ++ llm)
   |
   v
persistAsPendingReview(...)
```

`force_llm=true` (only via `igris_perception_extract_now`) bypasses the cost
gates (bytes + rules-sufficient) but NEVER bypasses the disabled gate — that's
an operator decision, not a cost decision.

## Rule Extractors (Phase 1)

Four deterministic regex/state-machine extractors, each producing
`source_extractor='rule:<name>'`:

| Extractor          | Confidence | What it finds                                         |
|--------------------|------------|-------------------------------------------------------|
| `learned_marker`   | 0.85       | Anchored `LEARNED:` lines in transcript content       |
| `retry_chain`      | 0.6        | sentinel-FAIL → forger-fix → sentinel-PASS triples    |
| `blocker_resolution`| 0.7        | `BLOCKER:` paired with subsequent `RESOLVED:` line    |
| `error_fingerprint`| 0.75       | TypeError/Exception/Traceback lines, signature-deduped|

Confidence ladder is intentional: `LEARNED:` is the highest-precision signal
because the human is explicitly tagging "remember this." LLM output is capped
at 0.85 (see below) so an over-confident model can never outrank `LEARNED:`.

## LLM Extractor (Phase 2)

A headless `claude -p` subprocess that mirrors FR-108's `verifier.ts` shape:

- **Probe:** `isClaudeCliAvailable()` cached probe at component init.
- **Spawn:** `spawn('claude', ['-p', '--output-format', 'json', '--system', <prompt>])`.
- **Timeout:** SIGTERM at 60s, hard SIGKILL 5s later.
- **Defensive fallbacks:** spawn-fail, parse-fail, non-zero exit, empty stdout
  all return `[]` (the runner proceeds with rule candidates only).

**Confidence cap.** LLM-reported confidence is post-parse coerced to
`min(0.85, llm.confidence)`. The original is preserved in
`evidence.llm_self_confidence` for forensics.

**Tie-breaking.** When a rule and the LLM produce the same dedupe key with
equal confidence, the rule source wins (`source_extractor` starting with
`rule:`). This is the deterministic-over-non-deterministic invariant.

## Prompt-Injection Mitigations

Four layered defenses — any one breaking does not compromise the system:

1. **`--system` flag:** the system prompt rides on a separate channel from
   user content. The transcript is never concatenated with instructions in
   the same string the model sees as "the request."
2. **`<transcript>...</transcript>` delimiters:** the user content is wrapped
   so the system prompt can refer to it explicitly as untrusted input.
3. **Control-char sanitization:** `sanitizeTranscript` strips ASCII control
   bytes (except `\n` and `\t`) before embedding.
4. **JSON-only output + validator:** the model is constrained to emit a JSON
   array. `validateAndCoerce` rejects malformed or oversize candidates
   silently. Even if the model is fooled, the output is structured data, not
   executable instructions.
5. **Human review gate:** every candidate goes through the same approve/reject
   flow as a rule-based one. A successful injection still produces a
   `pending_review` row that the human sees before it lands in recall.

## MCP Tools

Six tools surface the lifecycle:

| Tool                                 | Purpose                                                    |
|--------------------------------------|------------------------------------------------------------|
| `igris_perception_submit`            | Hook entry: ingest a transcript window                     |
| `igris_perception_review_pending`    | List pending candidates for `/awaken` (limit=5)            |
| `igris_perception_approve`           | Flip review_status='approved' (with optional edit)         |
| `igris_perception_reject`            | DELETE the pending row (hard delete, no soft-delete state) |
| `igris_perception_extract_now`       | Manual trigger with `force_llm` bypass                     |
| `igris_perception_expire_stale`      | Reclaim storage from rows past the TTL                     |

The first 5 are the canonical lifecycle. `expire_stale` is a maintenance
helper — the lazy-on-read TTL filter normally hides old rows, but this
tool reclaims them.

## Cost Gates

Five gates control LLM spend:

| Gate                           | Default | Override                                |
|--------------------------------|---------|-----------------------------------------|
| `extractor_llm_enabled`        | `false` | `~/.igris/config.json` `perception` section, env `IGRIS_PERCEPTION_LLM_ENABLED=1` |
| `claude` CLI present           | probed  | (none — environmental)                  |
| `llm_min_transcript_bytes`     | `1024`  | config or `force_llm=true`              |
| `llm_skip_threshold` (rules N) | `3`     | config or `force_llm=true`              |
| `llm_max_candidates`           | `10`    | config (cap on output regardless)       |
| `llm_timeout_ms`               | `60000` | config or env `IGRIS_PERCEPTION_LLM_TIMEOUT_MS` |

**Default is OFF.** The LLM extractor is opt-in. Operators flip
`extractor_llm_enabled=true` once they're comfortable with their cost
profile. Rules-only stays the no-cost default.

## Inbox + Watermark

The hook is dumb — it appends a JSONL row to
`~/.igris/projects/{slug}/session/perception_inbox.jsonl` and exits. Server-
side extraction happens when `/awaken` (section 3.6.5) or `/rest`
(section 2.6.6) drains the inbox via `igris_perception_submit`.

Each inbox row:

```json
{"project": "p", "source": "session_end", "transcript": "<JSONL or text>", "queued_at": "2026-04-29T10:00:00Z"}
```

The watermark file
`~/.igris/projects/{slug}/session/perception_watermark.txt`
records the last successfully-extracted ISO timestamp so the next ingest
can clamp to a forward-only window. Submit-path always advances the
watermark on success; manual `extract_now` only advances when
`advance_watermark=true`.

## Auto-Expire

A lazy-on-read TTL filter excludes rows older than
`pending_review_ttl_days` (default 14) from `igris_perception_review_pending`.
Storage reclamation is opt-in via `igris_perception_expire_stale` — no cron
schedule. This avoids competing with the subconscious cron and keeps the
component self-contained.

## Approval Edit Scope

`igris_perception_approve(learning_id, edit?)` permits editing six fields
before flipping the status: `title`, `content`, `tags`, `category`,
`confidence`, `tech_stack`. Other fields (`provenance`, `project`, `scope`,
`source_brief`) are NOT editable — `provenance` is permanent and the rest
are structural.

Approval is idempotent: a second call against an already-approved row is a
no-op (returns `updated: false`).

## Telemetry

Bus events:

- `perception.run_complete` — per-extraction summary (counts, llm_status, source)
- `perception.candidate_approved` — per-approval (learning_id)
- `perception.candidate_rejected` — per-rejection (learning_id, title, reason)

These flow through the standard monitoring component's event log so dashboards
can compute precision per source over time.

## References

- **Plan:** `~/.igris/projects/igris-ai/plans/FR-109-plan.md`
- **Migration:** `brain-mcp-server/src/db.ts:735` (v14, v15)
- **Component:** `brain-mcp-server/src/engine/components/perception/`
- **FR-108 verifier (canonical headless `claude -p` pattern):** `brain-mcp-server/src/engine/components/subconscious/verifier.ts`
