/**
 * `igris sync code [--dry-run] [--if-changed]` — code-sync sub-verb.
 *
 * Replaces the retired `scripts/igris_vps_update.sh` (deleted in M4.7).
 *
 * Pipeline:
 *   1. Read VPS config (`vps.{host,user,repo_path}`) from `~/.igris/config.json`.
 *      Read remote_brain.url for post-restart health check.
 *   2. (when --if-changed) Compare local HEAD against `origin/<branch>` for
 *      the configured repo. If no diff, exit 0 silently — cron-parity with
 *      the retired shell.
 *   3. rsync the local repo to `<vps.user>@<vps.host>:<vps.repo_path>` with
 *      `-az --delete` AND an exclusion list (TD-135). Excludes
 *      `node_modules/`, `.git/`, `dist/`, secrets, IDE files, logs, temp
 *      files, etc. Workstation-built native modules (better-sqlite3) do
 *      NOT ship.
 *   4. SSH `cd <repo> && npm ci` — install Linux-native dep tree on VPS.
 *   5. SSH `cd <repo>/brain-mcp-server && npm run build` — compile dist/
 *      that was excluded from rsync.
 *   6. SSH `node -e 'require("better-sqlite3")'` — fail-loud smoke check
 *      against the native binding (TD-141 load-bearing gate, PRE-restart).
 *      Non-zero exit means the just-installed Linux binding can't load;
 *      abort with exit 1 BEFORE tearing down the running brain. The
 *      previously-running brain process keeps serving on smoke failure.
 *   7. SSH-restart `brain-mcp-server` via PM2: `ssh user@host -- pm2 restart igris-brain`.
 *      Only reached after smoke confirms the binding loads.
 *   8. Verify health endpoint (`<remote_brain.url>/health`); WARN on failure
 *      but exit 0 (matches retired shell behavior — health failure may be
 *      a service-restart race; the smoke check above is the load-bearing
 *      native-module guard).
 *
 * Order rationale (TD-141): the smoke check is a standalone `node -e`
 * subprocess that reads only filesystem state (the built native binding
 * under brain-mcp-server/node_modules/). It does NOT consume PM2 state.
 * Running it BEFORE pm2 restart means a smoke failure leaves the
 * previously-running brain instance unaffected — vs the prior post-
 * restart placement (TD-135) which guaranteed crash-on-next-DB-access
 * if smoke ever failed. Trade-off documented in TD-141; supersedes
 * the post-restart choice from TD-135.
 *
 * `--dry-run`: enumerates the would-be rsync invocation + ssh restart
 * via the shared DryRunCollector instead of executing them.
 *
 * `--if-changed` (architect-derived per Risk #9): cron-parity with the
 * retired `igris_vps_update.sh --if-changed`. Implementation strategy is
 * `git fetch origin && git diff --quiet HEAD origin/<branch>` against the
 * LOCAL repo — if the local working tree is at `origin/<branch>`, there is
 * nothing meaningful to push (the rsync would still copy the same bytes,
 * but skipping is the cron contract). NOTE: This does NOT compare local
 * vs VPS state — it compares local vs origin. The retired shell ran ON
 * the VPS and compared VPS-local vs origin; we run from the developer's
 * workstation and compare workstation-local vs origin. Functionally
 * equivalent for the cron use case (cron jobs intend "deploy when there
 * is something new to deploy"); semantically slightly different (we'd
 * skip even if the VPS is on a stale commit). Documented here so warden
 * has the trade-off in front of them.
 *
 * Tests mock `child_process.execFile` (via lib/ssh wrapper) AND `node:https`
 * / `node:http` (via lib/mcp-client.healthCheck). The wrappers themselves
 * (lib/ssh, lib/mcp-client) are NOT mocked — per L-159 / TD-098.
 */

import { execFile, type ExecFileException } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { rsyncExec, sshExec } from "../ssh.js";
import {
  healthCheck,
  readRemoteBrainConfig,
  readVpsConfig,
} from "../mcp-client.js";
import { DryRunCollector } from "../dry-run.js";
import { info, warn, error as logError } from "../log.js";

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
  "build/",
  // Igris symlinks + local agent memory (each project's VPS has its own ~/.igris)
  ".claude/agent-memory/",
  ".claude/agents/",
  ".claude/rules/",
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
  ".claude/agents",
  ".claude/rules",
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

/**
 * Minimal shell single-quoting for a single arg embedded in a remote
 * command string. Wraps in single quotes and escapes embedded single
 * quotes via the `'\''` idiom. Safe for paths from config (operator-
 * controlled, not user-input); still defensive against weird repo_path
 * values.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
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
  /**
   * Test seam: post-restart settle delay in ms before health probe.
   * Defaults to 2000ms (matches the retired shell). Tests pass 0.
   */
  postRestartDelayMs?: number;
}

