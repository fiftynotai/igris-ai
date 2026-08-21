/**
 * harness-spawn-containment.test.ts — TD-408, the bash half.
 *
 * `resolveAdapterInvocation` builds `["--project-root", opts.projectRoot ??
 * process.cwd()]` and hands it to `compile_harnesses.sh` /
 * `check_harness_drift.sh`, which write under that root — `harness-manifest.json`,
 * `.claude/settings.json` and `CLAUDE.md` are all tracked at this repo root.
 * The write happens in bash, so `IGRIS_REPO_DIR` cannot reach it; the refusal is
 * therefore in the TS wrapper, before the spawn.
 *
 * The real adapters are NEVER run here. TD-388: `compile_harnesses.sh` rewrites
 * `~/.claude.json`, which live sessions depend on. A STAND-IN script is planted
 * under a sandboxed `brainRoot` instead — it takes `--project-root` and writes
 * a settings file under it, which is the only property of the real adapters this
 * seam is about. Whether the escape is real at the REAL root is established
 * separately, by asserting the constructed argv, which spawns nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const ENV_KEYS = ["IGRIS_BRAIN_DIR", "IGRIS_REPO_DIR", "VITEST", "NODE_ENV"];

/**
 * Stands in for `check_harness_drift.sh`: parses `--project-root` the same way
 * and writes one file under it. Deliberately minimal — the seam is about WHERE
 * the adapter writes, not what it writes.
 */
const STAND_IN = `#!/usr/bin/env bash
root=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project-root) root="$2"; shift 2 ;;
    *) shift ;;
  esac
done
mkdir -p "$root/.claude"
printf 'written-by-the-adapter\\n' > "$root/.claude/settings.json"
echo "OK    probe -> $root"
`;

let workDir: string;
let brainRoot: string;
let checkout: string;
let startCwd: string;
const envBackup: Record<string, string | undefined> = {};

function adapterTarget(): string {
  return join(checkout, ".claude", "settings.json");
}

beforeEach(() => {
  for (const k of ENV_KEYS) envBackup[k] = process.env[k];
  startCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), "td408spawn-"));
  brainRoot = join(workDir, "brain");
  checkout = join(workDir, "checkout");
  mkdirSync(checkout, { recursive: true });
  const adapters = join(brainRoot, "core", "scripts", "cli-adapters");
  mkdirSync(adapters, { recursive: true });
  const script = join(adapters, "check_harness_drift.sh");
  writeFileSync(script, STAND_IN);
  chmodSync(script, 0o755);
  process.env.IGRIS_BRAIN_DIR = brainRoot;
  delete process.env.IGRIS_REPO_DIR;
});

afterEach(() => {
  process.chdir(startCwd);
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe("TD-408 — the adapter spawn is refused when its root is uncontained", () => {
  it("ARM: the stand-in really does write under --project-root (else every arm below is vacuous)", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync(
      "bash",
      [
        join(brainRoot, "core", "scripts", "cli-adapters", "check_harness_drift.sh"),
        "--project-root",
        checkout,
      ],
      { stdio: "ignore" },
    );
    expect(readFileSync(adapterTarget(), "utf-8")).toContain(
      "written-by-the-adapter",
    );
  });

  it("refuses the DEFAULT (spawning) runner with a cwd-derived root, and nothing is written", async () => {
    rmSync(adapterTarget(), { force: true });
    const { runHarness } = await import("../verbs/harness.js");
    process.chdir(checkout);

    const code = await runHarness({ action: "check" });

    // FILE first: at HEAD this is the assertion that reds, and it reds because
    // bash ran and wrote. Asserting the exit code first would short-circuit and
    // report a number instead of the write.
    expect(existsSync(adapterTarget())).toBe(false);
    expect(code).toBe(1);
  });

  it("SPAWNS and writes once IGRIS_REPO_DIR declares that root — the refusal is not a blanket break", async () => {
    rmSync(adapterTarget(), { force: true });
    process.env.IGRIS_REPO_DIR = checkout;
    const { runHarness } = await import("../verbs/harness.js");
    process.chdir(checkout);

    const code = await runHarness({ action: "check" });

    expect(code).toBe(0);
    expect(readFileSync(adapterTarget(), "utf-8")).toContain(
      "written-by-the-adapter",
    );
  });

  it("PRODUCTION: no env and no test context spawns exactly as before", async () => {
    rmSync(adapterTarget(), { force: true });
    delete process.env.IGRIS_REPO_DIR;
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    const { runHarness } = await import("../verbs/harness.js");
    process.chdir(checkout);

    const code = await runHarness({ action: "check" });

    expect(code).toBe(0);
    expect(readFileSync(adapterTarget(), "utf-8")).toContain(
      "written-by-the-adapter",
    );
  });

  it("the structured path is guarded too, and reports the refusal as its output", async () => {
    rmSync(adapterTarget(), { force: true });
    const { runHarnessStructured } = await import("../verbs/harness.js");
    process.chdir(checkout);

    const result = await runHarnessStructured({ action: "check" });

    expect(existsSync(adapterTarget())).toBe(false);
    expect(result.code).toBe(1);
    expect(result.output).toContain("refusing to run the adapter");
  });

  it("an INJECTED runner is unaffected — it creates no subprocess, so there is nothing to contain", async () => {
    const seen: string[][] = [];
    const { runHarness } = await import("../verbs/harness.js");

    const code = await runHarness({
      action: "check",
      projectRoot: "/proj",
      runAdapter: (_script, args) => {
        seen.push(args);
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(seen[0]).toEqual(["--project-root", "/proj"]);
  });
});

describe("TD-408 — what the default runner WOULD hand bash at the real checkout", () => {
  it("the constructed argv carries the real repo root when cwd is the real checkout", async () => {
    // Spawns nothing: the injected runner captures the exact vector the default
    // runner would have passed to `bash check_harness_drift.sh`. This is what
    // makes the sandboxed arms above evidence about the REAL hazard, without
    // ever pointing an adapter at the operator's checkout.
    const seen: string[][] = [];
    const { runHarness } = await import("../verbs/harness.js");
    process.chdir(REPO_ROOT);

    await runHarness({
      action: "check",
      runAdapter: (_script, args) => {
        seen.push(args);
        return 0;
      },
    });

    expect(seen[0][0]).toBe("--project-root");
    expect(resolve(seen[0][1])).toBe(resolve(REPO_ROOT));
  });
});
