/**
 * Janitor merge-prompt + synthesis tests (M1 / FR-116).
 *
 * M1 enriches the janitor system prompt so a `merge` verdict covers not only
 * near-identical restatements but also COMPLEMENTARY pairs — two learnings that
 * capture different facets of the same knowledge and are strictly better fused
 * into ONE synthesized survivor that PRESERVES BOTH sides' distinct details
 * ("synthesized-C").
 *
 * The output CONTRACT is unchanged: synthesized-C content rides the existing
 * `synthesized_content?` field of a `merge` proposal, which `validateJanitorResponse`
 * (and downstream `applyMergeLearnings`) already consume. These tests pin:
 *   - the system prompt now instructs the LLM about complementary/synthesized-C
 *     merges while keeping the four verdicts (merge/keep_a/keep_b/keep_both);
 *   - a `merge` response whose synthesized_content unions BOTH learnings'
 *     details round-trips through the validator with both details preserved and
 *     the shipped MergeProposal shape intact.
 *
 * No mocks (L-159): the prompt builders + validator are pure.
 *
 * @module engine/components/janitor/__tests__/prompts.test
 */

import { describe, it, expect } from 'vitest';
import { buildJanitorSystemPrompt } from '../prompts.js';
import { validateJanitorResponse } from '../validator.js';
import type { DuplicatePair } from '../types.js';

describe('buildJanitorSystemPrompt — M1 synthesized-C guidance (FR-116)', () => {
  const sys = buildJanitorSystemPrompt();

  it('keeps all four verdicts', () => {
    for (const v of ['merge', 'keep_a', 'keep_b', 'keep_both']) {
      expect(sys).toContain(v);
    }
  });

  it('instructs the LLM on complementary / synthesized-C merges preserving both sides', () => {
    expect(sys.toLowerCase()).toContain('complementary');
    // The load-bearing instruction: the synthesized survivor must preserve every
    // distinct detail from BOTH sides (never a pick-one).
    expect(sys).toContain('synthesized_content');
    expect(sys.toUpperCase()).toContain('BOTH');
  });
});

describe('validateJanitorResponse — synthesized-C merge round-trips unchanged (FR-116)', () => {
  const pairs: DuplicatePair[] = [
    {
      from_id: 10,
      to_id: 20,
      from_title: 'Retry policy',
      from_snippet: 'Retry failed network calls three times.',
      to_title: 'Retry backoff',
      to_snippet: 'Use exponential backoff between retries.',
      cosine: 0.91,
      overlap: 0.62,
    },
  ];

  it('preserves BOTH sides\' details in a merge proposal (synthesized-C)', () => {
    const synthesized =
      'Retry failed network calls three times using exponential backoff between attempts.';
    const raw = JSON.stringify([
      {
        from_id: 10,
        to_id: 20,
        verdict: 'merge',
        survivor_id: 10,
        synthesized_content: synthesized,
        confidence: 0.8,
        justification: 'Complementary facets of the same retry rule — fused.',
      },
    ]);

    const out = validateJanitorResponse(raw, pairs);
    expect(out).toHaveLength(1);
    // Shipped MergeProposal shape — unchanged by M1.
    expect(out[0]).toMatchObject({
      survivor_id: 10,
      duplicate_id: 20,
      verdict: 'merge',
      synthesized_content: synthesized,
    });
    // Both distinct details survive the synthesis.
    expect(out[0].synthesized_content).toContain('three times');
    expect(out[0].synthesized_content).toContain('backoff');
    expect(out[0].cosine).toBe(0.91);
  });
});
