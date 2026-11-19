/**
 * TD-476 — RED-first unit tests for the TD-472 probe's `Census`'s new
 * `tool` classification / `tool_spawned` signal. Constructs fake `ps` rows
 * via a mocked `node:child_process#spawnSync`; NEVER spawns a real CLI and
 * makes NO live model calls (test_standards: no live calls in any vitest
 * file). Exercises the module's `--entry-point-only main()` guard as a side
 * effect: importing `Census` here must NOT trigger `main()` -> `parseArgs([])`
 * -> `refuse()` -> `process.exit(2)` on the vitest worker (the plan's
 * "Testability problem" — the fix this brief requires to make this file
 * possible at all).
 *
 * Cases (plan "Testing Strategy"):
 *   TC1 a bare `rg` descendant (not cli_self) classifies `tool`; `tool_spawned === true`
 *   TC2 antigravity's own `security find-generic-password` keychain helper does
 *       NOT classify `tool` (basename `security` is not in the denylist) — the
 *       concrete regression case the brief names
 *   TC3 a full-args MCP match still classifies `mcp` and sets `mcp_spawned`,
 *       independent of `tool_spawned` — the two signals never clobber each other
 *   TC4 a `cli_self`-classified descendant is NEVER also classified `tool`, even
 *       when its exe basename would otherwise match the denylist — precedence
 *       parity with the existing `mcp`/`cli_self` rule
 *
 * @module scripts/__tests__/td472_census.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

import { spawnSync } from 'node:child_process';
import { Census, HELPER_ARGS } from '../td472_child_env_probe.js';

const spawnSyncMock = spawnSync as unknown as Mock;

/** One `ps -Ao pid=,ppid=,args=` output line. */
const psLine = (pid: number, ppid: number, args: string): string => `${pid} ${ppid} ${args}`;

/**
 * Queue canned `ps` stdout, one array of lines per call (`Census.start()` +
 * `Census.stop()` call `sample()` exactly twice with no timer in between when
 * `stop()` runs synchronously right after `start()`, as every case below
 * does — the FIRST call is the "preexisting descendants" baseline, the
 * SECOND is what the fake tool/MCP/cli_self descendant is visible in). Any
 * call past the array's length reuses the last entry. Non-`ps` commands fail
 * closed (status 1, empty output) — nothing else is spawned in these tests.
 */
function queuePsOutput(...linesPerCall: string[][]): void {
  let call = 0;
  spawnSyncMock.mockImplementation((cmd: unknown, ...rest: unknown[]) => {
    if (cmd !== 'ps') return { status: 1, stdout: '', stderr: '', pid: 0, output: [], signal: null };
    const lines = linesPerCall[Math.min(call, linesPerCall.length - 1)];
    call += 1;
    void rest;
    return { status: 0, stdout: lines.join('\n'), stderr: '', pid: 0, output: [], signal: null };
  });
}

