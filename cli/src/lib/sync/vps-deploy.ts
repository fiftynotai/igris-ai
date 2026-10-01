/**
 * BR-116 — the VPS deploy workspace protocol: pure builders and parsers for
 * `igris sync code`. The remote workspace `<repo>/.igris-deploy/` (layout,
 * `rc` grammar, lock + swap-marker semantics, SWAP_SET) is a cross-version
 * contract — see the MAINTAINING.md row "VPS deploy workspace protocol".
 *
 * Every remote command is a POSIX-sh string whose first word is a
 * `: igris-deploy:<step>` marker; the runner avoids the bash-4 constructs
 * `vps-deploy.test.ts` lints for.
 */

import { nodeMajorSupported, SUPPORTED_NODE_RANGE } from "../preflight.js";

export const DEPLOY_DIR_NAME = ".igris-deploy";

/** Swapped as a unit, in this order (rollback walks the same order). */
export const SWAP_SET = [
  "node_modules",
  "brain-mcp-server/node_modules",
  "cli/node_modules",
  "brain-mcp-server/dist",
] as const;

/** The stage copy's excludes. `.igris-deploy/` stops it copying into itself. */
export const STAGE_EXCLUDES = [
  "node_modules/",
  ".git/",
  "dist/",
  "dist.tmp/",
  `${DEPLOY_DIR_NAME}/`,
] as const;

/** Instantiates the addon: `require` alone never loads the binding (it is lazy). */
export const SMOKE_JS = 'const D=require("better-sqlite3");new D(":memory:").close()';

// TD-487: the install fingerprint lives INSIDE the tree it describes, so every
// swap, rollback and restore carries it (MAINTAINING "VPS deploy workspace protocol").
export const INSTALL_FP_FILE = "node_modules/.igris-install-fp";

/** Never reused: transformers' runtime model cache (`src/env.js` DEFAULT_CACHE_DIR), and the marker. */
export const REUSE_EXCLUDES = ["@huggingface/transformers/.cache/", "/.igris-install-fp"] as const;

const NM_RELS = SWAP_SET.filter((r) => r.endsWith("node_modules"));

// sha256 of node/npm (argv), ABI, platform, arch, the lockfile, root + workspace
// package.json and .npmrc. Prints nothing and exits 1 on any doubt (→ npm ci).
// Not hashed: libc/kernel — the reuse smoke loads better-sqlite3 only, on the tree this host already runs.
export const FP_JS =
  'try{const[n,v]=process.argv.slice(1);if(!n||!v)throw 0;const f=require("fs"),h=require("crypto").createHash("sha256");' +
  'const w=JSON.parse(f.readFileSync("package.json","utf8")).workspaces||[];' +
  'if(!Array.isArray(w)||!w.every(x=>typeof x=="string"&&/^[\\w-][\\w.-]*(\\/[\\w-][\\w.-]*)*$/.test(x)))throw 0;' +
  'h.update(["igris-install-fp/1",n,v,process.versions.modules,process.platform,process.arch].join("\\0"));' +
  'for(const x of["package-lock.json","package.json",...w.map(d=>d+"/package.json"),".npmrc"]){let b;' +
  'try{b=f.readFileSync(x)}catch(e){if(x==".npmrc"&&e.code=="ENOENT"){h.update("\\0.npmrc\\0-");continue}throw e}' +
  'h.update("\\0"+x+"\\0"+b.length+"\\0");h.update(b)}console.log("v1-"+h.digest("hex"))}catch(e){process.exit(1)}';

const RUN_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$/;
const APP_RE = /^[A-Za-z0-9._-]+$/;

/** Shell single-quoting for one value embedded in a remote command. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function isValidRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}

export function isValidAppName(name: string): boolean {
  return APP_RE.test(name);
}

/** `YYYYMMDDTHHMMSSZ-<4 hex>` (UTC). */
export function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const hex = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `${ts}-${hex}`;
}

