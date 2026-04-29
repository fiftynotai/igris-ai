/**
 * Synthetic transcript fixtures for perception extractor tests (FR-109).
 *
 * Hand-crafted JSONL-like event arrays exercising each rule extractor's
 * happy path, edge cases, and false-positive guards. The LLM extractor
 * tests reuse a subset of these.
 *
 * @module engine/components/perception/__tests__/fixtures/synthetic-transcripts
 */

import type { TranscriptEvent } from '../../types.js';

/** Helper to compose events with sensible defaults. */
export function ev(role: string, content: string, ts = '2026-04-29T10:00:00Z'): TranscriptEvent {
  return { role, content, timestamp: ts };
}

/** Simple LEARNED-marker line in an assistant turn. */
export const transcriptWithSingleLearned: TranscriptEvent[] = [
  ev('user', 'Lets fix the failing test.'),
  ev('assistant', 'I tried running migrations against an in-memory DB and it cleared the prod data once.\n\nLEARNED: never run migrations against in-memory DB without IGRIS_DB_PATH override; it can shadow prod path resolution.'),
];

/** Multiple LEARNED markers in a single message. */
export const transcriptWithMultipleLearned: TranscriptEvent[] = [
  ev('assistant', 'Recap of the session:\n- LEARNED: prefer parametrised SQL\n- LEARNED: vectorSearch returns rowid not id\n- LEARNED: better-sqlite3 iterate blocks the connection during writes\n'),
];

/** LEARNED inside a markdown bullet — must still match. */
export const transcriptWithMarkdownLearned: TranscriptEvent[] = [
  ev('assistant', 'Outcomes:\n  * LEARNED: the perception runner must drain the inbox before extraction so the watermark advances correctly.'),
];

/** Should NOT match — "we learned that" is in-paragraph English. */
export const transcriptWithFalsePositive: TranscriptEvent[] = [
  ev('user', 'we learned that the previous approach was too slow, but moving on, can you help with the next thing?'),
  ev('assistant', 'Sure — i learned a lot from that. Let me try again.'),
];

/** sentinel-FAIL → forger fix → sentinel-PASS chain. */
export const transcriptWithRetryChain: TranscriptEvent[] = [
  ev('user', 'Run the new tests please.'),
  ev('sentinel', 'verdict: FAIL — `handleMemoryRecall` returned pending rows; expected only approved.'),
  ev('forger', 'Adding `AND review_status = \'approved\'` to the recall BM25 query.'),
  ev('sentinel', 'verdict: PASS — recall now hides pending rows.'),
];

/** Same chain but with intervening events that should not break the match. */
export const transcriptWithRetryChainAndDrift: TranscriptEvent[] = [
  ev('sentinel', 'verdict: FAIL — lint error on perception/runner.ts'),
  ev('forger', 'Looking at the file...'),
  ev('user', 'small drift question — can we increase the timeout?'),
  ev('forger', 'Fixing the lint issue: missing trailing semicolon.'),
  ev('sentinel', 'verdict: PASS — lint clean.'),
];

/** Two FAILs but only one fix → only one chain emitted. */
export const transcriptWithFailWithoutFix: TranscriptEvent[] = [
  ev('sentinel', 'verdict: FAIL — first failure'),
  ev('user', 'thinking about it'),
  ev('user', 'still thinking'),
  ev('user', 'still thinking'),
  ev('user', 'still thinking'),
  ev('user', 'still thinking'),
  ev('user', 'still thinking'),
  ev('user', 'still thinking'),
  ev('user', 'still thinking'),
  ev('sentinel', 'verdict: FAIL — different failure'),
  ev('forger', 'fix attempt'),
  ev('sentinel', 'verdict: PASS — green'),
];

