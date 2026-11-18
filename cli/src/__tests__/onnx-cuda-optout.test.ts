/**
 * onnx-cuda-optout.test.ts — BR-119: every install of the brain tree sets
 * `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` in its OWN spawn environment.
 *
 * WHY. onnxruntime-node 1.21.0 (pinned by @huggingface/transformers) runs a
 * postinstall, `script/install.js`. On Linux x64 it downloads the CUDA build
 * from a GitHub release URL that now answers 404, and the 404 THROWS inside
 * the `https.get` callback, so `npm ci` / `npm install` fails (CI run
 * 44258412602 on ca9fe3f). `skip` is the upstream opt-out. install.js reads it
 * from this env var FIRST (`parseInstallCudaFlag`, install.js:172-198) and
 * exits before any `nvcc` probe or network call. The value must be exactly
 * the lowercase word: any other word throws. Igris never uses the CUDA EP
 * (`brain-mcp-server/src/utils/embeddings.ts` passes no `device`).
 *
 * WHAT THIS FILE PINS (the other paths: V1 in vps-deploy.test.ts, V2 in
 * sync-code-remote.test.ts, O1-O3 in the brain's onnx-cpu-runtime.test.ts):
 *   P1-P3  `cli/scripts/postinstall.mjs`, the consumer install (path 4), run
 *          from a VERBATIM scratch copy against an `npm` PATH stub. The key is
 *          set AFTER the BR-075 `npm_config_*` strip, so P1 also carries the
 *          first regression guard that strip ever had.
 *   C1-C3  `cli/scripts/copy-templates.sh`, the vendor install every
 *          `npm run build` runs (path 1b), from a VERBATIM scratch copy of the
 *          script on a scratch tree built from its real preconditions.
 *   S1     a source census: the workflow-level `env:` of both workflows
 *          (paths 1a, 2, 3) and the inline prefix on every install line of
 *          `copy-templates.sh` and `scripts/igris_brain_deploy.sh` (path 6).
 *
 * HARNESS RULES (test_standards, TD-471):
 *   - PATH is REPLACED, never prepended: `<stub bin>:<node's dir>:/usr/bin:/bin`.
 *     Node's own dir holds a REAL npm, so `command -v npm` is asserted to be
 *     the stub before any case runs.
 *   - The child env is built from scratch, never a spread of `process.env`:
 *     an operator shell that exports the opt-out would mask every red.
 *   - The stub records env NAMES through `awk` ENVIRON, never `env`. The
 *     opt-out's VALUE is recorded because it is not a credential.
 *   - Every spawn carries its own `timeout` (TD-336).
 *
 * SAFETY. The real copy-templates.sh `rm -rf`s `cli/dist/brain-mcp-server`.
 * It derives ROOT from its own location, so a copy only ever touches the
 * scratch tree. C1-C3 assert the executed path is under the scratch dir, and
 * witness the real `cli/dist/brain-mcp-server` mtime as unchanged.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const OPT = "ONNXRUNTIME_NODE_INSTALL_CUDA";
const POSTINSTALL_TIMEOUT_MS = 20_000;
const COPY_TEMPLATES_TIMEOUT_MS = 30_000;

/*
 * The `npm` stub. One line per call in `calls`; the LAST call's argv (one
 * token per line), opt-out value and npm_config_* NAMES. `ci`/`install` exit
 * 1 when BR119_FAIL is set; otherwise they lay down the two packages the
 * callers' post-install checks look for (copy-templates' sdk dir and its
 * `import.meta.resolve` of transformers; postinstall's sdk dir).
 */
const NPM_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$BR119_REC/calls"
: > "$BR119_REC/argv"
for a in "$@"; do printf '%s\\n' "$a" >> "$BR119_REC/argv"; done
printf '%s\\n' "\${ONNXRUNTIME_NODE_INSTALL_CUDA-<unset>}" > "$BR119_REC/cuda"
awk 'BEGIN { for (k in ENVIRON) if (tolower(k) ~ /^npm_config_/) print k }' > "$BR119_REC/npm-config-names"
case "$1" in
  ci|install)
    [ -n "\${BR119_FAIL:-}" ] && exit 1
    mkdir -p node_modules/@modelcontextprotocol/sdk node_modules/@huggingface/transformers || exit 1
    printf '%s\\n' '{"name":"@huggingface/transformers","main":"index.js"}' > node_modules/@huggingface/transformers/package.json
    : > node_modules/@huggingface/transformers/index.js
    ;;
