/**
 * Cognition backend parse-output tests (FR-118 M0).
 *
 * Covers the per-harness stdout → text blob extraction (ported from
 * judge.ts:parseJudgeOutput): claude json/stream-json, codex JSONL, prose.
 *
 * @module engine/components/cognition/__tests__/parse-output.test
 */

import { describe, it, expect } from 'vitest';
import { extractText } from '../backend/parse-output.js';

describe('extractText', () => {
  it('extracts claude --output-format json result text', () => {
    const stdout = JSON.stringify({ type: 'result', result: '[{"title":"x"}]' });
    expect(extractText('claude', stdout)).toContain('[{"title":"x"}]');
  });

  it('extracts claude stream-json assistant content blocks', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello ' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'world' }] } }),
    ].join('\n');
    expect(extractText('claude', lines)).toBe('hello \nworld');
  });

  it('extracts codex JSONL agent_message texts', () => {
    const lines = [
      JSON.stringify({ item: { type: 'agent_message', text: 'first' } }),
      JSON.stringify({ item: { type: 'agent_message', text: 'second' } }),
    ].join('\n');
    expect(extractText('codex', lines)).toBe('first\nsecond');
  });

  it('keeps an unrecognised-but-valid JSON event as a raw line (faithful FR-201 port)', () => {
    // A valid JSON line that is NOT a known event shape is kept verbatim so the
    // instance parser can still find a payload in it (judge.ts:659-661 behaviour).
    const lines = [
      JSON.stringify({ item: { type: 'agent_message', text: 'real' } }),
      JSON.stringify({ item: { type: 'other', text: 'unknown-shape' } }),
    ].join('\n');
    const out = extractText('codex', lines);
    expect(out).toContain('real');
    expect(out).toContain('unknown-shape'); // kept as the raw line, not dropped
  });

  it('treats gemini/antigravity --print prose as raw text', () => {
    const stdout = 'line one\nline two\n';
    expect(extractText('antigravity', stdout)).toBe('line one\nline two');
  });

  it('keeps a bare JSON array printed directly (for the instance parser)', () => {
    const stdout = '[{"title":"direct"}]';
    expect(extractText('opencode', stdout)).toBe('[{"title":"direct"}]');
  });

  it('returns empty string for empty stdout', () => {
    expect(extractText('claude', '')).toBe('');
    expect(extractText('claude', '   \n  \n')).toBe('');
  });

  it('tolerates non-JSON garbage lines mixed with prose', () => {
    const stdout = 'preamble\n{not valid json\nactual answer';
    const out = extractText('gemini', stdout);
    expect(out).toContain('preamble');
    expect(out).toContain('actual answer');
  });
});
