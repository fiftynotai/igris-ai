// TD-525 fixture embed module: a burn that stands in for one MiniLM inference.
// Query: load (ms, first call only), heavy (ms) for the first heavyRows calls, light (ms) after,
// wall=1 burns wall time (default: main-thread CPU time), log=<path> appends {pid,n} per call.
// makeEmbed() gives the same schedule in-process (the OT controls and the RED arm).
import { appendFileSync } from 'node:fs';
import { fakeVector } from './fake-vector.mjs';

export { fakeVector };
const q = new URL(import.meta.url).searchParams;
const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);
const cpuMs = () => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1e3;
};

function burn(ms, wall) {
  if (!(ms > 0)) return;
  const now = wall ? () => performance.now() : cpuMs;
  const end = now() + ms;
  while (now() < end) { /* block the loop, as ONNX's binding.run does */ }
}

export function makeEmbed(opts = {}) {
  const o = {
    load: num('load', 0), heavy: num('heavy', 0), heavyRows: num('heavyRows', 0), light: num('light', 0),
    wall: q.get('wall') === '1', log: q.get('log'), ...opts,
  };
  let n = 0;
  const embed = async (text) => {
    if (n === 0) burn(o.load, o.wall);
    burn(n < o.heavyRows ? o.heavy : o.light, o.wall);
    n++;
    if (o.log) appendFileSync(o.log, JSON.stringify({ pid: process.pid, n }) + '\n');
    return fakeVector(text);
  };
  embed.calls = () => n;
  return embed;
}

const embed = makeEmbed();
export const generateEmbedding = (text) => embed(text);
export async function disposeEmbeddingPipeline() {}
export function setEmbeddingsOffline() {}
