// TD-525 fixture embed module (EC1): a vector of IEEE-754 edge values, so a byte comparison
// proves the IPC copy is exact (-0, a subnormal, a NaN payload, +/-Inf, the float maximum).
export function edgeVector() {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = (i - 192) / 7;
  const dv = new DataView(v.buffer);
  v[0] = -0;
  v[1] = 1e-45;
  dv.setUint32(2 * 4, 0x7fc0beef, true); // NaN with a payload
  v[3] = Infinity;
  v[4] = -Infinity;
  v[5] = 3.4028234663852886e38;
  return v;
}
export async function generateEmbedding() { return edgeVector(); }
export async function disposeEmbeddingPipeline() {}
export function setEmbeddingsOffline() {}
