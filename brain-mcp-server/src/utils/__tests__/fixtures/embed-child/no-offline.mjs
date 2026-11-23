// TD-525 fixture embed module (EC19): omits setEmbeddingsOffline, so the child must fail to start.
// generateEmbedding writes the marker, which proves an embed was attempted.
import { writeFileSync } from 'node:fs';

const marker = new URL(import.meta.url).searchParams.get('marker');
export async function generateEmbedding() {
  writeFileSync(marker, 'embedded');
  return new Float32Array(384);
}
export async function disposeEmbeddingPipeline() {}
