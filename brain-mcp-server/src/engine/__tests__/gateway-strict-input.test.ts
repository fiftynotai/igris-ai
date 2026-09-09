/**
 * TD-128 Gateway Strict-Input Contract — Tests
 *
 * Asserts that the gateway's strict-input contract (M4 reject-mode) THROWS
 * on unknown args for tools with `additionalProperties: false`. The handler
 * is NOT invoked when an extra arg is detected.
 *
 * Permissive tools (no `additionalProperties` field) must remain unaffected
 * — they accept any args and pass them through to their handler.
 *
 * The parameterized "every registered tool has additionalProperties: false"
 * contract test registers every component's tools() output into a gateway,
 * then iterates listTools() to assert the invariant holds for all
 * production-registered surfaces.
 *
 * @module engine/__tests__/gateway-strict-input.test
 */

import { describe, it, expect, vi } from 'vitest';
import { createGateway } from '../gateway.js';
import type { ToolDefinition, ToolResult } from '../types.js';

// Domain component factories — same set bootEngine() composes in
// engine/index.ts. We wire them into a freshly-created gateway so the
// parameterized test sees every production-registered tool without booting
// the full engine (no DB, no migrations, no event bus required).
import { createMemoryComponent } from '../components/memory/index.js';
import { createErrorsComponent } from '../components/errors/index.js';
import { createProjectsComponent } from '../components/projects/index.js';
import { createSessionsComponent } from '../components/sessions/index.js';
import { createBriefsComponent } from '../components/briefs/index.js';
import { createEdgesComponent } from '../components/edges/index.js';
import { createGoalsComponent } from '../components/goals/index.js';
import { createInstancesComponent } from '../components/instances/index.js';
import { createSyncComponent } from '../components/sync/index.js';
import { createCacheComponent } from '../components/cache/index.js';
import { createSchedulesComponent } from '../components/schedules/index.js';
import { createCognitionComponent } from '../components/cognition/index.js';
import { createMonitoringComponent } from '../components/monitoring/index.js';
import { createContextComponent } from '../components/context/index.js';
import { createCatalogComponent } from '../components/catalog/index.js';

function makeOkResult(text = 'ok'): ToolResult {
  return { content: [{ type: 'text', text }] };
}

describe('TD-128 gateway strict-input contract — M4 reject-mode', () => {
  it('strict tool throws on unknown arg with tool name + key + accepted keys list', async () => {
    const gateway = createGateway();
    const handler = vi.fn(async (_args: Record<string, unknown>) =>
      makeOkResult('strict-handler-ran'),
    );
    const tool: ToolDefinition = {
      name: 'igris_test_strict',
      description: 'TD-128 test fixture (strict)',
      inputSchema: {
        type: 'object',
        properties: { project: {}, brief_id: {} },
        additionalProperties: false,
      },
      handler,
    };
    gateway.register([tool]);

    await expect(
      gateway.dispatch('igris_test_strict', {
        project: 'igris-ai',
        brief_id: 'TD-128',
        bogus_extra: 'should-throw',
      }),
    ).rejects.toThrowError(
      /igris_test_strict: unknown argument 'bogus_extra'\. Accepted keys: project, brief_id\. \(strict-input contract; TD-128\)/,
    );

    // Handler MUST NOT have been invoked when reject-mode triggers.
    expect(handler).not.toHaveBeenCalled();
  });

  it('strict tool dispatches cleanly when only allowed args are passed', async () => {
    const gateway = createGateway();
    const handler = vi.fn(async (_args: Record<string, unknown>) =>
      makeOkResult('strict-handler-ran'),
    );
    const tool: ToolDefinition = {
      name: 'igris_test_strict_clean',
      description: 'TD-128 test fixture (strict, clean call)',
      inputSchema: {
        type: 'object',
        properties: { project: {}, brief_id: {} },
        additionalProperties: false,
      },
      handler,
    };
    gateway.register([tool]);

    const result = await gateway.dispatch('igris_test_strict_clean', {
      project: 'igris-ai',
      brief_id: 'TD-128',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      project: 'igris-ai',
      brief_id: 'TD-128',
    });
    expect(result).toEqual(makeOkResult('strict-handler-ran'));
  });

  it('permissive tool (no additionalProperties) accepts extras and dispatches', async () => {
    const gateway = createGateway();
    const handler = vi.fn(async (_args: Record<string, unknown>) =>
      makeOkResult('permissive-handler-ran'),
    );
    const tool: ToolDefinition = {
      name: 'igris_test_permissive',
      description: 'TD-128 test fixture (permissive — no additionalProperties)',
      inputSchema: {
        type: 'object',
        properties: { project: {} },
        // additionalProperties intentionally omitted — permissive-path
        // tools (none currently exist post-M2 sweep, but the gateway must
        // continue to support them for forward-compat).
      },
      handler,
    };
    gateway.register([tool]);

    const result = await gateway.dispatch('igris_test_permissive', {
      project: 'igris-ai',
      mystery_field: 42,
      another_extra: true,
    });

    // Handler received all args unchanged — permissive path bypasses the
    // strict guard entirely.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      project: 'igris-ai',
      mystery_field: 42,
      another_extra: true,
    });
    expect(result).toEqual(makeOkResult('permissive-handler-ran'));
  });
});

