/**
 * `igris sync code [--dry-run] [--if-changed]` — code-sync sub-verb.
 *
 * Replaces the retired `scripts/igris_vps_update.sh` (deleted in M4.7).
 *
 * Pipeline (BR-116 — no remote step is bounded by the client's ssh lifetime):
 *   1. Read VPS config (`vps.{host,user,repo_path}`) from `~/.igris/config.json`.
 *      Read remote_brain.url for post-restart health check.
 *   2. (when --if-changed) Compare local HEAD against `origin/<branch>`; no
 *      diff → exit 0 (cron parity). It compares local vs ORIGIN, not vs the
 *      VPS — a stale VPS on an unchanged origin is skipped.
 *   3. Preflight ssh: VPS Node vs the engines range (reported, never changed);
 *      REFUSE before rsync when another deploy runs, a swap was interrupted, or
 *      the projected free disk after staging is under 512 MiB.
 *   4. rsync `-az --delete` + RSYNC_EXCLUDES (TD-135: workstation-native
 *      `node_modules/` never ships; `.igris-deploy/` is never deleted).
 *   5. Launch a DETACHED runner (`vps-deploy.ts`) that installs + builds into a
 *      stage copy, smoke-loads the native binding, swaps `node_modules` + `dist`
 *      in, smokes the live tree and auto-rolls back on failure. The live tree is
 *      only touched after the stage smoke passes.
 *   6. Poll its `rc` file. The 30-min wait bound is REPORTED — the runner is
 *      never killed. A failure prints npm's real error, not its warnings.
 *   7. `pm2 restart`, then gate on pm2 `online` + `/health` 200 `status: ok`
 *      twice in a row (restart count past its pre-restart baseline and
 *      unchanged between the reads); a non-zero `pm2 restart` fails the
 *      attempt; one retry; exit 1 naming the
 *      state (BR-087: the exit code comes from a re-read, never from pm2's own
 *      exit code).
 *
 * TD-141 correction: its smoke `require("better-sqlite3")` never loaded the
 * binding — the addon loads lazily in the `Database` constructor
 * (`better-sqlite3/lib/database.js`), so the smoke now instantiates one.
 *
 * Tests mock `child_process.execFile` at the boundary (`sync-code.test.ts`) and
 * run a hermetic fake-ssh tier (`sync-code-remote.test.ts`); lib/ssh and
 * lib/mcp-client are NOT mocked — per L-159 / TD-098.
 */


import { execFile, type ExecFileException } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { rsyncExec, sshExec, type SshExecResult } from "../ssh.js";
import {
  healthCheck,
  readRemoteBrainConfig,
  readVpsConfig,
} from "../mcp-client.js";
import { DryRunCollector } from "../dry-run.js";
import { info, warn, error as logError } from "../log.js";
import {
  DEPLOY_DIR_NAME,
  buildLaunchCommand,
  buildPm2StatusCommand,
  buildPollCommand,
  buildPreflightCommand,
  buildRestartCommand,
  buildRestoreCommand,
  buildTailCommand,
  classifyVpsNode,
  isValidAppName,
  isValidRunId,
  newRunId,
  parseKv,
  parsePm2Status,
  parseRunnerState,
  summarizeRemoteFailure,
  type RunnerState,
} from "./vps-deploy.js";

/**
 * Paths that MUST NOT ship from the workstation to the VPS.
 *
 * The load-bearing exclusion is `node_modules/` (TD-135): workstation-built
 * native bindings (e.g. macOS-arm64 `better-sqlite3`) crash on Linux x86_64
 * the moment `require()` tries to load the binary. The VPS runs `npm ci`
 * post-rsync to materialize a Linux-native dep tree.
 *
 * The rest mirrors `.gitignore` essentials — secrets, IDE config, OS
 * detritus, build outputs, log/temp files. rsync's `--exclude` is glob-
 * pattern (not gitignore-pattern), so we mirror the spirit, not the literal
 * syntax. Any future expansion of `.gitignore` should consider whether the
 * new pattern also belongs here.
 */
