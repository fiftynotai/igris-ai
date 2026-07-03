/**
 * sync-transport.test.ts — TD-252.
 *
 * Unit-tests the transport classifier + override reader + enforcement gate.
 * No mocks of the module under test (per L-159 / TD-098); the only seams are
 * the `IGRIS_ALLOW_INSECURE_SYNC` env var, the `config.json`
 * `remote_brain.allow_insecure` key (via a sandboxed `IGRIS_BRAIN_DIR`), and
 * `process.stderr.write` (to capture the loud warning).
 *
 * #376 polarity guard: the UNSET override MUST refuse non-local http — the
 * default is refuse, the override flips to allow-with-warning. Asserted
 * explicitly in "unset override refuses".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpBrain: string;
const envBackup: Record<string, string | undefined> = {};

function writeConfig(content: Record<string, unknown>): void {
  writeFileSync(
    join(tmpBrain, "config.json"),
    JSON.stringify(content, null, 2) + "\n",
  );
}

beforeEach(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), "igris-cli-sync-transport-"));
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  envBackup.IGRIS_ALLOW_INSECURE_SYNC = process.env.IGRIS_ALLOW_INSECURE_SYNC;
  process.env.IGRIS_BRAIN_DIR = tmpBrain;
  // Default: override UNSET so each test starts from the refuse-default.
  delete process.env.IGRIS_ALLOW_INSECURE_SYNC;
});

afterEach(() => {
  rmSync(tmpBrain, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
  if (envBackup.IGRIS_ALLOW_INSECURE_SYNC === undefined) {
    delete process.env.IGRIS_ALLOW_INSECURE_SYNC;
  } else {
    process.env.IGRIS_ALLOW_INSECURE_SYNC = envBackup.IGRIS_ALLOW_INSECURE_SYNC;
  }
  vi.restoreAllMocks();
});

describe("classifySyncTransport — pure classification", () => {
  it("https:// → 'https'", async () => {
    const { classifySyncTransport } = await import("../lib/sync-transport.js");
    expect(classifySyncTransport("https://vps.example:3001")).toBe("https");
    expect(classifySyncTransport("https://127.0.0.1:3001")).toBe("https");
  });

  it("http:// to localhost variants → 'localhost-http' (protects test fixtures)", async () => {
    const { classifySyncTransport } = await import("../lib/sync-transport.js");
    expect(classifySyncTransport("http://127.0.0.1:3001")).toBe(
      "localhost-http",
    );
    expect(classifySyncTransport("http://localhost:3001")).toBe(
      "localhost-http",
    );
    expect(classifySyncTransport("http://[::1]:3001")).toBe("localhost-http");
    // No port (the bare loopback the boot-sync fixtures sometimes use).
    expect(classifySyncTransport("http://127.0.0.1")).toBe("localhost-http");
  });

  it("http:// to a remote host → 'insecure-http'", async () => {
    const { classifySyncTransport } = await import("../lib/sync-transport.js");
    expect(classifySyncTransport("http://vps.example:3001")).toBe(
      "insecure-http",
    );
    expect(classifySyncTransport("http://10.0.0.5:3001")).toBe("insecure-http");
  });

  it("malformed / non-http scheme → 'insecure-http' (defensive refuse)", async () => {
    const { classifySyncTransport } = await import("../lib/sync-transport.js");
    expect(classifySyncTransport("not a url")).toBe("insecure-http");
    expect(classifySyncTransport("ftp://vps.example")).toBe("insecure-http");
    expect(classifySyncTransport("")).toBe("insecure-http");
  });
});

describe("isInsecureSyncAllowed — override reader (#376 polarity)", () => {
  it("unset env + no config key → false (refuse by default)", async () => {
    const { isInsecureSyncAllowed } = await import("../lib/sync-transport.js");
    expect(isInsecureSyncAllowed()).toBe(false);
  });

  it("env var =1 → true", async () => {
    process.env.IGRIS_ALLOW_INSECURE_SYNC = "1";
    const { isInsecureSyncAllowed } = await import("../lib/sync-transport.js");
    expect(isInsecureSyncAllowed()).toBe(true);
  });

  it("env var set to anything other than '1' → false", async () => {
    process.env.IGRIS_ALLOW_INSECURE_SYNC = "true";
    const { isInsecureSyncAllowed } = await import("../lib/sync-transport.js");
    expect(isInsecureSyncAllowed()).toBe(false);
  });

  it("config.json remote_brain.allow_insecure: true → true", async () => {
    writeConfig({ remote_brain: { allow_insecure: true } });
    const { isInsecureSyncAllowed } = await import("../lib/sync-transport.js");
    expect(isInsecureSyncAllowed()).toBe(true);
  });

  it("config.json remote_brain.allow_insecure absent → false", async () => {
    writeConfig({ remote_brain: { url: "http://x", api_key: "k" } });
    const { isInsecureSyncAllowed } = await import("../lib/sync-transport.js");
    expect(isInsecureSyncAllowed()).toBe(false);
  });
});

describe("assertSyncTransportAllowed — enforcement gate (4-case matrix)", () => {
  it("case 1: https → {ok:true}, no warning", async () => {
    const stderr: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((c: unknown) => {
        stderr.push(typeof c === "string" ? c : String(c));
        return true;
      });
    const { assertSyncTransportAllowed } = await import(
      "../lib/sync-transport.js"
    );
    const res = assertSyncTransportAllowed("https://vps.example:3001");
    spy.mockRestore();
    expect(res.ok).toBe(true);
    expect(stderr.join("")).toBe("");
  });

  it("case 2: localhost http → {ok:true}, no warning", async () => {
    const stderr: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((c: unknown) => {
        stderr.push(typeof c === "string" ? c : String(c));
        return true;
      });
    const { assertSyncTransportAllowed } = await import(
      "../lib/sync-transport.js"
    );
    const res = assertSyncTransportAllowed("http://127.0.0.1:3001");
    spy.mockRestore();
    expect(res.ok).toBe(true);
    expect(stderr.join("")).toBe("");
  });

  it("case 3: remote http, override UNSET → {ok:false} with cleartext-key reason", async () => {
    // #376: the default (unset) MUST refuse.
    const { assertSyncTransportAllowed } = await import(
      "../lib/sync-transport.js"
    );
    const res = assertSyncTransportAllowed("http://vps.example:3001");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("cleartext");
      expect(res.reason).toContain("vps.example:3001");
      expect(res.reason).toContain("IGRIS_ALLOW_INSECURE_SYNC=1");
    }
  });

  it("case 4: remote http, override =1 → {ok:true} + loud warning", async () => {
    process.env.IGRIS_ALLOW_INSECURE_SYNC = "1";
    const stderr: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((c: unknown) => {
        stderr.push(typeof c === "string" ? c : String(c));
        return true;
      });
    const { assertSyncTransportAllowed } = await import(
      "../lib/sync-transport.js"
    );
    const res = assertSyncTransportAllowed("http://vps.example:3001");
    spy.mockRestore();
    expect(res.ok).toBe(true);
    const out = stderr.join("");
    expect(out).toContain("WARNING");
    expect(out).toContain("cleartext");
    expect(out).toContain("vps.example:3001");
  });

  it("case 4b: config-key override also allows (persistent form)", async () => {
    writeConfig({ remote_brain: { allow_insecure: true } });
    const { assertSyncTransportAllowed } = await import(
      "../lib/sync-transport.js"
    );
    const res = assertSyncTransportAllowed("http://vps.example:3001");
    expect(res.ok).toBe(true);
  });

  it("never throws on a malformed url (returns {ok:false})", async () => {
    const { assertSyncTransportAllowed } = await import(
      "../lib/sync-transport.js"
    );
    let res: { ok: boolean } | undefined;
    expect(() => {
      res = assertSyncTransportAllowed("::::not a url::::");
    }).not.toThrow();
    expect(res?.ok).toBe(false);
  });
});
