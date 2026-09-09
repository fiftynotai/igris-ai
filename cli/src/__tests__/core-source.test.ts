/**
 * core-source — the ONE resolver `init --upgrade` and `refresh` share
 * (BR-103). The precedence matrix, switch detection and the missing-checkout
 * refusal. No network: every network-facing path is a seam
 * (`latestReleaseTagFn` / `classifyFn`) that THROWS when reached
 * unexpectedly, so "no network" is asserted, not assumed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallSource } from "../types.js";

let work: string;
let checkout: string;

const NO_NETWORK = {
  latestReleaseTagFn: (): Promise<string> => {
    throw new Error("latestReleaseTagFn reached — the network was NOT supposed to be needed");
  },
  classifyFn: (): Promise<"tag" | "branch" | "none"> => {
    throw new Error("classifyFn reached — the network was NOT supposed to be needed");
  },
};

function fromSourceRecord(path: string | null): InstallSource {
  return {
    schema_version: 1,
    channel: "main",
    ref: "from-source",
    fetched_at: "2026-09-07T00:00:00.000Z",
    content_sha256: "from-source-fixture",
    source: "from-source",
    source_path: path,
  };
}

function githubRecord(channel: InstallSource["channel"], ref: string): InstallSource {
  return {
    schema_version: 1,
    channel,
    ref,
    fetched_at: "2026-09-07T00:00:00.000Z",
    content_sha256: "e12ac298",
    source: "github",
    source_path: null,
  };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "igris-core-source-"));
  checkout = join(work, "checkout");
  mkdirSync(join(checkout, "core"), { recursive: true });
  writeFileSync(join(checkout, "core", "SOUL.md"), "# soul\n");
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("resolveCoreSource — precedence (BR-103)", () => {
  it("explicit --from-source wins over --channel and the record; no network", async () => {
    const { resolveCoreSource } = await import("../lib/core-source.js");
    const r = await resolveCoreSource({
      fromSource: checkout,
      channel: "main",
      installSrc: githubRecord("release", "v7.2.0"),
      yes: true,
      ...NO_NETWORK,
    });
    expect(r.outcome).toBe("resolved");
    if (r.outcome !== "resolved") return;
    expect(r.source).toEqual({ kind: "from-source", path: checkout });
    expect(r.requestedFlag).toBe("from-source");
    expect(r.recordedFlag).toBe("v7.2.0");
    expect(r.switched).toBe(true);
  });

  it("explicit --channel main wins over a from-source record (a switch)", async () => {
    const { resolveCoreSource } = await import("../lib/core-source.js");
    const r = await resolveCoreSource({
      channel: "main",
      installSrc: fromSourceRecord(checkout),
      yes: true,
      ...NO_NETWORK,
    });
    expect(r.outcome).toBe("resolved");
    if (r.outcome !== "resolved") return;
    expect(r.source.kind).toBe("channel");
    if (r.source.kind !== "channel") return;
    expect(r.source.channelKind).toBe("main");
    expect(r.source.ref).toBe("main");
    expect(r.recordedFlag).toBe("from-source");
    expect(r.switched).toBe(true);
  });

  it("a from-source record with a live checkout re-resolves to THAT checkout — no switch, no network (the incident's shape)", async () => {
    const { resolveCoreSource } = await import("../lib/core-source.js");
    const r = await resolveCoreSource({
      installSrc: fromSourceRecord(checkout),
      yes: false,
      confirmFn: () => {
        throw new Error("confirmFn reached — there was no switch to confirm");
      },
      ...NO_NETWORK,
    });
    expect(r.outcome).toBe("resolved");
    if (r.outcome !== "resolved") return;
    expect(r.source).toEqual({ kind: "from-source", path: checkout });
    expect(r.switched).toBe(false);
  });

  it("a from-source record whose checkout is gone throws CoreSourceError naming the path", async () => {
    const { resolveCoreSource, CoreSourceError } = await import("../lib/core-source.js");
    const gone = join(work, "moved-away");
    await expect(
      resolveCoreSource({ installSrc: fromSourceRecord(gone), yes: true, ...NO_NETWORK }),
    ).rejects.toThrow(CoreSourceError);
    await expect(
      resolveCoreSource({ installSrc: fromSourceRecord(gone), yes: true, ...NO_NETWORK }),
    ).rejects.toThrow(gone);
    await expect(
      resolveCoreSource({ installSrc: fromSourceRecord(null), yes: true, ...NO_NETWORK }),
    ).rejects.toThrow(CoreSourceError);
  });

  it("a release record re-resolves the SAME tag (classified, not the latest) — no switch", async () => {
    const { resolveCoreSource } = await import("../lib/core-source.js");
    const classified: string[] = [];
    const r = await resolveCoreSource({
      installSrc: githubRecord("release", "v7.2.0"),
      yes: false,
      confirmFn: () => {
        throw new Error("confirmFn reached — there was no switch to confirm");
      },
      latestReleaseTagFn: NO_NETWORK.latestReleaseTagFn,
      classifyFn: (ref) => {
        classified.push(ref);
        return Promise.resolve("tag");
      },
    });
    expect(classified).toEqual(["v7.2.0"]);
    expect(r.outcome).toBe("resolved");
    if (r.outcome !== "resolved") return;
    expect(r.source.kind).toBe("channel");
    if (r.source.kind !== "channel") return;
    expect(r.source.ref).toBe("v7.2.0");
    expect(r.source.channelKind).toBe("tag");
    expect(r.requestedFlag).toBe("v7.2.0");
    expect(r.recordedFlag).toBe("v7.2.0");
    expect(r.switched).toBe(false);
  });

  it("a main record re-resolves main; a branch record re-resolves that branch", async () => {
    const { resolveCoreSource } = await import("../lib/core-source.js");
    const main = await resolveCoreSource({
      installSrc: githubRecord("main", "main"),
      yes: true,
      ...NO_NETWORK,
    });
    expect(main.outcome === "resolved" && main.source.kind === "channel" && main.source.ref).toBe("main");
    const branch = await resolveCoreSource({
      installSrc: githubRecord("branch", "develop"),
      yes: true,
      latestReleaseTagFn: NO_NETWORK.latestReleaseTagFn,
      classifyFn: () => Promise.resolve("branch"),
    });
    expect(branch.outcome === "resolved" && branch.source.kind === "channel" && branch.source.channelKind).toBe("branch");
    expect(branch.outcome === "resolved" && branch.switched).toBe(false);
  });

  it("no record and no flags → the latest release (the only path that asks for it); recordedFlag null, not a switch", async () => {
    const { resolveCoreSource } = await import("../lib/core-source.js");
    const r = await resolveCoreSource({
      installSrc: null,
      yes: false,
      confirmFn: () => {
        throw new Error("confirmFn reached — nothing recorded, nothing to switch from");
      },
      latestReleaseTagFn: () => Promise.resolve("v9.9.9-fixture"),
      classifyFn: NO_NETWORK.classifyFn,
    });
    expect(r.outcome).toBe("resolved");
    if (r.outcome !== "resolved") return;
    expect(r.source).toEqual({
      kind: "channel",
      channelKind: "release",
      ref: "v9.9.9-fixture",
      tarballUrl: expect.stringContaining("refs/tags/v9.9.9-fixture.tar.gz"),
    });
    expect(r.recordedFlag).toBeNull();
    expect(r.switched).toBe(false);
  });
});

describe("resolveCoreSource — the switch prompt (BR-103)", () => {
  it("a switch without --yes asks confirmFn with the from/to names; declining yields `declined`", async () => {
    const { resolveCoreSource } = await import("../lib/core-source.js");
    let prompt = "";
    const r = await resolveCoreSource({
      channel: "main",
      installSrc: fromSourceRecord(checkout),
      yes: false,
      confirmFn: (p) => {
        prompt = p;
        return false;
      },
      ...NO_NETWORK,
    });
    expect(prompt).toContain("from from-source to main");
    expect(prompt).toContain("replace ~/.igris/core/");
    expect(r).toEqual({ outcome: "declined", requestedFlag: "main", recordedFlag: "from-source" });
  });

  it("--yes accepts a switch without calling confirmFn", async () => {
    const { resolveCoreSource } = await import("../lib/core-source.js");
    let asked = 0;
    const r = await resolveCoreSource({
      fromSource: checkout,
      installSrc: githubRecord("main", "main"),
      yes: true,
      confirmFn: () => {
        asked++;
        return false;
      },
      ...NO_NETWORK,
    });
    expect(asked).toBe(0);
    expect(r.outcome).toBe("resolved");
    expect(r.outcome === "resolved" && r.switched).toBe(true);
  });
});

describe("recordedChannelToFlag / recordedFlagFromInstallSource", () => {
  it("main → main; release/tag/branch → the ref verbatim; a from-source ref → from-source", async () => {
    const { recordedChannelToFlag, recordedFlagFromInstallSource, recordIsFromSource } =
      await import("../lib/core-source.js");
    expect(recordedChannelToFlag("main", "main")).toBe("main");
    expect(recordedChannelToFlag("release", "v7.2.0")).toBe("v7.2.0");
    expect(recordedChannelToFlag("tag", "v7.1.0")).toBe("v7.1.0");
    expect(recordedChannelToFlag("branch", "develop")).toBe("develop");
    expect(recordedFlagFromInstallSource("main", "from-source")).toBe("from-source");
    expect(recordedFlagFromInstallSource("release", "v7.2.0")).toBe("v7.2.0");
    expect(recordIsFromSource(fromSourceRecord(checkout))).toBe(true);
    expect(recordIsFromSource(githubRecord("release", "v7.2.0"))).toBe(false);
    expect(recordIsFromSource(null)).toBe(false);
  });
});
