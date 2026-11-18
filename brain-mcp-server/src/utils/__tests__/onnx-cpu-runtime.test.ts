/**
 * onnx-cpu-runtime.test.ts — BR-119 AC4: the brain's ONNX Runtime still runs
 * inference on the CPU execution provider after an install that skipped the
 * CUDA download (`ONNXRUNTIME_NODE_INSTALL_CUDA=skip`).
 *
 * WHY THIS NEEDS A REAL INFERENCE. Before BR-119 a Linux x64 install
 * downloaded the GPU build and OVERWROTE `libonnxruntime.so.1.21.0` and
 * `libonnxruntime_providers_shared.so` with its copies (onnxruntime-node
 * `script/install.js:90-97`). With `skip`, Linux x64 runs the CPU library that
 * ships inside the npm package — for the first time. CI's brain-vitest job
 * runs this file on real x64 hardware, so a green O1 there is the evidence
 * that library loads and computes. The other embedding tests read for BR-119
 * mock the `utils/embeddings.js` seam or, in embeddings-guard, the transformers
 * import below it, so none of those loads the native addon.
 *
 * HOW. ONNX Runtime is loaded ONLY in a child process: a native addon in the
 * vitest worker plus the sqlite-vec teardown race is the BR-060 class. The
 * child resolves `onnxruntime-node` FROM `@huggingface/transformers` — the copy
 * the brain actually loads — and runs a hand-encoded one-node ONNX model, so
 * there is no network and no model fetch (TD-312's no-fetch stance).
 *
 * The model is `y = Identity(x)`, x and y float32 of shape [2], IR version 8,
 * default-domain opset 13. Protobuf field tags (field << 3 | wire type):
 *   ModelProto       ir_version 0x08, graph 0x3A, opset_import 0x42
 *   OperatorSetId    version 0x10 (domain omitted = "")
 *   GraphProto       node 0x0A, name 0x12, input 0x5A, output 0x62
 *   NodeProto        input 0x0A, output 0x12, op_type 0x22
 *   ValueInfoProto   name 0x0A, type 0x12
 *   TypeProto        tensor_type 0x0A
 *   TypeProto.Tensor elem_type 0x08 (1 = FLOAT), shape 0x12
 *   TensorShapeProto dim 0x0A
 *   Dimension        dim_value 0x08
 * Every non-varint field is length-delimited: tag, varint length, bytes.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CHILD_TIMEOUT_MS = 20_000;

const varint = (value: number): number[] => {
  const out: number[] = [];
  let n = value;
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
};
const utf8 = (s: string): number[] => [...Buffer.from(s, 'utf8')];
const lenDelim = (tag: number, payload: number[]): number[] => [tag, ...varint(payload.length), ...payload];
const varintField = (tag: number, value: number): number[] => [tag, ...varint(value)];

/** A float32 tensor of shape [2]. */
const valueInfo = (name: string): number[] => [
  ...lenDelim(0x0a, utf8(name)),
  ...lenDelim(
    0x12,
    lenDelim(0x0a, [...varintField(0x08, 1), ...lenDelim(0x12, lenDelim(0x0a, varintField(0x08, 2)))]),
  ),
];

function identityModel(): Buffer {
  const node = [...lenDelim(0x0a, utf8('x')), ...lenDelim(0x12, utf8('y')), ...lenDelim(0x22, utf8('Identity'))];
  const graph = [
    ...lenDelim(0x0a, node),
    ...lenDelim(0x12, utf8('g')),
    ...lenDelim(0x5a, valueInfo('x')),
    ...lenDelim(0x62, valueInfo('y')),
  ];
  return Buffer.from([...varintField(0x08, 8), ...lenDelim(0x3a, graph), ...lenDelim(0x42, varintField(0x10, 13))]);
}

/** Runs in the child (CommonJS `node -e`); argv[1] is the model, base64. */
const PROBE = `
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
(async () => {
  const fromBrain = createRequire(path.join(process.cwd(), 'package.json'));
  const fromTransformers = createRequire(fromBrain.resolve('@huggingface/transformers'));
  const pkgJson = fromTransformers.resolve('onnxruntime-node/package.json');
  const ort = fromTransformers('onnxruntime-node');
  const version = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version;
  const backends = ort.listSupportedBackends().map((b) => b.name);
  const cudaSo = fs.existsSync(path.join(path.dirname(pkgJson), 'bin', 'napi-v3', process.platform, process.arch, 'libonnxruntime_providers_cuda.so'));
  const session = await ort.InferenceSession.create(Buffer.from(process.argv[1], 'base64'), { executionProviders: ['cpu'] });
  const out = await session.run({ x: new ort.Tensor('float32', Float32Array.from([1.5, -2]), [2]) });
  const y = Array.from(out.y.data);
  await session.release();
  process.stdout.write(JSON.stringify({ version, backends, y, cudaSo }) + '\\n');
})().catch((e) => {
  process.stderr.write(String((e && e.stack) || e) + '\\n');
  process.exit(1);
});
`;

interface ProbeResult {
  version: string;
  backends: string[];
  y: number[];
  cudaSo: boolean;
}

let cached: ProbeResult | undefined;
function probe(): ProbeResult {
  cached ??= JSON.parse(
    execFileSync(process.execPath, ['-e', PROBE, identityModel().toString('base64')], {
      cwd: BRAIN_ROOT,
      encoding: 'utf-8',
      timeout: CHILD_TIMEOUT_MS,
    }),
  ) as ProbeResult;
  return cached;
}

const onGhaLinuxX64 =
  process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux' && process.arch === 'x64';

describe('BR-119 — ONNX Runtime runs on the CPU execution provider', () => {
  it('O1 (AC4): the CPU backend is listed and a real Identity inference returns its input', () => {
    const r = probe();
    expect(r.backends).toContain('cpu');
    expect(r.y).toEqual([1.5, -2]);
  }, 30_000);

  it('O2 (revisit trigger): onnxruntime-node is still 1.21.0', () => {
    expect(
      probe().version,
      'BR-119: onnxruntime-node moved. Re-read its script/install.js — the ONNXRUNTIME_NODE_INSTALL_CUDA ' +
        'name, the accepted values and the download condition — before re-pinning this version ' +
        '(MAINTAINING.md, the BR-119 row).',
    ).toBe('1.21.0');
  }, 30_000);

  it.skipIf(!onGhaLinuxX64)(
    'O3 (GitHub Actions linux-x64 only): the install carried the opt-out — no CUDA provider library was downloaded',
    () => {
      expect(probe().cudaSo).toBe(false);
    },
    30_000,
  );
});
