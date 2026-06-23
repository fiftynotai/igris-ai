# Subconscious Engine — the cognition subsystem

> **Status (v7.1): the subconscious is an LLM cognition INSTANCE, gated OFF by default.**
> FR-118 replaced the FR-106/FR-108 rule-detector pipeline (the `stalled`/`gap`/
> `conflict`/`pattern` detectors + the FR-108 conflict verifier + the
> `pattern_observations` smoothing table) with an LLM extractor that reads a
> deterministic brain digest and queues open-typed `suggestions`. The rule engine
> was deleted in FR-118 M4b. The instance runs only when
> `~/.igris/config.json:subconscious.enabled` (or `cognition.subconscious.enabled`)
> is `true` — the default is `false` until the engine is verified live.

**Briefs:** FR-118 — the cognition subsystem (an expandable LLM-extraction host)
**Supersedes:** FR-106 (rule subconscious) + FR-108 (conflict verifier) — both deleted.
**Schema:** `brain-mcp-server/src/engine/components/subconscious/schema.ts` —
v1 (`suggestions` + `dismissed_patterns`), v3 (rebuild: open `source_module` + LLM
columns), v4 (drop the dead `pattern_observations`). v2 created `pattern_observations`;
v4 drops it.

---

## The cognition subsystem

The subconscious is no longer a standalone rule engine — it is one **instance** of
the **cognition** subsystem, an instance-agnostic LLM-extraction host. The subsystem
is a sub-mechanism of `memory` (it is HOW some memory rows come to exist): it reads
brain state and proposes candidates for human review.

Its parts (`brain-mcp-server/src/engine/components/cognition/`):

| Part | Path | Role |
|---|---|---|
| **The agnostic engine** | `cognition/engine/` | `runExtractor(db, instance, args, deps)` — owns the cold-start / daily-budget / timeout / bytes gates, the one-terminal-event-per-run lifecycle, the prompt-injection wrap, and the auto-push. It runs ANY registered instance and never changes to add one. |
| **The harness-agnostic LLM backend** | `cognition/backend/` | spawn-map, parse-output, brain-isolation, env, exec. `resolveHarness` picks which CLI runs the call via the 4-layer chain (env → global `llm_extractor.harness` → per-instance pin → default `claude`); `isHarnessCliAvailable` probes it. Ported from FR-201's pluggable judge backend. |
| **The self-describing instances** | `cognition/extractors/<name>.ts` | each declares its own `buildContext` / `promptBuilder` / `parseResponse` / `persistCandidate` / `config` / `id`. Perception and subconscious are the two shipped instances. |
| **The OPEN registry** | `cognition/registry.ts` | discovers the instance files — it is OPEN, not a closed `'perception'|'subconscious'` enum. A new extractor is a new FILE; the engine discovers it with zero engine edit. |
| **The merged component** | `cognition/index.ts` | `createCognitionComponent()` composes both instances' surfaces (schema migrations under their original component keys, MCP tools, events, schedule bootstrap) into ONE engine component. |
| **The auto-action layer** | `cognition/actions/` (subconscious) | `igris_suggestion_apply_action` + the action kinds (tick_ac / dismiss_existing / create_brief / flag_for_review / add_edge). Operator-invoked; never auto-fires. |

**Expandability (the design goal):** adding a hypothetical third extractor — say a
roadmap-drift watcher — takes exactly a new `cognition/extractors/roadmap_drift.ts`
(declaring its contract), its appearance in the registry's glob, and optionally an
MCP run-tool + schedule entry. No engine edit, no backend edit, no new gate code. If
adding an instance ever requires touching `cognition/engine/`, the abstraction has
leaked — fix the engine, not the instance.

---

## The subconscious instance

`cognition/extractors/subconscious.ts` is the instance that reads the **brain
digest** (a deterministic summary of recent brain state — `subconscious/digest.ts`)
and asks an LLM to propose `suggestions`: things worth the operator's attention that
no single rule could name. The model names the suggestion KIND (`source_module` is
OPEN, `type_inferred=1`), unlike the old fixed `stalled`/`gap`/`conflict`/`pattern`
rule modules.

**What "passive" still buys us:** the instance proposes, it never mutates briefs,
learnings, goals, or edges on its own. A suggestion costs the operator a glance; the
operator decides whether to act (via `igris_suggestion_acted` / `apply_action`) or
dismiss (`igris_suggestion_dismiss`). The auto-action layer's `create_brief` kind
DRAFTS a brief for approval — it does not create one.

**The run path:** the `subconscious_engine` cron schedule (every 6h) fires
`igris_subconscious_run`, which calls `runSubconscious` (`subconscious/runner.ts`).
That builds a fresh instance from the resolved config and drives it through
`runExtractor`. The handler also accepts a manual fire (`force` bypasses the
cold-start + min-digest-bytes gate, but never the daily budget or the disabled
switch).

---

## Gates (where a run is skipped)

`runExtractor` evaluates these in order; the first that trips writes a `run_skipped`
lifecycle event and returns:

1. **DISABLED** — `config.enabled === false` → `run_skipped(reason='disabled')`.
2. **COLD-START** — a session booted within the grace window → `run_skipped`.
3. **DAILY-BUDGET** — today's `run_started` count ≥ `llm_daily_budget` (default 8) →
   `run_skipped(reason='budget')` with `used_today` + `budget` in the payload.
