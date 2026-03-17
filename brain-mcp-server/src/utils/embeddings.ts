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

const EMBEDDING_MODEL = MODEL_NAME;
const EMBEDDING_DIMENSIONS = EMBEDDING_DIMS;

export {
  generateEmbedding,
  embeddingToBuffer,
  bufferToEmbedding,
  isEmbeddingAvailable,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
};
