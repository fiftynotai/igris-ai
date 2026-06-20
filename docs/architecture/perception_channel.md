# Perception Channel

**Briefs:** FR-109 (initial design), TD-066 (LLM-only + detached architecture)
**Status:** LLM-only background extraction. Rule extractors removed.
**Schema:** `learnings.review_status` (DB v15) + `perception_watermarks` (component v1).

## Overview

The perception channel is a passive, post-session pipeline that scans
transcript windows for candidate learnings using a headless LLM and queues
them for human review before they enter the conscious channel (i.e., the
default `igris_memory_*` recall surfaces).

```
session_end / pre_compact hook
   -> spawn DETACHED process (nohup ... & disown)
       perception_extract_and_persist.sh
         -> 60s min-window guard
         -> resolve transcript_path from stdin JSON
         -> resolve brain-mcp-server location (env or ~/.igris/config.json)
         -> npx tsx scripts/perception_extract_cli.ts
              -> open brain DB
              -> resolve perception config (3-layer chain)
              -> select LLM extractor (probe claude CLI)
              -> runPerception (LLM-only)
              -> INSERT learnings (review_status='pending_review' OR 'approved'
                 if auto_approve_enabled=true)
              -> truncate perception_inbox.jsonl on success
/awaken section 4.9
   -> SELECT pending candidates (igris_perception_review_pending, limit=5)
user
   -> approves (igris_perception_approve) or rejects (igris_perception_reject)
default recall
   -> filters review_status='approved' (pending hidden)
```

The hook returns immediately after spawning the detached process. The
parent Claude Code session never blocks on extraction. /awaken and /rest
are read-only with respect to perception state — no inbox drain, no
synchronous LLM calls.

This keeps the conscious channel deterministic: only learnings that a human
actively approved (or were directly stored) ever surface in `recall`,
`search`, `hybrid_search`, or `pattern_suggest`. (Operators can opt into
`auto_approve_enabled` to bypass the review step — see "Auto-Approve" below.)

## Two-Channel Model

The conscious channel (default) and the perception channel share the
`learnings` table but are gated by `review_status`:

| Channel    | review_status   | Visible in recall?  | Source                      |
|------------|-----------------|---------------------|-----------------------------|
| Conscious  | `approved`      | Yes                 | `igris_memory_store`        |
| Perception | `pending_review`| No                  | LLM extractor via detached  |
| Perception | `approved`      | Yes                 | LLM extractor + auto_approve|

`review_status='approved'` is the default — every existing call path stays
visible. Perception extraction defaults to `'pending_review'` so the row is
hidden until a human approves it. `auto_approve_enabled=true` flips perception
inserts directly to `'approved'`.

The vocabulary is enforced at the handler layer (validator in
`tools/memory.ts`). The composite index `idx_learnings_review_status(review_status, project)`
keeps the lazy-on-read filter cheap.

## Provenance Interaction

Every perception-generated row is tagged `provenance='inferred'`. Approval
flips `review_status` to `'approved'` but does NOT change `provenance` —
inference is permanent. The forensic trail is preserved across the lifecycle:

- `provenance='inferred'` → derived by LLM, not directly observed.
- `learnings.source_extractor` → which extractor produced it.
  - Post-TD-066: `'llm'`, `'manual'` (direct memory_store), or `'distill'` (the `/harvest` skill — the enum value stays `'distill'` after the `/distill` → `/harvest` rename; it is a channel-tag, not the skill name).
  - Pre-TD-066 historical rows may carry `'rule:learned_marker'`,
    `'rule:retry_chain'`, `'rule:blocker_resolution'`, or
    `'rule:error_fingerprint'` — read-compatible, no migration needed.

Combined, you can compute precision per source: `approved_count / inferred_count`
broken down by `source_extractor`.

## LLM Extractor

A headless `claude -p` subprocess that mirrors FR-108's `verifier.ts` shape:

- **Probe:** `isClaudeCliAvailable()` cached probe at component init.
- **Spawn:** `spawn('claude', ['-p', '--output-format', 'json', '--system', <prompt>])`.
- **Timeout:** SIGTERM at 60s, hard SIGKILL 5s later.
- **Defensive fallbacks:** spawn-fail, parse-fail, non-zero exit, empty stdout
  all return `[]` (the runner inserts nothing for that window).

**Confidence cap.** LLM-reported confidence is post-parse coerced to
`min(0.85, llm.confidence)`. The original is preserved in
`evidence.llm_self_confidence` for forensics.

**No rule extractors.** TD-066 removed the four rule-based extractors
(`learned_marker`, `retry_chain`, `blocker_resolution`, `error_fingerprint`)
plus the rule-vs-llm dedupe tie-breaks and the `llm_skip_threshold` cost
gate. The LLM proved more reliable than brittle regexes.

