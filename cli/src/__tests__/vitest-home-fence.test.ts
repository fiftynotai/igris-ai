/**
 * BR-106 — every vitest file that can reach the operator's real `$HOME`
 * fences it. The vitest twin of TD-456's `bats-home-fence.test.ts`.
 *
 * THE INCIDENT (2026-09-08). A sentinel stripped the `HOME`/`IGRIS_BRAIN_DIR`
 * fence from `cli/src/__tests__/http.test.ts` to prove the fence was
 * load-bearing. All three cases still PASSED — and the run overwrote the
 * operator's real `~/.igris/.install-source.json`. The test succeeded BY
 * reading and writing real operator state, so the fence's absence was
 * invisible to the suite. TD-456 built this guard for the bats tier; the
 * vitest tier had none. `home-fence-witness.test.ts` is the RED for the class.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, textual so a reviewer can check it by reading
 * ---------------------------------------------------------------------------
 * There are TWO path tiers, and `IGRIS_BRAIN_DIR` only fences one:
 *
 *   Tier B (brain).  `brainDir()` (`lib/paths.ts:22-28`) prefers
 *     `IGRIS_BRAIN_DIR` and falls back to `join(homedir(), ".igris")`. A test
 *     that reaches it must set `IGRIS_BRAIN_DIR` **or** move `HOME` (moving
 *     HOME relocates the fallback too, so it is strictly stronger).
 *
 *   Tier H (home).   Twelve builders are `homedir()`-only and NO env var
 *     reaches them — `claudeJsonPath`, `geminiSettingsPath`,
 *     `geminiMcpConfigPath`, `geminiHooksPath`, `antigravitySkillsDir`,
 *     `agentsSkillsDir`, `codexConfigPath`, `opencodeConfigPath`,
 *     `claudeSettingsPath`, `antigravitySettingsPath`,
 *     `geminiTrustedFoldersPath`, `expandTilde`. A test that reaches one of
 *     these MUST move `HOME`. This tier is why a file can carry a healthy
 *     `IGRIS_BRAIN_DIR` count and still be exposed — TD-456's finding,
 *     restated for vitest.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCOPE IS DERIVED, NEVER HAND-LISTED
 * ---------------------------------------------------------------------------
 * The brief's own 8-symbol grep was already incomplete, and a hand-list rots
 * the moment a new module calls `homedir()`. So exposure is a TRANSITIVE
 * CLOSURE over function bodies:
 *
 *   seeds   := every top-level function in `cli/src` (excluding `__tests__`)
 *              whose stripped body calls `homedir()`, EXCEPT `brainDir` —
 *              the one such call site with an env seam. That exclusion is
 *              EARNED, not asserted: a test below reds if `brainDir` stops
 *              reading `IGRIS_BRAIN_DIR`.
 *   EXPOSED := least fixed point — S ∈ EXPOSED if S ∈ seeds, or S's body
 *              calls some T ∈ EXPOSED.
 *
 * A test file is IN SCOPE iff its stripped source calls an EXPORTED symbol in
 * EXPOSED. Two deliberate asymmetries:
 *   - the CLOSURE walks every top-level function, exported or not, so an
 *     intra-module chain through a private helper still propagates
 *     (`harnessIds -> loadHarnessDescriptor -> resolveManifestPath`);
 *   - the TEST BOUNDARY matches only EXPORTED names, because a test file can
 *     only call those. Matching private names there produced pure noise —
 *     `code`, `entry`, `resolvePath` collide across modules.
 *
 * Symbol matching is by NAME, so a collision between two modules that export
 * the same identifier OVER-approximates. That is the safe direction for a
 * fence guard: it can demand a fence that was not strictly needed, never
 * excuse one that was.
 *
 * KNOWN-OPEN EVASIONS, documented rather than pretended away (TD-456's habit):
 *   - a fence written inside a `${...}` interpolation reads as string content
 *     and would NOT count (no such code exists in the tier, 2026-09-10);
 *   - a SUT invoked purely through a dynamic `import()` whose specifier is
 *     computed at runtime is invisible to a static scan;
 *   - a method on a class is not a top-level declaration and is not walked.
 *
 * Shape: TD-456's `bats-home-fence.test.ts` — walk by fs path, assert the
 * population (a wrong directory scans nothing and reads "clean"), prove the
 * scanner with planted negatives, and prove each exemption.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const TESTS = HERE;

// ===========================================================================
// Layer 0 — the stripper
// ===========================================================================

export interface StripResult {
  /** Source with comments, string/template literals and regex literals removed. */
  code: string;
  /**
   * Structural surprises. A quoted string or a regex literal cannot span a
   * newline in valid TS, so consuming one means the scanner guessed wrong and
   * is swallowing real code. This is not hypothetical: the first version of
   * this stripper had no regex-literal case, so the `"` inside
   * `brain-bridge.test.ts:78`'s `/\bfrom\s+"(\.\/[^"]+\.js)"/g` opened a
   * phantom string that ate lines 78-90 — including that file's real
   * `process.env.IGRIS_BRAIN_DIR =` fence, which then read as UNFENCED. The
   * corpus assertion below pins this at zero.
   */
  anomalies: string[];
}

