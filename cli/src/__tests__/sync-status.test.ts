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
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

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