export const RSYNC_EXCLUDES: readonly string[] = [
  // Core fix — load-bearing
  "node_modules/",
  // Workstation history + build outputs (rebuilt on VPS via `npm run build`)
  ".git/",
  "dist/",
  // TD-373: brain-mcp-server compiles to `dist.tmp` and swaps, so a failed
  // build leaves the last-good `dist/` serving on the VPS. The directory only
  // exists mid-build or after a crashed one — never something to ship across.
  "dist.tmp/",
  "build/",
  // Igris symlinks + local agent memory (each project's VPS has its own ~/.igris)
  // (FR-187 retired the .claude/rules/ symlink layer — no rules dir to exclude.)
  ".claude/agent-memory/",
  // Per-developer local Claude settings — may embed machine-local secrets (TD-159).
  ".claude/settings.local.json",
  ".claude/agents/",
  ".claude/skills/",
  // Machine-local version stamp written by the CLI installer (per-host)
  ".igris_version",
  // Local dev overrides + secrets
  "CLAUDE.local.md",
  ".env",
  ".env.local",
  // FR-165 MCP secrets — real file lives at ~/.igris/secrets.env (outside repo);
  // mirror the .gitignore belt-and-suspenders so the TD-140 contract stays green.
  "secrets.env",
  // TD-220 — ~/.igris/config.json (may carry remote_brain credentials) lives
  // outside the repo at mode 600; mirror the .gitignore defense-in-depth so the
  // TD-140 bidirectional contract stays green. MUST NOT ship to the VPS.
  "config.json",
  // Logs
  "*.log",
  "logs/",
  // OS detritus
  ".DS_Store",
  "Thumbs.db",
  // IDE config
  ".idea/",
  ".vscode/",
  // Editor swap/backup files
  "*.swp",
  "*.swo",
  "*~",
  // Temp/scratch
  "*.tmp",
  "*.temp",
  ".temp/",
  "temp/",
  // Python caches (any tooling) — mirror .gitignore's `*.py[cod]` glob.
  "__pycache__/",
  ".pytest_cache/",
  "*.pyc",
  "*.pyo",
  "*.pyd",
  // Test scratch dirs
  ".test/",
  "test-output/",
  // Tarballs / archives (fixture tarballs are workstation-only)
  "*.zip",
  "*.tar.gz",
  // Image-generation staging (Higgsfield raw outputs — committed PNGs live at docs/images/*.png)
  "docs/images/generated/",
  // Generated memory-eval scorecards (FR-188 — regenerate via `npm run eval:memory`).
  // Mirror the .gitignore glob so the TD-140 bidirectional contract stays green
  // and these never rsync to the VPS.
  "brain-mcp-server/eval-memory-scorecard.*",
  // Generated harness projections (FR-137) — mechanically derived from canonical
  // sources by `igris harness compile`; never committed (regenerated on demand,
  // drift-checked against canonical). Mirror the .gitignore entries so the
  // TD-140 bidirectional contract stays green. These MUST NOT ship to the VPS.
  // NB: `/AGENTS.md` was removed from this list by TD-233 — the FR-153 codex
  // skills aggregator it ignored was retired, and project-root AGENTS.md is
  // now the COMMITTED orchestrator-identity file (mirrors .gitignore).
  ".codex/",
  ".gemini/",
  // BR-116: the VPS deploy workspace (runs, lock, swap marker, prev/). rsync
  // never deletes an excluded receiver path, so `--delete` cannot wipe it.
  ".igris-deploy/",
] as const;

function rsyncExcludeFlags(): string[] {
  return RSYNC_EXCLUDES.map((p) => `--exclude=${p}`);
}

/**
 * Paths that the v6 install model expects to be symlinks (created by
 * `igris register` / `igris install`). If a project has them as real
 * directories — e.g. partial install, manual override — RSYNC_EXCLUDES
 * will silently strip their contents on the VPS. Warn the operator at
 * deploy time so the footgun surfaces before it bites. Advisory only —
 * does NOT abort.
 */
const CLAUDE_SYMLINK_PATHS = [
  // FR-187 retired the .claude/rules/ symlink layer — install creates only
  // agents + skills symlinks now.
  ".claude/agents",
  ".claude/skills",
] as const;

function warnIfClaudeDirsAreNotSymlinks(repoPath: string): void {
  for (const relPath of CLAUDE_SYMLINK_PATHS) {
    const fullPath = pathResolve(repoPath, relPath);
    try {
      const st = lstatSync(fullPath);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        warn(
          `sync code: ${relPath}/ is a real directory but RSYNC_EXCLUDES ` +
            `treats it as a symlink. Its contents will NOT ship to the VPS. ` +
            `If this is intentional (project-local override), ignore this ` +
            `warning. Otherwise, restore the symlink via 'igris install'.`,
        );
      }
    } catch {
      // ENOENT or other — silent (the path being absent is the expected
      // case for projects that don't use the .claude/ symlinks at all).
    }
  }
}


