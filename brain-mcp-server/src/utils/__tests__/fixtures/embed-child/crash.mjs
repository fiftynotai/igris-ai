// TD-525 fixture embed module: the child SIGKILLs itself mid-request. mode=once crashes only
// while the marker file is absent (and writes it); mode=always crashes on every request.
import { existsSync, writeFileSync } from 'node:fs';
import { fakeVector } from './fake-vector.mjs';

const q = new URL(import.meta.url).searchParams;
const marker = q.get('marker');
export async function generateEmbedding(text) {
  if (q.get('mode') === 'always' || !existsSync(marker)) {
    if (marker) writeFileSync(marker, String(process.pid));
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
  return fakeVector(text);
}
export async function disposeEmbeddingPipeline() {}
export function setEmbeddingsOffline() {}
