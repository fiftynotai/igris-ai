/**
 * onboarding.test.ts — FR-235 first-run onboarding state.
 *
 * Real fs against a sandboxed IGRIS_BRAIN_DIR. No mocks of the SUT (L-159): the
 * three init-config helpers and the `igris onboarding` verb all run for real.
 *
 * Coverage (maps to the FR-235 ACs):
 *   - readOnboardingState: absent / malformed / block-absent → first-run default;
 *     reads set flags.
 *   - setOnboardingWelcomed / setOnboardingComplete: stamp the nested flag,
 *     preserve siblings, degrade on a missing config (never throw).
 *   - the verb: status JSON shape (first_run = !completed) incl. the config-absent
 *     degrade; welcomed/complete transitions + exit 0; unknown action → exit 2.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function readCfg(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(tmpBrain, "config.json"), "utf-8"),
  ) as Record<string, unknown>;
}

/** Capture everything written to process.stdout during `fn`. */
async function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const buf: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      buf.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return buf.join("");
}

beforeEach(() => {
  tmpBrain = mkdtempSync(join(tmpdir(), "igris-onboarding-test-"));
  envBackup.IGRIS_BRAIN_DIR = process.env.IGRIS_BRAIN_DIR;
  process.env.IGRIS_BRAIN_DIR = tmpBrain;
});

afterEach(() => {
  rmSync(tmpBrain, { recursive: true, force: true });
  process.env.IGRIS_BRAIN_DIR = envBackup.IGRIS_BRAIN_DIR;
});

describe("init-config — readOnboardingState", () => {
  it("config.json absent → first-run default {completed:false, boot_welcomed:false}", async () => {
    const m = await import("../lib/init-config.js");
    expect(m.readOnboardingState()).toEqual({
      completed: false,
      boot_welcomed: false,
    });
  });

  it("malformed config.json → first-run default (no throw)", async () => {
    writeFileSync(join(tmpBrain, "config.json"), "{ not json");
    const m = await import("../lib/init-config.js");
    expect(m.readOnboardingState()).toEqual({
      completed: false,
      boot_welcomed: false,
    });
  });

  it("onboarding block absent → both false", async () => {
    writeConfig({ version: "7.1.0" });
    const m = await import("../lib/init-config.js");
    expect(m.readOnboardingState()).toEqual({
      completed: false,
      boot_welcomed: false,
    });
  });

  it("reads the set flags verbatim", async () => {
    writeConfig({ onboarding: { completed: true, boot_welcomed: true } });
    const m = await import("../lib/init-config.js");
    expect(m.readOnboardingState()).toEqual({
      completed: true,
      boot_welcomed: true,
    });
  });
});

describe("init-config — setOnboardingWelcomed / setOnboardingComplete", () => {
  it("setOnboardingWelcomed stamps boot_welcomed=true, leaves completed absent, preserves siblings", async () => {
    writeConfig({
      version: "7.1.0",
      cognition: { perception: { enabled: false } },
    });
    const m = await import("../lib/init-config.js");
    expect(m.setOnboardingWelcomed()).toBe("written");

    const cfg = readCfg() as {
      version?: string;
      cognition?: { perception?: { enabled?: boolean } };
      onboarding?: { boot_welcomed?: boolean; completed?: boolean };
    };
    expect(cfg.onboarding?.boot_welcomed).toBe(true);
    expect(cfg.onboarding?.completed).toBeUndefined();
    // Siblings preserved.
    expect(cfg.version).toBe("7.1.0");
    expect(cfg.cognition?.perception?.enabled).toBe(false);
  });

  it("setOnboardingComplete stamps completed=true, preserves an existing boot_welcomed", async () => {
    writeConfig({ onboarding: { boot_welcomed: true } });
    const m = await import("../lib/init-config.js");
    expect(m.setOnboardingComplete()).toBe("written");

    const cfg = readCfg() as {
      onboarding?: { boot_welcomed?: boolean; completed?: boolean };
    };
    expect(cfg.onboarding?.completed).toBe(true);
    expect(cfg.onboarding?.boot_welcomed).toBe(true);
  });

  it("setters on an absent config → config_missing (no throw, no file created)", async () => {
    const m = await import("../lib/init-config.js");
    expect(m.setOnboardingWelcomed()).toBe("config_missing");
    expect(m.setOnboardingComplete()).toBe("config_missing");
    expect(existsSync(join(tmpBrain, "config.json"))).toBe(false);
  });

  it("is idempotent — re-stamping a set flag re-writes the same value", async () => {
    writeConfig({ onboarding: { completed: true } });
    const m = await import("../lib/init-config.js");
    expect(m.setOnboardingComplete()).toBe("written");
    expect(
      (readCfg() as { onboarding?: { completed?: boolean } }).onboarding
        ?.completed,
    ).toBe(true);
  });
});

