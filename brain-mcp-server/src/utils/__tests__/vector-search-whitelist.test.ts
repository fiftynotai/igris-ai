/**
 * Vector Search Whitelist Tests (TD-030)
 *
 * Tests that vec table names are validated against ALLOWED_VEC_TABLES
 * in insertEmbeddingInto, deleteEmbeddingFrom, and vectorSearchFrom.
 *
 * @module utils/__tests__/vector-search-whitelist.test
 */

import { describe, it, expect, vi } from 'vitest';

// We test the whitelist validation directly without needing a real DB
// because the validation throws before any DB call is made.

// Import the real module (no mocks needed for whitelist tests)
import {
  ALLOWED_VEC_TABLES,
  insertEmbeddingInto,
  deleteEmbeddingFrom,
  vectorSearchFrom,
} from '../vector-search.js';

describe('Vec Table Whitelist — TD-030', () => {
  // Use a fake db object — validation throws before db is used
  const fakeDb = {} as Parameters<typeof insertEmbeddingInto>[0];
  const fakeEmbedding = new Float32Array(384);

  it('should allow whitelisted table names', () => {
    expect(ALLOWED_VEC_TABLES.has('learnings_vec')).toBe(true);
    expect(ALLOWED_VEC_TABLES.has('briefs_vec')).toBe(true);
    expect(ALLOWED_VEC_TABLES.has('errors_vec')).toBe(true);
  });

  it('should reject non-whitelisted table in insertEmbeddingInto', () => {
    expect(() => insertEmbeddingInto(fakeDb, 'malicious_table', 1, fakeEmbedding))
      .toThrow('Invalid vec table name: "malicious_table"');
  });

  it('should reject non-whitelisted table in deleteEmbeddingFrom', () => {
    expect(() => deleteEmbeddingFrom(fakeDb, 'users; DROP TABLE--', 1))
      .toThrow('Invalid vec table name');
  });

  it('should reject non-whitelisted table in vectorSearchFrom', () => {
    expect(() => vectorSearchFrom(fakeDb, 'not_a_vec_table', fakeEmbedding, 10))
      .toThrow('Invalid vec table name: "not_a_vec_table"');
  });
});
