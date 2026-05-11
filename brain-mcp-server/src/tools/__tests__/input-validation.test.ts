/**
 * Input Validation Tests (TD-030)
 *
 * Tests for input length validation on:
 * 1. handleErrorSimilar — message length check
 * 2. handleMemoryHybridSearch — query length check
 *
 * @module tools/__tests__/input-validation.test
 */

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — declared before imports
// ---------------------------------------------------------------------------

vi.mock('../../db.js', () => ({
  getDb: vi.fn(),
  BRAIN_DIR: '/tmp/igris-test',
}));

vi.mock('../../utils/embeddings.js', () => ({
  generateEmbedding: vi.fn(),
  embeddingToBuffer: vi.fn(),
  processInBatches: vi.fn(),
  EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_DIMENSIONS: 384,
}));

vi.mock('../../utils/vector-search.js', () => ({
  isVectorSearchAvailable: vi.fn(() => false),
  insertEmbedding: vi.fn(),
  deleteEmbedding: vi.fn(),
  vectorSearch: vi.fn(() => []),
  insertEmbeddingInto: vi.fn(),
  deleteEmbeddingFrom: vi.fn(),
  vectorSearchFrom: vi.fn(() => []),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { handleErrorSimilar } from '../errors.js';
import { handleMemoryHybridSearch } from '../memory.js';

describe('Input Validation — TD-030', () => {
  describe('handleErrorSimilar', () => {
    it('should reject message exceeding MAX_CONTENT_LENGTH', async () => {
      const oversizedMessage = 'x'.repeat(1_048_577); // 1 MB + 1

      const result = await handleErrorSimilar({ message: oversizedMessage });

      expect(result.content[0].text).toContain('Validation error');
      expect(result.content[0].text).toContain('message');
    });

    it('should reject empty message', async () => {
      const result = await handleErrorSimilar({ message: '' });

      expect(result.content[0].text).toContain('Validation error');
    });
  });

  describe('handleMemoryHybridSearch', () => {
    it('should reject query exceeding MAX_QUERY_LENGTH', async () => {
      const oversizedQuery = 'x'.repeat(10_001);

      const result = await handleMemoryHybridSearch({ query: oversizedQuery });

      expect(result.content[0].text).toContain('Validation error');
      expect(result.content[0].text).toContain('query');
    });

    it('should reject empty query', async () => {
      const result = await handleMemoryHybridSearch({ query: '' });

      expect(result.content[0].text).toContain('Validation error');
    });
  });
});