/**
 * Remove comments, string/template literals and regex literals, preserving
 * line structure. Exported and asserted directly: a stripper that silently
 * did nothing would make every vacuity control below pass.
 */
export function stripCommentsAndStrings(src: string): StripResult {
  const anomalies: string[] = [];
  let out = "";
  let i = 0;
  let line = 1;
  const n = src.length;

  const lastSig = (): string => {
    for (let k = out.length - 1; k >= 0; k--) {
      const c = out[k]!;
      if (!/\s/.test(c)) return c;
    }
    return "";
  };
  // `/` opens a regex only in value position. After an identifier, `)` or `]`
  // it is division. The keyword list covers `return /re/.test(x)`.
  const IDENT_ONLY = /^[A-Za-z_$][\w$]*$/;
  const REGEX_OK = new Set(["", "(", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "~", "^", "<", ">", "{", "}", "["]);
  const endsWithKeyword = (): boolean =>
    /(?:^|[^\w$])(return|typeof|case|in|of|do|else|yield|await|new|delete|void|instanceof|throw)\s*$/.test(out);

  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "\n") { out += "\n"; line++; i++; continue; }
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") { out += "\n"; line++; } i++; }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      const startLine = line;
      const contentStart = i + 1;
      i++;
      let closed = false;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) { i++; closed = true; break; }
        if (src[i] === "\n") break; // RECOVER at the newline rather than cascading
        i++;
      }
      if (!closed) anomalies.push(`unterminated ${q} string at line ${startLine}`);
      // A string whose content is a BARE IDENTIFIER is kept, quoted. It cannot
      // fake an assignment, and `process.env["HOME"] = x` is a real fence form
      // that erasing the literal would make undetectable. Anything richer —
      // and `"process.env.HOME = tmp"` is richer — is erased.
      const content = src.slice(contentStart, closed ? i - 1 : i);
      out += IDENT_ONLY.test(content) ? `"${content}"` : '""';
      continue;
    }
    if (c === "`") {
      const startLine = line;
      i++;
      let depth = 0;
      let closed = false;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "\n") { out += "\n"; line++; i++; continue; }
        if (depth === 0 && src[i] === "$" && src[i + 1] === "{") { depth = 1; i += 2; continue; }
        if (depth > 0) {
          const ch = src[i];
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          else if (ch === "'" || ch === '"' || ch === "`") {
            const q2 = ch;
            i++;
            while (i < n) {
              if (src[i] === "\\") { i += 2; continue; }
              if (src[i] === q2) break;
              if (src[i] === "\n") { out += "\n"; line++; }
              i++;
            }
          }
          i++;
          continue;
        }
        if (src[i] === "`") { i++; closed = true; break; }
        i++;
      }
      if (!closed) anomalies.push(`unterminated template at line ${startLine}`);
      continue;
    }
    if (c === "/" && (REGEX_OK.has(lastSig()) || endsWithKeyword())) {
      const startLine = line;
      i++;
      let inClass = false;
      let closed = false;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "\n") break; // RECOVER: a regex literal cannot span a line
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { i++; closed = true; break; }
        i++;
      }
      if (!closed) anomalies.push(`unterminated regex at line ${startLine}`);
      while (i < n && /[a-z]/.test(src[i]!)) i++; // flags
      continue;
    }
    out += c;
    i++;
  }
  return { code: out, anomalies };
}

const strip = (src: string): string => stripCommentsAndStrings(src).code;

// ===========================================================================
// Layer A — the symbol table and the exposure closure
// ===========================================================================

