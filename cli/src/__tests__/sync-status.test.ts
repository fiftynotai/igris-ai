/**
 * sync-status.test.ts — M4.2 (MG-014).
 *
 * Real fs against tmp + a real loopback HTTP server. No mocks of the
 * module under test (per L-159 / TD-098). Mirrors the pattern used by
 * remote-push.test.ts.
 *
 * Test seam: `node:http.createServer` returning canned responses is the
 * external boundary. The lib/mcp-client.healthCheck function calls this
 * server directly via the configured remote_brain.url, so we get the full
 * HTTP roundtrip without mocking node:https.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SUPPORTED_NODE_RANGE } from "../lib/preflight.js";

let tmpBrain: string;
const envBackup: Record<string, string | undefined> = {};

function writeConfig(content: Record<string, unknown>): void {
  writeFileSync(
    join(tmpBrain, "config.json"),
    JSON.stringify(content, null, 2) + "\n",
  );
}

function writeQueue(slug: string, lines: string[]): string {
  const dir = join(tmpBrain, "projects", slug);
  mkdirSync(dir, { recursive: true });
  const queuePath = join(dir, "sync_queue.jsonl");
  writeFileSync(queuePath, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
  return queuePath;
}

beforeEach(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), "igris-cli-sync-status-"));
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  envBackup.IGRIS_ALLOW_INSECURE_SYNC = process.env.IGRIS_ALLOW_INSECURE_SYNC;
  process.env.IGRIS_BRAIN_DIR = tmpBrain;
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

describe("sync status — runSyncStatus", () => {
  it("remote_brain not configured → exit 1", async () => {
    const { runSyncStatus } = await import("../lib/sync/status.js");
    const code = await runSyncStatus();
    expect(code).toBe(1);
  });

  it("VPS reachable: prints OK status with brain version from /health", async () => {
    const server = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        if (req.url === "/health" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", version: "7.0.0" }));
          return;
        }
        res.writeHead(404);
        res.end();
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${port}`, api_key: "k" },
    });

    const stdoutBuf: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      const { runSyncStatus } = await import("../lib/sync/status.js");
      const code = await runSyncStatus({ projectSlug: "demo" });
      expect(code).toBe(0);
      const out = stdoutBuf.join("");
      expect(out).toContain("reachable:");
      expect(out).toContain("yes");
      expect(out).toContain("HTTP 200");
      expect(out).toContain("brain version:");
      expect(out).toContain("7.0.0");
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("VPS unreachable: returns 0 (status report still printed) with reachable=no", async () => {
    // Point at a port nothing's listening on. Use a high random port.
    writeConfig({
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });

    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    const outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      const { runSyncStatus } = await import("../lib/sync/status.js");
      const code = await runSyncStatus({ projectSlug: "demo" });
      expect(code).toBe(0);
      const out = stdoutBuf.join("") + stderrBuf.join("");
      expect(out).toContain("reachable:");
      // Either "no (HTTP unreachable)" or warn about VPS unreachable.
      expect(out.toLowerCase()).toContain("unreachable");
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("queue depth + lastPushAt: reads local sync_queue.jsonl correctly", async () => {
    const server = createServer(
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "7.0.0" }));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${port}`, api_key: "k" },
    });

    // Seed a 3-line queue.
    const queuePath = writeQueue("demo", [
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-100" }),
      JSON.stringify({ operation: "brief_create", brief_id: "TD-101" }),
      JSON.stringify({ operation: "brief_sync", brief_id: "TD-102" }),
    ]);
    // Force a known mtime so the timestamp test is deterministic.
    const fixedTime = new Date("2026-05-08T00:00:00.000Z");
    utimesSync(queuePath, fixedTime, fixedTime);

    const stdoutBuf: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      const { runSyncStatus } = await import("../lib/sync/status.js");
      const code = await runSyncStatus({ projectSlug: "demo" });
      expect(code).toBe(0);
      const out = stdoutBuf.join("");
      expect(out).toContain("queue depth:     3 entries");
      expect(out).toContain("last push:       2026-05-08T00:00:00.000Z");
      expect(out).toContain(queuePath);
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("queue missing: prints depth=0 and lastPush=never", async () => {
    const server = createServer(
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "7.0.0" }));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${port}`, api_key: "k" },
    });

    const stdoutBuf: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      const { runSyncStatus } = await import("../lib/sync/status.js");
      const code = await runSyncStatus({ projectSlug: "no-such-project" });
      expect(code).toBe(0);
      const out = stdoutBuf.join("");
      expect(out).toContain("queue depth:     0 entries");
      expect(out).toContain("last push:       never");
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("queue depth includes lines from stale .draining-* files; surfaces 'stale drains' line (FR-128)", async () => {
    const server = createServer(
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "7.0.0" }));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${port}`, api_key: "k" },
    });

    // Live queue: 2 lines.
    const queuePath = writeQueue("demo", [
      JSON.stringify({ operation: "brief_sync", brief_id: "L1" }),
      JSON.stringify({ operation: "brief_sync", brief_id: "L2" }),
    ]);
    // Stale draining file: 3 lines (simulates a mid-flight or crashed drain).
    const dir = join(tmpBrain, "projects", "demo");
    writeFileSync(
      join(dir, "sync_queue.jsonl.draining-12345-9"),
      [
        JSON.stringify({ operation: "brief_sync", brief_id: "D1" }),
        JSON.stringify({ operation: "brief_sync", brief_id: "D2" }),
        JSON.stringify({ operation: "brief_sync", brief_id: "D3" }),
      ].join("\n") + "\n",
    );

    const stdoutBuf: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      const { runSyncStatus } = await import("../lib/sync/status.js");
      const code = await runSyncStatus({ projectSlug: "demo" });
      expect(code).toBe(0);
      const out = stdoutBuf.join("");
      // True depth = liveLines (2) + drainingLines (3) = 5
      expect(out).toContain("queue depth:     5 entries");
      // Operator-visibility line.
      expect(out).toContain("stale drains:");
      expect(out).toContain("1 in-progress");
      expect(out).toContain("drainingLines=3");
      // Canonical queue path still rendered.
      expect(out).toContain(queuePath);
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("--dry-run: no network call; prints plan", async () => {
    writeConfig({
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
    });
    const stdoutBuf: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
    try {
      const { runSyncStatus } = await import("../lib/sync/status.js");
      const code = await runSyncStatus({ dryRun: true, projectSlug: "demo" });
      expect(code).toBe(0);
      const out = stdoutBuf.join("");
      expect(out).toContain("Dry-run plan:");
      expect(out).toContain("/health");
      expect(out).toContain("No filesystem writes were performed.");
    } finally {
      spy.mockRestore();
    }
  });

  it("TD-252: remote-http + override → report includes the INSECURE transport line", async () => {
    // Override active so health is attempted (but the host is invalid, so
    // reachable=no — the transport line is independent of reachability).
    process.env.IGRIS_ALLOW_INSECURE_SYNC = "1";
    writeConfig({
      remote_brain: { url: "http://vps.example.invalid:3001", api_key: "k" },
    });

    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];
    const outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });

    try {
      const { runSyncStatus } = await import("../lib/sync/status.js");
      const code = await runSyncStatus({ projectSlug: "demo" });
      expect(code).toBe(0);
      const out = stdoutBuf.join("") + stderrBuf.join("");
      expect(out).toContain("transport:");
      expect(out).toContain("INSECURE http://");
      expect(out).toContain("cleartext");
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("TD-252: localhost http → NO INSECURE transport line", async () => {
    const server = createServer(
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "7.0.0" }));
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    writeConfig({
      remote_brain: { url: `http://127.0.0.1:${port}`, api_key: "k" },
    });

    const stdoutBuf: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        stdoutBuf.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
    try {
      const { runSyncStatus } = await import("../lib/sync/status.js");
      const code = await runSyncStatus({ projectSlug: "demo" });
      expect(code).toBe(0);
      const out = stdoutBuf.join("");
      expect(out).not.toContain("INSECURE http://");
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("BR-116 AC-5 — `sync status` shows the VPS Node version vs the engines range", () => {
  // A PATH-stub `ssh` logs its argv and prints $BR116_SSH_OUT / exits $BR116_SSH_EXIT.
  let bin: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "br116-status-bin-"));
    writeFileSync(
      join(bin, "ssh"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$BR116_SSH_LOG"\nprintf \'%s\\n\' "$BR116_SSH_OUT"\nexit "${BR116_SSH_EXIT:-0}"\n',
    );
    chmodSync(join(bin, "ssh"), 0o755);
    for (const k of ["PATH", "BR116_SSH_LOG", "BR116_SSH_OUT", "BR116_SSH_EXIT"]) saved[k] = process.env[k];
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.BR116_SSH_LOG = join(bin, "calls.log");
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(bin, { recursive: true, force: true });
  });

  async function status(vps: boolean): Promise<{ code: number; out: string }> {
    writeConfig({
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
      ...(vps ? { vps: { host: "vps.example.com", user: "deploy", repo_path: "/srv/igris" } } : {}),
    });
    const buf: string[] = [];
    const push = (chunk: unknown) => (buf.push(String(chunk)), true);
    const o = vi.spyOn(process.stdout, "write").mockImplementation(push);
    const e = vi.spyOn(process.stderr, "write").mockImplementation(push);
    try {
      const { runSyncStatus } = await import("../lib/sync/status.js");
      const code = await runSyncStatus({ projectSlug: "demo" });
      return { code, out: buf.join("") };
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
  }

  it("S5a: VPS on v20.20.0 → OUTSIDE the exact range; exit 0", async () => {
    process.env.BR116_SSH_OUT = "v20.20.0";
    const { code, out } = await status(true);
    expect(code).toBe(0);
    const line = out.split("\n").find((l) => l.includes("vps node:")) ?? "";
    expect(line).toContain("v20.20.0");
    expect(line).toContain("OUTSIDE");
    expect(line).toContain(SUPPORTED_NODE_RANGE);
    const calls = readFileSync(join(bin, "calls.log"), "utf-8");
    expect(calls).toContain("deploy@vps.example.com -- node --version");
    expect(calls).toContain("ConnectTimeout=5");
  }, 20_000);

  it("S5b: v22.12.0 → within", async () => {
    process.env.BR116_SSH_OUT = "v22.12.0";
    const { code, out } = await status(true);
    expect(code).toBe(0);
    expect(out).toContain(`vps node:        v22.12.0 — within engines range ${SUPPORTED_NODE_RANGE}`);
  }, 20_000);

  it("S5c: the probe fails (ssh exit 255) → 'unknown (ssh probe failed: exit 255)', still exit 0", async () => {
    process.env.BR116_SSH_OUT = "";
    process.env.BR116_SSH_EXIT = "255";
    const { code, out } = await status(true);
    expect(code).toBe(0);
    expect(out).toContain("vps node:        unknown (ssh probe failed: exit 255)");
  }, 20_000);

  it("S5d: no `vps` block → no ssh at all and no vps node line", async () => {
    process.env.BR116_SSH_OUT = "v20.20.0";
    const { code, out } = await status(false);
    expect(code).toBe(0);
    expect(existsSync(join(bin, "calls.log"))).toBe(false);
    expect(out).not.toContain("vps node:");
  }, 20_000);

  it("--dry-run names the read-only `node --version` probe only when `vps` is configured", async () => {
    writeConfig({
      remote_brain: { url: "http://127.0.0.1:1", api_key: "k" },
      vps: { host: "vps.example.com", user: "deploy", repo_path: "/srv/igris" },
    });
    const buf: string[] = [];
    const o = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => (buf.push(String(c)), true));
    try {
      const { runSyncStatus } = await import("../lib/sync/status.js");
      expect(await runSyncStatus({ dryRun: true, projectSlug: "demo" })).toBe(0);
    } finally {
      o.mockRestore();
    }
    expect(buf.join("")).toContain("node --version");
    expect(existsSync(join(bin, "calls.log"))).toBe(false);
  });
});
