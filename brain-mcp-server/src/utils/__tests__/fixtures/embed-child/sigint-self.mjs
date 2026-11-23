// TD-525 fixture embed module (EC17): once (while the marker is absent) the child takes a
// default-disposition SIGINT mid-request, as a terminal Ctrl-C or pm2's kill_signal would.
import { existsSync, writeFileSync } from 'node:fs';
import { fakeVector } from './fake-vector.mjs';

const marker = new URL(import.meta.url).searchParams.get('marker');
export async function generateEmbedding(text) {
  if (!existsSync(marker)) {
    writeFileSync(marker, String(process.pid));
    process.kill(process.pid, 'SIGINT');
    await new Promise(() => {});
  }
  return fakeVector(text);
}
export async function disposeEmbeddingPipeline() {}
export function setEmbeddingsOffline() {}
