/**
 * FR-238 (D5) — the ported cross-platform open ladder.
 *
 * Every rung is exercised through the injected seams (`platform`, `env`,
 * `spawnFn`, `hasCommandFn`, `isWslFn`) rather than by actually launching a
 * browser. That is boundary-mocking, not SUT-mocking (L-159): the ladder's real
 * branching runs; only the process spawn is swapped out.
 *
 * The rung ORDER and the exact argv are the contract — this is a port of the
 * bash `open_in_browser()` in `core/skills/visualize/SKILL.md`, and TD-308 will
 * eventually re-point that skill here. A divergence in argv would surface as a
 * behaviour change on WSL, which nobody in this project can reproduce locally.
 */

import { describe, expect, it } from "vitest";
import { describeOpenResult, openUrl, type OpenUrlOptions } from "../lib/open-url.js";

interface Spawned {
  cmd: string;
  args: string[];
}

function harness(
  over: Partial<OpenUrlOptions> & { spawnOk?: boolean } = {},
): { opts: OpenUrlOptions; calls: Spawned[] } {
  const calls: Spawned[] = [];
  const opts: OpenUrlOptions = {
    platform: "linux",
    env: { DISPLAY: ":0" },
    hasCommandFn: () => true,
    isWslFn: () => false,
    spawnFn: (cmd, args) => {
      calls.push({ cmd, args });
      return over.spawnOk !== false;
    },
    ...over,
  };
  return { opts, calls };
}

describe("open-url — target validation (no code-execution primitive)", () => {
  it("accepts http, https, file and bare paths", () => {
    for (const t of [
      "http://127.0.0.1:7317/",
      "https://example.test/",
      "file:///tmp/x.html",
      "/tmp/graph.html",
      "./out.html",
      "C:\\Users\\x\\out.html",
    ]) {
      const { opts } = harness({ platform: "darwin" });
      expect(openUrl(t, opts).kind, t).not.toBe("rejected");
    }
  });

  it("REJECTS javascript:, data: and vbscript: without spawning", () => {
    for (const t of [
      "javascript:alert(1)",
      "data:text/html,<script>x</script>",
      "vbscript:msgbox",
    ]) {
      const { opts, calls } = harness({ platform: "darwin" });
      const r = openUrl(t, opts);
      expect(r.kind, t).toBe("rejected");
      expect(calls).toHaveLength(0);
    }
  });
});

describe("open-url — rung 0: headless guard", () => {
  it("no DISPLAY and no WAYLAND_DISPLAY on linux -> headless, no spawn", () => {
    const { opts, calls } = harness({ platform: "linux", env: {} });
    const r = openUrl("http://127.0.0.1:1/", opts);
    expect(r.kind).toBe("headless");
    expect(calls).toHaveLength(0);
    expect(describeOpenResult(r)).toContain("headless");
  });

  it("WAYLAND_DISPLAY alone lifts the guard", () => {
    const { opts, calls } = harness({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
    });
    expect(openUrl("http://127.0.0.1:1/", opts).kind).toBe("opened");
    expect(calls[0].cmd).toBe("xdg-open");
  });

  it("darwin is NEVER headless-gated (the bash `OSTYPE != darwin*` clause)", () => {
    const { opts } = harness({ platform: "darwin", env: {} });
    expect(openUrl("http://127.0.0.1:1/", opts).kind).toBe("opened");
  });
});

describe("open-url — rung 1: macOS", () => {
  it("spawns `open <target>`", () => {
    const { opts, calls } = harness({ platform: "darwin", env: {} });
    const r = openUrl("http://127.0.0.1:7317/", opts);
    expect(r.kind).toBe("opened");
    expect(r.opener).toBe("open");
    expect(calls).toEqual([{ cmd: "open", args: ["http://127.0.0.1:7317/"] }]);
  });

  it("a failed `open` reports failed, never throws", () => {
    const { opts } = harness({ platform: "darwin", env: {}, spawnOk: false });
    const r = openUrl("http://127.0.0.1:1/", opts);
    expect(r.kind).toBe("failed");
    expect(describeOpenResult(r)).toContain("could not auto-open");
  });
});

describe("open-url — rung 2: WSL", () => {
  it("prefers wslview when present", () => {
    const { opts, calls } = harness({ isWslFn: () => true });
    const r = openUrl("http://127.0.0.1:1/", opts);
    expect(r.opener).toBe("wslview");
    expect(calls).toEqual([{ cmd: "wslview", args: ["http://127.0.0.1:1/"] }]);
  });

  it("falls back to `cmd.exe /c start \"\" <target>` (the empty title arg)", () => {
    const { opts, calls } = harness({
      isWslFn: () => true,
      hasCommandFn: (c) => c !== "wslview",
    });
    const r = openUrl("http://127.0.0.1:1/", opts);
    expect(r.opener).toBe("cmd.exe");
    expect(calls).toEqual([
      { cmd: "cmd.exe", args: ["/c", "start", "", "http://127.0.0.1:1/"] },
    ]);
  });

  it("both WSL rungs failing reports failed", () => {
    const { opts } = harness({ isWslFn: () => true, spawnOk: false });
    expect(openUrl("http://127.0.0.1:1/", opts).kind).toBe("failed");
  });
});

describe("open-url — rung 3/4: Linux and fallback", () => {
  it("spawns xdg-open when present", () => {
    const { opts, calls } = harness();
    expect(openUrl("http://127.0.0.1:1/", opts).opener).toBe("xdg-open");
    expect(calls[0].args).toEqual(["http://127.0.0.1:1/"]);
  });

  it("no xdg-open -> failed, not an error", () => {
    const { opts, calls } = harness({ hasCommandFn: () => false });
    const r = openUrl("http://127.0.0.1:1/", opts);
    expect(r.kind).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("an unknown platform with a display falls through to failed", () => {
    const { opts } = harness({ platform: "freebsd" });
    expect(openUrl("http://127.0.0.1:1/", opts).kind).toBe("failed");
  });
});

describe("open-url — describeOpenResult", () => {
  it("returns null on success (nothing should print)", () => {
    const { opts } = harness({ platform: "darwin" });
    expect(describeOpenResult(openUrl("http://127.0.0.1:1/", opts))).toBeNull();
  });
});
