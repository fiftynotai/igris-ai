/**
 * TD-525 embed child, forked by embed-child-client. Loads the brain's own embeddings module
 * offline and answers each request. It never calls process.exit (ONNX aborts on it): it drains,
 * or SIGKILLs itself. Rules: MAINTAINING.md, the embed-child row.
 */
import { writeSync } from 'node:fs';

interface Emb {
  generateEmbedding(text: string): Promise<Float32Array>;
  disposeEmbeddingPipeline(): Promise<void>;
  setEmbeddingsOffline(): void;
}

const ppid = process.ppid;
let busy = 0;
let draining = false;
let watch: NodeJS.Timeout | undefined;

const line = (s: string): void => {
  try {
    writeSync(2, `[embed-child] ${s} pid=${process.pid}\n`);
  } catch {
    // stderr gone
  }
};
const die = (e: unknown): void => {
  line(`fatal: ${(e as Error)?.message ?? e}`);
  process.kill(process.pid, 'SIGKILL');
};
process.on('uncaughtException', die);
process.on('unhandledRejection', die);

const emb = (await import(process.argv[2] ?? './embeddings.js')) as Emb;
emb.setEmbeddingsOffline();

function drain(): void {
  if (draining) return;
  draining = true;
  setTimeout(() => {
    line('drain timeout');
    process.kill(process.pid, 'SIGKILL');
  }, 3_000).unref();
  void emb.disposeEmbeddingPipeline().finally(() => {
    clearInterval(watch);
    process.removeAllListeners('message');
    process.removeAllListeners('disconnect');
    if (process.connected) process.disconnect();
  });
}

const gone = (): void => (busy ? void process.kill(process.pid, 'SIGKILL') : drain());
const send = (m: object): void => {
  process.send!(m, undefined, {}, (e) => e && gone());
};

process.on('disconnect', gone);
watch = setInterval(() => process.ppid !== ppid && gone(), 1_000);
watch.unref();
process.on('message', (msg) => {
  const m = msg as { id: number; text: string; bye?: number };
  if (m.bye) return drain();
  busy++;
  emb
    .generateEmbedding(m.text)
    .then(
      (vec) => send({ id: m.id, vec }),
      (e: Error) => send({ id: m.id, name: e?.name, message: String(e?.message ?? e) }),
    )
    .finally(() => busy--);
});
send({ ready: 1, v: 1 });
