// TD-525 fixture helper: the FNV-1a -> xorshift32 -> L2 fake MiniLM vector (identical to
// sync.test.ts H.fakeVector), so a test can byte-compare what the child wrote.
export function fakeVector(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let state = h || 1;
  const v = new Float32Array(384);
  let norm = 0;
  for (let i = 0; i < 384; i++) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    const x = state / 0xffffffff - 0.5;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) v[i] /= norm;
  return v;
}