export interface SyncCodeOptions {
  /** When true, enumerate plan without executing rsync/ssh. */
  dryRun?: boolean;
  /**
   * When true, skip the entire push if local HEAD matches `origin/<branch>`.
   * Cron-parity with retired `igris_vps_update.sh --if-changed`.
   */
  ifChanged?: boolean;
  /**
   * Local repo path to sync. Defaults to `process.cwd()`. Caller-provided
   * to support test seams + alternate-repo deploys.
   */
  repoPath?: string;
  /** PM2 app name to restart. Defaults to "igris-brain" (matches VPS convention). */
  pm2AppName?: string;
  /** Test seam: settle delay after `pm2 restart` (default 2000 ms). */
  postRestartDelayMs?: number;
  /** Test seams (BR-116); the defaults are in `DEFAULTS`. */
  pollIntervalMs?: number;
  deployWaitMs?: number;
  heartbeatMs?: number;
  restartVerifyMs?: number;
  restartPollMs?: number;
  restartRetryDelayMs?: number;
  /** Overrides EVERY per-call ssh timeout. */
  sshCallTimeoutMs?: number;
  runId?: string;
}

const DEFAULTS = {
  pollIntervalMs: 10_000,
  deployWaitMs: 30 * 60_000,
  heartbeatMs: 60_000,
  restartVerifyMs: 60_000,
  restartPollMs: 2_000,
  restartRetryDelayMs: 3_000,
  postRestartDelayMs: 2_000,
};

/** One restart, then exactly one retry. */
const MAX_RESTART_ATTEMPTS = 2;

/** Healthy observations needed in a row, restart count unchanged between them. */
const HEALTHY_STREAK = 2;

const PRE_SWAP_PHASES = new Set(["prepare", "stage", "install", "build", "smoke-stage", ""]);

/**
 * Run `igris sync code`. Returns process exit code.
 *
 * Exit codes:
 *   0 — deployed and verified healthy (or no-change skip with --if-changed)
 *   1 — config missing / malformed; preflight refusal (busy, interrupted
 *       swap, disk); rsync failed; the remote run failed, died or outlived the
 *       wait bound; brain not healthy after a restart + one retry
 *   2 — argument or environment error
 */