// A pid is a live runner iff it answers kill -0 AND its args name run.sh
// (guards pid reuse; needs a procps/BSD `ps` — the preflight refuses without
// one; BusyBox is untested). A lock with no pid yet is held for ~1-2 min.
const ALIVE_FN =
  'alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null && case "$(ps -p "$1" -o args= 2>/dev/null)" in *run.sh*) return 0;; esac; return 1; }\n' +
  'held() { p=$(cat "$D/lock/pid" 2>/dev/null); if [ -n "$p" ]; then alive "$p"; else [ -n "$(find "$D/lock" -maxdepth 0 -mmin -2 2>/dev/null)" ]; fi; }';

// Restore-from-prev, run from inside the workspace. Idempotent: a rel is moved
// back when prev/ holds it, and a NEW-only rel (journaled `stage->live`, no
// prev) is moved to failed/ once. The runner's rollback runs this same text.
const RESTORE_SH =
  'h() { [ -e "$1" ] || [ -L "$1" ]; }; ok=1; for rel in ' +
  SWAP_SET.join(" ") +
  '; do if h "prev/$rel" || { grep -Fqx "stage->live $rel" journal 2>/dev/null && ! h "failed/$rel"; }; then ' +
  'if h "../$rel"; then mkdir -p "$(dirname "failed/$rel")" && mv "../$rel" "failed/$rel" || { ok=0; continue; }; fi; ' +
  'if h "prev/$rel"; then mv "prev/$rel" "../$rel" || ok=0; fi; fi; done; [ $ok -eq 1 ]';

function head(step: string, repoPath: string): string {
  return `: igris-deploy:${step}; R=${shellQuote(repoPath)}; D="$R/${DEPLOY_DIR_NAME}"`;
}

/** The detached runner (D2): stage → install → build → smoke → swap → live smoke. */
function checkRunId(id: string): void {
  if (!isValidRunId(id)) throw new Error(`invalid run id: ${id}`);
}

function checkApp(app: string): void {
  if (!isValidAppName(app)) throw new Error(`invalid pm2 app name: ${app}`);
}

