/**
 * TD-128 Gateway Strict-Input Contract — M1 (warn-mode) Unit Tests
 *
 * Asserts that the gateway's strict-input infrastructure (added in M1) emits
 * a warn log on unknown args for tools with `additionalProperties: false`,
 * and that the warn does NOT block the dispatch (handler still receives args).
 *
 * Permissive tools (no `additionalProperties` field) must remain unaffected.
 *
 * The parameterized "every registered tool has additionalProperties: false"
 * test is staged as an `it.todo` placeholder — M2 enables it once the schema
 * sweep lands.
 *
 * These warn-mode tests will be REPLACED in M4 with reject-mode equivalents
 * (per plan §4.M4).
 *
 * @module engine/__tests__/gateway-strict-input.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGateway } from '../gateway.js';
import type { ToolDefinition, ToolResult } from '../types.js';

function makeOkResult(text = 'ok'): ToolResult {
  return { content: [{ type: 'text', text }] };
}

describe('TD-128 gateway strict-input contract — M1 warn-mode', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('strict tool emits warn on unknown arg but still dispatches to handler', async () => {
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

    const result = await gateway.dispatch('igris_test_strict', {
      project: 'igris-ai',
      brief_id: 'TD-128',
      bogus_extra: 'should-warn',
    });

    // Warn was emitted with TD-128 marker, tool name, and offending key.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain('[TD-128]');
    expect(warnMsg).toContain('igris_test_strict');
    expect(warnMsg).toContain("unknown argument 'bogus_extra'");
    expect(warnMsg).toContain('warn-only');

    // Handler still received the args unchanged (warn does NOT block).
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      project: 'igris-ai',
      brief_id: 'TD-128',
      bogus_extra: 'should-warn',
    });
    expect(result).toEqual(makeOkResult('strict-handler-ran'));
  });

  it('permissive tool (no additionalProperties) emits no warn even with extras', async () => {
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
        // additionalProperties intentionally omitted — preserves M1+M2 transition
        // window where un-swept schemas continue to accept extras silently.
      },
      handler,
    };
    gateway.register([tool]);

    const result = await gateway.dispatch('igris_test_permissive', {
      project: 'igris-ai',
      mystery_field: 42,
      another_extra: true,
    });

    // No warn emitted on permissive-path tools.
    expect(warnSpy).not.toHaveBeenCalled();

    // Handler received all args unchanged.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      project: 'igris-ai',
      mystery_field: 42,
      another_extra: true,
    });
    expect(result).toEqual(makeOkResult('permissive-handler-ran'));
  });

  // M2 will replace this todo with an `it.each` parameterized test that
  // iterates `engine.gateway.listTools()` and asserts every entry has
  // `additionalProperties: false`. See plan §4.M2.
  it.todo(
    'every registered tool has additionalProperties: false (parameterized — enabled in M2)',
  );
});
