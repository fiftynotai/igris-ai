# CLI Lifecycle — Engine Boot, Shutdown, and Native Teardown

This note documents the lifecycle pattern that any short-lived TypeScript
CLI in `brain-mcp-server/scripts/` MUST follow when it opens the brain DB.
It exists because two recent regressions (BR-064 and BR-060) silently
broke detached background actors after the CLI appeared to succeed —
both root causes were in the teardown path, not the work path.

## TL;DR

If your CLI:

1. opens the brain DB (directly or transitively via `getDb()`), AND
2. exits via `process.exit(code)`,

then it MUST follow this template:

```typescript
import { bootEngine } from '../src/engine/index.js';
import type { Engine } from '../src/engine/index.js';

export async function main(argv: string[] = process.argv): Promise<number> {
  // ... arg parsing ...

  let engine: Engine;
  try {
    engine = bootEngine({ dbPath, components: {} });
  } catch (err) {
    console.error(`Error: engine boot failed: ${err}`);
    return 1;
  }

  try {
    // ... your work here ...
    return 0;
  } finally {
    // Optional: dispose any native subsystems your CLI loaded
    // (e.g. await disposeEmbeddingPipeline() if you generated embeddings).
    engine.shutdown();
  }
}

if (isDirectRun) {
  main().then((code) => {
    // BR-060: SET process.exitCode, do NOT call process.exit(code).
    // The synchronous exit path triggers atexit handlers that race with
    // any native worker pools still in their teardown — see below.
    process.exitCode = code;
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
```

## Why this matters

### BR-064 — partially-migrated DB

The pre-FR-120 standalone push CLI opened the DB via `getDb()` directly.
`getDb()` only runs the legacy `migrateSchema` ladder (v1-v15) — it does
NOT run per-component migrations (goals, entity_edges, tasks, …). On a
fresh install where the MCP server had never booted, the CLI threw
`no such table: goals` and exited non-zero. The wrapper script's
sentinel-and-spawn check skipped the auto-push, so the failure silently
broke the chain.

**Fix:** boot the engine (which runs all component migrations + initializes
the registry) before invoking the work handler. `bootEngine` internally
calls `setAdapter(storage)`, so subsequent `getDb()` calls inside any
component code resolve to the same booted connection automatically.

> **FR-120 update:** the standalone `brain_push_cli.ts` and its
> `brain_push_async.sh` wrapper were deleted. The push is now inlined
> into `perception_extract_cli.ts` as its final lifecycle phase
> (calling the same `handleBrainPush` handler the MCP exposes). The
> BR-064 lesson still applies: `bootEngine` must run before any handler
> that touches component-owned tables.

### BR-060 — process.exit race with native worker pools

`perception_extract_cli.ts` exited via `process.exit(0)` after printing the
success line. On hot runs (LLM produced candidates → embeddings written),
the @huggingface/transformers ONNX runtime's worker pool was still
mid-teardown when the synchronous `process.exit()` call fired the V8/libuv
atexit handlers. The two cleanup chains raced and the worker pool's
mutex teardown aborted with `mutex lock failed: Invalid argument`
(libc++abi SIGABRT, exit ~134).

The wrapper saw `cli_rc=134` and (under the pre-FR-120 chain) silently
skipped the standalone brain_push spawn — breaking session_end auto-push
end-to-end despite the actual work (8 inserted, 8 LLM, 8 embeddings)
succeeding. Post-FR-120 the push is inlined inside the same CLI's
finally-bounded body, so a SIGABRT race would now skip both the success
line AND the inline push — even more reason to keep the BR-060 fix in
place.

**Fix:** two-part:

1. Add a `try { ... } finally { engine.shutdown() }` around the post-boot
   work so engine teardown is deterministic. If your CLI loaded a native
   subsystem (e.g. the transformers pipeline), dispose it FIRST inside
   the finally so its native threads join before V8 teardown.
2. Replace `process.exit(code)` at the entry-point bottom with
   `process.exitCode = code`. This lets the event loop drain naturally:
   any pending teardown callbacks run to completion before the runtime
   exits, and worker threads get the chance to join cleanly.

## What happens if you skip this pattern

| Symptom | Likely cause |
|---|---|
| `no such table: <component>` on a fresh DB | Skipped `bootEngine`, `getDb()` only ran the legacy migration ladder. |
| `libc++abi: terminating ... mutex lock failed` after the success line | Used `process.exit(code)` while a native worker pool was still cleaning up. |
| `perception_extract.log` shows extract success but no `push=...` summary line | The CLI crashed/aborted between inbox truncate and the inline push — one of the two cases above. Pre-FR-120 this manifested as a missing "spawned brain_push_async" line. |

## Defensive shutdown timeout (optional but recommended)

Wrap the shutdown sequence in a 5-second `setTimeout(...).unref()` that
calls `process.exit(0)` if either dispose or `engine.shutdown()` ever
hangs. The work is already persisted at this point (the success line is
already on stdout), so a forced exit is safe — better than blocking the
wrapper script indefinitely.

```typescript
} finally {
  const shutdownTimer = setTimeout(() => {
    console.error('[my-cli] shutdown timed out after 5s, forcing exit');
    process.exit(0);
  }, 5000);
  shutdownTimer.unref();
  try {
    await disposeNativeSubsystem();
    engine.shutdown();
  } finally {
    clearTimeout(shutdownTimer);
  }
}
```

## Adopters

| CLI | Adopted in | Notes |
|---|---|---|
| `scripts/perception_extract_cli.ts` | BR-060, FR-120 | Engine boot + dispose pipeline + shutdown in finally + `process.exitCode` at entry point. Full template. Post-FR-120 also performs the inline brain-push as its final lifecycle phase. |
| ~~`scripts/brain_push_cli.ts`~~ | BR-064 (deleted in FR-120) | Engine boot + shutdown in finally. Was the canonical reference for the pattern; deleted when push moved inline into `perception_extract_cli.ts`. The pattern lives on in the perception CLI. |

If FR-118 (subconscious runner) ever spawns its own CLI, it MUST follow
the same template — anything that boots the engine inherits the same
teardown obligations.

## Operational escape hatch

`IGRIS_DISABLE_VEC=1` skips the sqlite-vec extension load entirely. This
is the kill-switch for ops triage when the native binary is broken or
ABI-mismatched. It does NOT address the BR-060 root cause (which was the
transformers worker pool, not sqlite-vec) — but it's the documented
fallback for any future "vec teardown crash" classes that may surface as
the codebase grows.

## References

- `scripts/perception_extract_cli.ts` — full template with native dispose + inline brain-push
- `src/engine/index.ts` — `bootEngine` + `engine.shutdown` semantics
- `src/utils/embeddings.ts` — `disposeEmbeddingPipeline` helper
- `src/tools/sync.ts` — `handleBrainPush` (called inline post-FR-120)
- BR-064, BR-060, FR-120 — origin briefs