export function buildRunnerScript(repoPath: string, runId: string): string {
  checkRunId(runId);
  const excl = STAGE_EXCLUDES.map((p) => `--exclude=${p}`).join(" ");
  const rexcl = REUSE_EXCLUDES.map((p) => `--exclude=${p}`).join(" ");
  return [
    "set -u",
    `R=${shellQuote(repoPath)}; ID=${runId}; SMOKE=${shellQuote(SMOKE_JS)}; FPJS=${shellQuote(FP_JS)}`,
    `D="$R/${DEPLOY_DIR_NAME}"; RUN="$D/runs/$ID"; PHASE=prepare; IS=; BS=; RB=0; RBS=; FP=; INST=; WHY=`,
    `SWAP='${SWAP_SET.join(" ")}'; NM='${NM_RELS.join(" ")}'; FPF=${INSTALL_FP_FILE}`,
    'fin() { { echo "code=$1"; echo "phase=$PHASE"; echo "rolled_back=$RB"; echo "rollback_smoke=$RBS"; echo "node=$(node --version 2>/dev/null)"; echo "install_s=$IS"; echo "build_s=$BS"; echo "install=$INST"; echo "install_why=$WHY"; } > "$RUN/rc.tmp" && mv -f "$RUN/rc.tmp" "$RUN/rc"; }',
    'ex() { c=$?; [ -f "$RUN/rc" ] || fin "$c"; [ "$(cat "$D/lock/run_id" 2>/dev/null)" = "$ID" ] && rm -rf "$D/lock"; }',
    "trap ex EXIT",
    'ph() { PHASE=$1; echo "$1" > "$RUN/phase.tmp" && mv -f "$RUN/phase.tmp" "$RUN/phase"; echo "=== igris-deploy phase=$1 start $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="; }',
    'die() { fin "$1"; exit "$1"; }',
    'has() { [ -e "$1" ] || [ -L "$1" ]; }',
    'smoke() { (cd "$1/brain-mcp-server" && node -e "$SMOKE"); }',
    // Copy the live NM rels into stage $1; refuse absolute links (they would
    // resolve into the live tree); then smoke the copy. Any failure → npm ci.
    `reuse() { for rel in $NM; do has "$R/$rel" || continue; mkdir -p "$1/$rel" && rsync -a ${rexcl} "$R/$rel/" "$1/$rel/" || return 1; AL=$(find "$1/$rel" -type l -lname '/*') || return 1; if [ -n "$AL" ]; then echo "reuse: absolute symlink under $rel"; return 1; fi; done; smoke "$1"; }`,
    "ph prepare",
    'echo $$ > "$RUN/pid"',
    'ls -1 "$D/runs" | sort -r | tail -n +6 | while read -r o; do [ "$o" = "$ID" ] || rm -rf "$D/runs/$o"; done',
    'rm -rf "$D/stage" "$D/prev" "$D/failed" "$D/journal"',
    "ph stage",
    `mkdir -p "$D/stage" && rsync -a --delete ${excl} "$R/" "$D/stage/" || die $?`,
    'FP=$(cd "$D/stage" && node -e "$FPJS" "$(node --version 2>/dev/null)" "$(npm --version 2>/dev/null)" 2>/dev/null); OLD=$(cat "$R/$FPF" 2>/dev/null); INST=ran',
    'if [ -z "$FP" ]; then WHY=unfingerprinted; elif [ -z "$OLD" ]; then WHY=first; elif [ "$FP" != "$OLD" ]; then WHY=changed; else INST=skipped; fi',
    'echo "install=$INST why=$WHY fp=$FP recorded=$OLD"; T=$(date +%s)',
    'if [ "$INST" = skipped ]; then ph reuse; reuse "$D/stage" || { echo "reuse failed, falling back to npm ci"; INST=ran; WHY=reuse-failed; }; fi',
    'if [ "$INST" = ran ]; then ph install; for rel in $NM; do rm -rf "$D/stage/$rel"; done; (cd "$D/stage" && npm ci --no-audit --no-fund); c=$?; IS=$(( $(date +%s) - T )); [ $c -eq 0 ] || die $c; fi',
    'IS=$(( $(date +%s) - T ))',
    "ph build",
    'T=$(date +%s); (cd "$D/stage/brain-mcp-server" && npm run build); c=$?; BS=$(( $(date +%s) - T )); [ $c -eq 0 ] || die $c',
    "ph smoke-stage",
    'smoke "$D/stage" || die $?',
    "ph swap",
    ': > "$D/journal" && echo "swap $ID" > "$D/swap.inprogress" || die 1',
    'for rel in $SWAP; do',
    '  if has "$R/$rel"; then mkdir -p "$(dirname "$D/prev/$rel")" && mv "$R/$rel" "$D/prev/$rel" || die 1; fi',
    '  if has "$D/stage/$rel"; then echo "stage->live $rel" >> "$D/journal" && mv "$D/stage/$rel" "$R/$rel" || die 1; fi',
    "done",
    'rm -f "$D/swap.inprogress"',
    "ph smoke-live",
    'smoke "$R"; c=$?',
    'if [ $c -ne 0 ]; then',
    '  echo "rollback $ID" > "$D/swap.inprogress"',
    `  if (cd "$D" && ${RESTORE_SH}); then rm -f "$D/swap.inprogress"; RB=1; if smoke "$R"; then RBS=ok; else RBS=fail; fi; fi`,
    "  die $c",
    "fi",
    // Acknowledged only now: a run that fails before this line writes no new marker.
    '[ -z "$FP" ] || { echo "$FP" > "$R/$FPF.tmp" && mv -f "$R/$FPF.tmp" "$R/$FPF"; }',
    "ph done",
    'rm -rf "$D/stage"',
    "die 0",
    "",
  ].join("\n");
}

