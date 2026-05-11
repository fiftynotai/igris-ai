/**
 * processInBatches Tests (PF-002)
 *
 * Tests for the batch processing utility in embeddings.ts.
 *
 * @module utils/__tests__/process-in-batches.test
 */

import { describe, it, expect, vi } from 'vitest';
import { processInBatches } from '../embeddings.js';

describe('processInBatches — PF-002', () => {
  it('should process all items and count successes', async () => {
    const items = [1, 2, 3, 4, 5];
    const processed: number[] = [];

    const result = await processInBatches(items, async (item) => {
      processed.push(item);
    }, 2);

    expect(result.succeeded).toBe(5);
    expect(result.failed).toBe(0);
    expect(processed).toEqual([1, 2, 3, 4, 5]);
  });

  it('should count failures without stopping', async () => {
    const items = ['ok', 'fail', 'ok', 'fail', 'ok'];

    const result = await processInBatches(items, async (item) => {
      if (item === 'fail') throw new Error('boom');
    }, 3);

    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(2);
  });

  it('should handle empty items array', async () => {
    const result = await processInBatches([], async () => {}, 5);

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('should respect batch size for concurrency', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const items = [1, 2, 3, 4, 5, 6, 7];

    await processInBatches(items, async () => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) {
        maxConcurrent = currentConcurrent;
      }
      // Simulate async work
      await new Promise(resolve => setTimeout(resolve, 10));
      currentConcurrent--;
    }, 3);

    // Max concurrent should not exceed batch size of 3
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(0);
  });
});
