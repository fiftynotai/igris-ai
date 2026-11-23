// TD-525 spawn-tier parent (embed-child-spawn.test.ts, embed-child-real-model.test.ts ER4).
// usage: node --import tsx parent.mjs <mode> <compiledDir> [arg]
// It imports the COMPILED client (compile.mjs), so its child is plain JS with execArgv [] (R8).
// A fork wrapper installed through module.syncBuiltinESMExports() counts the client's forks and
// prints `FORKS <n>` on stderr at exit. Status lines go to stderr; results are ONE JSON line on
// stdout. This parent never loads ORT itself, except in `parity` (ER4), which exits by draining.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [mode, dir, arg] = process.argv.slice(2);
const FIX = new URL('./', import.meta.url).href;
const fixture = (name, query = '') => FIX + name + (query ? '?' + query : '');
const say = (s) => process.stderr.write(s + '\n');
const result = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const realFork = cp.fork;
let forks = 0;
cp.fork = (...a) => {
  forks++;
  const child = realFork(...a);
  child.once('exit', (code, signal) => say(`EXIT ${child.pid} ${code} ${signal}`));
  return child;
};
syncBuiltinESMExports();
process.on('exit', () => say('FORKS ' + forks));

// Loaded per mode: the control modes (leak-control, offline-control) never touch the client,
// so they run on a tree where it does not exist yet.
const client = () => import(pathToFileURL(join(dir, 'embed-child-client.js')).href);
const ORT = fixture('ort-matmul.mjs');

async function busyLoop(c) {
  for (let i = 0; ; i++) {
    try {
      await c.embed('busy ' + i);
    } catch (e) {
      say('EMBED ' + e.name);
      return;
    }
  }
}

const CONTROL = mode === 'leak-control' || mode === 'offline-control';
const { createEmbedChild, shutdownEmbedChild } = CONTROL ? {} : await client();

switch (mode) {
  case 'leak': {
    const c = createEmbedChild({ embedModule: fixture('leaky.mjs') });
    const v = await c.embed('leak');
    c.close();
    result({ mode, len: v.length });
    break;
  }
  case 'leak-control': {
    // stdio 'inherit': the child's three fd-1 writes land on THIS process's stdout.
    const child = realFork(fileURLToPath(new URL('./leaky-entry.mjs', import.meta.url)), [], { stdio: 'inherit' });
    await new Promise((r) => child.once('exit', r));
    result({ mode });
    break;
  }
  case 'natural': {
    const c = createEmbedChild({ embedModule: ORT, idleMs: 60_000 });
    for (let i = 0; i < 3; i++) await c.embed('natural ' + i);
    say('CHILD ' + c.pid);
    result({ mode, pid: c.pid });
    break; // nothing else holds the loop: the parent must drain and exit on its own
  }
  case 'busy-hold': {
    const c = createEmbedChild({ embedModule: fixture('burn.mjs', 'heavy=' + (arg ?? 1500) + '&heavyRows=9&wall=1') });
    const t0 = Date.now();
    c.embed('hold').then((v) => result({ mode, len: v.length, ms: Date.now() - t0 }));
    break; // only the pending request may keep the parent alive
  }
  case 'orphan-idle':
  case 'orphan-busy': {
    const busy = mode === 'orphan-busy';
    const c = createEmbedChild({ embedModule: busy ? fixture('burn.mjs', 'heavy=400&heavyRows=100000') : ORT, idleMs: 600_000 });
    await c.embed('warm');
    say('CHILD ' + c.pid);
    if (busy) void busyLoop(c);
    setTimeout(() => say('READY'), busy ? 100 : 0);
    setInterval(() => {}, 1_000);
    break;
  }
  case 'group': {
    const c = createEmbedChild({ embedModule: ORT, idleMs: 600_000 });
    await c.embed('warm');
    say('CHILD ' + c.pid);
    process.on('SIGINT', () => {
      say('PARENT SIGINT');
      c.close();
      setImmediate(() => process.exit(0));
    });
    void busyLoop(c);
    setTimeout(() => say('READY'), 100);
    setInterval(() => {}, 1_000);
    break;
  }
  case 'stdio-shape': {
    const { installStdioTeardown } = await import(new URL('../../../../stdio-lifecycle.ts', import.meta.url).href);
    const c = createEmbedChild({ embedModule: ORT, idleMs: 600_000 });
    await c.embed('warm');
    say('CHILD ' + c.pid);
    installStdioTeardown({
      onShutdown: () => {
        shutdownEmbedChild();
        c.close();
      },
    });
    void busyLoop(c);
    result({ mode, pid: c.pid });
    setTimeout(() => say('READY'), 100);
    break;
  }
  case 'http-shape': {
    const c = createEmbedChild({ embedModule: ORT, idleMs: 600_000 });
    await c.embed('warm');
    say('CHILD ' + c.pid);
    process.on('SIGTERM', () => {
      shutdownEmbedChild();
      c.close();
      setImmediate(() => process.exit(0));
    });
    void busyLoop(c);
    setTimeout(() => say('READY'), 100);
    setInterval(() => {}, 1_000);
    break;
  }
  case 'offline': {
    const q = new URLSearchParams({ emb: pathToFileURL(join(dir, 'embeddings.js')).href, cache: arg, arm: '1' });
    const c = createEmbedChild({ embedModule: fixture('offline-env.mjs', q.toString()) });
    try {
      await c.embed('offline');
      result({ mode, ok: true });
    } catch (e) {
      result({ mode, name: e.name, message: e.message });
    }
    c.close();
    break;
  }
  case 'offline-control': {
    // The same closed-port, empty-cache setup, UNARMED, in this process through the source
    // embeddings.ts: the load must fail on the fetch. It never gets a model, so no ORT session.
    const src = new URL('../../../embeddings.ts', import.meta.url).href;
    const emb = await import(fixture('offline-env.mjs', new URLSearchParams({ emb: src, cache: arg, arm: '0' }).toString()));
    try {
      await emb.generateEmbedding('offline');
      result({ mode, ok: true });
    } catch (e) {
      result({ mode, name: e.name, message: e.message });
    }
    break;
  }
  case 'parity': {
    // ER4: an offline main-thread pipeline against the child, byte for byte. This parent loads
    // ORT itself, so it never calls process.exit: it disposes and lets the loop drain.
    const emb = await import(pathToFileURL(join(dir, 'embeddings.js')).href);
    emb.setEmbeddingsOffline();
    const c = createEmbedChild({ idleMs: 300 });
    const long = 'brain memory sync embed child process vector learning pattern '.repeat(120);
    const texts = ['hello brain', 'a learning about sqlite-vec rowids', 'onnx runtime on one thread', '', long];
    const rows = [];
    for (let it = 0; it < 11; it++) {
      for (const t of it === 0 ? texts : [texts[it % texts.length]]) {
        const main = await emb.generateEmbedding(t);
        const kid = await c.embed(t);
        let dot = 0;
        for (let i = 0; i < 384; i++) dot += main[i] * kid[i];
        rows.push({ it, len: kid.length, equal: Buffer.from(main.buffer, main.byteOffset, main.byteLength).equals(Buffer.from(kid.buffer, kid.byteOffset, kid.byteLength)), cosine: dot });
      }
    }
    result({ mode, pid: c.pid, rows });
    await new Promise((r) => setTimeout(r, 1_500)); // the idle reap drains the child (EXIT line)
    await emb.disposeEmbeddingPipeline();
    break;
  }
  default:
    say('unknown mode ' + mode);
    process.exitCode = 2;
}
