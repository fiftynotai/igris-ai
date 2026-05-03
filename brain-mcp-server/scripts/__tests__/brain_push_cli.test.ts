/**
 * TD-080 — brain_push_cli unit tests.
 *
 * Covers:
 *   - parseCliArgs() flag handling + error paths
 *   - resolveRemoteConfig() hybrid (config.json default + flag overrides)
 *   - main() exit codes:
 *     * 0 on success / "remote not configured"
 *     * 1 on malformed args / handler throw
 *
 * Mocks:
 *   - sync.ts → handleBrainPush is replaced with a vi.fn so we can assert
 *     it was called with the resolved url+key, and to keep tests offline.
 *
 * @module scripts/__tests__/brain_push_cli.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

// Mock handleBrainPush BEFORE importing the CLI module so the import chain
// picks up the mocked symbol. Default impl returns a benign success payload.
vi.mock('../../src/tools/sync.js', () => ({
  handleBrainPush: vi.fn(async () => ({
    content: [{ type: 'text', text: 'Brain push completed successfully (test stub).' }],
  })),
}));

import { handleBrainPush } from '../../src/tools/sync.js';
import {
  parseCliArgs,
  resolveRemoteConfig,
  defaultConfigPath,
  main,
  USAGE,
} from '../brain_push_cli.js';

const mockedHandleBrainPush = vi.mocked(handleBrainPush);

function tempPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${randomBytes(6).toString('hex')}`);
}

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

describe('parseCliArgs', () => {
  it('parses required --project flag', () => {
    const args = parseCliArgs(['node', 'script.ts', '--project', 'igris-ai']);
    expect(args.project).toBe('igris-ai');
    expect(args.remoteUrlOverride).toBeUndefined();
    expect(args.apiKeyOverride).toBeUndefined();
    expect(args.dbPathOverride).toBeUndefined();
    expect(args.configPathOverride).toBeUndefined();
    expect(args.help).toBe(false);
  });

  it('parses optional override flags', () => {
    const args = parseCliArgs([
      'node',
      'script.ts',
      '--project',
      'p',
      '--db',
      '/tmp/test.db',
      '--remote-url',
      'http://staging.example.com',
      '--api-key',
      'override-key',
      '--config',
      '/tmp/cfg.json',
    ]);
    expect(args.dbPathOverride).toBe('/tmp/test.db');
    expect(args.remoteUrlOverride).toBe('http://staging.example.com');
    expect(args.apiKeyOverride).toBe('override-key');
    expect(args.configPathOverride).toBe('/tmp/cfg.json');
  });

  it('throws when --project is missing', () => {
    expect(() => parseCliArgs(['node', 's'])).toThrow(/--project/);
  });

  it('throws when a flag value is another flag', () => {
    expect(() => parseCliArgs(['node', 's', '--project', '--db', '/x'])).toThrow(/--project/);
  });

  it('returns help sentinel on --help without requiring --project', () => {
    const args = parseCliArgs(['node', 'script.ts', '--help']);
    expect(args.help).toBe(true);
    expect(args.project).toBe('');
  });

  it('returns help sentinel on -h short flag', () => {
    const args = parseCliArgs(['node', 'script.ts', '-h']);
    expect(args.help).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defaultConfigPath
// ---------------------------------------------------------------------------

describe('defaultConfigPath', () => {
  it('builds the canonical config.json path', () => {
    const p = defaultConfigPath();
    expect(p).toContain('.igris');
    expect(p).toContain('config.json');
  });
});

// ---------------------------------------------------------------------------
// resolveRemoteConfig — hybrid config.json + flag override
// ---------------------------------------------------------------------------

describe('resolveRemoteConfig', () => {
  const cleanupFiles: string[] = [];

  afterEach(() => {
    for (const f of cleanupFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
    cleanupFiles.length = 0;
  });

  it('returns null when config file is absent and no overrides are given', () => {
    const result = resolveRemoteConfig({
      remoteUrlOverride: undefined,
      apiKeyOverride: undefined,
      configPathOverride: tempPath('absent-cfg'),
    });
    expect(result).toBeNull();
  });

  it('returns null when config has empty url', () => {
    const cfgPath = tempPath('cfg');
    cleanupFiles.push(cfgPath);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ remote_brain: { url: '', api_key: 'has-key' } }),
    );
    const result = resolveRemoteConfig({
      remoteUrlOverride: undefined,
      apiKeyOverride: undefined,
      configPathOverride: cfgPath,
    });
    expect(result).toBeNull();
  });

  it('returns null when config has empty api_key', () => {
    const cfgPath = tempPath('cfg');
    cleanupFiles.push(cfgPath);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ remote_brain: { url: 'http://x', api_key: '' } }),
    );
    const result = resolveRemoteConfig({
      remoteUrlOverride: undefined,
      apiKeyOverride: undefined,
      configPathOverride: cfgPath,
    });
    expect(result).toBeNull();
  });

  it('returns null when config.json is malformed', () => {
    const cfgPath = tempPath('cfg-bad');
    cleanupFiles.push(cfgPath);
    fs.writeFileSync(cfgPath, '{not-valid-json');
    const result = resolveRemoteConfig({
      remoteUrlOverride: undefined,
      apiKeyOverride: undefined,
      configPathOverride: cfgPath,
    });
    expect(result).toBeNull();
  });

  it('reads url + key from config.json when both flags are absent', () => {
    const cfgPath = tempPath('cfg-good');
    cleanupFiles.push(cfgPath);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        remote_brain: { url: 'http://config-url', api_key: 'config-key' },
      }),
    );
    const result = resolveRemoteConfig({
      remoteUrlOverride: undefined,
      apiKeyOverride: undefined,
      configPathOverride: cfgPath,
    });
    expect(result).not.toBeNull();
    expect(result?.remoteUrl).toBe('http://config-url');
    expect(result?.apiKey).toBe('config-key');
  });

  it('flag overrides take precedence over config.json values', () => {
    const cfgPath = tempPath('cfg-good');
    cleanupFiles.push(cfgPath);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        remote_brain: { url: 'http://config-url', api_key: 'config-key' },
      }),
    );
    const result = resolveRemoteConfig({
      remoteUrlOverride: 'http://override-url',
      apiKeyOverride: 'override-key',
      configPathOverride: cfgPath,
    });
    expect(result?.remoteUrl).toBe('http://override-url');
    expect(result?.apiKey).toBe('override-key');
  });

  it('uses both flags as the sole source when both are supplied (no config read)', () => {
    // Pass an absent config path; both-flags path should not even try to read.
    const result = resolveRemoteConfig({
      remoteUrlOverride: 'http://flag-only',
      apiKeyOverride: 'flag-only-key',
      configPathOverride: tempPath('does-not-exist'),
    });
    expect(result?.remoteUrl).toBe('http://flag-only');
    expect(result?.apiKey).toBe('flag-only-key');
  });

  it('partial overrides fall back to config.json for the missing field', () => {
    const cfgPath = tempPath('cfg-good');
    cleanupFiles.push(cfgPath);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        remote_brain: { url: 'http://config-url', api_key: 'config-key' },
      }),
    );
    const result = resolveRemoteConfig({
      remoteUrlOverride: 'http://flag-url',
      apiKeyOverride: undefined,
      configPathOverride: cfgPath,
    });
    expect(result?.remoteUrl).toBe('http://flag-url');
    expect(result?.apiKey).toBe('config-key');
  });
});

// ---------------------------------------------------------------------------
// main — end-to-end CLI behavior
// ---------------------------------------------------------------------------

describe('main', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const cleanupFiles: string[] = [];

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedHandleBrainPush.mockClear();
    // Restore to default success implementation between tests.
    mockedHandleBrainPush.mockResolvedValue({
      content: [{ type: 'text', text: 'Brain push completed successfully (test stub).' }],
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    for (const f of cleanupFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
    cleanupFiles.length = 0;
  });

  it('returns 1 on malformed args', async () => {
    const code = await main(['node', 'brain_push_cli.ts']);
    expect(code).toBe(1);
    expect(mockedHandleBrainPush).not.toHaveBeenCalled();
  });

  it('returns 0 and prints USAGE on --help', async () => {
    const code = await main(['node', 'brain_push_cli.ts', '--help']);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(USAGE);
    expect(mockedHandleBrainPush).not.toHaveBeenCalled();
  });

  it('returns 0 silently when remote is not configured', async () => {
    const code = await main([
      'node',
      'brain_push_cli.ts',
      '--project',
      'p',
      '--config',
      tempPath('absent-cfg'),
    ]);
    expect(code).toBe(0);
    expect(mockedHandleBrainPush).not.toHaveBeenCalled();
    // Stderr note explains the silent skip.
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/remote not configured/));
  });

  it('calls handleBrainPush with config-derived url+key on success', async () => {
    const cfgPath = tempPath('cfg-main-ok');
    cleanupFiles.push(cfgPath);
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        remote_brain: { url: 'http://test-url', api_key: 'test-key' },
      }),
    );
    const code = await main([
      'node',
      'brain_push_cli.ts',
      '--project',
      'igris-ai',
      '--config',
      cfgPath,
    ]);
    expect(code).toBe(0);
    expect(mockedHandleBrainPush).toHaveBeenCalledTimes(1);
    expect(mockedHandleBrainPush).toHaveBeenCalledWith({
      remote_url: 'http://test-url',
      api_key: 'test-key',
    });
    // The handler's text payload is printed to stdout for the log file.
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Brain push completed successfully'),
    );
  });

  it('calls handleBrainPush with flag overrides when both are supplied', async () => {
    const code = await main([
      'node',
      'brain_push_cli.ts',
      '--project',
      'p',
      '--remote-url',
      'http://flag-url',
      '--api-key',
      'flag-key',
    ]);
    expect(code).toBe(0);
    expect(mockedHandleBrainPush).toHaveBeenCalledWith({
      remote_url: 'http://flag-url',
      api_key: 'flag-key',
    });
  });

  it('returns 1 when handleBrainPush throws', async () => {
    mockedHandleBrainPush.mockRejectedValueOnce(new Error('simulated network failure'));
    const code = await main([
      'node',
      'brain_push_cli.ts',
      '--project',
      'p',
      '--remote-url',
      'http://x',
      '--api-key',
      'k',
    ]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/handleBrainPush threw.*simulated network failure/),
    );
  });

  it('returns 0 when handleBrainPush returns isError (rows queued for retry)', async () => {
    // isError=true is the queue-failed path: rows are enqueued in sync_queue,
    // which the next /awaken §3.6.1 drain will retry. Helper still exits 0.
    mockedHandleBrainPush.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Brain push failed: timeout. Rows queued for retry: 12' }],
      isError: true,
    } as unknown as { content: { type: string; text: string }[] });
    const code = await main([
      'node',
      'brain_push_cli.ts',
      '--project',
      'p',
      '--remote-url',
      'http://x',
      '--api-key',
      'k',
    ]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('queued for retry'));
  });
});
