// TD-525 fixture embed module (ES1): writes to fd 1 three ways. With stdio ['ignore', 2, 2, 'ipc']
// all three must land on the parent's stderr, never its stdout (the stdio brain's protocol).
import { writeSync } from 'node:fs';
import { fakeVector } from './fake-vector.mjs';

export async function generateEmbedding(text) {
  console.log('LEAK-console.log');
  process.stdout.write('LEAK-stdout.write\n');
  writeSync(1, 'LEAK-fd1\n');
  return fakeVector(text);
}
export async function disposeEmbeddingPipeline() {}
export function setEmbeddingsOffline() {}