describe('TD-476 — Census tool classification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('TC1: a fake rg descendant (not cli_self) classifies tool; tool_spawned is true', () => {
    const parent = process.pid;
    queuePsOutput([], [psLine(900001, parent, '/usr/bin/rg pattern .')]);
    const census = new Census([], []);
    census.start();
    const result = census.stop();
    expect(result.tool_spawned).toBe(true);
    expect(result.mcp_spawned).toBe(false);
    expect(result.descendants).toContainEqual({ exe_basename: 'rg', classes: ['tool'] });
  });

  it("TC2: antigravity's own security find-generic-password helper does NOT classify tool (basename-only)", () => {
    const parent = process.pid;
    queuePsOutput([], [psLine(900002, parent, '/usr/bin/security find-generic-password -a fx -s fx -w')]);
    const census = new Census([], []);
    census.start();
    const result = census.stop();
    expect(result.tool_spawned).toBe(false);
    const security = result.descendants.find((d) => d.exe_basename === 'security');
    expect(security).toBeDefined();
    expect(security?.classes).toEqual([]);
  });

  it('TC3: a full-args MCP match still classifies mcp and sets mcp_spawned, independent of tool_spawned', () => {
    const parent = process.pid;
    queuePsOutput([], [psLine(900003, parent, '/usr/local/bin/mcp-server-foo --stdio')]);
    const census = new Census([], []);
    census.start();
    const result = census.stop();
    expect(result.mcp_spawned).toBe(true);
    expect(result.tool_spawned).toBe(false);
  });

  it('TC4: a cli_self descendant is never also classified tool, even when its basename matches the denylist', () => {
    const parent = process.pid;
    queuePsOutput([], [psLine(900004, parent, 'bash -c igris-fixture-td476-marker')]);
    const census = new Census(['igris-fixture-td476-marker'], []);
    census.start();
    const result = census.stop();
    const bash = result.descendants.find((d) => d.exe_basename === 'bash');
    expect(bash?.classes).toEqual(['cli_self']);
    expect(result.tool_spawned).toBe(false);
    expect(result.cli_seen).toBe(true);
  });

  it('TC5: an already-exited tool, which ps prints as "(rg)", still classifies tool', () => {
    const parent = process.pid;
    queuePsOutput([], [psLine(900005, parent, '(rg)')]);
    const census = new Census([], []);
    census.start();
    const result = census.stop();
    expect(result.tool_spawned).toBe(true);
    expect(result.descendants).toContainEqual({ exe_basename: '(rg)', classes: ['tool'] });
  });

  it('TC6: an exited "(node)" is left unattributed, since it is a node-script CLI launcher as often as a tool', () => {
    const parent = process.pid;
    queuePsOutput([], [psLine(900006, parent, '(node)')]);
    const census = new Census([], []);
    census.start();
    const result = census.stop();
    expect(result.tool_spawned).toBe(false);
    expect(result.descendants).toContainEqual({ exe_basename: '(node)', classes: [] });
  });

  it("TC7: opencode's exact startup index argv is cli_helper, not tool; any other rg still reads tool", () => {
    // The shipped signature must stay an exact match: a broadened pattern would pass a model's rg.
    expect(HELPER_ARGS.opencode?.map(String)).toEqual([String(/(^|\/)rg --no-config --files --glob=!\.git\/\* --hidden \.$/)]);
    const parent = process.pid;
    const sig = HELPER_ARGS.opencode ?? []; // the SHIPPED signature, not a copy
    queuePsOutput([], [
      psLine(900007, parent, '/x/.cache/opencode/bin/rg --no-config --files --glob=!.git/* --hidden .'),
      psLine(900008, parent, '/x/.cache/opencode/bin/rg secret_token .'),
    ]);
    const census = new Census([], [], [], sig);
    census.start();
    const result = census.stop();
    expect(result.descendants).toContainEqual({ exe_basename: 'rg', classes: ['cli_helper'] });
    expect(result.descendants).toContainEqual({ exe_basename: 'rg', classes: ['tool'] });
    expect(result.tool_spawned).toBe(true);
    expect(result.mcp_spawned).toBe(false);
  });

  it('TC8: a pid first seen running keeps its classification when a later sample shows it exited', () => {
    const parent = process.pid;
    const sig = HELPER_ARGS.opencode ?? []; // the SHIPPED signature, not a copy
    queuePsOutput([], [psLine(900009, parent, '/x/rg --no-config --files --glob=!.git/* --hidden .')], [psLine(900009, parent, '(rg)')]);
    vi.useFakeTimers();
    try {
      const census = new Census([], [], [], sig);
      census.start(); // sample 1: the pre-existing snapshot
      vi.advanceTimersByTime(150); // sample 2: the helper running
      const result = census.stop(); // sample 3: the same pid, exited
      expect(result.tool_spawned).toBe(false);
      expect(result.descendants).toContainEqual({ exe_basename: '(rg)', classes: ['cli_helper'] });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TD-478 — claude startup helpers + the no-model-tools exited-shell rule', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('TC9: HELPER_ARGS.claude pins the shipped git + xcodebuild regex pair exactly', () => {
    expect(HELPER_ARGS.claude?.map(String)).toEqual([
      String(
        /(^|\/)git -c core\.askPass= -c protocol\.ext\.allow=never -c submodule\.recurse=false -c log\.showSignature=false -c gc\.auto=0 -c maintenance\.auto=false -c core\.hooksPath=/,
      ),
      String(/(^|\/)xcodebuild -license check$/),
    ]);
  });

  it('TC10: the exact captured git argv (hardened flags, any core.hooksPath= suffix) classifies cli_helper, not tool', () => {
    const parent = process.pid;
    const sig = HELPER_ARGS.claude ?? []; // the SHIPPED signature, not a copy
    queuePsOutput(
      [],
      [
        psLine(
          900010,
          parent,
          '/usr/bin/git -c core.askPass= -c protocol.ext.allow=never -c submodule.recurse=false -c log.showSignature=false -c gc.auto=0 -c maintenance.auto=false -c core.hooksPath=/Users/x/.igris/core/git-hooks status',
        ),
      ],
    );
    const census = new Census([], [], [], sig);
    census.start();
    const result = census.stop();
    expect(result.descendants).toContainEqual({ exe_basename: 'git', classes: ['cli_helper'] });
    expect(result.tool_spawned).toBe(false);
  });

  it('TC11: the xcodebuild -license check argv classifies cli_helper, not tool', () => {
    const parent = process.pid;
    const sig = HELPER_ARGS.claude ?? []; // the SHIPPED signature, not a copy
    queuePsOutput([], [psLine(900011, parent, '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -license check')]);
    const census = new Census([], [], [], sig);
    census.start();
    const result = census.stop();
    expect(result.descendants).toContainEqual({ exe_basename: 'xcodebuild', classes: ['cli_helper'] });
    expect(result.tool_spawned).toBe(false);
  });

  it('TC12: an exited, argv-less (sh)/(bash)/(git) under modelHasNoTools=true classifies cli_helper', () => {
    const parent = process.pid;
    queuePsOutput([], [psLine(900012, parent, '(sh)'), psLine(900013, parent, '(bash)'), psLine(900017, parent, '(git)')]);
    const census = new Census([], [], [], [], true);
    census.start();
    const result = census.stop();
    expect(result.descendants).toContainEqual({ exe_basename: '(sh)', classes: ['cli_helper'] });
    expect(result.descendants).toContainEqual({ exe_basename: '(bash)', classes: ['cli_helper'] });
    // measured: claude's second git probe was sampled only after it exited (td477-evidence egress-claude-*-1)
    expect(result.descendants).toContainEqual({ exe_basename: '(git)', classes: ['cli_helper'] });
    expect(result.tool_spawned).toBe(false);
  });

  it('TC13 (negative control, AC-2): a LIVE, argv-bearing sh under modelHasNoTools=true still classifies tool', () => {
    const parent = process.pid;
    queuePsOutput([], [psLine(900014, parent, "/bin/sh -c 'cat /etc/hosts'")]);
    const census = new Census([], [], [], [], true);
    census.start();
    const result = census.stop();
    expect(result.descendants).toContainEqual({ exe_basename: 'sh', classes: ['tool'] });
    expect(result.tool_spawned).toBe(true);
  });

  it('TC14: the same exited (sh) under modelHasNoTools=false (opencode\'s existing construction) still classifies tool', () => {
    const parent = process.pid;
    queuePsOutput([], [psLine(900015, parent, '(sh)')]);
    const census = new Census([], [], [], [], false);
    census.start();
    const result = census.stop();
    expect(result.descendants).toContainEqual({ exe_basename: '(sh)', classes: ['tool'] });
    expect(result.tool_spawned).toBe(true);
  });
});
