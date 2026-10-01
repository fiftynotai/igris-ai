/**
 * vps-deploy.test.ts — BR-116 pure tier: the failure summarizer (AC-4) against
 * MEASURED npm bytes, the poll/pm2 parsers, the signal map, and the remote
 * scripts' syntax, bash-3.2 portability and quoting.
 */

import { afterAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  buildForceInstallCommand,
  buildPreflightCommand,
  buildRestartCommand,
  buildRestoreCommand,
  buildRunnerScript,
  buildTailCommand,
  FP_JS,
  INSTALL_FP_FILE,
  isValidAppName,
  isValidRunId,
  newRunId,
  parsePm2Status,
  parseRunnerState,
  REUSE_EXCLUDES,
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

/*
 * TD-487 — the install fingerprint (FP_JS) and the runner's reuse branch.
 * FP_JS runs as `node -e FP_JS <node --version> <npm --version>` in the stage.
 */
describe("TD-487 install fingerprint", () => {
  const FILES: Record<string, string> = {
    "package.json": '{"name":"igris-ai","workspaces":["brain-mcp-server","cli"]}\n',
    "package-lock.json": '{"lockfileVersion":3}\n',
    "brain-mcp-server/package.json": '{"name":"igris-brain-mcp-server"}\n',
    "cli/package.json": '{"name":"igris-ai"}\n',
    "README.md": "# r\n",
    "brain-mcp-server/src/x.ts": "export const x = 1;\n",
    "cli/src/y.ts": "export const y = 1;\n",
  };
  const dirs: string[] = [];
  /** A fresh fixture; `edit` overrides (string) or deletes (null) files. */
  const fixture = (edit: Record<string, string | null> = {}): string => {
    const dir = mkdtempSync(join(tmpdir(), "td487-fp-"));
    dirs.push(dir);
    for (const [rel, body] of Object.entries({ ...FILES, ...edit })) {
      if (body === null) continue;
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), body);
    }
    return dir;
  };
  const fp = (dir: string, node = "v22.23.3", npm = "10.9.8"): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath, ["-e", FP_JS, node, npm], { cwd: dir, encoding: "utf-8", timeout: 10_000 });
    return { status: r.status, out: r.stdout };
  };
  const base = (): string => fp(fixture()).out.trim();

  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("F1: `v1-<sha256>`, stable across runs and fixtures", () => {
    const a = fp(fixture());
    expect(a.status).toBe(0);
    expect(a.out.trim()).toMatch(/^v1-[0-9a-f]{64}$/);
    expect(fp(fixture()).out).toBe(a.out);
  }, 20_000);

  it("F2: every install input moves the hash — lockfile, root + each workspace manifest, node, npm, .npmrc", () => {
    const b = base();
    const moved: Record<string, string> = {
      "package-lock.json": fp(fixture({ "package-lock.json": FILES["package-lock.json"] + " " })).out.trim(),
      "package.json": fp(fixture({ "package.json": FILES["package.json"] + " " })).out.trim(),
      "brain-mcp-server/package.json": fp(fixture({ "brain-mcp-server/package.json": FILES["brain-mcp-server/package.json"] + " " })).out.trim(),
      "cli/package.json (L-965)": fp(fixture({ "cli/package.json": '{"name":"igris-ai","dependencies":{"left-pad":"1.3.0"}}\n' })).out.trim(),
      "node version": fp(fixture(), "v22.23.4").out.trim(),
      "npm version": fp(fixture(), "v22.23.3", "10.9.9").out.trim(),
      ".npmrc created": fp(fixture({ ".npmrc": "legacy-peer-deps=true\n" })).out.trim(),
    };
    for (const [input, h] of Object.entries(moved)) {
      expect(h, input).toMatch(/^v1-[0-9a-f]{64}$/);
      expect(h, `${input} did not move the fingerprint`).not.toBe(b);
    }
    expect(new Set(Object.values(moved)).size).toBe(Object.keys(moved).length);
  }, 30_000);

  it("F3: non-inputs keep the hash — README, brain src, cli src (a deploy that changes only code reuses)", () => {
    const b = base();
    expect(fp(fixture({ "README.md": "# changed\n" })).out.trim(), "README.md").toBe(b);
    expect(fp(fixture({ "brain-mcp-server/src/x.ts": "export const x = 2;\n" })).out.trim(), "brain src").toBe(b);
    expect(fp(fixture({ "cli/src/y.ts": "export const y = 2;\n" })).out.trim(), "cli src").toBe(b);
  }, 20_000);

  it("F4: fails CLOSED (empty stdout, non-zero) on any doubt — the runner then runs npm ci", () => {
    const cases: Array<[string, { status: number | null; out: string }]> = [
      ["missing lockfile", fp(fixture({ "package-lock.json": null }))],
      ["missing workspace manifest", fp(fixture({ "cli/package.json": null }))],
      ["glob workspace", fp(fixture({ "package.json": '{"workspaces":["packages/*"]}' }))],
      ["`..` workspace", fp(fixture({ "package.json": '{"workspaces":["../x"]}' }))],
      ["object-form workspaces", fp(fixture({ "package.json": '{"workspaces":{"packages":["cli"]}}' }))],
      ["unparseable package.json", fp(fixture({ "package.json": "{not json" }))],
      ["empty npm version", fp(fixture(), "v22.23.3", "")],
      ["empty node version", fp(fixture(), "", "10.9.8")],
    ];
    for (const [name, r] of cases) {
      expect(r.out, name).toBe("");
      expect(r.status, name).not.toBe(0);
    }
  }, 30_000);

  it("F5: runner order — fingerprint after the stage copy, reuse/install before the build, the marker written only after smoke-live; restore text unchanged", () => {
    const s = buildRunnerScript("/srv/igris", ID);
    const at = (needle: string, from = 0): number => {
      const i = s.indexOf(needle, from);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      "ph stage",
      'node -e "$FPJS"',
      "ph reuse",
      'reuse "$D/stage"',
      "ph install",
      "ph build",
      "ph smoke-stage",
      "ph swap",
      "ph smoke-live",
      'mv -f "$R/$FPF.tmp" "$R/$FPF"',
      "ph done",
    ];
    for (let i = 1; i < order.length; i += 1) {
      expect(at(order[i - 1]), `${order[i - 1]} < ${order[i]}`).toBeLessThan(at(order[i]));
    }
    // The marker write sits AFTER the rollback branch closes (only a passing live smoke reaches it).
    expect(at('mv -f "$R/$FPF.tmp"')).toBeGreaterThan(at("  die $c\nfi"));
    const fin = s.slice(at("fin() {"), at("}\n", at("fin() {")));
    expect(fin.indexOf("install=$INST")).toBeGreaterThan(-1);
    expect(fin.indexOf('echo "install_why=$WHY"')).toBeLessThan(fin.indexOf("mv -f"));
    expect(s).toContain(`FPF=${INSTALL_FP_FILE}`);
    expect(INSTALL_FP_FILE).toBe("node_modules/.igris-install-fp");
    for (const x of REUSE_EXCLUDES) expect(s).toContain(`--exclude=${x}`);
    expect(s).toContain("-type l -lname '/*'");
    // RESTORE_SH is untouched by TD-487: the printed text is byte-identical to HEAD d6f8ef3's.
    expect(buildRestoreCommand("/srv/igris", "igris-brain")).toBe(
      "cd '/srv/igris'/.igris-deploy && { h() { [ -e \"$1\" ] || [ -L \"$1\" ]; }; ok=1; for rel in node_modules brain-mcp-server/node_modules cli/node_modules brain-mcp-server/dist; do if h \"prev/$rel\" || { grep -Fqx \"stage->live $rel\" journal 2>/dev/null && ! h \"failed/$rel\"; }; then if h \"../$rel\"; then mkdir -p \"$(dirname \"failed/$rel\")\" && mv \"../$rel\" \"failed/$rel\" || { ok=0; continue; }; fi; if h \"prev/$rel\"; then mv \"prev/$rel\" \"../$rel\" || ok=0; fi; fi; done; [ $ok -eq 1 ]; } && rm -f swap.inprogress && pm2 restart igris-brain",
    );
  });

  it("F6: parseRunnerState reads rc.install / rc.install_why; an older runner's rc gives \"\"", () => {
    expect(parseRunnerState("alive=0\nrc.code=0\nrc.phase=done\nrc.install=skipped\nrc.install_why=\n")).toMatchObject({
      kind: "finished",
      install: "skipped",
      installWhy: "",
    });
    expect(parseRunnerState("rc.code=0\nrc.phase=done\nrc.install=ran\nrc.install_why=changed\n")).toMatchObject({
      install: "ran",
      installWhy: "changed",
    });
    expect(parseRunnerState("rc.code=0\nrc.phase=done\n")).toMatchObject({ install: "", installWhy: "" });
  });

  it("F7: buildForceInstallCommand parses, passes the bash-3.2 lint, deletes exactly the marker, and runs nothing an injected repo_path names", () => {
    const HOSTILE = "/srv/my app'; rm -rf ~";
    const forbidden = [/\bmapfile\b/, /declare -A/, /\|&/, /&>>/, /readlink -f/, /stat -c/, /(^|[;\s])timeout\s/];
    for (const repo of ["/srv/igris", HOSTILE]) {
      const c = buildForceInstallCommand(repo);
      execFileSync("bash", ["-n", "-c", c], { timeout: 10_000 });
      for (const re of forbidden) expect(c).not.toMatch(re);
    }
    expect(buildForceInstallCommand(HOSTILE).split("rm -rf ~").length - 1).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), "td487-force-"));
    try {
      const repo = join(dir, "my repo");
      mkdirSync(join(repo, "node_modules", "x"), { recursive: true });
      writeFileSync(join(repo, INSTALL_FP_FILE), "v1-old\n");
      execFileSync("bash", ["-c", buildForceInstallCommand(repo)], { timeout: 10_000 });
      expect(existsSync(join(repo, INSTALL_FP_FILE))).toBe(false);
      expect(existsSync(join(repo, "node_modules", "x"))).toBe(true); // only the marker
      const pwned = join(dir, "PWNED");
      try {
        execFileSync("bash", ["-c", buildForceInstallCommand(`${dir}/my app'; touch '${pwned}'; '`)], { stdio: "ignore", timeout: 10_000 });
      } catch {
        // only the payload matters
      }
      expect(existsSync(pwned)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
