// TD-525 fixture helper: is the MiniLM cache present for a package root, and a listing of it
// (names, sizes, mtimes) so a test can prove nothing wrote it (L-2506).
import { createRequire } from 'node:module';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'];

export function transformersCache(pkgJson) {
  const entry = createRequire(pkgJson).resolve('@huggingface/transformers');
  return join(dirname(dirname(entry)), '.cache');
}

export function minilmCached(pkgJson) {
  try {
    const dir = join(transformersCache(pkgJson), 'Xenova', 'all-MiniLM-L6-v2');
    return FILES.every((f) => {
      try { return statSync(join(dir, f)).size > 0; } catch { return false; }
    });
  } catch {
    return false;
  }
}

export function cacheListing(pkgJson) {
  let root;
  try { root = transformersCache(pkgJson); } catch { return 'no transformers'; }
  if (!existsSync(root)) return 'no cache dir';
  return readdirSync(root, { recursive: true })
    .map((f) => {
      const s = statSync(join(root, String(f)));
      return `${f}:${s.isDirectory() ? 'd' : s.size}:${s.mtimeMs}`;
    })
    .sort()
    .join('\n');
}