export async function runSyncCode(opts: SyncCodeOptions = {}): Promise<number> {
  const dryRun = opts.dryRun === true;
  const dry = dryRun ? new DryRunCollector() : null;

  // 1. Load configs.
  const vps = readVpsConfig();
  if (vps === null) {
    logError(
      "vps config not found in ~/.igris/config.json. Add a 'vps' block with host/user/repo_path.",
    );
    return 1;
  }
  const remote = readRemoteBrainConfig();
  if (remote === null) {
    logError(
      "remote_brain config not found in ~/.igris/config.json. Required for post-restart health check.",
    );
    return 1;
  }

  const repoPath = pathResolve(opts.repoPath ?? process.cwd());
  if (!existsSync(repoPath)) {
    logError(`local repo path does not exist: ${repoPath}`);
    return 1;
  }
  const pm2AppName = opts.pm2AppName ?? "igris-brain";
  const runId = opts.runId ?? newRunId();
  if (!isValidAppName(pm2AppName) || !isValidRunId(runId)) {
    logError(`invalid pm2 app name or run id: ${pm2AppName} / ${runId}`);
    return 2;
  }
  const cfg = { ...DEFAULTS, ...definedOnly(opts) };

  // TD-139: advisory check — warn if .claude/{agents,skills}/ are
  // real dirs rather than symlinks. RSYNC_EXCLUDES treats them as symlinks
  // per the v6 install model; a real directory would have its contents
  // silently stripped at deploy time. Does NOT abort.
  warnIfClaudeDirsAreNotSymlinks(repoPath);

  // 2. --if-changed: skip entire push when local HEAD == origin/<branch>.
  if (opts.ifChanged === true) {
    const changed = await detectChange(repoPath, dry);
    if (changed === "no-change") {
      info("sync code --if-changed: local HEAD matches origin; nothing to push.");
      if (dry !== null) dry.print();
      return 0;
    }
    if (changed === "git-error") {
      // Non-fatal: log warning and proceed with the push.
      warn(
        "sync code --if-changed: git diff check failed; proceeding with push anyway.",
      );
    }
    // "changed" → fall through to rsync.
  }

  // Trailing slash on src is intentional — copy the contents INTO repo_path.
  const src = repoPath.endsWith("/") ? repoPath : repoPath + "/";
  const dst = `${vps.user}@${vps.host}:${vps.repoPath}/`;
  const target = `${vps.user}@${vps.host}`;
  const ws = `${vps.repoPath}/${DEPLOY_DIR_NAME}`;
  const runRef = `${target}:${ws}/runs/${runId}`;

  if (dry !== null) {
    const sshArgs = (cmd: string) => ["-o", "ConnectTimeout=30", "-o", "BatchMode=yes", target, "--", cmd];
    dry.wouldInvokeCommand(
      "ssh",
      sshArgs(`: igris-deploy:preflight (node/npm --version, lock, swap marker, df/du in ${ws})`),
      "preflight: VPS Node vs engines range; refuse if busy / interrupted swap / low disk",
    );
    const rsyncArgs = ["-a", "-z", "--delete", ...rsyncExcludeFlags(), "--dry-run", "-v", "-i"];
    dry.wouldInvokeCommand(
      "rsync",
      [...rsyncArgs, src, dst],
      "mirror local repo to VPS (excludes node_modules + dev artifacts + .igris-deploy)",
    );
    dry.wouldInvokeCommand(
      "ssh",
      sshArgs(`: igris-deploy:launch (setsid/nohup bash ${ws}/runs/${runId}/run.sh, detached)`),
      "detached runner: stage copy → npm ci → npm run build → smoke new Database(require(\"better-sqlite3\")) → " +
        "swap node_modules+dist → live smoke (auto-rollback)",
    );
    dry.wouldInvokeCommand(
      "ssh",
      sshArgs(`: igris-deploy:poll (${ws}/runs/${runId}/rc)`),
      `poll every ${cfg.pollIntervalMs / 1000}s; wait bound ${cfg.deployWaitMs / 60_000}m is reported, never enforced by killing`,
    );
    dry.wouldInvokeCommand("ssh", sshArgs(`pm2 restart ${pm2AppName}`), "restart brain-mcp-server (after code=0 phase=done only)");
    dry.wouldInvokeCommand(
      "ssh",
      sshArgs(`pm2 jlist | node -e <filter> ${pm2AppName}`),
      "post-restart gate: pm2 online (filtered on the VPS — env never leaves it); one retry",
    );
    dry.wouldFetchUrl(`${remote.url.replace(/\/$/, "")}/health`);
    dry.print();
    return 0;
  }

  const ssh = (cmd: string, ms: number) =>
    sshExec(vps.user, vps.host, cmd, { timeoutMs: cfg.sshCallTimeoutMs ?? ms });
  // The next run deletes prev/ at its start, so the restore must come first.
  const restoreHint =
    `  restore the previous tree by hand on the VPS (BEFORE re-running \`igris sync code\`): ` +
    buildRestoreCommand(vps.repoPath, pm2AppName);

  // 3. Preflight — refuse BEFORE rsync.
  const pre = await ssh(buildPreflightCommand(vps.repoPath), 60_000);
  if (pre.exitCode !== 0) {
    logError(`sync code: preflight ssh failed (${describe(pre)}): ${truncate(pre.stderr, 500)}`);
    return 1;
  }
  const kv = parseKv(pre.stdout);
  const vpsNode = classifyVpsNode(kv.node ?? "");
  (vpsNode.verdict === "outside" ? warn : info)(`sync code: VPS Node ${vpsNode.message}`);
  if (kv.ps === "0") {
    logError("sync code: the VPS has no `ps` — the runner liveness check needs it. Nothing was deployed.");
    return 1;
  }
  if (kv.busy === "1") {
    const run = kv.busy_run ?? "?";
    logError(
      `sync code: another deploy is running on the VPS — run ${run} (phase ${kv.busy_phase || "?"}, ` +
        `started ${run.slice(0, 16)}). Nothing was deployed; inspect ${target}:${ws}/runs/${run}/.`,
    );
    return 1;
  }
  if (kv.swap_marker === "1") {
    const journal = pre.stdout.split("\n").filter((l) => l.startsWith("journal=")).map((l) => l.slice(8));
    logError(`sync code: an interrupted swap was found (${ws}/swap.inprogress) — refusing; never auto-restored.`);
    for (const l of journal) logError(`  journal: ${l}`);
    logError(restoreHint);
    return 1;
  }
  const avail = parseInt(kv.avail_kb ?? "", 10);
  if (Number.isFinite(avail)) {
    const need = Math.ceil(1.25 * Math.max(parseInt(kv.nm_kb ?? "0", 10) || 0, 1_048_576));
    const projected = avail + (parseInt(kv.prev_kb ?? "0", 10) || 0) - need;
    if (projected < 524_288) {
      logError(
        `sync code: not enough disk on the VPS — avail_kb=${avail}, need=${need} KB for the stage; ` +
          "projected free < 512 MiB (the brain DB shares this disk). Nothing was deployed.",
      );
      return 1;
    }
  } else {
    warn("sync code: could not read VPS free disk; skipping the disk check.");
  }

  // 4. rsync.
  info(`sync code: rsync ${src} -> ${dst}`);
  const rsyncResult = await rsyncExec(src, dst, {
    dryRun: false,
    extraFlags: rsyncExcludeFlags(),
  });
  if (rsyncResult.exitCode !== 0) {
    logError(
      `rsync failed (exit ${rsyncResult.exitCode}): ${truncate(rsyncResult.stderr, 500)}`,
    );
    return 1;
  }
  if (rsyncResult.stdout.length > 0) {
    info(rsyncResult.stdout.trimEnd());
  }

  // 5. Launch the detached runner.
  const launch = await ssh(buildLaunchCommand(vps.repoPath, runId), 60_000);
  const lkv = parseKv(launch.stdout);
  if (launch.exitCode !== 0 || lkv.state === undefined) {
    logError(
      `sync code: launch ssh failed (${describe(launch)}) — remote state unknown; check ${runRef}/. ` +
        truncate(launch.stderr, 300),
    );
    return 1;
  }
  if (lkv.state !== "launched") {
    logError(`sync code: VPS refused the launch (state=${lkv.state}) — nothing was deployed. Re-run to see the preflight detail.`);
    return 1;
  }
  info(`sync code: run ${runId} launched on the VPS (stage → npm ci → build → smoke → swap → live smoke)`);

  // 6. Poll until the runner writes rc (or dies, or the bound passes).
  const t0 = Date.now();
  let lastPhase = "";
  let lastBeat = t0;
  let failStreak = 0;
  let done: Exclude<RunnerState, { kind: "running" } | { kind: "unknown" }>;
  for (;;) {
    if (Date.now() - t0 >= cfg.deployWaitMs) {
      logError(
        `sync code: run ${runId} still running (phase ${lastPhase || "?"}) after ${fmtDur(Date.now() - t0)}. ` +
          "It was NOT killed and will finish on its own. The live tree is swapped only on success. " +
          `The brain was NOT restarted. Check: ssh ${target} -- cat ${ws}/runs/${runId}/rc; ` +
          "re-run `igris sync code` after it finishes.",
      );
      return 1;
    }
    await sleep(cfg.pollIntervalMs);
    const r = await ssh(buildPollCommand(vps.repoPath, runId), 30_000);
    const s: RunnerState = r.exitCode === 0 ? parseRunnerState(r.stdout) : { kind: "unknown" };
    if (s.kind === "unknown") {
      failStreak += 1;
      if (failStreak % 3 === 1) {
        warn(`sync code: poll failed (${describe(r)}) — the remote run is unaffected; still polling`);
      }
      continue;
    }
    failStreak = 0;
    if (s.kind !== "running") {
      done = s;
      break;
    }
    const now = Date.now();
    if (s.phase !== lastPhase) {
      info(`sync code: [${runId}] ${s.phase}`);
      lastPhase = s.phase;
      lastBeat = now;
    } else if (now - lastBeat >= cfg.heartbeatMs) {
      info(`sync code: ${s.phase} running ${fmtDur(now - t0)}`);
      lastBeat = now;
    }
  }

  if (done.kind === "died" || done.code !== 0 || done.phase !== "done") {
    const tail = await ssh(buildTailCommand(vps.repoPath, runId), 30_000);
    const summary = summarizeRemoteFailure(tail.stdout, done, {
      vpsNode: done.kind === "finished" && done.node !== "" ? done.node : kv.node,
      logRef: `${runRef}/log`,
    });
    for (const l of summary) logError(l);
    if (PRE_SWAP_PHASES.has(done.phase)) {
      logError("live tree untouched; brain not restarted.");
    } else if (done.phase === "done") {
      logError("the new tree is live and smoke-tested, but the brain was NOT restarted — re-run or `pm2 restart`.");
    } else if (done.kind === "finished" && done.rolledBack) {
      logError(
        `auto-rolled back to the previous tree (rollback smoke: ${done.rollbackSmoke || "?"}); ` +
          `the new tree is in ${ws}/failed/. Brain not restarted.`,
      );
    } else {
      logError(`the live tree may be mid-swap or mid-rollback (${ws}/swap.inprogress). Brain not restarted.`);
      logError(restoreHint);
    }
    return 1;
  }

  // 7. Restart + verify (one retry). The restart count read BEFORE each
  // restart is the baseline a healthy read must exceed — proof that the
  // process serving /health is a restarted one, not the old one.
  const base = await ssh(buildPm2StatusCommand(pm2AppName), 30_000);
  let baseline = base.exitCode === 0 ? parsePm2Status(base.stdout).restarts : null;
  let v: Verdict = { ok: false, pm2: "unknown", restarts: null, health: "unknown", node: null };
  for (let attempt = 1; attempt <= MAX_RESTART_ATTEMPTS; attempt += 1) {
    const rr = await ssh(buildRestartCommand(pm2AppName), 60_000);
    if (rr.exitCode !== 0) {
      v = { ok: false, pm2: `not restarted (pm2 restart ${describe(rr)})`, restarts: baseline, health: "not checked", node: null };
    } else {
      await sleep(cfg.postRestartDelayMs);
      v = await verifyRestart(ssh, pm2AppName, remote.url, cfg, baseline);
    }
    if (v.ok) {
      if (attempt > 1) info(`sync code: recovered on retry ${attempt - 1}/${MAX_RESTART_ATTEMPTS - 1}`);
      break;
    }
    baseline = v.restarts ?? baseline;
    if (attempt < MAX_RESTART_ATTEMPTS) {
      warn(`sync code: brain not healthy after restart (pm2=${v.pm2}, health=${v.health}) — retrying pm2 restart once`);
      await sleep(cfg.restartRetryDelayMs);
    }
  }
  if (!v.ok) {
    logError(
      `sync code: brain not healthy after pm2 restart + 1 retry — pm2 status=${v.pm2} restarts=${v.restarts ?? "?"}, ` +
        `health=${v.health}`,
    );
    logError(`  next: ssh ${target} -- pm2 logs ${pm2AppName} --lines 50`);
    logError(restoreHint);
    return 1;
  }
  info(
    `sync code: deployed run ${runId} — install ${done.installS || "?"}s, build ${done.buildS || "?"}s; ` +
      `pm2 online (node ${v.node ?? "?"}); health ok`,
  );
  return 0;
}