// ---------------------------------------------------------------------------
// M2 parameterized contract test — every registered tool is strict.
// ---------------------------------------------------------------------------
//
// Builds a fresh gateway, wires every domain component's tools() output
// (mirroring engine/index.ts:bootEngine), then asserts via listTools()
// that every registered tool's schema declares additionalProperties: false.
// This activates the M1 it.todo placeholder once M2's schema sweep lands.
//
// Why this approach over a full bootEngine(): the schema invariant is a
// pure structural property of the tools() return value. We can collect
// every tool definition without standing up storage, migrations, or the
// event bus. This keeps the test fast and avoids cross-cutting coupling
// with the engine bootstrap chain.

const COMPONENT_FACTORIES = [
  createMemoryComponent,
  createErrorsComponent,
  createProjectsComponent,
  createContextComponent,
  createSessionsComponent,
  createBriefsComponent,
  createEdgesComponent,
  createGoalsComponent,
  createInstancesComponent,
  createSyncComponent,
  createCacheComponent,
  createSchedulesComponent,
  // FR-118 M4a: perception + subconscious collapsed into one cognition factory.
  // The strict-input contract test is parameterised over listTools(), so the
  // merged factory's tools auto-cover (no per-tool edit needed).
  createCognitionComponent,
  createMonitoringComponent,
  createCatalogComponent,
];

function collectAllTools(): ToolDefinition[] {
  const all: ToolDefinition[] = [];
  for (const factory of COMPONENT_FACTORIES) {
    const component = factory();
    all.push(...component.tools());
  }
  return all;
}