4. **BYTES** — the digest is below `min_digest_bytes` (default 10 KB), unless `force`.
5. **BACKEND** — the resolved harness CLI is absent → `run_skipped(reason='cli_missing')`.

Past the gates, the engine writes `run_started` (consuming budget), runs the isolated
LLM call, persists candidates via the instance's `persistCandidate`, and writes
exactly one terminal event: `run_succeeded` (with `persisted` count) or `run_failed`
(with `reason`). The one-terminal-event-per-run invariant (TD-074) is enforced in the
lifecycle emitter so a run can never double-report nor surface as stuck-RUNNING.

---

## Lifecycle events

The engine writes the run lifecycle DIRECTLY to `event_log` (NOT the bus) under the
per-instance namespace `cognition.subconscious`:

- `cognition.subconscious.run_started`
- `cognition.subconscious.run_succeeded` (`payload.persisted` = suggestions queued)
- `cognition.subconscious.run_failed` (`payload.reason`)
- `cognition.subconscious.run_skipped` (`payload.reason`; `budget` adds `used_today`/`budget`)

Observe them with `igris_event_log component='cognition.subconscious'` or a direct
`sqlite3` read. `/scan` renders a health line (last run, `suggested_today`,
`budget_remaining`); `/awaken` §4.8 renders a failure WARNING when the latest event
is `run_failed` with no later `run_succeeded`. Both surfaces are gated behind
`subconscious.enabled`, so they render nothing while the engine is off.

> The legacy `subconscious.*` bus events (`run_start`/`run_complete`/
> `suggestion_emitted`/`suggestion_suppressed`) are GONE — they belonged to the
> deleted rule pipeline. The only surviving bus emit is
> `subconscious.bootstrap_failed` (the schedule-bootstrap failure on `engine.ready`).

---

## The dismiss-reason learning loop (still live)

The one piece of FR-106 that survives is the dismiss loop — it is instance-agnostic
bookkeeping, not a detector. `subconscious/runner.ts` keeps:

- `computeEvidenceSignature(module, evidence)` — a stable per-kind key (the same row
  the dismiss UPSERT lands on each time). The subconscious instance reuses it so an
  LLM suggestion that maps onto a previously-dismissed signature is suppressed
  before insert.
- `recordDismissPattern(...)` — the `igris_suggestion_dismiss` handler UPSERTs the
  signature into `dismissed_patterns` (dismiss_count++, reasons appended, capped).

After `dismiss_suppress_count` dismisses (default 2) the signature is always
suppressed; a single dismiss is silenced for `dismiss_cooldown_days` and then allowed
to re-emit. This gives the operator a quiet, code-free way to silence a noisy
suggestion kind.

---

## Schema

`subconscious/schema.ts`, applied under the `subconscious` component key in
`engine_migrations` (per-component registry, keyed by `(component, version)`):

- **v1** — `suggestions` (the canonical queued-findings store) + `dismissed_patterns`
  (the dismiss-loop UPSERT target, composite-UNIQUE on
  `source_module, project_slug, evidence_signature`) + lookup indexes.
- **v2** — `pattern_observations` (the old rule smoothing table). **Dropped by v4.**
- **v3** — REBUILD `suggestions`: open the `source_module` CHECK (the LLM emits
  open-typed kinds) and add `confidence` / `suggested_action` / `type_inferred`.
  SQLite cannot drop a CHECK via ALTER, so v3 is a table-rebuild that copies every
  legacy row across with `type_inferred=0`. The priority + status CHECKs are kept.
- **v4** — `DROP TABLE IF EXISTS pattern_observations`. Idempotent; safe on a brain
  that never applied v2. `suggestions` / `dismissed_patterns` are untouched. The
  table was never in `SYNC_TABLES`, so there is no cross-machine merge state to lose.

`suggestions` is not in `SYNC_TABLES` either — suggestions are machine-local review
artifacts, re-derivable from brain state on the next run.

---

## Config

Read with defaults; absent keys fall back. The subconscious resolver
(`subconscious/index.ts:resolveSubconsciousConfig`) reads BOTH the new
`cognition.subconscious` block and the legacy top-level `subconscious` block (the new
path wins where both set a key; the legacy `subconscious.enabled` stays grep-able):

```jsonc
{
  "subconscious": { "enabled": false },          // legacy top-level — resolver fallback + grep anchor
  "llm_extractor": {                               // the shared cognition-backend harness selector
    "harness": "claude",
    "fallback_order": ["claude", "codex", "gemini"]
  },
  "cognition": {
    "perception": { "enabled": true },
    "subconscious": {
      "enabled": false,
      "llm_timeout_ms": 300000,
      "llm_daily_budget": 8,
      "min_digest_bytes": 10240,
      "harness": null                              // null = inherit the global llm_extractor.harness
    }
  }
}
```

Enabling the engine is a single flag flip (`subconscious.enabled` →
`cognition.subconscious.enabled` → `true`) — no schedule re-bootstrap needed. The
`subconscious_engine` cron schedule is bootstrapped idempotently on `engine.ready`
and fires `igris_subconscious_run` regardless of the engine internals.