interface Verdict {
  ok: boolean;
  pm2: string;
  restarts: number | null;
  health: string;
  node: string | null;
}

/** Observe pm2 + /health until HEALTHY_STREAK good reads, an errored/stopped read, or the bound. */
async function verifyRestart(
  ssh: (cmd: string, ms: number) => Promise<SshExecResult>,
  app: string,
  url: string,
  cfg: typeof DEFAULTS,
  baseline: number | null,
): Promise<Verdict> {
  const deadline = Date.now() + cfg.restartVerifyMs;
  let streak = 0;
  let prevRestarts: number | null = null;
  for (;;) {
    const r = await ssh(buildPm2StatusCommand(app), 30_000);
    const st = r.exitCode === 0 ? parsePm2Status(r.stdout) : null;
    const h = await healthCheck(url);
    const healthOk = h.statusCode === 200 && bodyStatusOk(h.body);
    const v: Verdict = {
      ok: false,
      pm2: st === null ? `unknown (${describe(r)})` : st.found ? (st.status ?? "unknown") : (st.error ?? "not found"),
      restarts: st?.restarts ?? null,
      health: h.statusCode === null ? "unreachable" : `${h.statusCode}${h.statusCode === 200 && !healthOk ? " (status not ok)" : ""}`,
      node: st?.node ?? null,
    };
    const moved = baseline === null || (v.restarts !== null && v.restarts > baseline);
    if (st?.status === "online" && !moved) v.pm2 = `online (restart count unchanged from ${baseline})`;
    if (st?.status === "online" && healthOk && moved) {
      streak = streak > 0 && v.restarts === prevRestarts ? streak + 1 : 1;
      prevRestarts = v.restarts;
      if (streak >= HEALTHY_STREAK) return { ...v, ok: true };
    } else {
      streak = 0;
      if (st?.status === "errored" || st?.status === "stopped") return v;
    }
    if (Date.now() >= deadline) return v;
    await sleep(cfg.restartPollMs);
  }
}

