// TD-525 fixture embed module: every request fails with the typed graceful-degrade error.
export async function generateEmbedding() {
  throw Object.assign(new Error('embeddings backend unavailable: fixture'), { name: 'EmbeddingsUnavailableError' });
}
export async function disposeEmbeddingPipeline() {}
export function setEmbeddingsOffline() {}