/** Preflight (D3.2): node/npm versions, busy lock, swap marker, disk numbers. */
export function buildPreflightCommand(repoPath: string): string {
  return [
    head("preflight", repoPath),
    ALIVE_FN,
    'echo "node=$(node --version 2>/dev/null)"; echo "npm=$(npm --version 2>/dev/null)"',
    'if command -v ps >/dev/null 2>&1; then echo ps=1; else echo ps=0; fi',
    'if [ -d "$D/lock" ]; then b=$(cat "$D/lock/run_id" 2>/dev/null); if held; then echo busy=1; echo "busy_run=$b"; echo "busy_phase=$(cat "$D/runs/$b/phase" 2>/dev/null)"; else echo busy=0; fi; else echo busy=0; fi',
    'if [ -f "$D/swap.inprogress" ]; then echo swap_marker=1; sed "s/^/journal=/" "$D/swap.inprogress" "$D/journal" 2>/dev/null; else echo swap_marker=0; fi',
    'echo "avail_kb=$(df -Pk "$R" 2>/dev/null | awk \'NR==2{print $4}\')"',
    'echo "nm_kb=$(du -sk "$R/node_modules" "$R/brain-mcp-server/node_modules" 2>/dev/null | awk \'{s+=$1} END{print s+0}\')"',
    'echo "prev_kb=$(du -sk "$D/prev" 2>/dev/null | awk \'{s+=$1} END{print s+0}\')"',
  ].join("\n");
}

/**
 * Launch (D3.4): re-check marker + lock (atomic mkdir), write run.sh, start it
 * detached with EVERY fd redirected — otherwise sshd holds the channel open
 * and this ssh blocks until the runner exits.
 */
export function buildLaunchCommand(repoPath: string, runId: string): string {
  const script = buildRunnerScript(repoPath, runId);
  return [
    head("launch", repoPath) + `; ID=${runId}; RUN="$D/runs/$ID"`,
    ALIVE_FN,
    'mkdir -p "$D" || exit 1',
    'if [ -e "$D/swap.inprogress" ]; then echo state=interrupted-swap; exit 0; fi',
    'if ! mkdir "$D/lock" 2>/dev/null; then if held; then echo state=busy; echo "run=$(cat "$D/lock/run_id" 2>/dev/null)"; exit 0; fi; rm -rf "$D/lock"; mkdir "$D/lock" || { echo state=busy; exit 0; }; fi',
    'mkdir -p "$RUN" && echo "$ID" > "$D/lock/run_id" || exit 1',
    `printf '%s' ${shellQuote(script)} > "$RUN/run.sh" || exit 1`,
    "cd / || exit 1",
    'if command -v setsid >/dev/null 2>&1; then L="setsid nohup"; else L=nohup; fi',
    '$L bash "$RUN/run.sh" </dev/null >>"$RUN/log" 2>&1 &',
    'P=$!; echo $P > "$RUN/pid"; echo $P > "$D/lock/pid" 2>/dev/null; echo state=launched; echo "pid=$P"',
  ].join("\n");
}

/** Poll (D3.5): `alive` is read BEFORE `rc` — that order makes "died" race-free. */
export function buildPollCommand(repoPath: string, runId: string): string {
  checkRunId(runId);
  return [
    head("poll", repoPath) + `; RUN="$D/runs/${runId}"`,
    ALIVE_FN,
    'if alive "$(cat "$RUN/pid" 2>/dev/null)"; then echo alive=1; else echo alive=0; fi',
    'echo "phase=$(cat "$RUN/phase" 2>/dev/null)"',
    'if [ -f "$RUN/rc" ]; then sed "s/^/rc./" "$RUN/rc"; fi',
  ].join("\n");
}

export function buildTailCommand(repoPath: string, runId: string): string {
  checkRunId(runId);
  return `${head("tail", repoPath)}; tail -n 400 "$D/runs/${runId}/log"`;
}

export function buildRestartCommand(app: string): string {
  checkApp(app);
  return `: igris-deploy:restart; pm2 restart ${app}`;
}

// Runs ON the VPS: `pm2 jlist` carries each process's env (secrets), so only
// six fields ever cross the wire. Banner lines ("[PM2] ...") are skipped by
// seeking the JSON array start; a parse error never echoes the input.
const PM2_FILTER_JS =
  'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{let o;try{const i=s.search(/^\\[[{\\]]/m);' +
  'const a=JSON.parse(i<0?"":s.slice(i).split("\\n")[0]);const p=a.find(x=>x.name===process.argv[1]);' +
  "const e=p&&p.pm2_env||{};o=p?{found:true,status:e.status,restarts:e.restart_time,unstable:e.unstable_restarts," +
  'node:e.node_version,uptime_ms:e.pm_uptime?Date.now()-e.pm_uptime:null}:{found:false}}catch(x){o={error:"unparseable pm2 jlist"}}' +
  "console.log(JSON.stringify(o))})";

