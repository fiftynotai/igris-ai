/**
 * Cognition backend — `resolveOpencodeModel` / `oauthProviders` (BR-110), the
 * pure resolver `spawn-map.ts`, `preflight.ts` and the TD-472 probe all share.
 *
 * Every case passes an EXPLICIT `home` (the injectable param) — no HOME fence,
 * no real CLI, no filesystem outside a per-test `mkdtemp`.
 *
 * Names only (D6): `auth.json` fixtures carry `.type` and nothing shaped like a
 * secret; `model.json` fixtures carry public model identifiers.
 *
 * @module engine/components/cognition/__tests__/opencode-model.test
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oauthProviders, resolveOpencodeModel } from '../backend/opencode-model.js';

let home = '';
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = '';
});

function freshHome(): string {
  home = mkdtempSync(join(tmpdir(), 'opencode-model-'));
  return home;
}

function writeAuth(h: string, providers: Record<string, string>): void {
  mkdirSync(join(h, '.local', 'share', 'opencode'), { recursive: true });
  const j: Record<string, { type: string }> = {};
  for (const [id, type] of Object.entries(providers)) j[id] = { type };
  writeFileSync(join(h, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify(j));
}

function writeModelState(h: string, recent: Array<[string, string]>, favorite: Array<[string, string]> = []): void {
  mkdirSync(join(h, '.local', 'state', 'opencode'), { recursive: true });
  const toRefs = (list: Array<[string, string]>) => list.map(([providerID, modelID]) => ({ providerID, modelID }));
  writeFileSync(
    join(h, '.local', 'state', 'opencode', 'model.json'),
    JSON.stringify({ recent: toRefs(recent), favorite: toRefs(favorite) }),
  );
}

describe('oauthProviders — names + .type only (D6)', () => {
  it('returns the sorted ids whose auth.json entry has type "oauth"', () => {
    const h = freshHome();
    writeAuth(h, { zeta: 'oauth', alpha: 'api', beta: 'oauth', gamma: 'wellknown' });
    expect(oauthProviders(h)).toEqual(['beta', 'zeta']);
  });

  it('an absent auth.json → []', () => {
    expect(oauthProviders(freshHome())).toEqual([]);
  });

  it('a malformed auth.json → [] (fail-closed, never throws)', () => {
    const h = freshHome();
    mkdirSync(join(h, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(join(h, '.local', 'share', 'opencode', 'auth.json'), '{not json');
    expect(oauthProviders(h)).toEqual([]);
  });

  it('an auth.json that is a JSON array (not an object) → []', () => {
    const h = freshHome();
    mkdirSync(join(h, '.local', 'share', 'opencode'), { recursive: true });
    writeFileSync(join(h, '.local', 'share', 'opencode', 'auth.json'), '[]');
    expect(oauthProviders(h)).toEqual([]);
  });
});

describe('resolveOpencodeModel — no configured model (recent, then favorite)', () => {
  it('the first recent entry whose provider is oauth resolves', () => {
    const h = freshHome();
    writeAuth(h, { openai: 'oauth', openrouter: 'api' });
    writeModelState(h, [['openai', 'gpt-5.5']]);
    expect(resolveOpencodeModel(undefined, h)).toEqual({ usable: true, model: 'openai/gpt-5.5' });
  });

  it('an api-typed recent entry is SKIPPED, not refused — a later oauth entry still resolves', () => {
    const h = freshHome();
    writeAuth(h, { openai: 'oauth', openrouter: 'api' });
    writeModelState(h, [
      ['openrouter', 'gemini-3-pro-preview'],
      ['openai', 'gpt-5.5'],
    ]);
    expect(resolveOpencodeModel(undefined, h)).toEqual({ usable: true, model: 'openai/gpt-5.5' });
  });

  it('recent is exhausted (no oauth match) → favorite is tried next', () => {
    const h = freshHome();
    writeAuth(h, { openai: 'oauth', openrouter: 'api' });
    writeModelState(h, [['openrouter', 'gemini-3-pro-preview']], [['openai', 'gpt-5.5-pro']]);
    expect(resolveOpencodeModel(undefined, h)).toEqual({ usable: true, model: 'openai/gpt-5.5-pro' });
  });

  it('no oauth provider at all → no_subscription_model', () => {
    const h = freshHome();
    writeAuth(h, { openrouter: 'api' });
    writeModelState(h, [['openrouter', 'gemini-3-pro-preview']]);
    const r = resolveOpencodeModel(undefined, h);
    expect(r.usable).toBe(false);
    expect(r.usable === false && r.reason).toBe('no_subscription_model');
  });

  it('an oauth provider exists but no candidate names it → no_subscription_model', () => {
    const h = freshHome();
    writeAuth(h, { openai: 'oauth', openrouter: 'api' });
    writeModelState(h, [['openrouter', 'gemini-3-pro-preview']]);
    const r = resolveOpencodeModel(undefined, h);
    expect(r.usable).toBe(false);
    expect(r.usable === false && r.reason).toBe('no_subscription_model');
  });

  it('no model.json at all (fresh install, an oauth provider exists) → no_subscription_model', () => {
    const h = freshHome();
    writeAuth(h, { openai: 'oauth' });
    const r = resolveOpencodeModel(undefined, h);
    expect(r.usable).toBe(false);
    expect(r.usable === false && r.reason).toBe('no_subscription_model');
  });
});

describe('resolveOpencodeModel — a configured model', () => {
  it('a configured model naming an oauth provider resolves verbatim (recent/favorite ignored)', () => {
    const h = freshHome();
    writeAuth(h, { openai: 'oauth' });
    writeModelState(h, [['openai', 'gpt-5.5']]);
    expect(resolveOpencodeModel('openai/gpt-5.5-pro', h)).toEqual({ usable: true, model: 'openai/gpt-5.5-pro' });
  });

  it('a configured model naming a non-oauth (api) provider is REFUSED', () => {
    const h = freshHome();
    writeAuth(h, { openai: 'oauth', openrouter: 'api' });
    const r = resolveOpencodeModel('openrouter/gemini-3-pro-preview', h);
    expect(r.usable).toBe(false);
    expect(r.usable === false && r.reason).toBe('no_subscription_model');
    expect(r.usable === false && r.detail).toContain('openrouter');
  });

  it('a configured model naming a provider with NO auth.json entry at all is refused', () => {
    const h = freshHome();
    writeAuth(h, { openai: 'oauth' });
    const r = resolveOpencodeModel('unknown-provider/x', h);
    expect(r.usable).toBe(false);
    expect(r.usable === false && r.reason).toBe('no_subscription_model');
  });
});