esac
exit 0
`;

let T: string;
let BIN: string;
let STUB_PATH: string;
let caseN = 0;

interface Recording {
  calls: string[];
  argv: string[];
  cuda: string;
  npmConfigNames: string[];
}

function newRec(): string {
  caseN += 1;
  const rec = join(T, `rec-${caseN}`);
  mkdirSync(rec, { recursive: true });
  return rec;
}

function readRec(rec: string): Recording {
  const lines = (f: string): string[] =>
    existsSync(join(rec, f))
      ? readFileSync(join(rec, f), "utf-8").split("\n").filter((l) => l.length > 0)
      : [];
  return {
    calls: lines("calls"),
    argv: lines("argv"),
    cuda: lines("cuda")[0] ?? "(stub never ran)",
    npmConfigNames: lines("npm-config-names").sort(),
  };
}

/** A child env built from scratch: never a spread of process.env. */
function childEnv(rec: string, extra: Record<string, string> = {}): Record<string, string> {
  return { HOME: join(T, "home"), PATH: STUB_PATH, BR119_REC: rec, ...extra };
}

beforeAll(() => {
  T = mkdtempSync(join(tmpdir(), "br119-"));
  BIN = join(T, "bin");
  mkdirSync(BIN, { recursive: true });
  mkdirSync(join(T, "home"), { recursive: true });
  writeFileSync(join(BIN, "npm"), NPM_STUB);
  chmodSync(join(BIN, "npm"), 0o755);
  STUB_PATH = `${BIN}:${dirname(process.execPath)}:/usr/bin:/bin`;
  // The stub must win over the real npm that sits beside node.
  const resolved = execFileSync("/bin/sh", ["-c", "command -v npm"], {
    env: { PATH: STUB_PATH },
    encoding: "utf-8",
    timeout: 10_000,
  }).trim();
  expect(resolved).toBe(join(BIN, "npm"));
  // Warm the fresh stub (first exec of a new script is slow on macOS).
  const warm = newRec();
  execFileSync(join(BIN, "npm"), ["--version"], { env: childEnv(warm), stdio: "ignore", timeout: 10_000 });
});

afterAll(() => {
  if (T) rmSync(T, { recursive: true, force: true });
});

// ===========================================================================
// P — cli/scripts/postinstall.mjs (path 4, the consumer install)
// ===========================================================================

function stagePostinstall(): { root: string; script: string; bundle: string } {
  const root = mkdtempSync(join(T, "pi-"));
  const script = join(root, "cli", "scripts", "postinstall.mjs");
  const bundle = join(root, "cli", "dist", "brain-mcp-server");
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(bundle, { recursive: true });
  copyFileSync(join(REPO, "cli", "scripts", "postinstall.mjs"), script);
  writeFileSync(join(bundle, "package.json"), '{"name":"igris-brain-mcp-server","type":"module"}\n');
  writeFileSync(join(bundle, "package-lock.json"), '{"lockfileVersion":3}\n');
  return { root, script, bundle };
}

function runPostinstall(
  env: Record<string, string>,
  preload?: string,
): { status: number | null; out: string; script: string } {
  const { root, script } = stagePostinstall();
  const args = preload ? ["--require", preload, script] : [script];
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf-8",
    timeout: POSTINSTALL_TIMEOUT_MS,
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, script };
}

/** A `--require` preload that makes the child report `platform`. */
function platformPreload(platform: "linux" | "darwin"): string {
  const f = join(T, `platform-${platform}.cjs`);
  if (!existsSync(f)) {
    writeFileSync(f, `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });\n`);
  }
  return f;
}

const LINUX_RECOVERY = `${OPT}=skip npm install --omit=dev`;

describe("BR-119 P — postinstall.mjs sets the opt-out in the nested npm's env", () => {
  it("P1: with no opt-out in the caller env, the nested `npm ci` sees skip; every npm_config_* is still stripped (BR-075 guard)", () => {
    const rec = newRec();
    const r = runPostinstall(
      childEnv(rec, { npm_config_global: "true", npm_config_prefix: "/x", NPM_CONFIG_OMIT: "dev" }),
    );
    expect(r.status, r.out).toBe(0);
    const got = readRec(rec);
    // Controls: the stub was reached, once, with the lockfile argv.
    expect(got.calls).toHaveLength(1);
    expect(got.argv).toEqual(["ci", "--omit=dev", "--no-audit", "--no-fund"]);
    expect(r.out).toContain("igris-brain MCP dependencies ready");
    // BR-075: no inherited npm_config_* reaches the nested npm.
    expect(got.npmConfigNames).toEqual([]);
    // BR-119.
    expect(got.cuda).toBe("skip");
  });

  it("P2 (D2): a caller's ONNXRUNTIME_NODE_INSTALL_CUDA=v12 is overridden to skip", () => {
    const rec = newRec();
    const r = runPostinstall(childEnv(rec, { [OPT]: "v12" }));
    expect(r.status, r.out).toBe(0);
    const got = readRec(rec);
    expect(got.calls).toHaveLength(1);
    expect(got.cuda).toBe("skip");
  });

  it("P3a: on a failed install the recovery text carries the opt-out prefix iff the HOST platform is linux (exit 0 kept)", () => {
    const rec = newRec();
    const r = runPostinstall(childEnv(rec, { BR119_FAIL: "1" }));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("WARNING");
    expect(r.out).toContain("npm exited with status 1");
    if (process.platform === "linux") expect(r.out).toContain(LINUX_RECOVERY);
    else expect(r.out).not.toContain(`${OPT}=`);
  });

  it("P3b: with process.platform forced to linux (every host), BOTH recovery commands carry the prefix", () => {
    const rec = newRec();
    const r = runPostinstall(childEnv(rec, { BR119_FAIL: "1" }), platformPreload("linux"));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("WARNING");
    // The two-line form and the one-line `--prefix` form.
    expect(r.out.split(LINUX_RECOVERY).length - 1, r.out).toBe(2);
    expect(r.out).toContain(`${LINUX_RECOVERY} --prefix "`);
  });

  it("P3c (control): with process.platform forced to darwin (every host), the recovery text has no prefix", () => {
    const rec = newRec();
    const r = runPostinstall(childEnv(rec, { BR119_FAIL: "1" }), platformPreload("darwin"));
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("WARNING");
    expect(r.out).toContain("npm install --omit=dev");
    expect(r.out).not.toContain(`${OPT}=`);
  });
});

