# Brain MCP Server — Architecture Notes

## Identity

Brain MCP server (engine v5+); registered tools served via stdio MCP and
HTTP MCP transports. Tools are contributed by domain components under
`src/engine/components/*/index.ts` and routed through a single API
gateway (`src/engine/gateway.ts`).

## Strict-input contract (TD-128 + TD-120)

Every registered tool's `inputSchema` MUST declare
`additionalProperties: false`. The gateway enforces this invariant at
dispatch — extras throw a JSON-RPC-friendly error envelope.

- **Schema declaration:** each `ToolDefinition.inputSchema` literal carries
  `additionalProperties: false` adjacent to `type: 'object' as const`. The
  type contract permits the field via the optional declaration on
  `ToolInputSchema` (`src/engine/types.ts:21-26`).
- **Pre-computation:** `gateway.register()` walks each tool's
  `inputSchema.properties` and stores `_allowedKeys: Set<string>` plus a
  `_strict: boolean` flag on the registered record
  (`src/engine/gateway.ts:62-75`). Membership checks at dispatch are
  therefore O(1) per arg key.
- **Dispatch enforcement:** `gateway.dispatch()` rejects any arg key not
  in `_allowedKeys` for strict tools, throwing
  `"<tool>: unknown argument '<key>'. Accepted keys: ..."`
  (`src/engine/gateway.ts:109-138`). The handler is NOT invoked when an
  extra is detected.
- **Reject-mode flag:** `REJECT_EXTRAS` constant
  (`src/engine/gateway.ts:47`) is retained as a single-line revert path
  for production-incident recovery. When `false`, extras emit
  `console.warn` instead of throwing.

**Prior art:** `igris_sync_queue_drain` shipped a per-handler allow-list
guard under TD-120 (`src/tools/sync.ts:1037` —
`ALLOWED_DRAIN_KEYS = new Set(['remote_url', 'api_key'])`). TD-128
generalises that contract to every tool via the gateway choke point.
The TD-120 in-handler guard remains as defence-in-depth.

**Origin:** MG-014 M4 surfaced silent data-loss when a brief-sync caller
passed a field outside the brain's accepted args — the brain accepted the
call, ignored the field, and returned success. The strict-input contract
forecloses that failure mode by making "unknown arg" a loud error.

## Tool-registration contract

Components export a `tools()` factory returning `ToolDefinition[]`.
`bootEngine()` (`src/engine/index.ts`) composes the 19 component
factories under `src/engine/components/*/index.ts` and feeds the
aggregated array to `gateway.register()`. The gateway is the single
choke point for both transports:

- **HTTP MCP transport:** `src/index.ts:161-174` (direct-dispatch
  fallback for sessions that hit the brain without an MCP handshake)
  delegates to `engine.gateway.dispatch(name, args)`.
- **Stdio MCP transport:** `src/index.ts:210-225`
  (`CallToolRequestSchema` handler) delegates to
  `engine.gateway.dispatch(name, args as Record<string, unknown>)`.

Both call sites wrap thrown errors as `{ content: [...], isError: true }`
so strict-input violations surface to the caller as a JSON-RPC error
envelope rather than a transport-level exception.

`gateway.listTools()` (`src/engine/gateway.ts:81-98`) forwards
`additionalProperties: false` so MCP clients see the strict contract in
the listed schema. Server-side enforcement does not depend on this — the
forward exists for client-tooling consistency.

## Forbidden patterns

- **No permissive schemas.** Every new tool MUST declare
  `additionalProperties: false`. The contract test
  (`src/engine/__tests__/gateway-strict-input.test.ts:196+`)
  parameterises over `listTools()` and asserts the invariant for every
  registered tool. A new permissive tool fails CI immediately.
- **No per-tool guards as a substitute.** The gateway is the choke
  point. Adding a redundant `Object.keys(args)` walk inside a handler
  duplicates the gateway's check and creates maintenance drift. The
  TD-120 guard in `src/tools/sync.ts` is grandfathered in as
  defence-in-depth ONLY because it predates TD-128 — do not add new
  per-tool guards.
- **No `Record<string, unknown>` passthrough from callers.** Callers
  forwarding queue entries or external payloads to `mcpCall` MUST build
  the args via an explicit allow-list keyed by op. Canonical example:
  `cli/src/lib/sync/data.ts:224` — `ALLOWED_KEYS_PER_OP` map +
  `buildToolArgs()` walker. Spread-from-entry (`for ([k,v] of entries)`)
  is forbidden — historical queue entries may carry fields the target
  tool's schema does not declare, and reject-mode will throw on those
  fields at replay time.

## Test invariants

- **Canonical contract test:**
  `src/engine/__tests__/gateway-strict-input.test.ts`
  - Reject-mode block (M4): asserts strict tools throw on unknown args,
    dispatch cleanly on allowed args, and that permissive tools (no
    `additionalProperties` field) bypass the check.
  - Parameterised block (M2): registers every component's `tools()`
    output into a freshly-created gateway, iterates `listTools()`, and
    asserts `inputSchema.additionalProperties === false` for every
    entry. Count is dynamic — the test scales with the registered
    surface, not a hardcoded number.
- **CLI caller contract:** `cli/src/__tests__/sync-data.test.ts`
  exercises `dispatchEntry()` to confirm `buildToolArgs()` strips
  fields outside `ALLOWED_KEYS_PER_OP[op]` before reaching `mcpCall`,
  and that the `cache_path → content` substitution is preserved under
  the strict allow-list.

When extending the registered surface (new component or new tool),
update the contract test only if the component factory is new — adding
a tool to an existing component is automatically covered by the
parameterised iteration.

closes #TD-129