function bodyStatusOk(body: string): boolean {
  try {
    return (JSON.parse(body) as { status?: unknown }).status === "ok";
  } catch {
    return false;
  }
}

function describe(r: SshExecResult): string {
  return r.timedOut === true ? "client-side timeout; remote state unknown" : `exit ${r.exitCode}`;
}

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function definedOnly(o: SyncCodeOptions): Partial<typeof DEFAULTS> & { sshCallTimeoutMs?: number } {
  const out: Record<string, number> = {};
  for (const k of [...Object.keys(DEFAULTS), "sshCallTimeoutMs"] as const) {
    const val = (o as Record<string, unknown>)[k];
    if (typeof val === "number") out[k] = val;
  }
  return out;
}


/**
 * Detect whether local HEAD differs from `origin/<branch>`.
 *
 * Returns:
 *   "changed"   — local diverges from origin; rsync should run
 *   "no-change" — local matches origin; --if-changed should skip
 *   "git-error" — git invocation failed; caller should log + proceed
 *
 * Uses `git fetch origin` then `git diff --quiet HEAD origin/<branch>`.
 * `--quiet` returns 0 when there are no diffs, 1 when there are. Non-0/1
 * exit codes indicate git error (no remote, no branch, etc.).
 *
 * In dry-run mode, records the would-invoke commands in the collector
 * and returns "changed" so the dry-run plan still emits the rsync/ssh
 * preview. Cron-style `--if-changed` paths don't typically use --dry-run,
 * but the combination is well-defined: the dry-run output should show
 * the FULL plan as if change was detected.
 */
