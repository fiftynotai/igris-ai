/**
 * FR-273 D6 — `normaliseRepoUrl` (plan §4.2 D1): every spelling of one repo
 * maps to ONE form; a different host or owner never matches.
 *
 * @module engine/components/projects/__tests__/url-normalise.test
 */

import { describe, it, expect } from 'vitest';
import { normaliseRepoUrl, sameRepo } from '../relations/url-normalise.js';

const CANON = 'github.com/kalvadtech/moca-agent-flutter-client';

describe('normaliseRepoUrl (D1)', () => {
  it.each([
    'https://github.com/KalvadTech/moca-agent-flutter-client',
    'https://github.com/KalvadTech/moca-agent-flutter-client.git',
    'https://github.com/KalvadTech/moca-agent-flutter-client/',
    'http://github.com/KalvadTech/moca-agent-flutter-client',
    'https://user:token@github.com/KalvadTech/moca-agent-flutter-client.git',
    'ssh://git@github.com/KalvadTech/moca-agent-flutter-client.git',
    'ssh://git@github.com:22/KalvadTech/moca-agent-flutter-client.git',
    'git@github.com:KalvadTech/moca-agent-flutter-client.git',
    'deploy-user:s3cr3t@github.com:KalvadTech/moca-agent-flutter-client.git',
    'git://github.com/KalvadTech/moca-agent-flutter-client.git',
    'git+https://github.com/KalvadTech/moca-agent-flutter-client.git',
    'git+ssh://git@github.com/KalvadTech/moca-agent-flutter-client.git#v2.0.0',
    'github:KalvadTech/moca-agent-flutter-client',
    'KalvadTech/moca-agent-flutter-client',
    '  GitHub.com/KALVADTECH/Moca-Agent-Flutter-Client  ',
  ])('%s → the one form', (raw) => {
    expect(normaliseRepoUrl(raw)).toBe(CANON);
  });

  it('a different host or a different owner does not match (M40)', () => {
    expect(normaliseRepoUrl('https://gitlab.com/KalvadTech/moca-agent-flutter-client')).toBe('gitlab.com/kalvadtech/moca-agent-flutter-client');
    expect(sameRepo('https://gitlab.com/KalvadTech/moca-agent-flutter-client', CANON)).toBe(false);
    expect(sameRepo('https://github.com/Other/moca-agent-flutter-client', CANON)).toBe(false);
    expect(sameRepo('git@github.com:KalvadTech/moca-agent-flutter-client.git', 'https://github.com/KalvadTech/moca-agent-flutter-client')).toBe(true);
  });

  it('unparseable input is null, and null never matches', () => {
    for (const raw of ['', '   ', 'not a url', '^1.2.3', 'file:../x', 'FILE:///Users/x/pkg', 'FILE:///Users/x', 'File:///Users/acme', 'File:///x']) expect(normaliseRepoUrl(raw), raw).toBeNull();
    expect(sameRepo('', '')).toBe(false);
  });
});
