/**
 * Shared test helpers for brain-mcp-server test suites.
 *
 * Note: fakeEmbedding is also inlined in vi.hoisted() blocks in test files
 * that need it inside vi.mock() factories (vitest hoists mocks above imports,
 * so regular imports are not available). This file is the canonical source.
 * If you update fakeEmbedding here, also update the vi.hoisted() copies in:
 *   - hybrid-search.test.ts
 *   - error-similar.test.ts
 *   - brief-similar.test.ts
 *
 * @module tools/__tests__/test-helpers
 */

/**
 * Generate a deterministic fake embedding based on text hash.
 *
 * Produces a normalized 384-dimension Float32Array that is
 * deterministic for a given input string. Used in vi.mock()
 * factories to avoid loading the actual HF model in tests.
 *
 * @param text - Input text to generate a fake embedding for
 * @returns A normalized 384-dimension Float32Array
 */
export function fakeEmbedding(text: string): Float32Array {
  const arr = new Float32Array(384);
  // Simple hash-based seeding for deterministic but text-dependent vectors
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  for (let i = 0; i < 384; i++) {
    hash = ((hash << 5) - hash + i) | 0;
    arr[i] = (hash & 0xffff) / 0xffff;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < 384; i++) arr[i] /= norm;
  return arr;
}
