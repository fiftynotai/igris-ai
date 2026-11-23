// TD-525 fixture embed module: a REAL onnxruntime-node session in the child, with no model file
// and no network. Each request runs a two-input MatMul until at least `ms` (default 60) of wall
// time has passed, so the child holds ORT the way MiniLM does. ORT is resolved from `base`
// (a package.json; default the brain's) through @huggingface/transformers, the copy the brain loads.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fakeVector } from './fake-vector.mjs';

const q = new URL(import.meta.url).searchParams;
const base = q.get('base') ?? fileURLToPath(new URL('../../../../../package.json', import.meta.url));
const ms = Number(q.get('ms') ?? 60);
const N = 256;
const varint = (v) => { const o = []; let n = v; while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n >>>= 7; } o.push(n); return o; };
const utf8 = (s) => [...Buffer.from(s, 'utf8')];
const ld = (tag, p) => [tag, ...varint(p.length), ...p];
const vf = (tag, v) => [tag, ...varint(v)];
const dim = (n) => ld(0x0a, vf(0x08, n));
const info = (name) => [...ld(0x0a, utf8(name)), ...ld(0x12, ld(0x0a, [...vf(0x08, 1), ...ld(0x12, [...dim(N), ...dim(N)])]))];
function matmulModel() {
  const node = [...ld(0x0a, utf8('a')), ...ld(0x0a, utf8('b')), ...ld(0x12, utf8('c')), ...ld(0x22, utf8('MatMul'))];
  const graph = [...ld(0x0a, node), ...ld(0x12, utf8('g')), ...ld(0x5a, info('a')), ...ld(0x5a, info('b')), ...ld(0x62, info('c'))];
  return Buffer.from([...vf(0x08, 8), ...ld(0x3a, graph), ...ld(0x42, vf(0x10, 13))]);
}

let session = null;
let ort = null;
export async function generateEmbedding(text) {
  if (!ort) ort = createRequire(createRequire(base).resolve('@huggingface/transformers'))('onnxruntime-node');
  session ??= await ort.InferenceSession.create(matmulModel(), { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1 });
  const a = new ort.Tensor('float32', new Float32Array(N * N).fill(1), [N, N]);
  const b = new ort.Tensor('float32', new Float32Array(N * N).fill(0.5), [N, N]);
  const end = performance.now() + ms;
  do await session.run({ a, b }); while (performance.now() < end);
  return fakeVector(text);
}
export async function disposeEmbeddingPipeline() {
  await session?.release();
  session = null;
}
export function setEmbeddingsOffline() {}
