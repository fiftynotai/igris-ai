/**
 * Embeddings hybrid graceful-degrade guard tests (BR-070).
 *
 * The bundle build previously deleted @huggingface/transformers from the
 * staged manifest, so the dynamic import threw ERR_MODULE_NOT_FOUND at
 * runtime — and the prior getPipeline() reset _loadPromise to null on
 * failure, re-attempting the failing import (and re-logging) on EVERY call.
 *
 * BR-070 makes the failure a LATCHED, once-logged capability degrade:
 *   (a) transformers present + model loads  → full embedding (unchanged).
 *   (b) import/model-load failure            → latch unavailable, log ONE
 *       warning, throw a typed EmbeddingsUnavailableError, and fast-fail
 *       subsequent calls WITHOUT re-importing or re-logging.
 *
 * These tests mock the dynamic-imported @huggingface/transformers module
 * and reset the module registry per scenario so the embeddings singleton
 * starts clean each time.
 *
 * @module utils/__tests__/embeddings-guard.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('embeddings hybrid guard — BR-070', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@huggingface/transformers');
  });

  it('(a) transformers present → generateEmbedding returns a 384-dim vector', async () => {
    // A fake feature-extraction extractor returning a fixed-length output.
    const fakeExtractor = vi.fn(async (_text: string, _opts: unknown) => ({
      data: new Float32Array(384).fill(0.1),
    }));
    const pipeline = vi.fn(async (_task: string, _model: string) => fakeExtractor);

    vi.doMock('@huggingface/transformers', () => ({ pipeline }));

    const { generateEmbedding, isEmbeddingAvailable } = await import('../embeddings.js');

    const vec = await generateEmbedding('hello world');

    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
    expect(isEmbeddingAvailable()).toBe(true);
    expect(pipeline).toHaveBeenCalledWith('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  });

  it('(b) import failure → latched unavailable, throws typed error, logs ONE warning, no throw-storm', async () => {
    // Simulate the package being absent. A `throw` from the factory itself
    // is intercepted by vitest's mock machinery, so instead we expose a
    // `pipeline` getter that throws on access — faithfully reproducing the
    // "package not usable" failure the embeddings module catches.
    vi.doMock('@huggingface/transformers', () => ({
      get pipeline(): never {
        throw new Error("Cannot find package '@huggingface/transformers'");
      },
    }));

    const { generateEmbedding, isEmbeddingAvailable, EmbeddingsUnavailableError } =
      await import('../embeddings.js');

    // First call: throws the typed error (callers catch this).
    await expect(generateEmbedding('first')).rejects.toBeInstanceOf(EmbeddingsUnavailableError);
    expect(isEmbeddingAvailable()).toBe(false);

    // Several subsequent calls: still the typed error, still fast — and
    // crucially NOT a throw-storm of fresh imports / repeated logging.
    await expect(generateEmbedding('second')).rejects.toBeInstanceOf(EmbeddingsUnavailableError);
    await expect(generateEmbedding('third')).rejects.toBeInstanceOf(EmbeddingsUnavailableError);

    // The capability warning must fire exactly ONCE across all calls, and it
    // is the PERMANENT variant (import failure).
    const warningCalls = errorSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('[embeddings] backend unavailable (permanent)'),
    );
    expect(warningCalls.length).toBe(1);
    expect(warningCalls[0][0]).toContain('keyword (BM25/FTS) search still active');
  });

  it('(b2) RECOVERABLE model-fetch failure → throws + warns once + retries on next call (NOT permanently latched)', async () => {
    // Import resolves; the model weight fetch fails (transient network blip).
    // This must NOT permanently latch — the next call should retry.
    const pipeline = vi.fn(async () => {
      throw new Error('fetch failed: HF Hub 503');
    });
    vi.doMock('@huggingface/transformers', () => ({ pipeline }));

    const { generateEmbedding, isEmbeddingAvailable, EmbeddingsUnavailableError } =
      await import('../embeddings.js');

    await expect(generateEmbedding('x')).rejects.toBeInstanceOf(EmbeddingsUnavailableError);
    // Crucially NOT permanently latched: stays null (unlatched), so the fast-fail
    // gate does not short-circuit and the next call is free to retry.
    expect(isEmbeddingAvailable()).toBeNull();

    // A subsequent call DOES re-attempt the fetch (does not fast-fail).
    await expect(generateEmbedding('y')).rejects.toBeInstanceOf(EmbeddingsUnavailableError);
    expect(pipeline).toHaveBeenCalledTimes(2);

    // Each failed episode logs the recoverable variant; one warning per attempt.
    const recoverableWarnings = errorSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('[embeddings] model load failed (recoverable'),
    );
    expect(recoverableWarnings.length).toBe(2);
  });

  it('(b3) RECOVERABLE: model-fetch fails once then succeeds → embeddings RECOVER without restart', async () => {
    // First pipeline() call throws (transient); second call succeeds.
    const fakeExtractor = vi.fn(async (_text: string, _opts: unknown) => ({
      data: new Float32Array(384).fill(0.2),
    }));
    const pipeline = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed: transient'))
      .mockResolvedValueOnce(fakeExtractor);
    vi.doMock('@huggingface/transformers', () => ({ pipeline }));

    const { generateEmbedding, isEmbeddingAvailable, EmbeddingsUnavailableError } =
      await import('../embeddings.js');

    // First call: transient model-fetch failure.
    await expect(generateEmbedding('first')).rejects.toBeInstanceOf(EmbeddingsUnavailableError);
    expect(isEmbeddingAvailable()).toBeNull(); // unlatched — recovery is possible

    // Second call: fetch now succeeds → real vector, and the backend is marked
    // available again. This is the regression guard for the warden defect.
    const vec = await generateEmbedding('second');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
    expect(isEmbeddingAvailable()).toBe(true);
    expect(pipeline).toHaveBeenCalledTimes(2);
  });

  it('(b4) PERMANENT: native-addon load failure surfaced from import stays latched (no retry)', async () => {
    // A native-addon load failure manifests at import/destructure time (the
    // package module throws while initialising its onnxruntime binding). This
    // is deterministic for the process → permanent latch, no retry.
    vi.doMock('@huggingface/transformers', () => ({
      get pipeline(): never {
        throw new Error('Cannot load onnxruntime-node native binding for this platform');
      },
    }));

    const { generateEmbedding, isEmbeddingAvailable, EmbeddingsUnavailableError } =
      await import('../embeddings.js');

    await expect(generateEmbedding('x')).rejects.toBeInstanceOf(EmbeddingsUnavailableError);
    expect(isEmbeddingAvailable()).toBe(false); // permanent

    // Subsequent calls fast-fail without re-entering the import.
    await expect(generateEmbedding('y')).rejects.toBeInstanceOf(EmbeddingsUnavailableError);

    const permanentWarnings = errorSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('[embeddings] backend unavailable (permanent)'),
    );
    expect(permanentWarnings.length).toBe(1);
  });

  it('(c) the typed error carries the underlying reason for diagnosis', async () => {
    vi.doMock('@huggingface/transformers', () => ({
      get pipeline(): never {
        throw new Error("Cannot find package '@huggingface/transformers'");
      },
    }));

    const { generateEmbedding } = await import('../embeddings.js');

    await expect(generateEmbedding('x')).rejects.toThrow(/@huggingface\/transformers/);
  });
});