## Detached Process Pattern

```
hook (parent session)
  | nohup bash perception_extract_and_persist.sh "<slug>" </dev/null >/dev/null 2>&1 & disown
  v
detached child
  | 60s min-window guard (perception_extract_watermark.txt)
  | locate transcript via stdin JSON
  | resolve brain MCP (env IGRIS_BRAIN_MCP_DIR | source_repo from ~/.igris/config.json)
  | log to ~/.igris/projects/<slug>/session/perception_extract.log (rotated at 1MB)
  | invoke npx tsx scripts/perception_extract_cli.ts
  v
CLI (TS via tsx)
  | parse args, open brain DB, pre-flight learnings table check
  | read transcript file (4MB cap, tail-read on oversize)
  | resolvePerceptionConfig + selectLlmExtractor
  | runPerception (LLM-only)
  | truncate perception_inbox.jsonl atomically
```

The 60s min-window guard prevents thrash from rapid hook fires. The atomic
inbox truncation (write empty temp file + rename) is safe for concurrent
appenders.

This pattern is the canonical detached-process template for FR-116
(background brain maintenance) and any future hook-spawned background work.

## Prompt-Injection Mitigations

Five layered defenses — any one breaking does not compromise the system:

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
5. **Human review gate (default):** every candidate goes through the same
   approve/reject flow as a manual one. A successful injection still produces
   a `pending_review` row that the human sees before it lands in recall.
   Auto-approve operators trade this gate for convenience.

## MCP Tools

Six tools surface the lifecycle:

| Tool                                 | Purpose                                                    |
|--------------------------------------|------------------------------------------------------------|
| `igris_perception_submit`            | Direct ingest (CLI bypasses this; manual triage uses it)   |
| `igris_perception_review_pending`    | List pending candidates for `/awaken` (limit=5)            |
| `igris_perception_approve`           | Flip review_status='approved' (with optional edit)         |
| `igris_perception_reject`            | DELETE the pending row (hard delete, no soft-delete state) |
| `igris_perception_extract_now`       | Manual trigger with `force_llm` bypass                     |
| `igris_perception_expire_stale`      | Reclaim storage from rows past the TTL                     |

The first 5 are the canonical lifecycle. `expire_stale` is a maintenance
helper — the lazy-on-read TTL filter normally hides old rows, but this
tool reclaims them.

## Cost Gates

Four gates control LLM spend:

| Gate                           | Default | Override                                |
|--------------------------------|---------|-----------------------------------------|
| `extractor_llm_enabled`        | `true`  | `~/.igris/config.json` `perception` section, env `IGRIS_PERCEPTION_LLM_ENABLED=0\|1` |
| `claude` CLI present           | probed  | (none — environmental)                  |
| `llm_min_transcript_bytes`     | `1024`  | config or `force_llm=true`              |
| `llm_max_candidates`           | `10`    | config (cap on output regardless)       |
| `llm_timeout_ms`               | `60000` | config or env `IGRIS_PERCEPTION_LLM_TIMEOUT_MS` |

**Default is ON** (TD-066). The LLM extractor runs by default; operators
flip `extractor_llm_enabled=false` if they want to disable. The pre-TD-066
`llm_skip_threshold` cost gate was removed — it was rule-count dependent,
and rules are gone.

## Auto-Approve

`auto_approve_enabled=false` is the default. Set it to `true` (in
`~/.igris/config.json` `perception` section, or env
`IGRIS_PERCEPTION_AUTO_APPROVE=1`) to insert perception rows directly as
`review_status='approved'`. They appear in `recall`/`search` immediately
without operator review.

**Tradeoffs:**
- Pro: zero review backlog; LLM findings surface automatically.
- Con: no human gate for low-quality/noisy LLM output; relies entirely on
  the LLM_CONFIDENCE_CAP=0.85 ceiling and validator.

The setting is global — same flag applies to all projects on this machine.
Per-project override is not currently supported (YAGNI; revisit if needed).

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

- **Plans:** `~/.igris/projects/igris-ai/plans/FR-109-plan.md`,
             `~/.igris/projects/igris-ai/plans/TD-066-plan.md`
- **Migration:** `brain-mcp-server/src/db.ts:735` (v14, v15)
- **Component:** `brain-mcp-server/src/engine/components/perception/`
- **CLI:** `brain-mcp-server/scripts/perception_extract_cli.ts`
- **Wrapper:** `~/.igris/core/hooks/shared/perception_extract_and_persist.sh`
- **FR-108 verifier (canonical headless `claude -p` pattern):** `brain-mcp-server/src/engine/components/subconscious/verifier.ts`
