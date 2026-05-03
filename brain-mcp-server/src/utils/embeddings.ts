/**
 * Igris Brain — Embedding Pipeline
 *
 * Lazy-loaded singleton embedding pipeline using @huggingface/transformers
 * with the all-MiniLM-L6-v2 model (384 dimensions).
 *
 * The model is downloaded on first use and cached in ~/.cache/huggingface/.
 * Subsequent calls reuse the cached model and the singleton pipeline instance.
 *
 * Exports:
 * - generateEmbedding(text): Promise<Float32Array> — produce a 384-dim embedding
 * - embeddingToBuffer(embedding): Buffer — convert Float32Array to BLOB-ready Buffer
 * - bufferToEmbedding(buf): Float32Array — convert Buffer back to Float32Array
 * - isEmbeddingAvailable(): boolean — whether the pipeline loaded successfully
 * - EMBEDDING_MODEL: string — the model identifier
 * - EMBEDDING_DIMENSIONS: number — output vector dimensionality (384)
 *
 * @module utils/embeddings
 * @author Fifty.ai
 */

/** Model identifier — hosted on Hugging Face Hub */
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

/** Dimensionality of the output embedding vectors */
const EMBEDDING_DIMS = 384;

// ---------------------------------------------------------------------------
// Singleton pipeline — lazy-loaded on first call to generateEmbedding()
// ---------------------------------------------------------------------------

// Use `unknown` to avoid importing the Pipeline type at module scope
// (the import is deferred to keep startup fast)
let _pipeline: unknown = null;
let _available: boolean | null = null;
let _loadPromise: Promise<unknown> | null = null;

/**
 * Lazily initialise and return the feature-extraction pipeline.
 *
 * Uses dynamic import so that the large @huggingface/transformers
 * dependency is not loaded until actually needed.
 */
async function getPipeline(): Promise<unknown> {
  if (_pipeline) return _pipeline;

  // Avoid concurrent initialisations
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    try {
      const { pipeline } = await import('@huggingface/transformers');
      _pipeline = await pipeline('feature-extraction', MODEL_NAME);
      _available = true;
      console.error('[embeddings] Pipeline loaded — model:', MODEL_NAME);
      return _pipeline;
    } catch (err) {
      _available = false;
      _loadPromise = null;
      throw err;
    }
  })();

  return _loadPromise;
}

/**
 * Generate a normalised embedding vector for the given text.
 *
 * The result is a Float32Array of length EMBEDDING_DIMENSIONS (384).
 * Embeddings are L2-normalised so that cosine similarity equals
 * 1 - (L2 distance / 2).
 *
 * @param text - The text to embed
 * @returns A 384-dimension Float32Array embedding
 */
async function generateEmbedding(text: string): Promise<Float32Array> {
  const extractor = await getPipeline() as (
    text: string,
    opts: { pooling: string; normalize: boolean }
  ) => Promise<{ data: ArrayLike<number> }>;

  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

/**
 * Convert a Float32Array embedding to a Buffer suitable for SQLite BLOB storage.
 *
 * @param embedding - The embedding to convert
 * @returns A Buffer containing the raw float bytes
 */
function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Convert a Buffer (from SQLite BLOB) back to a Float32Array embedding.
 *
 * @param buf - The buffer read from the database
 * @returns A Float32Array of the embedding values
 */
function bufferToEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Check whether the embedding pipeline is available.
 *
 * Returns null if the pipeline has never been initialised,
 * true if it loaded successfully, false if it failed to load.
 */
function isEmbeddingAvailable(): boolean | null {
  return _available;
}

/**
 * Dispose the singleton pipeline so its underlying ONNX runtime sessions
 * release native resources (worker threads, GPU contexts) cleanly.
 *
 * BR-060 — short-lived CLIs (perception_extract_cli) MUST call this before
 * `engine.shutdown()` so the transformers worker is torn down BEFORE the
 * sqlite-vec native extension's `db.close()` path runs. Without this,
 * the two native cleanup chains race and the sqlite-vec mutex teardown
 * aborts with `mutex lock failed: Invalid argument` on macOS / libc++.
 *
 * The MCP server (long-running) does not need this — its DB connection lives
 * for the process lifetime and the abort symptom requires both subsystems
 * to be torn down in close temporal proximity.
 *
 * Idempotent: returns immediately if the pipeline was never loaded. Errors
 * during dispose are swallowed (best-effort) so a hung dispose cannot block
 * the caller's own shutdown sequence.
 */
async function disposeEmbeddingPipeline(): Promise<void> {
  if (!_pipeline) return;
  try {
    const pipe = _pipeline as { dispose?: () => Promise<void> };
    if (typeof pipe.dispose === 'function') {
      await pipe.dispose();
    }
  } catch (err) {
    console.error(
      '[embeddings] dispose failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    _pipeline = null;
    _loadPromise = null;
    // Leave _available as-is so a re-init reflects the prior load result.
  }
}

const EMBEDDING_MODEL = MODEL_NAME;
const EMBEDDING_DIMENSIONS = EMBEDDING_DIMS;

/**
 * Process an array of items in parallel batches.
 *
 * Runs `fn` on up to `batchSize` items concurrently using Promise.allSettled,
 * then moves to the next batch. Returns counts of succeeded and failed items.
 *
 * @param items - The items to process
 * @param fn - Async function to run on each item
 * @param batchSize - Maximum concurrency per batch (default 5)
 * @returns Counts of succeeded and failed items
 */
async function processInBatches<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  batchSize: number = 5,
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(fn));
    for (const r of results) {
      if (r.status === 'fulfilled') succeeded++;
      else failed++;
    }
  }
  return { succeeded, failed };
}

export {
  generateEmbedding,
  embeddingToBuffer,
  bufferToEmbedding,
  isEmbeddingAvailable,
  disposeEmbeddingPipeline,
  processInBatches,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
};
