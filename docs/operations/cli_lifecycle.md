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

`brain_push_cli.ts` originally opened the DB via `getDb()` directly.
`getDb()` only runs the legacy `migrateSchema` ladder (v1-v15) — it does
NOT run per-component migrations (goals, entity_edges, tasks, …). On a
fresh install where the MCP server had never booted, the CLI threw
`no such table: goals` and exited non-zero. The wrapper script
`perception_extract_and_persist.sh` checks `cli_rc -eq 0` before spawning
`brain_push_async.sh`, so the failure silently broke the auto-push path.

**Fix:** boot the engine (which runs all component migrations + initializes
the registry) before invoking the work handler. `bootEngine` internally
calls `setAdapter(storage)`, so subsequent `getDb()` calls inside any
component code resolve to the same booted connection automatically.

### BR-060 — process.exit race with native worker pools

`perception_extract_cli.ts` exited via `process.exit(0)` after printing the
success line. On hot runs (LLM produced candidates → embeddings written),
the @huggingface/transformers ONNX runtime's worker pool was still
mid-teardown when the synchronous `process.exit()` call fired the V8/libuv
atexit handlers. The two cleanup chains raced and the worker pool's
mutex teardown aborted with `mutex lock failed: Invalid argument`
(libc++abi SIGABRT, exit ~134).

The wrapper saw `cli_rc=134` and silently skipped the brain_push spawn
— breaking TD-080's session_end auto-push end-to-end despite the actual
work (8 inserted, 8 LLM, 8 embeddings) succeeding.

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
| Wrapper script logs "starting" but never logs "spawned brain_push_async" | `cli_rc` was non-zero — almost always one of the two cases above. |

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
| `scripts/brain_push_cli.ts` | BR-064 | Engine boot + shutdown in finally. Does NOT load transformers, so it never needed the `process.exitCode` fix — but it follows the same template. |
| `scripts/perception_extract_cli.ts` | BR-060 | Engine boot + dispose pipeline + shutdown in finally + `process.exitCode` at entry point. Full template. |

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

- `scripts/brain_push_cli.ts` — canonical reference
- `scripts/perception_extract_cli.ts` — full template with native dispose
- `src/engine/index.ts` — `bootEngine` + `engine.shutdown` semantics
- `src/utils/embeddings.ts` — `disposeEmbeddingPipeline` helper
- BR-064, BR-060 — origin briefs