// ===========================================================================
// C — cli/scripts/copy-templates.sh (path 1b, the vendor install)
// ===========================================================================

const REAL_BUNDLE = join(REPO, "cli", "dist", "brain-mcp-server");
const realBundleMtime = (): number | "absent" =>
  existsSync(REAL_BUNDLE) ? statSync(REAL_BUNDLE).mtimeMs : "absent";

/** A scratch tree satisfying copy-templates.sh's preconditions, with no rebuild trigger. */
function stageCopyTemplates(): { root: string; script: string } {
  const root = mkdtempSync(join(T, "ct-"));
  const scripts = join(root, "cli", "scripts");
  mkdirSync(scripts, { recursive: true });
  const script = join(scripts, "copy-templates.sh");
  copyFileSync(join(REPO, "cli", "scripts", "copy-templates.sh"), script);
  // TD-426's smoke guard has its own twin (build-smoke-sandbox.bats).
  writeFileSync(join(scripts, "smoke-bundled-mcp.sh"), "#!/bin/sh\nexit 0\n");
  mkdirSync(join(root, "cli", "src", "lib", "templates"), { recursive: true });
  writeFileSync(join(root, "harness-manifest.json"), "{}\n");
  const brain = join(root, "brain-mcp-server");
  for (const d of ["dist", "src", "scripts"]) mkdirSync(join(brain, d), { recursive: true });
  writeFileSync(
    join(brain, "package.json"),
    `${JSON.stringify(
      {
        name: "igris-brain-mcp-server",
        type: "module",
        dependencies: { "@modelcontextprotocol/sdk": "^1.0.0" },
        devDependencies: { vitest: "^4.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(brain, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(brain, "dist", "index.js"), "export {};\n");
  writeFileSync(join(brain, "src", "index.ts"), "export {};\n");
  writeFileSync(join(brain, "scripts", "keep.ts"), "export {};\n");
  // src/ OLDER than dist/index.js, so the `find -newer` rebuild trigger stays quiet.
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(join(brain, "src", "index.ts"), old, old);
  return { root, script };
}

function runCopyTemplates(env: Record<string, string>): { status: number | null; out: string; root: string } {
  const { root, script } = stageCopyTemplates();
  // SAFETY: never execute the real script.
  expect(realpathSync(script).startsWith(`${realpathSync(T)}/`)).toBe(true);
  const before = realBundleMtime();
  const r = spawnSync("/bin/bash", [script], {
    cwd: root,
    env,
    encoding: "utf-8",
    timeout: COPY_TEMPLATES_TIMEOUT_MS,
  });
  expect(realBundleMtime(), "the real cli/dist/brain-mcp-server was touched").toBe(before);
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, root };
}

describe("BR-119 C — copy-templates.sh runs the vendor install with the opt-out", () => {
  it("C1: with no opt-out in the caller env, the vendor `npm install` sees skip", () => {
    const rec = newRec();
    const r = runCopyTemplates(childEnv(rec));
    expect(r.status, r.out).toBe(0);
    expect(readRec(rec).cuda).toBe("skip");
  });

  it("C2 (D2): a caller's ONNXRUNTIME_NODE_INSTALL_CUDA=v12 is overridden to skip", () => {
    const rec = newRec();
    const r = runCopyTemplates(childEnv(rec, { [OPT]: "v12" }));
    expect(r.status, r.out).toBe(0);
    expect(readRec(rec).cuda).toBe("skip");
  });

  it("C3 (control): the script ran end to end — one install call with its argv, devDependencies pruned, descriptor bundled", () => {
    const rec = newRec();
    const r = runCopyTemplates(childEnv(rec));
    expect(r.status, r.out).toBe(0);
    const got = readRec(rec);
    expect(got.calls).toHaveLength(1);
    expect(got.argv).toEqual(["install", "--omit=dev", "--no-audit", "--no-fund"]);
    const staged = JSON.parse(
      readFileSync(join(r.root, "cli", "dist", "brain-mcp-server", "package.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(staged.devDependencies).toBeUndefined();
    expect(staged.dependencies).toEqual({ "@modelcontextprotocol/sdk": "^1.0.0" });
    expect(existsSync(join(r.root, "cli", "dist", "lib", "harness-manifest.json"))).toBe(true);
    expect(r.out).toContain("copy-templates: bundled brain-mcp-server ->");
  });
});

// ===========================================================================
// S1 — source census (paths 1a, 2, 3, 1b, 6)
// ===========================================================================

/**
 * A workflow sets the opt-out for EVERY job: a column-0 `env:` mapping before
 * the first column-0 `jobs:` line holds `ONNXRUNTIME_NODE_INSTALL_CUDA: skip`
 * (quoted or not), and no other non-comment line assigns the name.
 */
function workflowViolations(text: string): string[] {
  const lines = text.split("\n");
  const jobsAt = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (jobsAt < 0) return ["no column-0 `jobs:` line"];
  const envAt = lines.slice(0, jobsAt).findIndex((l) => /^env:\s*(#.*)?$/.test(l));
  if (envAt < 0) return ["no column-0 `env:` block before `jobs:`"];
  const keyRe = new RegExp(`^\\s+${OPT}:\\s*(["']?)skip\\1\\s*(#.*)?$`);
  let keyAt = -1;
  for (let i = envAt + 1; i < jobsAt; i++) {
    const l = lines[i];
    if (/^[^\s#]/.test(l)) break; // the next top-level key ends the block
    if (keyRe.test(l)) keyAt = i;
  }
  const out: string[] = [];
  if (keyAt < 0) out.push(`the top-level \`env:\` block lacks \`${OPT}: skip\``);
  lines.forEach((l, i) => {
    if (i !== keyAt && l.includes(OPT) && !/^\s*#/.test(l)) out.push(`line ${i + 1} re-assigns ${OPT}: ${l.trim()}`);
  });
  return out;
}

/**
 * Every non-comment `npm ci` / `npm install` (not `-g`) in a shell text is
 * IMMEDIATELY prefixed by `ONNXRUNTIME_NODE_INSTALL_CUDA=skip ` — the inline
 * form, which puts the value in that one command's environment.
 */
function shellCensus(text: string): { sites: number; violations: string[] } {
  let sites = 0;
  const violations: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const re = /(?<![\w-])npm\s+(ci|install)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (/^\s+-g\b/.test(line.slice(m.index + m[0].length))) continue;
      sites += 1;
      if (!line.slice(0, m.index).endsWith(`${OPT}=skip `)) violations.push(`line ${i + 1}: ${line.trim()}`);
    }
  });
  return { sites, violations };
}

const read = (rel: string): string => readFileSync(join(REPO, rel), "utf-8");

describe("BR-119 S1 — source census of the CI and shell install sites", () => {
  it.each([".github/workflows/test.yml", ".github/workflows/npm-publish.yml"])(
    "S1(a): %s sets ONNXRUNTIME_NODE_INSTALL_CUDA: skip in a workflow-level env block",
    (rel) => {
      expect(workflowViolations(read(rel))).toEqual([]);
    },
  );

  it.each(["cli/scripts/copy-templates.sh", "scripts/igris_brain_deploy.sh"])(
    "S1(b): every npm ci / npm install line in %s carries the inline opt-out",
    (rel) => {
      const c = shellCensus(read(rel));
      expect(c.sites, "no install line found — the census is vacuous").toBeGreaterThanOrEqual(1);
      expect(c.violations).toEqual([]);
    },
  );

  it("S1(c) self-negative: the census reports HEAD-shaped and near-miss texts, and passes the minimal correct ones", () => {
    const head = "name: x\non:\n  push:\njobs:\n  a:\n    steps:\n      - run: npm ci\n";
    expect(workflowViolations(head)).toEqual(["no column-0 `env:` block before `jobs:`"]);
    const jobLevel = `name: x\njobs:\n  a:\n    env:\n      ${OPT}: skip\n`;
    expect(workflowViolations(jobLevel).length).toBeGreaterThan(0);
    expect(workflowViolations(`name: x\nenv:\n  ${OPT}: SKIP\njobs:\n  a: {}\n`).length).toBeGreaterThan(0);
    expect(workflowViolations(`name: x\nenv:\n  OTHER: 1\njobs:\n  a: {}\n`).length).toBeGreaterThan(0);
    const overridden = `name: x\nenv:\n  ${OPT}: skip\njobs:\n  a:\n    env:\n      ${OPT}: v12\n`;
    expect(workflowViolations(overridden)).toEqual([`line 7 re-assigns ${OPT}: ${OPT}: v12`]);
    expect(workflowViolations(`name: x\nenv:\n  # why\n  ${OPT}: "skip"\njobs:\n  a: {}\n`)).toEqual([]);
    expect(workflowViolations(`name: x\nenv:\n  ${OPT}: skip\njobs:\n  a: {}\n`)).toEqual([]);

    expect(shellCensus('(cd "$MCP_DEST" && npm install --omit=dev --no-audit --no-fund)\n')).toEqual({
      sites: 1,
      violations: ['line 1: (cd "$MCP_DEST" && npm install --omit=dev --no-audit --no-fund)'],
    });
    expect(shellCensus(`  npm ci --silent 2>&1 | tail -1\n`).violations).toHaveLength(1);
    expect(shellCensus(`${OPT}=skip; npm ci\n`).violations).toHaveLength(1);
    expect(shellCensus(`export ${OPT}=skip\nnpm ci\n`).violations).toHaveLength(1);
    expect(shellCensus(`check_command pm2 "PM2" "npm install -g pm2"\n# npm ci here\n`)).toEqual({
      sites: 0,
      violations: [],
    });
    expect(shellCensus(`  ${OPT}=skip npm ci --silent 2>&1 | tail -1\n`)).toEqual({ sites: 1, violations: [] });
  });
});
