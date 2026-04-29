/**
 * Pre-canned LLM responses for the perception LLM-extractor tests.
 *
 * These are stdout strings the mocked `claude -p` subprocess emits. Each
 * fixture exercises a specific shape of the extractJsonArrayReply path so
 * we can assert validation and coercion behavior without invoking the real
 * model.
 *
 * @module engine/components/perception/__tests__/fixtures/canned-llm-responses
 */

/** Three valid candidates. Used for the happy-path mocked test. */
export const cannedThreeCandidates = JSON.stringify([
  {
    category: 'pattern',
    title: 'Watermark file path matches sync_queue convention',
    content:
      'Use ~/.igris/projects/{slug}/session/perception_watermark.txt to mirror sync_queue.jsonl placement. Drained by /awaken and /rest.',
    tags: ['perception', 'watermark', 'session'],
    confidence: 0.7,
    evidence: { transcript_excerpt: 'Watermark file: ~/.igris/projects/{slug}/session/perception_watermark.txt' },
    tech_stack: 'typescript,sqlite',
  },
  {
    category: 'decision',
    title: 'Mode B chosen over Mode A or C',
    content: 'Rules + LLM both fire on the same window; dedupe handles overlap. Heuristic-first cost gate skips LLM when rules sufficient.',
    tags: ['mode-b', 'cost-gate'],
    confidence: 0.8,
    evidence: { transcript_excerpt: 'Run mode: Mode B' },
  },
  {
    category: 'mistake',
    title: 'Forgot to add review_status to test schema',
    content: 'When updating a learnings table column, every test schema that reproduces it needs the same column added.',
    tags: ['testing', 'schema'],
    confidence: 0.6,
    evidence: { transcript_excerpt: 'review_status TEXT NOT NULL DEFAULT approved' },
  },
]);

/** Empty array — the LLM declined to extract anything. */
export const cannedEmpty = '[]';

/** Garbage non-JSON. */
export const cannedGarbage = 'I am sorry, I cannot help with that.';

/** Fenced JSON. */
export const cannedFenced = `\`\`\`json
${JSON.stringify([
  {
    category: 'discovery',
    title: 'Fenced response works',
    content: 'Code fences are stripped before parsing.',
    tags: [],
    confidence: 0.5,
    evidence: { transcript_excerpt: 'fenced' },
  },
])}
\`\`\``;

/** Envelope shape — `--output-format json` wrapping a JSON array as a string. */
export const cannedEnveloped = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: JSON.stringify([
    {
      category: 'optimization',
      title: 'Envelope handling works',
      content: 'extractJsonArrayReply recurses on the result field of an envelope.',
      tags: ['envelope'],
      confidence: 0.55,
      evidence: { transcript_excerpt: 'envelope' },
    },
  ]),
});

/** Mixed valid/invalid candidates — the validator drops the bad ones. */
export const cannedMixedValidity = JSON.stringify([
  {
    category: 'pattern',
    title: 'Valid one',
    content: 'This survives validation.',
    tags: [],
    confidence: 0.6,
    evidence: { transcript_excerpt: 'ok' },
  },
  {
    // Invalid: missing category
    title: 'Missing category',
    content: 'Should be dropped.',
    tags: [],
    confidence: 0.5,
    evidence: {},
  },
  {
    // Invalid: oversize title (>120 chars)
    category: 'pattern',
    title: 'X'.repeat(150),
    content: 'Should be dropped.',
    tags: [],
    confidence: 0.5,
    evidence: {},
  },
  {
    // Invalid: empty content
    category: 'discovery',
    title: 'Empty content',
    content: '',
    tags: [],
    confidence: 0.5,
    evidence: {},
  },
  {
    // Valid second one
    category: 'mistake',
    title: 'Another valid one',
    content: 'Also survives.',
    tags: ['ok'],
    confidence: 0.5,
    evidence: { transcript_excerpt: 'second' },
  },
]);

/** Confidence-cap test — the LLM returns 0.95, validator coerces to 0.85. */
export const cannedHighConfidence = JSON.stringify([
  {
    category: 'pattern',
    title: 'Overconfident LLM output',
    content: 'Self-reports 0.95 confidence; validator caps at 0.85.',
    tags: [],
    confidence: 0.95,
    evidence: { transcript_excerpt: 'cap' },
  },
]);