describe('TD-128 strict-input contract — every registered tool (M2)', () => {
  const gateway = createGateway();
  gateway.register(collectAllTools());
  const tools = gateway.listTools();

  it('every component factory contributes at least one tool', () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it.each(tools.map((t) => [t.name, t] as const))(
    '%s schema has additionalProperties: false (TD-128)',
    (_name, tool) => {
      expect(
        (tool.inputSchema as { additionalProperties?: boolean })
          .additionalProperties,
      ).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// BR-080 missing-required contract — the symmetric half of TD-128.
// ---------------------------------------------------------------------------
//
// TD-128 made an UNDECLARED argument a loud error. `required` was the mirror
// image: 80 declarations across 16 component files that `listTools()` faithfully
// advertised to clients and that `dispatch()` never read. A no-arg
// `igris_sync_queue_drain()` therefore reached the handler and died on
// `args.remote_url.replace(...)` with a bare
// `TypeError: Cannot read properties of undefined (reading 'replace')` (BR-080).
//
// WHAT THIS BLOCK PROVES:
//   - the guard REJECTS when a declared required key is absent (missing-required
//     cases below, and the parameterized sweep);
//   - the guard is WIRED for every registered tool, reached through the same
//     `gateway.dispatch` entrypoint production uses from BOTH transports
//     (`src/index.ts` stdio `CallToolRequestSchema` handler and the HTTP
//     direct-dispatch fallback);
//   - the guard is NOT unconditional — control A shows a fully-supplied call
//     still reaches its handler, control B shows a `required: []` tool still
//     dispatches on `{}`. Without those two, a guard that threw on EVERY call
//     would pass the reject cases and look identical to a correct one.
//
// WHAT THIS BLOCK DOES NOT PROVE:
//   - that any given tool's `required` LIST is semantically correct. A schema
//     that over-declares (naming a key its handler treats as optional) turns a
//     previously-working call into a hard rejection, and no test in either
//     package can see that: component tests call `tool.handler()` directly and
//     bypass the gateway entirely, and the CLI's `makeLoopback` fake validates
//     nothing. The compensating control is the BR-080 manual caller audit
//     recorded in the hunt record, plus the full local suite — NOT this gate.
//   - that the drain (or any handler) still works end-to-end. Siblings:
//     `src/__tests__/sync-push-isolation.test.ts` (populated-queue drain, direct
//     AND gateway-routed) and
//     `src/tools/__tests__/sync-queue-drain-contract.test.ts` (the BR-080 R1
//     regression, which additionally asserts the message is NOT the old
//     TypeError).
//
// PREVIOUSLY NOT PROVEN, CLOSED BY TD-321 — recorded here because an omission
// from this ledger reads as "no residual here":
//   - the omitted-`params.arguments` case for the 37 registered tools that
//     declare NO `required` list. BR-080 read only the required walk through a
//     no-args stand-in, so those 37 still died in the TD-128 extras walk on
//     `TypeError: Cannot convert undefined or null to object`. Every
//     missing-required case in THIS block registers a fixture that declares
//     `required`, so none of them could ever have seen it. TD-321 normalised
//     the omitted-arguments case once at the top of `dispatch()` and proves the
//     other half of the corpus in the TD-321 block at the bottom of this file.

describe('BR-080 gateway missing-required contract', () => {
  it('rejects when a declared required key is absent, naming the key and the full list', async () => {
    const gateway = createGateway();
    const handler = vi.fn(async (_args: Record<string, unknown>) =>
      makeOkResult('required-handler-ran'),
    );
    gateway.register([
      {
        name: 'igris_test_required',
        description: 'BR-080 test fixture (required a, b)',
        inputSchema: {
          type: 'object',
          properties: { a: {}, b: {}, c: {} },
          required: ['a', 'b'],
          additionalProperties: false,
        },
        handler,
      },
    ]);

    await expect(gateway.dispatch('igris_test_required', {})).rejects.toThrowError(
      /igris_test_required: missing required argument 'a'\. Required: a, b\. \(strict-input contract; BR-080\)/,
    );
    // The handler is never entered — the guard is a gate, not a logger.
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports the FIRST missing key in declaration order when several are absent', async () => {
    const gateway = createGateway();
    gateway.register([
      {
        name: 'igris_test_required_order',
        description: 'BR-080 test fixture (declaration order)',
        inputSchema: {
          type: 'object',
          properties: { a: {}, b: {} },
          required: ['a', 'b'],
          additionalProperties: false,
        },
        handler: async () => makeOkResult(),
      },
    ]);

    // `b` supplied, `a` absent → the message must name `a`, not `b`.
    await expect(
      gateway.dispatch('igris_test_required_order', { b: 2 }),
    ).rejects.toThrowError(/missing required argument 'a'/);
  });

  it('missing-required is reported BEFORE an unknown extra on the same call', async () => {
    const gateway = createGateway();
    gateway.register([
      {
        name: 'igris_test_required_precedence',
        description: 'BR-080 test fixture (ordering vs TD-128)',
        inputSchema: {
          type: 'object',
          properties: { a: {} },
          required: ['a'],
          additionalProperties: false,
        },
        handler: async () => makeOkResult(),
      },
    ]);

    const err = await gateway
      .dispatch('igris_test_required_precedence', { bogus: 1 })
      .then(
        () => {
          throw new Error('expected rejection, got resolution');
        },
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      );

    // Missing-required is the more actionable diagnosis: "you forgot `a`"
    // beats "you passed `bogus`" when the caller did both.
    expect(err.message).toMatch(/missing required argument 'a'/);
    expect(err.message).not.toMatch(/unknown argument/);
  });

  it('presence, not truthiness: empty string / 0 / false / null satisfy required', async () => {
    const gateway = createGateway();
    const handler = vi.fn(async (_args: Record<string, unknown>) =>
      makeOkResult('falsy-ok'),
    );
    gateway.register([
      {
        name: 'igris_test_required_falsy',
        description: 'BR-080 test fixture (falsy but present)',
        inputSchema: {
          type: 'object',
          properties: { s: {}, n: {}, b: {}, z: {} },
          required: ['s', 'n', 'b', 'z'],
          additionalProperties: false,
        },
        handler,
      },
    ]);

    const args = { s: '', n: 0, b: false, z: null };
    const result = await gateway.dispatch('igris_test_required_falsy', args);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(args);
    expect(result).toEqual(makeOkResult('falsy-ok'));
  });

  it('a REQUIRED-declaring tool whose call omits params.arguments names the missing key, not a TypeError', async () => {
    // Some MCP clients send `tools/call` with no `arguments` key at all, so the
    // gateway receives `undefined`. `key in undefined` would throw the very
    // TypeError class BR-080 exists to eliminate.
    //
    // SCOPE (TD-321): the fixture below DECLARES `required`, so this case can
    // only ever prove the required-declaring half of the corpus — 74 of the 108
    // registered tools (re-measured at FR-267, 2026-08-26; 75 of 112 at TD-321).
    // The title said "an MCP call that omits params.arguments" and read as a
    // system-wide property; it was not one. The other 34 tools are covered by
    // the TD-321 block at the bottom of this file.
    const gateway = createGateway();
    gateway.register([
      {
        name: 'igris_test_required_undefined_args',
        description: 'BR-080 test fixture (undefined args object)',
        inputSchema: {
          type: 'object',
          properties: { a: {} },
          required: ['a'],
          additionalProperties: false,
        },
        handler: async () => makeOkResult(),
      },
    ]);

    const err = await gateway
      .dispatch(
        'igris_test_required_undefined_args',
        undefined as unknown as Record<string, unknown>,
      )
      .then(
        () => {
          throw new Error('expected rejection, got resolution');
        },
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      );

    expect(err.message).toMatch(/missing required argument 'a'/);
    expect(err.message).not.toMatch(/Cannot read properties of undefined/);
    expect(err.message).not.toMatch(/Cannot use 'in' operator/);
  });

  // SELF-NEGATIVE-CONTROL A — liveness. A guard whose only observed outcome is
  // "throw" is indistinguishable from a guard that throws unconditionally. This
  // exercises the same dispatch path as the reject cases above and asserts the
  // handler DOES run.
  it('control A: a required-declaring tool with all args supplied still invokes its handler', async () => {
    const gateway = createGateway();
    const handler = vi.fn(async (_args: Record<string, unknown>) =>
      makeOkResult('control-a-ran'),
    );
    gateway.register([
      {
        name: 'igris_test_required_control_a',
        description: 'BR-080 self-negative-control A',
        inputSchema: {
          type: 'object',
          properties: { a: {}, b: {}, optional: {} },
          required: ['a', 'b'],
          additionalProperties: false,
        },
        handler,
      },
    ]);

    const result = await gateway.dispatch('igris_test_required_control_a', {
      a: 1,
      b: 2,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ a: 1, b: 2 });
    expect(result).toEqual(makeOkResult('control-a-ran'));
  });

  // SELF-NEGATIVE-CONTROL B — the guard does not fire universally. Tools that
  // declare no required keys (real precedent: `igris_sync_queue_status`,
  // `igris_brief_dashboard`) must still accept `{}`.
  it('control B: a tool with no required keys dispatches cleanly on an empty args object', async () => {
    const gateway = createGateway();
    const handlerEmptyArray = vi.fn(async () => makeOkResult('empty-array-ran'));
    const handlerNoField = vi.fn(async () => makeOkResult('no-field-ran'));
    gateway.register([
      {
        name: 'igris_test_required_empty_array',
        description: 'BR-080 self-negative-control B (required: [])',
        inputSchema: {
          type: 'object',
          properties: { optional: {} },
          required: [],
          additionalProperties: false,
        },
        handler: handlerEmptyArray,
      },
      {
        name: 'igris_test_required_absent',
        description: 'BR-080 self-negative-control B (no required field)',
        inputSchema: {
          type: 'object',
          properties: { optional: {} },
          additionalProperties: false,
        },
        handler: handlerNoField,
      },
    ]);

    await expect(
      gateway.dispatch('igris_test_required_empty_array', {}),
    ).resolves.toEqual(makeOkResult('empty-array-ran'));
    await expect(
      gateway.dispatch('igris_test_required_absent', {}),
    ).resolves.toEqual(makeOkResult('no-field-ran'));
    expect(handlerEmptyArray).toHaveBeenCalledTimes(1);
    expect(handlerNoField).toHaveBeenCalledTimes(1);
  });
});

describe('BR-080 missing-required contract — every registered tool that declares required', () => {
  const gateway = createGateway();
  gateway.register(collectAllTools());
  const requiring = gateway
    .listTools()
    .filter((t) => (t.inputSchema.required ?? []).length > 0);

  // CORPUS FLOOR. `it.each` over an empty array passes vacuously and reports
  // zero cases — a component-import regression or a schema-shape change that
  // silently emptied this list would turn the sweep below into a no-op that
  // still shows green. The floor is the assert-then-diff guard one level up.
  //
  // WHAT THE FLOOR IS COMPARED AGAINST (TD-321 corrected the referent): the
  // floor guards `requiring.length` — the number of REGISTERED tools whose
  // `listTools()` schema carries a non-empty `required` list. Re-measured at
  // TD-321: 75, out of 112 registered tools. Re-measured at FR-267 (2026-08-26,
  // metrics component retired — `igris_metrics_record` was its one
  // required-declaring tool): 74, out of 108.
  //
  // The BR-080 comment here named a different population: the 80
  // `required: [...]` source literals across the 16 component files that carry
  // one (79 across 15 files since FR-267). Both numbers are right in isolation,
  // and the two do not reconcile 1:1 — 4 of the literals are `required: []`
  // and 1 is a NESTED schema (the edge-spec array item in
  // `components/memory/index.ts`), which is why 80 - 5 = 75 and 79 - 5 = 74.
  // The floor clears both counts, so this was a wrong-referent sentence and
  // never a wrong gate.
  //
  // The floor sits deliberately BELOW the measured 74 so a legitimate tool
  // removal does not false-fail; it is a non-vacuity check, not a pin.
  it('the swept corpus is non-empty and at least 60 tools deep', () => {
    expect(requiring.length).toBeGreaterThanOrEqual(60);
  });

  it.each(requiring.map((t) => [t.name, t.inputSchema.required ?? []] as const))(
    '%s rejects an empty args object naming its first required key (BR-080)',
    async (name, required) => {
      await expect(gateway.dispatch(name, {})).rejects.toThrowError(
        new RegExp(
          `^${name}: missing required argument '${required[0]}'\\. Required: `,
        ),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// TD-321 omitted-`params.arguments` normalisation — the other 34 tools (37 at TD-321).
// ---------------------------------------------------------------------------
//
// The MCP spec makes `params.arguments` OPTIONAL, and both brain entrypoints
// (`src/index.ts` stdio `CallToolRequestSchema` handler and the HTTP
// direct-dispatch fallback) forward `request.params.arguments` to
// `gateway.dispatch` without defaulting it. So `args` really does arrive as
// `undefined` in production.
//
// BR-080 read the required walk through a no-args stand-in but deliberately
// did not forward it: the TD-128 extras walk still ran `Object.keys(args)` on
// the original. For the 75 tools that declare `required` the guard threw first
// and the walk was never reached — but for the other 37 the call fell straight
// into `Object.keys(undefined)`:
//
//     TypeError: Cannot convert undefined or null to object
//
// which is the exact symptom class BR-080 exists to eliminate. TD-321
// normalises the omitted-arguments case ONCE at the top of `dispatch()`, so an
// absent `arguments` is exactly equivalent to `{}` for all 108 tools (FR-267).
//
// WHAT THIS BLOCK PROVES:
//   - `undefined` AND `null` args normalise, on both schema shapes that produce
//     an empty `_required` (`required: []` and no `required` field at all);
//   - the handler receives `{}` — not `undefined`, and not a value that merely
//     survived the gateway's own walks;
//   - the property holds for every REAL registered schema in the 37-tool half
//     of the corpus, not just a hand-written fixture (the parameterized sweep);
//   - normalisation did not disarm the two walks it feeds: an extra key on an
//     omitted-args-normalised call still throws TD-128, and a supplied args
//     object still reaches the handler as the SAME object (identity control —
//     a normalisation that copied would silently break handlers that mutate or
//     compare by reference).
//
// WHAT THIS BLOCK DOES NOT PROVE:
//   - that any of the 37 handlers is SEMANTICALLY happy with `{}`. The sweep
//     registers each real schema with a STUB handler on purpose: the real
//     handlers open the operator's live brain DB at `~/.igris/memory/`, which a
//     unit test must never touch. What the schema says is the contract — a tool
//     that declares no `required` key is advertising that `{}` is a legal call,
//     and if that advertisement is wrong the defect is in the schema, which is
//     the same residual the BR-080 ledger above already records.
//   - anything about the 74 required-declaring tools; that half is the BR-080
//     sweep above.

describe('TD-321 omitted-arguments normalisation — fixtures', () => {
  it.each([
    ['required: [] declared', 'igris_test_td321_empty_array', [] as string[]],
    ['no required field', 'igris_test_td321_no_field', undefined],
  ])(
    'a tool with %s dispatches on omitted args and its handler receives {}',
    async (_shape, name, required) => {
      const gateway = createGateway();
      const handler = vi.fn(async (_args: Record<string, unknown>) =>
        makeOkResult('td321-ran'),
      );
      gateway.register([
        {
          name,
          description: 'TD-321 fixture (no required list)',
          inputSchema: {
            type: 'object',
            properties: { optional: {} },
            ...(required ? { required } : {}),
            additionalProperties: false,
          },
          handler,
        },
      ]);

      await expect(
        gateway.dispatch(name, undefined as unknown as Record<string, unknown>),
      ).resolves.toEqual(makeOkResult('td321-ran'));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({});
    },
  );

  it('a null args object normalises the same way as an omitted one', async () => {
    // `Object.keys(null)` throws the identical TypeError, and a JSON-RPC client
    // that serialises an absent argument map as `null` is as plausible as one
    // that omits the key.
    const gateway = createGateway();
    const handler = vi.fn(async (_args: Record<string, unknown>) =>
      makeOkResult('td321-null-ran'),
    );
    gateway.register([
      {
        name: 'igris_test_td321_null',
        description: 'TD-321 fixture (null args)',
        inputSchema: {
          type: 'object',
          properties: { optional: {} },
          additionalProperties: false,
        },
        handler,
      },
    ]);

    await expect(
      gateway.dispatch('igris_test_td321_null', null as unknown as Record<string, unknown>),
    ).resolves.toEqual(makeOkResult('td321-null-ran'));
    expect(handler).toHaveBeenCalledWith({});
  });

  it('the old TypeError is gone: the failure mode is not "Cannot convert undefined or null to object"', async () => {
    // Red-first anchor. Before TD-321 this dispatch rejected with exactly that
    // message, thrown by `Object.keys(args)` in the TD-128 extras walk.
    const gateway = createGateway();
    gateway.register([
      {
        name: 'igris_test_td321_typeerror',
        description: 'TD-321 fixture (old TypeError anchor)',
        inputSchema: {
          type: 'object',
          properties: { optional: {} },
          additionalProperties: false,
        },
        handler: async () => makeOkResult('reached-handler'),
      },
    ]);

    const outcome = await gateway
      .dispatch(
        'igris_test_td321_typeerror',
        undefined as unknown as Record<string, unknown>,
      )
      .then(
        (r) => ({ ok: true as const, text: JSON.stringify(r) }),
        (e: unknown) => ({
          ok: false as const,
          text: e instanceof Error ? e.message : String(e),
        }),
      );

    expect(outcome.text).not.toMatch(/Cannot convert undefined or null to object/);
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('reached-handler');
  });

  // CONTROL — normalisation is not a bypass. The TD-128 extras walk now reads
  // the normalised object, so it must still reject an unknown key.
  it('control: normalisation does not disarm the TD-128 extras walk', async () => {
    const gateway = createGateway();
    const handler = vi.fn(async (_args: Record<string, unknown>) => makeOkResult());
    gateway.register([
      {
        name: 'igris_test_td321_extras_still_reject',
        description: 'TD-321 control (extras walk still armed)',
        inputSchema: {
          type: 'object',
          properties: { optional: {} },
          additionalProperties: false,
        },
        handler,
      },
    ]);

    await expect(
      gateway.dispatch('igris_test_td321_extras_still_reject', { bogus: 1 }),
    ).rejects.toThrowError(/unknown argument 'bogus'/);
    expect(handler).not.toHaveBeenCalled();
  });

  // CONTROL — identity. A supplied args object must reach the handler as the
  // SAME reference; `args ?? {}` preserves that, a spread or clone would not.
  it('control: a supplied args object reaches the handler by identity, not by copy', async () => {
    const gateway = createGateway();
    const handler = vi.fn(async (_args: Record<string, unknown>) => makeOkResult());
    gateway.register([
      {
        name: 'igris_test_td321_identity',
        description: 'TD-321 control (no copy on the supplied path)',
        inputSchema: {
          type: 'object',
          properties: { optional: {} },
          additionalProperties: false,
        },
        handler,
      },
    ]);

    const supplied = { optional: 'value' };
    await gateway.dispatch('igris_test_td321_identity', supplied);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toBe(supplied);
  });
});

describe('TD-321 omitted-arguments normalisation — every registered tool that declares no required', () => {
  // Real registered schemas, STUB handlers (see the block ledger above: the
  // real ones open the operator's brain DB). The schema — `properties`,
  // `additionalProperties`, `required` — is what both gateway walks read, and
  // it is carried over verbatim.
  const nonRequiring = collectAllTools().filter(
    (t) => (t.inputSchema.required ?? []).length === 0,
  );

  // CORPUS FLOOR. Same non-vacuity guard as the BR-080 sweep: `it.each` over an
  // empty array passes while reporting zero cases. The floor guards
  // `nonRequiring.length` — registered tools whose `required` list is absent or
  // empty. Measured at TD-321: 37, the complement of BR-080's 75, summing to
  // the 112 registered tools that `gateway-tool-count.test.ts` pins. Re-measured
  // at FR-267 (2026-08-26): 34, the complement of 74, summing to 108 — the three
  // `igris_metrics_query` / `_velocity` / `_dashboard` tools that left declared
  // no `required`. The floor sits below 34 so a legitimate tool removal (or a
  // tool GAINING a required key, which moves it into the other sweep) does not
  // false-fail.
  it('the swept corpus is non-empty and at least 25 tools deep', () => {
    expect(nonRequiring.length).toBeGreaterThanOrEqual(25);
  });

  it.each(nonRequiring.map((t) => [t.name, t] as const))(
    '%s dispatches on an omitted args object instead of throwing a TypeError (TD-321)',
    async (name, tool) => {
      const gateway = createGateway();
      const handler = vi.fn(async (_args: Record<string, unknown>) =>
        makeOkResult('swept-stub-ran'),
      );
      gateway.register([{ ...tool, handler }]);

      await expect(
        gateway.dispatch(name, undefined as unknown as Record<string, unknown>),
      ).resolves.toEqual(makeOkResult('swept-stub-ran'));
      expect(handler).toHaveBeenCalledWith({});
    },
  );
});