export function buildPm2StatusCommand(app: string): string {
  checkApp(app);
  return `: igris-deploy:pm2; pm2 jlist 2>/dev/null | node -e ${shellQuote(PM2_FILTER_JS)} ${app}`;
}

export function buildNodeVersionCommand(): string {
  return "node --version";
}

/** Printed (never run): deletes the marker, so the next deploy runs `npm ci` (TD-487). */
export function buildForceInstallCommand(repoPath: string): string {
  return `rm -f ${shellQuote(`${repoPath}/${INSTALL_FP_FILE}`)}`;
}

/** Manual restore-from-prev, printed (never run) after an interrupted swap or a failed restart. */
export function buildRestoreCommand(repoPath: string, app: string): string {
  checkApp(app);
  return `cd ${shellQuote(repoPath)}/${DEPLOY_DIR_NAME} && { ${RESTORE_SH}; } && rm -f swap.inprogress && pm2 restart ${app}`;
}

/** `key=value` lines → record (last wins). */
export function parseKv(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) r[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return r;
}

export type RunnerState =
  | { kind: "running"; phase: string }
  | {
      kind: "finished";
      code: number;
      phase: string;
      rolledBack: boolean;
      rollbackSmoke: string;
      node: string;
      installS: string;
      buildS: string;
      install: string;
      installWhy: string;
    }
  | { kind: "died"; phase: string }
  | { kind: "unknown" };

/** rc present → finished (whatever `alive` says); no rc + alive=0 → died. */
export function parseRunnerState(out: string): RunnerState {
  const kv = parseKv(out);
  const code = kv["rc.code"];
  if (code !== undefined && /^\d+$/.test(code)) {
    return {
      kind: "finished",
      code: parseInt(code, 10),
      phase: kv["rc.phase"] ?? "",
      rolledBack: kv["rc.rolled_back"] === "1",
      rollbackSmoke: kv["rc.rollback_smoke"] ?? "",
      node: kv["rc.node"] ?? "",
      installS: kv["rc.install_s"] ?? "",
      buildS: kv["rc.build_s"] ?? "",
      install: kv["rc.install"] ?? "",
      installWhy: kv["rc.install_why"] ?? "",
    };
  }
  const phase = kv.phase ?? "";
  if (kv.alive === "0") return { kind: "died", phase };
  if (kv.alive === "1") return { kind: "running", phase };
  return { kind: "unknown" };
}

export interface Pm2Status {
  found: boolean;
  status: string | null;
  restarts: number | null;
  node: string | null;
  error: string | null;
}

/** Reads ONLY the filtered keys; takes the last JSON-object line. */
export function parsePm2Status(out: string): Pm2Status {
  const none: Pm2Status = { found: false, status: null, restarts: null, node: null, error: null };
  const line = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (line === undefined) return { ...none, error: "no pm2 status output" };
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (typeof o.error === "string") return { ...none, error: o.error };
    if (o.found !== true) return none;
    return {
      found: true,
      status: typeof o.status === "string" ? o.status : null,
      restarts: typeof o.restarts === "number" ? o.restarts : null,
      node: typeof o.node === "string" ? o.node : null,
      error: null,
    };
  } catch {
    return { ...none, error: "malformed pm2 status output" };
  }
}

const SIGNALS: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  6: "SIGABRT",
  9: "SIGKILL",
  13: "SIGPIPE",
  15: "SIGTERM",
};

/** 128+N (bash's report of a signal death) → name; null when rc ≤ 128. */
export function signalName(rc: number): string | null {
  if (rc <= 128 || rc > 128 + 64) return null;
  return SIGNALS[rc - 128] ?? `signal ${rc - 128}`;
}

export interface VpsNodeVerdict {
  version: string | null;
  verdict: "within" | "outside" | "unknown";
  message: string;
}