async function detectChange(
  repoPath: string,
  dry: DryRunCollector | null,
): Promise<"changed" | "no-change" | "git-error"> {
  if (dry !== null) {
    dry.wouldInvokeCommand(
      "git",
      ["fetch", "origin", "--quiet"],
      "if-changed: fetch origin to compare HEAD",
    );
    dry.wouldInvokeCommand(
      "git",
      ["diff", "--quiet", "HEAD"],
      "if-changed: detect local-vs-origin divergence",
    );
    return "changed";
  }

  const branch = await currentBranch(repoPath);
  if (branch === null) return "git-error";

  // Fetch origin so the comparison is fresh.
  const fetchExit = await runGit(repoPath, ["fetch", "origin", branch, "--quiet"]);
  if (fetchExit !== 0) return "git-error";

  // diff --quiet returns 0 when no diff, 1 when diff, >1 on error.
  const diffExit = await runGit(repoPath, [
    "diff",
    "--quiet",
    "HEAD",
    `origin/${branch}`,
  ]);
  if (diffExit === 0) return "no-change";
  if (diffExit === 1) return "changed";
  return "git-error";
}

/** Get the current git branch name (or null on error). */
async function currentBranch(repoPath: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: repoPath, encoding: "utf-8", timeout: 10_000 },
      (err: ExecFileException | null, stdout: string | Buffer) => {
        if (err !== null) {
          resolve(null);
          return;
        }
        const out = typeof stdout === "string" ? stdout : stdout.toString("utf-8");
        const trimmed = out.trim();
        resolve(trimmed.length > 0 ? trimmed : null);
      },
    );
  });
}

/** Run a git command and return its exit code (never rejects). */
async function runGit(repoPath: string, args: string[]): Promise<number> {
  return new Promise<number>((resolve) => {
    execFile(
      "git",
      args,
      { cwd: repoPath, encoding: "utf-8", timeout: 60_000 },
      (err: ExecFileException | null) => {
        if (err === null) {
          resolve(0);
          return;
        }
        if (typeof err.code === "number") {
          resolve(err.code);
          return;
        }
        resolve(2);
      },
    );
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "... [truncated]";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
