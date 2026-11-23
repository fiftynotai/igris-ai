/**
 * TD-525: the post-merge embed pass runs inference in one lazy child process, so ONNX never
 * blocks this thread. Protocol, limits and callers: MAINTAINING.md, the embed-child row.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface EmbedChildOptions {
  embedModule?: string;
  idleMs?: number;
  requestMs?: number;
  loadMs?: number;
  breakerMs?: number;
}

export interface EmbedChild {
  embed(text: string): Promise<Float32Array>;
  close(): void;
  readonly pid: number | undefined;
}

interface Kid { c: ChildProcess; ready: boolean; first: boolean; at: number; asked: boolean; gone: Promise<void> }
interface Req { id: number; text: string; ok: (v: Float32Array) => void; no: (e: Error) => void; t?: NodeJS.Timeout }
interface Msg { ready?: number; v?: number; id?: number; vec?: Float32Array; name?: string; message?: string }

const CLOSED = 'EmbedChildClosedError';
const CRASHED = 'EmbedChildCrashedError';
const UNAVAILABLE = 'EmbeddingsUnavailableError';
const self = fileURLToPath(import.meta.url);
const ext = self.slice(self.lastIndexOf('.'));
const ENTRY = fileURLToPath(new URL('./embed-child' + ext, import.meta.url));
const named = (name: string, message: string): Error => Object.assign(new Error(message), { name });

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (/^(PATH|HOME|TMPDIR|LANG|LC_\w+)$/.test(k)) env[k] = v;
  return env;
}

export function createEmbedChild(o: EmbedChildOptions = {}): EmbedChild {
  const { embedModule, idleMs = 60_000, requestMs = 60_000, loadMs = 180_000, breakerMs = 300_000 } = o;
  let k: Kid | null = null;
  let p: Req | null = null;
  let idle: NodeJS.Timeout | undefined;
  let draining: Promise<void> = Promise.resolve();
  let chain: Promise<unknown> = Promise.resolve();
  let seq = 0;
  let fails = 0;
  let openUntil = 0;
  let closed = false;

  function spawn(): Kid {
    const c = fork(ENTRY, embedModule ? [embedModule] : [], {
      execArgv: ext === '.ts' ? ['--import', 'tsx'] : [],
      env: childEnv(),
      serialization: 'advanced',
      stdio: ['ignore', 2, 2, 'ipc'],
    });
    let done!: () => void;
    const kid: Kid = { c, ready: false, first: true, at: Date.now(), asked: false, gone: new Promise((r) => (done = r)) };
    let ended = false;
    const end = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (ended) return;
      ended = true;
      done();
      onExit(kid, code, sig);
    };
    c.on('message', (m: Msg) => onMessage(kid, m));
    c.once('exit', end);
    c.on('error', () => c.pid === undefined && end(null, null));
    return kid;
  }

  function trip(): void {
    if (++fails >= 3) {
      openUntil = Date.now() + breakerMs;
      console.error(`[embed-child] ${fails} failures; refusing for ${breakerMs} ms`);
    }
  }

  function stop(kid: Kid, kill?: boolean): void {
    clearTimeout(idle);
    kid.asked = true;
    if (k === kid) k = null;
    draining = kid.gone;
    if (kill) kid.c.kill('SIGKILL');
    else {
      kid.c.send({ bye: 1 });
      setTimeout(() => kid.c.kill('SIGKILL'), 3_000).unref();
    }
  }

  function settle(kid: Kid): Req | null {
    const r = p;
    p = null;
    clearTimeout(r?.t);
    if (kid.asked || !kid.c.connected) return r;
    kid.c.unref();
    kid.c.channel?.unref();
    idle = setTimeout(() => stop(kid), idleMs);
    idle.unref();
    return r;
  }

  function onMessage(kid: Kid, m: Msg): void {
    if (kid !== k) return;
    if (m.ready) {
      if (m.v !== 1) return void kid.c.kill('SIGKILL');
      kid.ready = true;
      if (p) kid.c.send({ id: p.id, text: p.text });
      return;
    }
    if (!p || m.id !== p.id) return;
    fails = 0;
    kid.first = false;
    const r = settle(kid)!;
    if (m.vec) return r.ok(m.vec.slice()); // own buffer: IPC hands back a view into its message
    if (m.name === UNAVAILABLE) openUntil = Date.now() + idleMs;
    r.no(named(m.name ?? 'Error', m.message ?? ''));
  }

  function onExit(kid: Kid, code: number | null, sig: NodeJS.Signals | null): void {
    if (k === kid) k = null;
    if (kid.asked) return;
    console.error(`[embed-child] pid=${kid.c.pid} exited code=${code} signal=${sig}`);
    const external = sig === 'SIGINT' || sig === 'SIGTERM' || sig === 'SIGHUP';
    if (!external) trip();
    settle(kid)?.no(named(external ? CLOSED : CRASHED, `embed child exited (${code ?? sig})`));
  }

  function once(text: string): Promise<Float32Array> {
    clearTimeout(idle);
    const kid = (k ??= spawn());
    kid.c.ref();
    kid.c.channel?.ref();
    return new Promise((ok, no) => {
      const r: Req = (p = { id: ++seq, text, ok, no });
      r.t = setTimeout(() => {
        if (p !== r) return;
        p = null;
        trip();
        stop(kid, true);
        no(named('EmbedTimeoutError', 'embed child timed out'));
      }, kid.first ? loadMs - (Date.now() - kid.at) : requestMs);
      if (kid.ready) kid.c.send({ id: r.id, text });
    });
  }

  async function run(text: string): Promise<Float32Array> {
    for (let n = 0; ; n++) {
      await draining;
      if (closed) throw named(CLOSED, 'embed child closed');
      if (Date.now() < openUntil) throw named(UNAVAILABLE, 'embed child refusing');
      try {
        return await once(text);
      } catch (e) {
        if (n || (e as Error).name !== CRASHED) throw e;
      }
    }
  }

  return {
    embed(text) {
      const r = chain.then(() => run(text));
      chain = r.catch(() => {});
      return r;
    },
    close() {
      closed = true;
      clearTimeout(idle);
      if (k) {
        const kid = k;
        stop(kid, true);
        settle(kid)?.no(named(CLOSED, 'embed child closed'));
      }
    },
    get pid() {
      return k?.c.pid;
    },
  };
}

let one: EmbedChild | null = null;
let shut = false;

/** The brain's one embed child, created on first use. */
export function getEmbedChild(): EmbedChild {
  if (!one) {
    one = createEmbedChild();
    if (shut) one.close();
    else process.once('exit', () => one?.close());
  }
  return one;
}

/** Synchronous; no respawn after it. Call before engine.shutdown(). */
export function shutdownEmbedChild(): void {
  shut = true;
  one?.close();
}