/**
 * Run `igris sync code`. Returns process exit code.
 *
 * Exit codes:
 *   0 — success (or no-change skip with --if-changed)
 *   1 — config missing / malformed, rsync failed, ssh restart failed
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

  // TD-139: advisory check — warn if .claude/{agents,rules,skills}/ are
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

  // 3. rsync local repo to VPS. Trailing slash on src is intentional —
  // we want the contents of repoPath copied INTO vps.repoPath, not nested.
  const src = repoPath.endsWith("/") ? repoPath : repoPath + "/";
  const dst = `${vps.user}@${vps.host}:${vps.repoPath}/`;

  if (dry !== null) {
    // Plan output: enumerate the full pipeline.
    const rsyncArgs = ["-a", "-z", "--delete", ...rsyncExcludeFlags()];
    if (dryRun) rsyncArgs.push("--dry-run", "-v", "-i");
    dry.wouldInvokeCommand(
      "rsync",
      [...rsyncArgs, src, dst],
      "mirror local repo to VPS (excludes node_modules + dev artifacts)",
    );
    dry.wouldInvokeCommand(
      "ssh",
      [
        "-o",
        "ConnectTimeout=30",
        "-o",
        "BatchMode=yes",
        `${vps.user}@${vps.host}`,
        "--",
        `cd ${vps.repoPath} && npm ci`,
      ],
      "install Linux-native deps on VPS (better-sqlite3 native rebuild)",
    );
    dry.wouldInvokeCommand(
      "ssh",
      [
        "-o",
        "ConnectTimeout=30",
        "-o",
        "BatchMode=yes",
        `${vps.user}@${vps.host}`,
        "--",
        `cd ${vps.repoPath}/brain-mcp-server && npm run build`,
      ],
      "rebuild brain-mcp-server dist on VPS",
    );
    dry.wouldInvokeCommand(
      "ssh",
      [
        "-o",
        "ConnectTimeout=30",
        "-o",
        "BatchMode=yes",
        `${vps.user}@${vps.host}`,
        "--",
        `cd ${vps.repoPath}/brain-mcp-server && node -e 'require("better-sqlite3")'`,
      ],
      "native-module smoke check (TD-141 PRE-restart gate)",
    );
    dry.wouldInvokeCommand(
      "ssh",
      [
        "-o",
        "ConnectTimeout=30",
        "-o",
        "BatchMode=yes",
        `${vps.user}@${vps.host}`,
        "--",
        `pm2 restart ${pm2AppName}`,
      ],
      "restart brain-mcp-server",
    );
    dry.wouldFetchUrl(`${remote.url.replace(/\/$/, "")}/health`);
    dry.print();
    return 0;
  }

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

  // 4. npm ci on VPS — materialize a Linux-native dep tree (TD-135).
  // Workstation node_modules/ was excluded from rsync, so the VPS needs
  // a fresh install. better-sqlite3 (and any other native modules)
  // rebuild from source against the Linux toolchain. ~30s on typical VPS.
  info(`sync code: ssh ${vps.user}@${vps.host} -- npm ci (in ${vps.repoPath})`);
  const npmCiResult = await sshExec(
    vps.user,
    vps.host,
    `cd ${shellQuote(vps.repoPath)} && npm ci`,
    { timeoutMs: 5 * 60_000 },
  );
  if (npmCiResult.exitCode !== 0) {
    logError(
      `npm ci on VPS failed (exit ${npmCiResult.exitCode}): ${truncate(npmCiResult.stderr, 500)}`,
    );
    return 1;
  }
  info("sync code: npm ci complete on VPS");

  // 5. Rebuild brain-mcp-server dist — workstation dist/ was excluded.
  // PM2 executes from brain-mcp-server/dist/, so this step is mandatory.
  info(
    `sync code: ssh ${vps.user}@${vps.host} -- npm run build (brain-mcp-server)`,
  );
  const buildResult = await sshExec(
    vps.user,
    vps.host,
    `cd ${shellQuote(vps.repoPath)}/brain-mcp-server && npm run build`,
    { timeoutMs: 2 * 60_000 },
  );
  if (buildResult.exitCode !== 0) {
    logError(
      `brain-mcp-server build on VPS failed (exit ${buildResult.exitCode}): ${truncate(buildResult.stderr, 500)}`,
    );
    return 1;
  }
  info("sync code: brain-mcp-server build complete on VPS");

  // 6. Native-module smoke check — load-bearing gate (PRE-restart per TD-141).
  // If better-sqlite3 can't load on the VPS, fail loud BEFORE we tear down
  // the running brain process. Old brain stays serving; operator can
  // diagnose without an outage. The smoke check is a standalone node -e
  // subprocess that reads only filesystem state (the built native binding),
  // so its success-path behavior is identical to the prior post-restart
  // placement (TD-135). Only the failure mode improves.
  info(`sync code: ssh ${vps.user}@${vps.host} -- native-module smoke check`);
  const smokeResult = await sshExec(
    vps.user,
    vps.host,
    `cd ${shellQuote(vps.repoPath)}/brain-mcp-server && node -e 'require("better-sqlite3")'`,
    { timeoutMs: 30_000 },
  );
  if (smokeResult.exitCode !== 0) {
    logError(
      `native-module smoke check failed on VPS (exit ${smokeResult.exitCode}): ${truncate(smokeResult.stderr, 500)}`,
    );
    logError(
      "  → better-sqlite3 binding did not load. Aborting before pm2 restart — old brain still running.",
    );
    return 1;
  }
  info("sync code: native-module smoke check passed");

  // 7. SSH restart brain-mcp-server via PM2 — only after smoke confirms binding loads.
  info(`sync code: ssh ${vps.user}@${vps.host} -- pm2 restart ${pm2AppName}`);
  const sshResult = await sshExec(
    vps.user,
    vps.host,
    `pm2 restart ${pm2AppName}`,
  );
  if (sshResult.exitCode !== 0) {
    logError(
      `ssh restart failed (exit ${sshResult.exitCode}): ${truncate(sshResult.stderr, 500)}`,
    );
    return 1;
  }
  info("sync code: pm2 restart issued");

  // 8. Health check (best-effort — service may still be restarting).
  // Wait briefly so the restart has a chance to settle.
  await sleep(opts.postRestartDelayMs ?? 2_000);
  const health = await healthCheck(remote.url);
  if (health.statusCode === 200) {
    info(`sync code: health OK — ${truncate(health.body, 200)}`);
  } else {
    warn(
      `sync code: health check did not return 200 (got ${health.statusCode ?? "unreachable"}). The service may still be starting up.`,
    );
  }

  info("sync code: complete");
  return 0;
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
