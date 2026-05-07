/**
 * remote-push.test.ts — Phase 2 (M2, Risk A4).
 *
 * Real fs against tmp dirs + a real loopback HTTP server. No mocks of the
 * module under test (L-159). The HTTP server is the external boundary
 * where the test seam sits — we accept the connection and capture body
 * shape + headers.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

let tmpBrain: string;

function writeConfig(content: Record<string, unknown>): void {
  writeFileSync(
    join(tmpBrain, "config.json"),
    JSON.stringify(content, null, 2) + "\n",
  );
}

beforeEach(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), "igris-cli-remote-push-"));
  process.env.IGRIS_BRAIN_DIR = tmpBrain;
});

afterEach(() => {
  rmSync(tmpBrain, { recursive: true, force: true });
  delete process.env.IGRIS_BRAIN_DIR;
});

describe("remote-push — pushProjectToRemote", () => {
  it("config absent → not_configured (no network call)", async () => {
    const m = await import("../lib/remote-push.js");
    const out = await m.pushProjectToRemote({
      slug: "demo",
      path: "/tmp/demo",
      techStack: "typescript",
      cliVersion: "7.0.0",
    });
    expect(out).toBe("not_configured");
  });

  it("remote_brain unset → not_configured (no network call)", async () => {
    writeConfig({ remote_brain: null });
    const m = await import("../lib/remote-push.js");
    const out = await m.pushProjectToRemote({
      slug: "demo",
      path: "/tmp/demo",
      techStack: "typescript",
      cliVersion: "7.0.0",
    });
    expect(out).toBe("not_configured");
  });

  it("config with empty url/key → not_configured", async () => {
    writeConfig({ remote_brain: { url: "", api_key: "" } });
    const m = await import("../lib/remote-push.js");
    const out = await m.pushProjectToRemote({
      slug: "demo",
      path: "/tmp/demo",
      techStack: "typescript",
      cliVersion: "7.0.0",
    });
    expect(out).toBe("not_configured");
  });

  it("HTTP 200 response → pushed; body matches schema", async () => {
    let capturedBody = "";
    let capturedAuth = "";
    const server = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        capturedAuth = req.headers.authorization ?? "";
        let buf = "";
        req.on("data", (chunk: Buffer) => {
          buf += chunk.toString("utf-8");
        });
        req.on("end", () => {
          capturedBody = buf;
          res.statusCode = 200;
          res.end("{}");
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      writeConfig({
        remote_brain: {
          url: `http://127.0.0.1:${port}`,
          api_key: "secret-token",
        },
      });
      const m = await import("../lib/remote-push.js");
      const out = await m.pushProjectToRemote({
        slug: "demo",
        path: "/tmp/demo",
        techStack: "typescript/javascript",
        cliVersion: "7.0.0",
      });
      expect(out).toBe("pushed");
      expect(capturedAuth).toBe("Bearer secret-token");

      const body = JSON.parse(capturedBody) as {
        tables: { projects: Array<{ slug: string; path: string }> };
      };
      expect(body.tables.projects[0].slug).toBe("demo");
      expect(body.tables.projects[0].path).toBe("/tmp/demo");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("HTTP 500 response → http_error (install does not fail)", async () => {
    const server = createServer(
      (_req: IncomingMessage, res: ServerResponse) => {
        res.statusCode = 500;
        res.end("server error");
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      writeConfig({
        remote_brain: {
          url: `http://127.0.0.1:${port}`,
          api_key: "secret",
        },
      });
      const m = await import("../lib/remote-push.js");
      const out = await m.pushProjectToRemote({
        slug: "demo",
        path: "/tmp/demo",
        techStack: "",
        cliVersion: "7.0.0",
      });
      expect(out).toBe("http_error");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("network error (connection refused) → network_error", async () => {
    // Reserve a port then close, so connect() refuses.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    writeConfig({
      remote_brain: {
        url: `http://127.0.0.1:${port}`,
        api_key: "secret",
      },
    });
    const m = await import("../lib/remote-push.js");
    const out = await m.pushProjectToRemote({
      slug: "demo",
      path: "/tmp/demo",
      techStack: "",
      cliVersion: "7.0.0",
    });
    expect(out).toBe("network_error");
  });
});