/** BLOCKER + RESOLUTION pair. */
export const transcriptWithBlockerResolution: TranscriptEvent[] = [
  ev('user', 'BLOCKER: cannot mock claude CLI on the macOS test runner; spawnSync hits PATH=/dev/null and crashes.'),
  ev('assistant', 'investigating...'),
  ev('assistant', 'RESOLVED: pass `command: "node"` and a stub script via the factory `command/args` overrides — same shape verifier.test.ts uses.'),
];

/** BLOCKER without RESOLUTION — should NOT emit. */
export const transcriptWithUnresolvedBlocker: TranscriptEvent[] = [
  ev('user', 'BLOCKER: db schema migration v15 collides with a partially-applied v14.'),
  ev('assistant', 'still investigating, no fix yet.'),
];

/** Two blockers, two resolutions — pair by recency. */
export const transcriptWithMultipleBlockerResolutions: TranscriptEvent[] = [
  ev('user', 'BLOCKER: first issue — vec extension not loaded'),
  ev('user', 'BLOCKER: second issue — embedding model missing'),
  ev('assistant', 'RESOLVED: ran npm rebuild for sqlite-vec'),
  ev('assistant', 'RESOLVED: downloaded model via Xenova HF'),
];

/** TypeScript error fingerprint with stack frames. */
export const transcriptWithTypeErrorFingerprint: TranscriptEvent[] = [
  ev(
    'tool',
    'TypeError: Cannot read properties of undefined (reading \'rowid\')\n    at vectorSearch (/Users/x/.../vector-search.ts:42:7)\n    at handleMemoryRecall (/Users/x/.../memory.ts:362:24)\n    at <anonymous>',
  ),
];

/** Same error appearing 3x — only one candidate (signature dedupe within a single run). */
export const transcriptWithDuplicateErrors: TranscriptEvent[] = [
  ev('tool', 'TypeError: Cannot read properties of undefined (reading \'foo\') at handler.ts:10:5'),
  ev('tool', 'TypeError: Cannot read properties of undefined (reading \'foo\') at handler.ts:11:5'),
  ev('tool', 'TypeError: Cannot read properties of undefined (reading \'foo\') at handler.ts:12:5'),
];

/** Generic "error" word in prose — should NOT match. */
export const transcriptWithErrorWord: TranscriptEvent[] = [
  ev('user', 'we got an error in our thinking but no actual exception was thrown'),
  ev('assistant', 'agreed, that was just a planning error.'),
];

/** Mixed transcript exercising all four rule extractors at once. */
export const transcriptMultiExtractor: TranscriptEvent[] = [
  ev('sentinel', 'verdict: FAIL\nTypeError: Cannot read properties of undefined (reading \'rowid\')\n    at vectorSearch (vector-search.ts:42:7)'),
  ev('forger', 'Adding null check to vectorSearch before reading rowid.'),
  ev('sentinel', 'verdict: PASS — null guard added.'),
  ev('user', 'BLOCKER: the in-memory DB does not load sqlite-vec.'),
  ev('assistant', 'RESOLVED: tests now use the noopVerifier path via the factory override.'),
  ev('assistant', 'LEARNED: sqlite-vec is unavailable in :memory: DBs unless we set IGRIS_DISABLE_VEC=1 explicitly.'),
];

/** A larger fixture used for the LLM-extractor opt-in integration. */
export const transcriptWithSubtlePattern: TranscriptEvent[] = [
  ev('user', 'I keep hitting the same problem when I refactor the runner — every time I move the dedupe loop I forget to update the integration tests in subconscious/__tests__/runner-verifier.test.ts.'),
  ev('assistant', 'Yeah, the runner test relies on the iteration order of the candidates array. If you swap dedupe before suppression you have to rebuild the expected output. We caught it last time too.'),
  ev('user', 'so what do we do?'),
  ev('assistant', 'Add a comment on the dedupe block that says it must come AFTER suppression — that documents the ordering invariant. The integration test already encodes it but the failure mode is unclear.'),
  ev('user', 'good idea.'),
];
