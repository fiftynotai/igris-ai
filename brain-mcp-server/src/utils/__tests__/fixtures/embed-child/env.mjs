// TD-525 fixture embed module (EC18): replies with the child's env key list as the error message.
export async function generateEmbedding() {
  throw Object.assign(new Error(Object.keys(process.env).sort().join(',')), { name: 'EnvKeys' });
}
export async function disposeEmbeddingPipeline() {}
export function setEmbeddingsOffline() {}
