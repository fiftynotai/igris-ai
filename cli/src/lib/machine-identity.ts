/**
 * Machine identity — the CLI twin (BR-100). The PURE REGION is a byte-pinned
 * copy of `brain-mcp-server/src/machine-identity.ts` (zero cross-imports; the
 * FR-238 runtime door is async and this must not be). Contract, rationale and
 * the alias fallback: docs/COGNITION.md + MAINTAINING (machine identity row).
 * `os.hostname()` is read at CALL time (AC-2 stubs it between two writes).
 */

import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { isTestContext } from "./canonical-root.js";
import { readConfig, writeConfigAtomic } from "./init-config.js";
import { configJsonPath } from "./paths.js";

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

/** The predicate as SQL; without the column (older brain) the hostname-only form. */
export function sameMachineSql(
  me: MachineIdentity,
  hasMachineIdColumn: boolean,
  tableAlias = "",
): { sql: string; params: (string | null)[] } {
  const c = tableAlias.length > 0 ? `${tableAlias}.` : "";
  const hosts = `${c}machine_hostname IN (${me.aliases.map(() => "?").join(", ")})`;
  if (!hasMachineIdColumn) return { sql: hosts, params: [...me.aliases] };
  return {
    sql: `(${c}machine_id = ? OR (${c}machine_id IS NULL AND ${hosts}))`,
    params: [me.machine_id, ...me.aliases],
  };
}

function loadConfig(): Record<string, unknown> | null {
  const cfg = readConfig();
  return cfg !== null && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : null;
}

// 40 × 25 ms; a lock older than 5 s is broken; null ⇒ proceed without minting.
function acquireLock(lock: string): number | null {
  for (let i = 0; i < 40; i++) {
    try {
      return openSync(lock, "wx");
    } catch {
      /* held */
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > 5_000) unlinkSync(lock);
    } catch {
      /* gone */
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return null;
}

/** READER — pure; never writes. */
export function readMachineIdentity(): MachineIdentity {
  let host = "";
  try {
    host = os.hostname();
    return resolveIdentity(loadConfig(), host);
  } catch {
    return resolveIdentity(null, host);
  }
}

/** WRITER — mint once + append the live alias under a wx lock; contained under a test runner with no IGRIS_BRAIN_DIR (TD-406 shape); never throws. */
export function ensureMachineIdentity(): MachineIdentity {
  let host = "";
  try {
    host = os.hostname();
    const cfg = loadConfig();
    if (cfg === null) return resolveIdentity(null, host);
    const seen = resolveIdentity(cfg, host);
    const contained = isTestContext() && !(process.env.IGRIS_BRAIN_DIR && process.env.IGRIS_BRAIN_DIR.length > 0);
    if ((seen.machine_id !== null && !withObservedHostname(cfg, host).changed) || contained) return seen;
    const lock = `${configJsonPath()}.lock`;
    const fd = acquireLock(lock);
    if (fd === null) {
      process.stderr.write(`[machine-identity] lock held: ${lock} — not minting this run\n`);
      return seen;
    }
    try {
      const fresh = loadConfig();
      if (fresh === null) return seen;
      const minted = resolveIdentity(fresh, host).machine_id === null;
      const next = minted ? withMintedId(fresh, randomUUID(), new Date().toISOString()) : fresh;
      const obs = withObservedHostname(next, host);
      if (minted || obs.changed) writeConfigAtomic(obs.next);
      return resolveIdentity(obs.next, host);
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lock);
      } catch {
        /* already gone */
      }
    }
  } catch {
    return resolveIdentity(null, host);
  }
}
