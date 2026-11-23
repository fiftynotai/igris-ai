// TD-525 fixture embed module: at=import never finishes loading (the child never sends ready);
// at=embed&nth=N never answers the Nth request (1-based). The child stays alive either way.
import { fakeVector } from './fake-vector.mjs';

const q = new URL(import.meta.url).searchParams;
if (q.get('at') === 'import') {
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
let n = 0;
export async function generateEmbedding(text) {
  if (++n === Number(q.get('nth'))) return new Promise(() => {});
  return fakeVector(text);
}
export async function disposeEmbeddingPipeline() {}
export function setEmbeddingsOffline() {}
