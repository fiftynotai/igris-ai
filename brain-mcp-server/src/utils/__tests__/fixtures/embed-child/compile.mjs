// TD-525 fixture helper (R8): transpile the embed child, its client and embeddings.ts to plain JS
// in a fresh tmp dir ({"type":"module"} + a node_modules link to the brain's resolution root),
// with the `typescript` devDependency. Every assertion on an ORT child's EXIT STATUS runs this
// output, so no tsx loader thread is present in the child (`execArgv` is [] for a .js entry).
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UTILS = fileURLToPath(new URL('../../../', import.meta.url));
export const BRAIN_PKG = fileURLToPath(new URL('../../../../../package.json', import.meta.url));

export function compileEmbedChild() {
  const req = createRequire(BRAIN_PKG);
  const ts = req('typescript');
  let nm = dirname(req.resolve('@huggingface/transformers'));
  while (basename(nm) !== 'node_modules') nm = dirname(nm);
  const dir = mkdtempSync(join(tmpdir(), 'td525-compiled-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  symlinkSync(nm, join(dir, 'node_modules'));
  for (const f of ['embed-child', 'embed-child-client', 'embeddings']) {
    const src = readFileSync(join(UTILS, f + '.ts'), 'utf8');
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: false,
    }).outputText;
    writeFileSync(join(dir, f + '.js'), out);
  }
  return {
    dir,
    child: join(dir, 'embed-child.js'),
    client: join(dir, 'embed-child-client.js'),
    embeddings: join(dir, 'embeddings.js'),
  };
}
