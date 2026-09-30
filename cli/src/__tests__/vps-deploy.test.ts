/**
 * vps-deploy.test.ts — BR-116 pure tier: the failure summarizer (AC-4) against
 * MEASURED npm bytes, the poll/pm2 parsers, the signal map, and the remote
 * scripts' syntax, bash-3.2 portability and quoting.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NPM_EBADENGINE_ONLY,
  NPM_EBADENGINE_THEN_ERROR,
} from "./fixtures/br116-npm-output.js";
import {
  buildLaunchCommand,
  buildPm2StatusCommand,
  buildPollCommand,
  buildPreflightCommand,
  buildRestartCommand,
  buildRestoreCommand,
  buildRunnerScript,
  buildTailCommand,
  isValidAppName,
  isValidRunId,
  newRunId,
  parsePm2Status,
  parseRunnerState,
  shellQuote,
  signalName,
  SMOKE_JS,
  summarizeRemoteFailure,
} from "../lib/sync/vps-deploy.js";

const ID = "20260930T120000Z-b116";
const REF = { logRef: "deploy@vps:/srv/igris/.igris-deploy/runs/x/log" };
const mark = (p: string) => `=== igris-deploy phase=${p} start 2026-09-30T12:00:00Z ===\n`;
const EBAD_LINES = NPM_EBADENGINE_ONLY.split("\n").filter((l) => l.startsWith("npm warn"));

describe("BR-116 AC-4 — summarizeRemoteFailure names npm's real failure", () => {
  it("P4a: measured EBADENGINE block + real `npm error` block (rc 1) → headline is the exit code, first quote is the first npm error line", () => {
    const out = summarizeRemoteFailure(mark("install") + NPM_EBADENGINE_THEN_ERROR, { kind: "finished", code: 1, phase: "install" }, REF);
    expect(out[0]).toBe("install failed — npm ci exited 1");
    expect(out[1]).toBe("  | npm error code EUSAGE");
    expect(out.some((l) => l.includes("Missing: left-pad@1.3.0 from lock file"))).toBe(true);
    const ebad = out.filter((l) => /EBADENGINE/.test(l));
    expect(ebad).toHaveLength(1);
    expect(ebad[0]).toMatch(/^\(5 EBADENGINE warning lines suppressed/);
    expect(out[out.length - 1]).toBe(`full log: ${REF.logRef}`);
  });

  it("P4b: the incident shape — measured warnings only, SYNTHETIC rc 1 → 'no error output', never an EBADENGINE headline", () => {
    expect(EBAD_LINES).toHaveLength(5);
    const out = summarizeRemoteFailure(mark("install") + EBAD_LINES.join("\n") + "\n", { kind: "finished", code: 1, phase: "install" }, { ...REF, vpsNode: "v20.20.0" });
    expect(out[0]).toBe("install failed — npm ci exited 1 with no error output (5 warning lines suppressed)");
    expect(out[0]).not.toMatch(/EBADENGINE/);
    expect(out.filter((l) => /EBADENGINE/.test(l))).toHaveLength(1);
    expect(out.join("\n")).toContain("VPS Node v20.20.0 is OUTSIDE");
  });

  it("P4c: rc > 128 is a signal death — 129 SIGHUP, 137 SIGKILL (possibly OOM)", () => {
    expect(summarizeRemoteFailure(mark("install"), { kind: "finished", code: 129, phase: "install" }, REF)[0]).toBe(
      "install failed — npm ci killed by SIGHUP (rc 129)",
    );
    expect(summarizeRemoteFailure(mark("install"), { kind: "finished", code: 137, phase: "install" }, REF)[0]).toBe(
      "install failed — npm ci killed by SIGKILL (rc 137), possibly the kernel OOM killer",
    );
  });

  it("P4d: a build failure with no npm error lines quotes the last 15 non-noise lines OF THE BUILD PHASE (synthetic tsc lines)", () => {
    const tsc = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts(1,1): error TS2322: synthetic ${i}`);
    const log = mark("install") + NPM_EBADENGINE_ONLY + mark("build") + "npm warn deprecated x\n" + tsc.join("\n") + "\n";
    const out = summarizeRemoteFailure(log, { kind: "finished", code: 2, phase: "build" }, REF);
    expect(out[0]).toBe("build failed — npm run build exited 2");
    const quoted = out.filter((l) => l.startsWith("  | "));
    expect(quoted).toEqual(tsc.slice(5).map((l) => `  | ${l}`));
    expect(out.join("\n")).not.toMatch(/EBADENGINE|up to date/);
  });

  it("a runner that died writes no rc → the headline says so", () => {
    expect(summarizeRemoteFailure(mark("install"), { kind: "died", phase: "install" }, REF)[0]).toBe(
      "runner died during install — no exit code recorded (killed externally?)",
    );
  });
});

describe("BR-116 poll + pm2 parsers", () => {
  it("U5: rc present → finished even when alive=0; no rc + alive=0 → died; alive=1 → running; garbage → unknown", () => {
    const fin = parseRunnerState("alive=0\nphase=done\nrc.code=0\nrc.phase=done\nrc.rolled_back=0\nrc.node=v22.1.0\nrc.install_s=41\n");
    expect(fin).toMatchObject({ kind: "finished", code: 0, phase: "done", node: "v22.1.0", installS: "41" });
    expect(parseRunnerState("alive=0\nphase=install\n")).toEqual({ kind: "died", phase: "install" });
    expect(parseRunnerState("alive=1\nphase=build\n")).toEqual({ kind: "running", phase: "build" });
    expect(parseRunnerState("ssh: banner only")).toEqual({ kind: "unknown" });
  });

  it("U6: parsePm2Status reads the filtered line after banners; found:false; error; malformed", () => {
    expect(parsePm2Status('[PM2] banner\n{"found":true,"status":"online","restarts":3,"node":"20.20.0"}\n')).toEqual({
      found: true,
      status: "online",
      restarts: 3,
      node: "20.20.0",
      error: null,
    });
    expect(parsePm2Status('{"found":false}').found).toBe(false);
    expect(parsePm2Status('{"error":"unparseable pm2 jlist"}').error).toBe("unparseable pm2 jlist");
    expect(parsePm2Status("{not json").error).toBe("malformed pm2 status output");
    expect(parsePm2Status("").error).toBe("no pm2 status output");
  });

  it("S-SEC: the pm2 filter runs on the VPS and emits ONLY the six keys — a planted secret never leaves, even on a parse error", () => {
    const jlist =
      '[PM2] Spawning PM2 daemon with pm2_home=/x\n[{"name":"igris-brain","pm2_env":{"status":"errored","restart_time":7,' +
      '"unstable_restarts":1,"node_version":"20.20.0","pm_uptime":1,"BRAIN_API_KEY":"sk-br116-canary"}}]\n';
    const run = (input: string) =>
      execFileSync("bash", ["-c", `pm2() { printf '%s' "$J"; }; ${buildPm2StatusCommand("igris-brain")}`], {
        encoding: "utf-8",
        env: { ...process.env, J: input },
        timeout: 10_000,
      });
    const good = run(jlist);
    expect(good).not.toContain("sk-br116-canary");
    expect(Object.keys(JSON.parse(good) as object).sort()).toEqual(["found", "node", "restarts", "status", "unstable", "uptime_ms"]);
    expect(parsePm2Status(good)).toMatchObject({ found: true, status: "errored", restarts: 7 });
    const broken = run(jlist.slice(0, jlist.indexOf("sk-br116") + 12));
    expect(broken).not.toContain("sk-br116");
    expect(JSON.parse(broken)).toEqual({ error: "unparseable pm2 jlist" });
  }, 20_000);

  it("signalName maps 128+N and nothing else", () => {
    expect(signalName(129)).toBe("SIGHUP");
    expect(signalName(137)).toBe("SIGKILL");
    expect(signalName(143)).toBe("SIGTERM");
    expect(signalName(128)).toBeNull();
    expect(signalName(1)).toBeNull();
  });
});

describe("BR-116 remote scripts — syntax, bash 3.2, quoting", () => {
  const HOSTILE = "/srv/my app'; rm -rf ~";
  const all = (repo: string) => [
    buildRunnerScript(repo, ID),
    buildPreflightCommand(repo),
    buildLaunchCommand(repo, ID),
    buildPollCommand(repo, ID),
    buildTailCommand(repo, ID),
    buildRestartCommand("igris-brain"),
    buildPm2StatusCommand("igris-brain"),
    buildRestoreCommand(repo, "igris-brain"),
  ];

  it("U7a: every script parses (`bash -n`), including with a hostile repo_path", () => {
    for (const s of [...all("/srv/igris"), ...all(HOSTILE)]) {
      execFileSync("bash", ["-n", "-c", s], { timeout: 10_000 });
    }
  }, 20_000);

  it("U7b: no bash-4 / GNU-only construct (the runner must run under bash 3.2 and BSD tools)", () => {
    const forbidden = [/\bmapfile\b/, /\breadarray\b/, /declare -A/, /\$\{[^}]*(,,|\^\^)/, /wait -n/, /\|&/, /&>>/, /mv -T/, /readlink -f/, /stat -c/, /(^|[;\s])timeout\s/];
    for (const s of all("/srv/igris")) {
      for (const re of forbidden) expect(s, `${re} in:\n${s}`).not.toMatch(re);
    }
  });

  it("U7c: a hostile repo_path appears only inside one single-quoted assignment", () => {
    const runner = buildRunnerScript(HOSTILE, ID);
    expect(runner.split("rm -rf ~").length - 1).toBe(1);
    expect(runner).toContain(`R=${shellQuote(HOSTILE)};`);
  });

  it("U7d: executed with an injection payload in repo_path, the read-only commands run nothing it names", () => {
    const dir = mkdtempSync(join(tmpdir(), "br116-quote-"));
    try {
      const pwned = join(dir, "PWNED");
      const repo = `${dir}/my app'; touch '${pwned}'; '`;
      for (const s of [buildPreflightCommand(repo), buildPollCommand(repo, ID), buildTailCommand(repo, ID)]) {
        try {
          execFileSync("bash", ["-c", s], { stdio: "ignore", timeout: 10_000 });
        } catch {
          // the path does not exist; only the payload matters
        }
      }
      expect(existsSync(pwned)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("N3: the poll reads `alive` BEFORE it reads `rc` (what makes 'died' trustworthy)", () => {
    const poll = buildPollCommand("/srv/igris", ID);
    expect(poll.indexOf("echo alive=1")).toBeGreaterThan(-1);
    expect(poll.indexOf("echo alive=1")).toBeLessThan(poll.indexOf('"$RUN/rc"'));
  });

  it("U7e: run ids and pm2 app names are validated before any interpolation", () => {
    expect(isValidRunId(newRunId())).toBe(true);
    for (const bad of ["x; rm -rf /", "../20260930T120000Z-b116", "20260930T120000Z-B116"]) {
      expect(isValidRunId(bad)).toBe(false);
      expect(() => buildRunnerScript("/r", bad)).toThrow(/invalid run id/);
    }
    for (const bad of ["x; rm -rf /", "../20260930T120000Z-b116"]) {
      expect(() => buildPollCommand("/r", bad)).toThrow(/invalid run id/);
      expect(() => buildTailCommand("/r", bad)).toThrow(/invalid run id/);
      expect(() => buildLaunchCommand("/r", bad)).toThrow(/invalid run id/);
    }
    for (const bad of ["igris brain", "a;b", "$(x)", ""]) {
      expect(isValidAppName(bad)).toBe(false);
      expect(() => buildRestartCommand(bad)).toThrow(/invalid pm2 app name/);
      expect(() => buildPm2StatusCommand(bad)).toThrow(/invalid pm2 app name/);
      expect(() => buildRestoreCommand("/r", bad)).toThrow(/invalid pm2 app name/);
    }
    expect(buildRestartCommand("igris-brain")).toContain("pm2 restart igris-brain");
  });

  it("the runner's order: install in the stage root, build in stage/brain-mcp-server, the smoke instantiates, and it precedes the swap", () => {
    const s = buildRunnerScript("/srv/igris", ID);
    const at = (needle: string) => {
      const i = s.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(SMOKE_JS).toContain('require("better-sqlite3")');
    expect(SMOKE_JS).toMatch(/new D\(":memory:"\)\.close\(\)/);
    expect(at('(cd "$D/stage" && npm ci')).toBeLessThan(at('(cd "$D/stage/brain-mcp-server" && npm run build)'));
    expect(at("npm run build")).toBeLessThan(at('smoke "$D/stage"'));
    expect(at('smoke "$D/stage"')).toBeLessThan(at("ph swap"));
    expect(at("ph swap")).toBeLessThan(at("ph smoke-live"));
    expect(s).toContain("--exclude=.igris-deploy/");
  });
});