export interface SymbolTable {
  /** name -> concatenated bodies (a name declared twice is over-approximated). */
  bodies: Map<string, string>;
  /** name -> the file that first declared it. */
  owner: Map<string, string>;
  /** Names reachable from a test file. */
  exported: Set<string>;
}

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTs(p, acc);
    else if (e.name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

function matchDelim(code: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === open) depth++;
    else if (code[i] === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** `idx` points at the `(` or `<` that opens the signature. */
function bodyFrom(code: string, idx: number): string {
  let i = idx;
  if (code[i] === "<") {
    const g = matchDelim(code, i, "<", ">");
    if (g < 0) return "";
    i = code.indexOf("(", g);
    if (i < 0) return "";
  }
  // Skip the WHOLE parameter list before looking for the body brace — an
  // inline object type (`opts?: { claudeJsonPath?: string }`) otherwise reads
  // as the body and the function's real calls become invisible.
  const close = matchDelim(code, i, "(", ")");
  if (close < 0) return "";
  const open = code.indexOf("{", close);
  if (open < 0) return "";
  const end = matchDelim(code, open, "{", "}");
  return end < 0 ? code.slice(open + 1) : code.slice(open + 1, end);
}

const DECL = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]/g;
const ARROW = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s*)?\(/g;

export function buildSymbolTable(moduleFiles: string[]): SymbolTable {
  const bodies = new Map<string, string>();
  const owner = new Map<string, string>();
  const exported = new Set<string>();
  for (const file of moduleFiles) {
    const code = strip(readFileSync(file, "utf-8"));
    for (const re of [DECL, ARROW]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        const name = m[1]!;
        if (/\bexport\s/.test(m[0])) exported.add(name);
        const body = bodyFrom(code, m.index + m[0].length - 1);
        bodies.set(name, `${bodies.get(name) ?? ""}\n${body}`);
        if (!owner.has(name)) owner.set(name, file);
      }
    }
    for (const g of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
      for (const part of g[1]!.split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0]!.trim();
        if (name) exported.add(name);
      }
    }
  }
  return { bodies, owner, exported };
}

const calls = (body: string, name: string): boolean =>
  new RegExp(`\\b${name}\\s*\\(`).test(body);

/** Least fixed point: S is in the set if it is a seed or calls a member. */
export function closeOver(bodies: Map<string, string>, seeds: string[]): Set<string> {
  const out = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, body] of bodies) {
      if (out.has(name)) continue;
      for (const member of out) {
        if (member === name) continue;
        if (calls(body, member)) { out.add(name); changed = true; break; }
      }
    }
  }
  return out;
}

// ===========================================================================
// Layer B — the fence predicate
// ===========================================================================

/**
 * An assignment whose right-hand side is a SAVED value is a RESTORE, not a
 * fence — and this distinction is not academic. `http.test.ts`'s TD-301
 * repair (2026-09-08) created a `brainRoot`, backed up `IGRIS_BRAIN_DIR` and
 * `HOME`, wrote a fixture record, and restored both keys in `afterEach` — but
 * NEVER ASSIGNED either key. The only `process.env.HOME =` in the file was
 * the `afterEach` restore, so a naive predicate read it as fenced while
 * `writeInstallSource()` went on resolving `brainDir()` to the operator's real
 * `~/.igris/`. Measured at e908493 with the belt off: the file wrote
 * `<HOME>/.igris/.install-source.json`, byte-identical to the operator's real
 * record. A fence must assign a FRESH value.
 */
const RESTORE_RHS = /(saved|prev|backup|orig|initial|restore)/i;

/** `process.env.<key>` is assigned a value that is not a restore of a saved one. */
export function assignsFreshEnv(strippedCode: string, key: string): boolean {
  const forms = [
    new RegExp(`\\bprocess\\s*\\.\\s*env\\s*\\.\\s*${key}\\s*=([^;\\n]*)`, "g"),
    new RegExp(`\\bprocess\\s*\\.\\s*env\\s*\\[\\s*["\']${key}["\']\\s*\\]\\s*=([^;\\n]*)`, "g"),
  ];
  for (const re of forms) {
    for (const m of strippedCode.matchAll(re)) {
      const rhs = m[1]!;
      if (rhs.startsWith("=")) continue; // `===` / `==`, a comparison
      if (!RESTORE_RHS.test(rhs)) return true;
    }
  }
  return false;
}

/**
 * Stripping strings rejects `const hint = "process.env.HOME = tmp"`.
 * Stripping comments rejects the TD-456 failure verbatim. `assignsFreshEnv`
 * rejects the restore-only shape above.
 */