describe("onboarding verb — status", () => {
  it("config absent → degrades to {completed:false, boot_welcomed:false, first_run:true}, exit 0", async () => {
    const { runOnboarding } = await import("../verbs/onboarding.js");
    let code = -1;
    const out = await captureStdout(() => {
      code = runOnboarding("status", { json: true });
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.trim())).toEqual({
      completed: false,
      boot_welcomed: false,
      first_run: true,
    });
  });

  it("completed=true → first_run:false", async () => {
    writeConfig({ onboarding: { completed: true, boot_welcomed: true } });
    const { runOnboarding } = await import("../verbs/onboarding.js");
    let code = -1;
    const out = await captureStdout(() => {
      code = runOnboarding("status", { json: true });
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.trim())).toEqual({
      completed: true,
      boot_welcomed: true,
      first_run: false,
    });
  });
});

describe("onboarding verb — welcomed / complete transitions", () => {
  it("welcomed stamps boot_welcomed and exits 0", async () => {
    writeConfig({ version: "7.1.0" });
    const { runOnboarding } = await import("../verbs/onboarding.js");
    expect(runOnboarding("welcomed", { json: true })).toBe(0);
    expect(
      (readCfg() as { onboarding?: { boot_welcomed?: boolean } }).onboarding
        ?.boot_welcomed,
    ).toBe(true);
  });

  it("complete stamps completed and exits 0", async () => {
    writeConfig({ version: "7.1.0" });
    const { runOnboarding } = await import("../verbs/onboarding.js");
    expect(runOnboarding("complete", { json: true })).toBe(0);
    expect(
      (readCfg() as { onboarding?: { completed?: boolean } }).onboarding
        ?.completed,
    ).toBe(true);
  });

  it("welcomed/complete on an absent config exit 0 (idempotent, never throw)", async () => {
    const { runOnboarding } = await import("../verbs/onboarding.js");
    expect(runOnboarding("welcomed", { json: true })).toBe(0);
    expect(runOnboarding("complete", { json: true })).toBe(0);
  });

  it("a full status → welcomed → status → complete → status flow tracks state", async () => {
    writeConfig({ version: "7.1.0" });
    const { runOnboarding } = await import("../verbs/onboarding.js");

    const s1 = JSON.parse(
      (await captureStdout(() => void runOnboarding("status"))).trim(),
    );
    expect(s1).toMatchObject({ first_run: true, boot_welcomed: false });

    runOnboarding("welcomed");
    const s2 = JSON.parse(
      (await captureStdout(() => void runOnboarding("status"))).trim(),
    );
    expect(s2).toMatchObject({ first_run: true, boot_welcomed: true });

    runOnboarding("complete");
    const s3 = JSON.parse(
      (await captureStdout(() => void runOnboarding("status"))).trim(),
    );
    expect(s3).toMatchObject({ first_run: false, completed: true });
  });
});

describe("onboarding verb — unknown action", () => {
  it("returns exit 2", async () => {
    const { runOnboarding } = await import("../verbs/onboarding.js");
    expect(runOnboarding("bogus", { json: true })).toBe(2);
  });
});
