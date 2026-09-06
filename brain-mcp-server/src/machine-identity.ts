/**
 * Machine identity (BR-100): config.json `machine.id`, stamped as `machine_id`
 * beside the hostname label; pure region parity-pinned with the CLI twin;
 * honours IGRIS_BRAIN_DIR (a WRITE seam). Rationale: docs/COGNITION.md.
 * @module machine-identity
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// --- BR-100 PURE REGION (parity-pinned) ---
/** Minted id (null before the first writer), live hostname, every hostname seen. */
export interface MachineIdentity {
  machine_id: string | null;
  hostname: string;
  aliases: string[];
}

function machineBlock(config: unknown): Record<string, unknown> | null {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return null;
  const m = (config as Record<string, unknown>).machine;
  return typeof m === 'object' && m !== null && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
}

function persistedAliases(block: Record<string, unknown> | null): string[] {
  const a = block?.aliases;
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

/** Identity from a parsed config.json (or null) + live hostname; aliases = persisted ∪ live. */
export function resolveIdentity(config: unknown, liveHostname: string): MachineIdentity {
  const block = machineBlock(config);
  const id = typeof block?.id === 'string' && block.id.length > 0 ? block.id : null;
  const aliases = persistedAliases(block);
  if (liveHostname.length > 0 && !aliases.includes(liveHostname)) aliases.push(liveHostname);
  return { machine_id: id, hostname: liveHostname, aliases };
}

/** Config with machine.id / minted_at set; siblings and aliases kept. */
export function withMintedId(config: Record<string, unknown>, id: string, mintedAt: string): Record<string, unknown> {
  const block = machineBlock(config);
  return { ...config, machine: { ...(block ?? {}), id, aliases: persistedAliases(block), minted_at: mintedAt } };
}

/** Config with `host` appended to machine.aliases; unchanged ⇒ the same object. */
export function withObservedHostname(config: Record<string, unknown>, host: string): { next: Record<string, unknown>; changed: boolean } {
  const block = machineBlock(config);
  const aliases = persistedAliases(block);
  if (host.length === 0 || aliases.includes(host)) return { next: config, changed: false };
  return { next: { ...config, machine: { ...(block ?? {}), aliases: [...aliases, host] } }, changed: true };
}

/** Row is mine: id equal (id wins), else NULL id + hostname in aliases. */
export function isSameMachine(row: { machine_id?: string | null; machine_hostname: string | null }, me: MachineIdentity): boolean {
  const rid = row.machine_id;
  if (typeof rid === 'string' && rid.length > 0) return me.machine_id !== null && rid === me.machine_id;
  return row.machine_hostname !== null && me.aliases.includes(row.machine_hostname);
}
// --- END PURE REGION ---

function configPath(): string {
  const dir = process.env.IGRIS_BRAIN_DIR;
  return dir && dir.length > 0 ? path.join(dir, 'config.json') : path.join(os.homedir(), '.igris', 'config.json');
}

function readConfigFile(p: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeConfigFile(p: string, next: Record<string, unknown>): void {
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, p);
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* win32 */
  }
}

// TD-406 shape: under a test runner the writer is contained to the seam.
function writerContained(): boolean {
  const t = process.env.VITEST;
  const test = (t !== undefined && t !== '' && t !== 'false') || process.env.NODE_ENV === 'test';
  const dir = process.env.IGRIS_BRAIN_DIR;
  return test && !(dir && dir.length > 0);
}

function acquireLock(lock: string): number | null {
  for (let i = 0; i < 40; i++) {
    try {
      return fs.openSync(lock, 'wx');
    } catch {
      /* held */
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > 5_000) fs.unlinkSync(lock);
    } catch {
      /* gone */
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return null;
}

/** READER — pure; never writes. */
export function readMachineIdentity(): MachineIdentity {
  let host = '';
  try {
    host = os.hostname();
    return resolveIdentity(readConfigFile(configPath()), host);
  } catch {
    return resolveIdentity(null, host);
  }
}

/** WRITER — mint once + append the live alias under a wx lock; absent/malformed config or a held lock ⇒ no write, id null; never throws. */
export function ensureMachineIdentity(): MachineIdentity {
  let host = '';
  try {
    host = os.hostname();
    const p = configPath();
    const cfg = readConfigFile(p);
    if (cfg === null) return resolveIdentity(null, host);
    const seen = resolveIdentity(cfg, host);
    if ((seen.machine_id !== null && !withObservedHostname(cfg, host).changed) || writerContained()) return seen;
    const lock = `${p}.lock`;
    const fd = acquireLock(lock);
    if (fd === null) {
      process.stderr.write(`[machine-identity] lock held: ${lock} — not minting this run\n`);
      return seen;
    }
    try {
      const fresh = readConfigFile(p);
      if (fresh === null) return seen;
      const minted = resolveIdentity(fresh, host).machine_id === null;
      const next = minted ? withMintedId(fresh, randomUUID(), new Date().toISOString()) : fresh;
      const obs = withObservedHostname(next, host);
      if (minted || obs.changed) writeConfigFile(p, obs.next);
      return resolveIdentity(obs.next, host);
    } finally {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  } catch {
    return resolveIdentity(null, host);
  }
}