const HOME_FENCE_FORMS: ReadonlyArray<readonly [string, RegExp]> = [
  ["shared helper", /\bfenceHome\s*\(/],
  // `tarball.test.ts` fences a CHILD process with a `HOME: fakeHome` key in
  // the `env` object of its `node` spawn (locate by NAME — a line number
  // there has drifted repeatedly, including on this brief's own docblock
  // edits). It is a real fence idiom, and the brief's own grep was blind to
  // it — omitting this form makes that file a permanent false positive.
  ["child env", /(^|[\s{,])HOME\s*:/m],
];

const BRAIN_FENCE_FORMS: ReadonlyArray<readonly [string, RegExp]> = [
  ["child env", /(^|[\s{,])IGRIS_BRAIN_DIR\s*:/m],
];

export function fencesHome(strippedCode: string): boolean {
  return (
    assignsFreshEnv(strippedCode, "HOME") ||
    HOME_FENCE_FORMS.some(([, re]) => re.test(strippedCode))
  );
}

/** A HOME fence also relocates `brainDir()`'s fallback, so it satisfies Tier B. */
export function fencesBrainDir(strippedCode: string): boolean {
  return (
    fencesHome(strippedCode) ||
    assignsFreshEnv(strippedCode, "IGRIS_BRAIN_DIR") ||
    BRAIN_FENCE_FORMS.some(([, re]) => re.test(strippedCode))
  );
}

// ===========================================================================
// The scan
// ===========================================================================

export interface VitestFenceScan {
  scanned: string[];
  seeds: string[];
  homeExposed: Set<string>;
  brainExposed: Set<string>;
  inScopeHome: string[];
  inScopeBrain: string[];
  unfencedHome: string[];
  unfencedBrain: string[];
  /** Files that fence HOME and then swap `process.env` wholesale. */
  disarmed: string[];
  anomalies: string[];
  table: SymbolTable;
}

/**
 * `process.env = saved` replaces libuv's live environment with a plain object.
 * Every later `process.env.HOME = x` then writes to that object and never
 * reaches `getenv`, so `os.homedir()` keeps the value it had at the swap. In a
 * file with a per-test HOME fence, test 2 onwards silently run under TEST 1's
 * fence. BR-106 found this live in the three `boot-sync*` suites the moment a
 * fence was added to them — the fence threw `NOT ARMED` on the second test.
 */
export function swapsProcessEnv(strippedCode: string): boolean {
  return /^\s*process\s*\.\s*env\s*=[^=]/m.test(strippedCode);
}

export function scanVitestHomeFence(srcRoot: string, testsDir: string): VitestFenceScan {
  // The two roots are walked SEPARATELY so a control can point `testsDir` at a
  // planted directory outside `cli/src` and still be scanned against the real
  // module graph. Filtering one walk by prefix silently scanned nothing there.
  const moduleFiles = walkTs(srcRoot).filter((p) => !p.startsWith(`${testsDir}/`));
  const testFiles = walkTs(testsDir).filter((p) => p.endsWith(".test.ts"));
  const table = buildSymbolTable(moduleFiles);

  const seeds = [...table.bodies.keys()]
    .filter((n) => n !== "brainDir" && /\bhomedir\s*\(/.test(table.bodies.get(n)!))
    .sort();
  const homeExposed = closeOver(table.bodies, seeds);
  const brainExposed = closeOver(table.bodies, ["brainDir"]);

  const scanned: string[] = [];
  const inScopeHome: string[] = [];
  const inScopeBrain: string[] = [];
  const unfencedHome: string[] = [];
  const unfencedBrain: string[] = [];
  const disarmed: string[] = [];
  const anomalies: string[] = [];

  for (const file of testFiles) {
    const rel = relative(testsDir, file);
    scanned.push(rel);
    const res = stripCommentsAndStrings(readFileSync(file, "utf-8"));
    for (const a of res.anomalies) anomalies.push(`${rel}: ${a}`);
    const code = res.code;
    const reaches = (set: Set<string>): boolean => {
      for (const s of set) if (table.exported.has(s) && calls(code, s)) return true;
      return false;
    };
    if (fencesHome(code) && swapsProcessEnv(code)) disarmed.push(rel);
    if (reaches(homeExposed)) {
      inScopeHome.push(rel);
      if (!fencesHome(code)) unfencedHome.push(rel);
    }
    if (reaches(brainExposed)) {
      inScopeBrain.push(rel);
      if (!fencesBrainDir(code)) unfencedBrain.push(rel);
    }
  }
  return { scanned, seeds, homeExposed, brainExposed, inScopeHome, inScopeBrain, unfencedHome, unfencedBrain, disarmed, anomalies, table };
}

/**
 * Files in scope that pass WITHOUT a textual fence, each with the reason.
 * Bounded rather than open: three self-checks below stop it rotting into an
 * allowlist. An exemption is NEVER satisfied by a comment — the pass
 * condition is always a recorded structural fact about the file.
 */
export const TRIAGED_EXEMPT: Readonly<Record<string, string>> = {};

const EXEMPT_CAP = 3;

// A single scan, reused: walking `cli/src` 20 times is the slow part.
const SCAN = scanVitestHomeFence(SRC, TESTS);

// ===========================================================================
// The whole-tier assertions
// ===========================================================================

describe("BR-106 — every file in cli/src/__tests__ that can reach the real $HOME fences it", () => {
  it("Tier H: no file reaching a homedir()-only builder is unfenced (cli/src/__tests__)", () => {
    expect(SCAN.unfencedHome.filter((f) => !(f in TRIAGED_EXEMPT))).toEqual([]);
  });

  it("Tier B: no file reaching brainDir() is unfenced by BOTH HOME and IGRIS_BRAIN_DIR", () => {
    expect(SCAN.unfencedBrain.filter((f) => !(f in TRIAGED_EXEMPT))).toEqual([]);
  });

  it("no HOME-fenced file swaps process.env wholesale (that DISARMS the fence)", () => {
    // Not hypothetical: adding a fence to boot-sync.test.ts,
    // boot-sync-normalize.test.ts and boot-sync-project-path-guard.test.ts
    // made 36 cases throw `home fence NOT ARMED: homedir() is <test 1's
    // fence>`. `restoreEnv()` in home-fence.ts is the by-key replacement.
    expect(SCAN.disarmed).toEqual([]);
  });

  it("DETECTION CONTROL: the swap detector is not vacuous", () => {
    expect(swapsProcessEnv(strip("process.env = savedEnv;"))).toBe(true);
    expect(swapsProcessEnv(strip("  process.env = { ...saved };"))).toBe(true);
    // ...and it does not fire on the things that merely look like it.
    expect(swapsProcessEnv(strip("process.env.HOME = fence;"))).toBe(false);
    expect(swapsProcessEnv(strip('process.env["HOME"] = fence;'))).toBe(false);
    expect(swapsProcessEnv(strip("if (process.env === other) { }"))).toBe(false);
    expect(swapsProcessEnv(strip("// process.env = savedEnv;"))).toBe(false);
    expect(swapsProcessEnv(strip("restoreEnv(savedEnv);"))).toBe(false);
    // The whole-tier assertion above would be vacuous if NO file in the tier
    // used the idiom at all — 11 do, they simply do not also fence HOME.
    const swappers = SCAN.scanned.filter((f) =>
      swapsProcessEnv(strip(readFileSync(join(TESTS, f), "utf-8"))),
    );
    expect(swappers.length).toBeGreaterThanOrEqual(5);
  });

  it("the stripper swallowed no real code anywhere in the corpus", () => {
    // The regex-literal bug this pins ate a real IGRIS_BRAIN_DIR fence.
    expect(SCAN.anomalies).toEqual([]);
  });
});

// ===========================================================================
// CONTROL 6 — population. A wrong directory scans nothing and reads "clean".
// ===========================================================================

describe("BR-106 — the population is asserted, not assumed", () => {
  it("scans the real tier (>= 100 test files, >= 100 exposed symbols)", () => {
    expect(SCAN.scanned.length).toBeGreaterThanOrEqual(100); // 120 measured 2026-09-10
    expect(SCAN.table.bodies.size).toBeGreaterThanOrEqual(800); // 1019 measured 2026-09-10
    expect(SCAN.homeExposed.size).toBeGreaterThanOrEqual(100); // 142 measured 2026-09-10
    expect(SCAN.brainExposed.size).toBeGreaterThanOrEqual(250); // 357 measured 2026-09-10
  });

  it("both tiers have a non-trivial in-scope population", () => {
    expect(SCAN.inScopeHome.length).toBeGreaterThanOrEqual(25); // 34 measured 2026-09-10
    expect(SCAN.inScopeBrain.length).toBeGreaterThanOrEqual(60); // 77 measured 2026-09-10
  });

  it("the incident's own file class and the live hazard are both in scope", () => {
    // install-source.test.ts is the incident's file class (Tier B: its writer
    // resolves through brainDir()). install.test.ts is the live hazard found
    // during BR-106 planning (Tier H: runInstall -> registerMcpInClaudeJson
    // -> claudeJsonPath).
    expect(SCAN.inScopeBrain).toContain("install-source.test.ts");
    expect(SCAN.inScopeHome).toContain("install.test.ts");
  });
});

// ===========================================================================
// CONTROL 7 — the closure. Transitivity proved, and a pure module excluded.
// ===========================================================================

describe("BR-106 — the exposure closure is transitive and bounded", () => {
  it("the seeds are derived from real homedir() call sites in the expected modules", () => {
    const seedOwners = new Set(SCAN.seeds.map((s) => relative(SRC, SCAN.table.owner.get(s)!)));
    for (const f of ["lib/paths.ts", "verbs/loadout.ts", "lib/cli-detect.ts"]) {
      expect(seedOwners, f).toContain(f);
    }
    expect(SCAN.seeds).toContain("claudeJsonPath");
    expect(SCAN.seeds).toContain("expandTilde");
  });

  it("brainDir's exclusion from the HOME seeds is EARNED — it reads IGRIS_BRAIN_DIR", () => {
    // If this seam is ever removed, brainDir becomes a HOME seed and the
    // exclusion below must go with it. Asserting the seam is what keeps the
    // carve-out honest rather than assumed.
    expect(SCAN.table.bodies.get("brainDir")).toMatch(/process\s*\.\s*env\s*\.\s*IGRIS_BRAIN_DIR/);
    expect(SCAN.seeds).not.toContain("brainDir");
    expect(SCAN.homeExposed.has("brainDir")).toBe(false);
  });

  it("TRANSITIVITY: runInstall is exposed WITHOUT being a seed (2 hops)", () => {
    // runInstall -> registerMcpInClaudeJson -> claudeJsonPath -> homedir()
    expect(SCAN.seeds).not.toContain("runInstall");
    expect(SCAN.homeExposed.has("runInstall")).toBe(true);
    expect(SCAN.homeExposed.has("registerMcpInClaudeJson")).toBe(true);
    // The incident's own writer reaches real state through brainDir(), not
    // homedir() — a direct-import-only scan would have missed this class.
    expect(SCAN.seeds).not.toContain("writeInstallSource");
    expect(SCAN.brainExposed.has("writeInstallSource")).toBe(true);
  });

  it("BOUNDED: a verified pure module is in NEITHER closure", () => {
    // cli/src/lib/slug.ts: zero imports, one exported regex validator
    // (read 2026-09-10). If everything were "exposed" the guard would be a
    // tautology.
    expect(SCAN.table.owner.get("validateSlug")).toBe(join(SRC, "lib", "slug.ts"));
    expect(SCAN.homeExposed.has("validateSlug")).toBe(false);
    expect(SCAN.brainExposed.has("validateSlug")).toBe(false);
  });
});

// ===========================================================================
// CONTROLS 1-3 — VACUITY. The predicate is not satisfied by a mention.
// ===========================================================================

describe("BR-106 VACUITY CONTROLS — a mention of the fence is not a fence", () => {
  it("the stripper actually strips (asserted directly, not only through fixtures)", () => {
    const cases: ReadonlyArray<readonly [string, string, boolean]> = [
      ["line comment", "// process.env.HOME = tmp\nconst a = 1;", false],
      ["block comment", "/* process.env.HOME = tmp */\nconst a = 1;", false],
      ["string literal", 'const hint = "process.env.HOME = tmp";', false],
      ["identifier-only string is kept (see stripCommentsAndStrings)", 'const k = "HOME";', false],
      ["template literal", "const hint = `process.env.HOME = ${tmp}`;", false],
      ["=== comparison", "if (process.env.HOME === y) { }", false],
      ["expect() read-back", "expect(process.env.HOME).toBe(fence);", false],
      ["real assignment", "process.env.HOME = fence;", true],
      ["bracket assignment", 'process.env["HOME"] = fence;', true],
      ["helper call", "const f = fenceHome();", true],
      ["child env", "spawnSync(bin, args, { env: { HOME: fake } });", true],
      // A RESTORE is not a fence — the http.test.ts shape.
      ["restore from saved", "process.env.HOME = savedHome;", false],
      ["restore from a backup record", "process.env.HOME = envBackup.HOME;", false],
      ["restore, bracket form", 'process.env["HOME"] = prevHome;', false],
      // ...but a file that BOTH fences and restores still passes.
      ["fence then restore", "process.env.HOME = fence;\nprocess.env.HOME = savedHome;", true],
    ];
    for (const [label, src, want] of cases) {
      expect(fencesHome(strip(src)), label).toBe(want);
    }
  });

  it("a regex literal containing a quote does not swallow the next line", () => {
    // The exact shape at brain-bridge.test.ts:78. Before the regex-literal
    // case existed, the `"` inside the pattern opened a phantom string that
    // ate 12 lines including that file's real IGRIS_BRAIN_DIR fence.
    const src = 'const RE = /\\bfrom\\s+"(\\.\\/[^"]+\\.js)"/g;\nprocess.env.IGRIS_BRAIN_DIR = sandbox;\n';
    const res = stripCommentsAndStrings(src);
    expect(res.anomalies).toEqual([]);
    expect(fencesBrainDir(res.code)).toBe(true);
    // ...and division is still division.
    expect(stripCommentsAndStrings("const r = a / b / c;\nprocess.env.HOME = f;").anomalies).toEqual([]);
    expect(fencesHome(strip("const r = a / b / c;\nprocess.env.HOME = f;"))).toBe(true);
  });

  it("a planted file whose only HOME mention is a comment is reported unfenced", () => {
    const tmp = mkdtempSync(join(tmpdir(), "br106-vacuity-comment-"));
    try {
      writeFileSync(
        join(tmp, "planted.test.ts"),
        [
          "// This suite fences HOME: process.env.HOME = fake",
          "/* see fenceHome() in home-fence.ts */",
          'import { runInstall } from "../verbs/install.js";',
          'it("planted", async () => { await runInstall({ path: p }); });',
          "",
        ].join("\n"),
      );
      const scan = scanVitestHomeFence(SRC, tmp);
      expect(scan.scanned).toEqual(["planted.test.ts"]);
      expect(scan.inScopeHome).toEqual(["planted.test.ts"]);
      expect(scan.unfencedHome).toEqual(["planted.test.ts"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a planted file whose only HOME mention is a string or a comparison is reported unfenced", () => {
    const tmp = mkdtempSync(join(tmpdir(), "br106-vacuity-string-"));
    try {
      writeFileSync(
        join(tmp, "planted.test.ts"),
        [
          'import { runInstall } from "../verbs/install.js";',
          'const doc = "process.env.HOME = fence";',
          "it(\"planted\", async () => {",
          "  if (process.env.HOME === doc) return;",
          "  expect(process.env.HOME).toBe(doc);",
          "  await runInstall({ path: p });",
          "});",
          "",
        ].join("\n"),
      );
      const scan = scanVitestHomeFence(SRC, tmp);
      expect(scan.unfencedHome).toEqual(["planted.test.ts"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// CONTROLS 4-5 — SELF-NEGATIVE and POSITIVE, on a REAL file.
// ===========================================================================

describe("BR-106 SELF-NEGATIVE CONTROL — a real file with its fence deleted is reported", () => {
  it("install-mcp-keep.test.ts passes; the same file with its HOME fence removed does not", () => {
    const real = readFileSync(join(TESTS, "install-mcp-keep.test.ts"), "utf-8");
    // The real file satisfies the rule...
    expect(fencesHome(strip(real))).toBe(true);
    expect(SCAN.unfencedHome).not.toContain("install-mcp-keep.test.ts");

    // ...and with the fence assignment deleted it does not. The mutation is
    // the sentinel's 2026-09-08 one: remove the HOME line, keep everything
    // else (including the surrounding comments that TALK about the fence).
    const mutant = real
      .replace(/process\.env\.HOME\s*=/g, "process.env.NOT_HOME =")
      .replace(/\bfenceHome\s*\(/g, "notAFence(");
    const tmp = mkdtempSync(join(tmpdir(), "br106-selfneg-"));
    try {
      writeFileSync(join(tmp, "planted.test.ts"), mutant);
      const scan = scanVitestHomeFence(SRC, tmp);
      expect(scan.scanned).toEqual(["planted.test.ts"]);
      expect(scan.inScopeHome).toEqual(["planted.test.ts"]); // still drives runInstall
      expect(scan.unfencedHome).toEqual(["planted.test.ts"]); // and is now reported
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("POSITIVE CONTROL: restoring the fence on the same copy clears the report", () => {
    const real = readFileSync(join(TESTS, "install-mcp-keep.test.ts"), "utf-8");
    const tmp = mkdtempSync(join(tmpdir(), "br106-positive-"));
    try {
      writeFileSync(join(tmp, "planted.test.ts"), real);
      const scan = scanVitestHomeFence(SRC, tmp);
      expect(scan.inScopeHome).toEqual(["planted.test.ts"]);
      expect(scan.unfencedHome).toEqual([]);
      expect(scan.unfencedBrain).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// The exemption table's own self-checks.
// ===========================================================================

describe("BR-106 — TRIAGED_EXEMPT cannot rot into an allowlist", () => {
  it("every exempt key exists on disk (a rename reds)", () => {
    for (const key of Object.keys(TRIAGED_EXEMPT)) {
      expect(() => statSync(join(TESTS, key)), key).not.toThrow();
    }
  });

  it("every exempt key is actually in scope (a dead exemption must be deleted)", () => {
    const inScope = new Set([...SCAN.inScopeHome, ...SCAN.inScopeBrain]);
    for (const key of Object.keys(TRIAGED_EXEMPT)) {
      expect(inScope.has(key), `${key} is exempt but not in scope`).toBe(true);
    }
  });

  it("every exemption carries a reason, and growth is a review event", () => {
    for (const [key, reason] of Object.entries(TRIAGED_EXEMPT)) {
      expect(reason.length, key).toBeGreaterThan(20);
    }
    expect(Object.keys(TRIAGED_EXEMPT).length).toBeLessThanOrEqual(EXEMPT_CAP);
  });

  it("the exemption MECHANISM works — proved on a planted entry, since the real table is empty", () => {
    // An empty table makes the three checks above vacuous. This proves the
    // filter actually consults the table rather than being dead code.
    const tmp = mkdtempSync(join(tmpdir(), "br106-exempt-"));
    try {
      writeFileSync(
        join(tmp, "planted.test.ts"),
        'import { runInstall } from "../verbs/install.js";\nit("x", async () => { await runInstall({ path: p }); });\n',
      );
      const scan = scanVitestHomeFence(SRC, tmp);
      expect(scan.unfencedHome).toEqual(["planted.test.ts"]);
      const exempt: Record<string, string> = { "planted.test.ts": "a reason long enough to satisfy the cap" };
      expect(scan.unfencedHome.filter((f) => !(f in exempt))).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// The shared helper's own arm-check (TD-456's `stageBrainFences` analogue).
// `fenceHome(` is a token in the predicate above; without this it is a name
// with no teeth.
// ===========================================================================

describe("BR-106 — the fenceHome helper is a fence, not a name", () => {
  it("home-fence.ts really assigns HOME and reads the fence back from the OS resolver", () => {
    const helper = strip(readFileSync(join(TESTS, "home-fence.ts"), "utf-8"));
    // BR-106 review finding 5: this assertion used a RAW
    // `/process.env.HOME\s*=[^=]/` match, which `release()`'s restore satisfies
    // on its own — the exact restore-vs-fence confusion this brief exists to
    // close, one layer up. Route it through the SAME hardened predicate the
    // corpus scan uses, so a helper that only ever restores fails here too.
    expect(
      assignsFreshEnv(helper, "HOME"),
      "home-fence.ts must FRESHLY assign HOME, not merely restore it",
    ).toBe(true);
    // ARMED: it reads back from the OS resolver, not from the env var it just
    // wrote — `homedir()` is what the production path builders actually call.
    expect(helper).toMatch(/\bhomedir\s*\(/);
    // ...it REFUSES rather than warns...
    expect(helper).toMatch(/\bthrow new Error\b/);
    // ...and one of the refusals is "the fence IS the operator's real home",
    // which is the check that makes a stand-in safe rather than intended-safe.
    expect(helper).toMatch(/IGRIS_REAL_HOME/);
    expect(helper).toMatch(/\bexport function assertHomeFenced\b/);
  });

  it("the belt publishes IGRIS_REAL_HOME BEFORE repointing HOME (order is load-bearing)", () => {
    const setup = strip(readFileSync(resolve(SRC, "..", "vitest.setup.ts"), "utf-8"));
    const publish = setup.search(/process\s*\.\s*env\s*\.\s*IGRIS_REAL_HOME\s*=[^=]/);
    const repoint = setup.search(/process\s*\.\s*env\s*\.\s*HOME\s*=\s*belt/);
    expect(publish).toBeGreaterThan(-1);
    expect(repoint).toBeGreaterThan(-1);
    // Setup files run before the test file's modules load, so a module-level
    // `const REAL_HOME = process.env.HOME` already sees the belt. If HOME were
    // repointed first, IGRIS_REAL_HOME would capture the BELT and every
    // real-home belt in the tier would silently no-op.
    expect(publish).toBeLessThan(repoint);
    // The belt must NOT set IGRIS_BRAIN_DIR — files assert it is unset.
    expect(setup).not.toMatch(/process\s*\.\s*env\s*\.\s*IGRIS_BRAIN_DIR\s*=[^=]/);
  });
});