/** The VPS Node version vs SUPPORTED_NODE_RANGE (MAINTAINING row 154 consumer). */
export function classifyVpsNode(versionOutput: string): VpsNodeVerdict {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
  if (m === null) {
    return { version: null, verdict: "unknown", message: "unknown" };
  }
  const version = `v${m[1]}.${m[2]}.${m[3]}`;
  if (nodeMajorSupported(parseInt(m[1], 10))) {
    return { version, verdict: "within", message: `${version} — within engines range ${SUPPORTED_NODE_RANGE}` };
  }
  return {
    version,
    verdict: "outside",
    message:
      `${version} — OUTSIDE engines range ${SUPPORTED_NODE_RANGE} (warning only: npm does not enforce ` +
      "engines; measured better-sqlite3 prebuild gaps at Node 20/21/23 — MAINTAINING.md, the supported " +
      "Node range row — so an install there can compile from source)",
  };
}

// No `reuse` entry: a reuse failure falls back to npm ci, so only a death ends there.
const PHASE_CMD: Record<string, string> = {
  stage: "the stage copy (rsync)",
  install: "npm ci",
  build: "npm run build",
  "smoke-stage": "the native smoke (stage)",
  "smoke-live": "the native smoke (live)",
  swap: "the swap",
};

const NOISE_RE = /^npm (warn|notice|verb|verbose|timing|http)\b/i;
const NPM_ERR_RE = /^npm (error|ERR!)/i;

/**
 * AC-4: headline the failing phase + the real exit code/signal; quote npm's
 * error lines (else the last 15 non-noise lines); never an EBADENGINE line.
 */
export function summarizeRemoteFailure(
  log: string,
  state: { kind: "finished"; code: number; phase: string } | { kind: "died"; phase: string },
  ctx: { vpsNode?: string; logRef: string },
): string[] {
  const marker = `=== igris-deploy phase=${state.phase} start`;
  const at = log.lastIndexOf(marker);
  const sliced = at >= 0 ? log.slice(at) : log;
  let suppressed = 0;
  let ebad = 0;
  const kept: string[] = [];
  for (const raw of sliced.split("\n")) {
    const line = raw.trimEnd();
    if (line.length === 0 || line.startsWith("=== igris-deploy phase=")) continue;
    if (NOISE_RE.test(line)) {
      suppressed += 1;
      if (/EBADENGINE/.test(line)) ebad += 1;
      continue;
    }
    kept.push(line);
  }
  const errs = kept.filter((l) => NPM_ERR_RE.test(l));
  const shown = errs.length > 0 ? errs.slice(0, 15) : kept.slice(-15);
  const cmd = PHASE_CMD[state.phase] ?? `phase ${state.phase || "(unknown)"}`;
  let headline: string;
  if (state.kind === "died") {
    headline = `runner died during ${state.phase || "(unknown phase)"} — no exit code recorded (killed externally?)`;
  } else {
    const sig = signalName(state.code);
    headline =
      sig !== null
        ? `${state.phase} failed — ${cmd} killed by ${sig} (rc ${state.code})` +
          (sig === "SIGKILL" ? ", possibly the kernel OOM killer" : "")
        : `${state.phase} failed — ${cmd} exited ${state.code}` +
          (kept.length === 0 ? ` with no error output (${suppressed} warning lines suppressed)` : "");
  }
  const lines = [headline, ...shown.map((l) => `  | ${l}`)];
  if (ebad > 0) {
    const node = ctx.vpsNode !== undefined ? classifyVpsNode(ctx.vpsNode) : null;
    const where = node !== null && node.version !== null ? `; VPS Node ${node.version} is ${node.verdict === "within" ? "within" : "OUTSIDE"} ${SUPPORTED_NODE_RANGE}` : "";
    lines.push(
      `(${ebad} EBADENGINE warning lines suppressed — npm does not enforce engines, so these are warnings, not the failure${where})`,
    );
  }
  lines.push(`full log: ${ctx.logRef}`);
  return lines;
}

/** The `sync status` "vps node:" value for one `node --version` probe result. */
export function formatVpsNodeLine(probe: { exitCode: number; stdout: string }): string {
  if (probe.exitCode !== 0) return `unknown (ssh probe failed: exit ${probe.exitCode})`;
  return classifyVpsNode(probe.stdout).message;
}
